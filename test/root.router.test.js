const test = require('node:test');
const assert = require('node:assert/strict');
const { runCliRootRouter } = require('../lib/cli/commands/root/router');

function createHarness(overrides = {}) {
  const events = [];
  let exitCode = null;

  const deps = {
    processObj: {
      exit: (code) => {
        exitCode = code;
        events.push(`exit:${code}`);
      },
      stdout: { write: (s) => events.push(`stdout:${s}`) },
      stderr: { write: (s) => events.push(`stderr:${s}`) }
    },
    consoleImpl: {
      log: (msg) => events.push(`log:${String(msg)}`),
      error: (msg) => events.push(`error:${String(msg)}`)
    },
    fs: {},
    buildUsageProbePayload: () => ({ ok: true }),
    showHelp: () => events.push('showHelp'),
    showLsHelp: () => events.push('showLsHelp'),
    listProfiles: () => events.push('listProfiles'),
    countProfiles: () => ({ total: 0, providers: {} }),
    runGlobalAccountImport: async () => ({ providers: [], failedProviders: [] }),
    parseCodexBulkImportArgs: () => ({}),
    importCodexTokensFromOutput: async () => ({}),
    refreshAccountStateIndexForProvider: () => events.push('refreshIndex'),
    runDevCommand: async () => 0,
    devContext: {},
    runBackupCommand: () => false,
    backupContext: {},
    runServerEntry: async () => 0,
    serverEntryContext: {},
    runAiCliCommandRouter: (cmd) => events.push(`ai:${cmd}`),
    aiCliContext: {}
  };

  Object.assign(deps, overrides);
  return { deps, events, getExitCode: () => exitCode };
}

test('runCliRootRouter handles help command first', async () => {
  const h = createHarness();
  await runCliRootRouter(['--help'], h.deps);
  assert.equal(h.getExitCode(), 0);
  assert.deepEqual(h.events.slice(0, 2), ['showHelp', 'exit:0']);
});

test('runCliRootRouter gives backup command priority before fallback router', async () => {
  const h = createHarness({
    runBackupCommand: (cmd) => {
      h.events.push(`backup:${cmd}`);
      return true;
    },
    runServerEntry: async () => {
      h.events.push('serverEntry');
      return 0;
    }
  });

  await runCliRootRouter(['backup', 'export'], h.deps);
  assert.equal(h.events.includes('backup:backup'), true);
  assert.equal(h.events.includes('serverEntry'), false);
  assert.equal(h.events.some((e) => e.startsWith('ai:')), false);
});

test('runCliRootRouter routes server command after backup check', async () => {
  const h = createHarness({
    runBackupCommand: () => false,
    runServerEntry: async () => 7
  });

  await runCliRootRouter(['server', 'start'], h.deps);
  assert.equal(h.getExitCode(), 7);
});

test('runCliRootRouter falls back to ai cli router for unknown root commands', async () => {
  const h = createHarness();
  await runCliRootRouter(['codex', '10086'], h.deps);
  assert.equal(h.events.includes('ai:codex'), true);
  assert.equal(h.getExitCode(), null);
});

test('runCliRootRouter maps bare account id to unique tool router', async () => {
  const calls = [];
  const h = createHarness({
    fs: {
      existsSync: (target) => String(target).includes('/profiles/codex/123')
    },
    aiCliContext: {
      PROFILES_DIR: '/tmp/profiles'
    },
    runAiCliCommandRouter: (cmd, args) => calls.push({ cmd, args })
  });
  await runCliRootRouter(['123'], h.deps);
  assert.deepEqual(calls, [{ cmd: 'codex', args: ['codex', '123'] }]);
});

test('runCliRootRouter maps usage id shorthand to unique tool router', async () => {
  const calls = [];
  const h = createHarness({
    fs: {
      existsSync: (target) => String(target).includes('/profiles/codex/456')
    },
    aiCliContext: {
      PROFILES_DIR: '/tmp/profiles'
    },
    runAiCliCommandRouter: (cmd, args) => calls.push({ cmd, args })
  });
  await runCliRootRouter(['usage', '456', '--no-cache'], h.deps);
  assert.deepEqual(calls, [{ cmd: 'codex', args: ['codex', 'usage', '456', '--no-cache'] }]);
});

test('runCliRootRouter __usage-probe prefers async payload builder and writes newline-delimited json', async () => {
  const h = createHarness({
    buildUsageProbePayload: () => ({ source: 'sync' }),
    buildUsageProbePayloadAsync: async () => ({ source: 'async', ok: true })
  });
  await runCliRootRouter(['__usage-probe', 'codex', '1'], h.deps);
  assert.equal(h.getExitCode(), 0);
  assert.equal(h.events.some((event) => event === 'stdout:{"source":"async","ok":true}\n'), true);
});

test('runCliRootRouter prints overall counts for `aih count`', async () => {
  const h = createHarness({
    countProfiles: () => ({
      total: 6,
      providers: { codex: 4, gemini: 1, claude: 1 }
    })
  });
  await runCliRootRouter(['count'], h.deps);
  assert.equal(h.getExitCode(), 0);
  assert.equal(h.events.some((event) => event.includes('codex: 4')), true);
  assert.equal(h.events.some((event) => event.includes('total: 6')), true);
});

test('runCliRootRouter routes provider-scoped export through backup command', async () => {
  const calls = [];
  const h = createHarness({
    runBackupCommand: async (cmd, args) => {
      calls.push({ cmd, args });
      return true;
    }
  });
  await runCliRootRouter(['codex', 'export'], h.deps);
  assert.deepEqual(calls, [{ cmd: 'export', args: ['export', '__provider__', 'codex'] }]);
});

test('runCliRootRouter routes provider-scoped cliproxyapi export through backup command', async () => {
  const calls = [];
  const h = createHarness({
    runBackupCommand: async (cmd, args) => {
      calls.push({ cmd, args });
      return true;
    }
  });
  await runCliRootRouter(['codex', 'export', 'cliproxyapi'], h.deps);
  assert.deepEqual(calls, [{ cmd: 'export', args: ['export', 'cliproxyapi', 'codex'] }]);
});
