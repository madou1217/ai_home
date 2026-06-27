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
    runGlobalPersistentSessionsCommand: () => {
      events.push('sessions');
      return 0;
    },
    globalSessionContext: {},
    runGlobalAccountImport: async () => ({ providers: [], failedProviders: [] }),
    parseCodexBulkImportArgs: () => ({}),
    importCodexTokensFromOutput: async () => ({}),
    refreshAccountStateIndexForProvider: () => events.push('refreshIndex'),
    runBackupCommand: () => false,
    backupContext: {},
    runServerEntry: async () => 0,
    serverEntryContext: {},
    runUpdateCommand: async () => 0,
    updateContext: {},
    runNodeCommandRouter: async () => 0,
    nodeContext: {},
    runFabricCommandRouter: async () => 0,
    fabricContext: {},
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

test('runCliRootRouter forwards `serve` options to foreground server serve', async () => {
  const calls = [];
  const h = createHarness({
    runBackupCommand: () => false,
    runServerEntry: async (args) => {
      calls.push(args);
      return 0;
    }
  });

  await runCliRootRouter(['serve', '--port', '8317'], h.deps);
  assert.deepEqual(calls, [['server', 'serve', '--port', '8317']]);
  assert.equal(h.getExitCode(), 0);
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

test('runCliRootRouter routes global usage to model accounting', async () => {
  const calls = [];
  const h = createHarness({
    printModelUsageReport: async (args) => calls.push(args)
  });
  await runCliRootRouter(['usage', 'models', '--provider', 'codex'], h.deps);
  assert.deepEqual(calls, [['models', '--provider', 'codex']]);
  assert.equal(h.getExitCode(), 0);
  assert.equal(h.events.some((event) => event.startsWith('ai:')), false);
});

test('runCliRootRouter routes sessions before ai cli fallback', async () => {
  const calls = [];
  const h = createHarness({
    globalSessionContext: { global: true },
    runGlobalPersistentSessionsCommand: (args, context) => {
      calls.push({ args, context });
      return 0;
    }
  });
  await runCliRootRouter(['sessions'], h.deps);
  assert.deepEqual(calls, [{ args: [], context: { global: true } }]);
  assert.equal(h.events.some((event) => event.startsWith('ai:')), false);
  assert.equal(h.getExitCode(), 0);
});

test('runCliRootRouter routes ss as sessions alias', async () => {
  const calls = [];
  const h = createHarness({
    globalSessionContext: { global: true },
    runGlobalPersistentSessionsCommand: (args, context) => {
      calls.push({ args, context });
      return 0;
    }
  });
  await runCliRootRouter(['ss', '--help'], h.deps);
  assert.deepEqual(calls, [{ args: ['--help'], context: { global: true } }]);
  assert.equal(h.events.some((event) => event.startsWith('ai:')), false);
  assert.equal(h.getExitCode(), 0);
});

test('runCliRootRouter does not exit after sessions enters PTY', async () => {
  const h = createHarness({
    runGlobalPersistentSessionsCommand: async () => ({ entered: true })
  });
  await runCliRootRouter(['ss'], h.deps);
  assert.equal(h.getExitCode(), null);
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

test('runCliRootRouter no longer handles `aih count` as a root command', async () => {
  const h = createHarness();
  await runCliRootRouter(['count'], h.deps);
  assert.equal(h.getExitCode(), null);
  assert.equal(h.events.includes('ai:count'), true);
});

test('runCliRootRouter no longer handles `aih dev mock-usage` as a root command', async () => {
  const h = createHarness();
  await runCliRootRouter(['dev', 'mock-usage', 'codex', '1'], h.deps);
  assert.equal(h.getExitCode(), null);
  assert.equal(h.events.includes('ai:dev'), true);
});

test('runCliRootRouter no longer maps `provider` alias to server', async () => {
  const h = createHarness({
    runServerEntry: async () => {
      h.events.push('serverEntry');
      return 0;
    }
  });
  await runCliRootRouter(['provider'], h.deps);
  assert.equal(h.getExitCode(), null);
  assert.equal(h.events.includes('serverEntry'), false);
  assert.equal(h.events.includes('ai:provider'), true);
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

test('runCliRootRouter routes gemini-scoped cliproxyapi export through backup command', async () => {
  const calls = [];
  const h = createHarness({
    runBackupCommand: async (cmd, args) => {
      calls.push({ cmd, args });
      return true;
    }
  });
  await runCliRootRouter(['gemini', 'export', 'cliproxyapi'], h.deps);
  assert.deepEqual(calls, [{ cmd: 'export', args: ['export', 'cliproxyapi', 'gemini'] }]);
});

test('runCliRootRouter routes provider-scoped sub2api export through backup command', async () => {
  const calls = [];
  const h = createHarness({
    runBackupCommand: async (cmd, args) => {
      calls.push({ cmd, args });
      return true;
    }
  });
  await runCliRootRouter(['codex', 'export', 'sub2api', 'out.json'], h.deps);
  assert.deepEqual(calls, [{ cmd: 'export', args: ['export', 'sub2api', 'codex', 'out.json'] }]);
});

test('runCliRootRouter routes provider-scoped antigravity export through backup command', async () => {
  const calls = [];
  const h = createHarness({
    runBackupCommand: async (cmd, args) => {
      calls.push({ cmd, args });
      return true;
    }
  });
  await runCliRootRouter(['agy', 'export', 'antigravity', 'out.json'], h.deps);
  assert.deepEqual(calls, [{ cmd: 'export', args: ['export', 'antigravity', 'agy', 'out.json'] }]);
});

test('runCliRootRouter routes update command before ai cli fallback', async () => {
  const calls = [];
  const h = createHarness({
    runUpdateCommand: async (args) => {
      calls.push(args);
      return 5;
    }
  });
  await runCliRootRouter(['update', '--check'], h.deps);
  assert.deepEqual(calls, [['--check']]);
  assert.equal(h.getExitCode(), 5);
  assert.equal(h.events.some((event) => event.startsWith('ai:')), false);
});

test('runCliRootRouter routes node command before ai cli fallback', async () => {
  const calls = [];
  const h = createHarness({
    runNodeCommandRouter: async (args, context) => {
      calls.push({ args, context });
      return 0;
    },
    nodeContext: { node: true }
  });
  await runCliRootRouter(['node', 'join', 'https://control.example.com/v0/node-rpc/join?code=abc'], h.deps);
  assert.deepEqual(calls, [{
    args: ['node', 'join', 'https://control.example.com/v0/node-rpc/join?code=abc'],
    context: { node: true }
  }]);
  assert.equal(h.events.some((event) => event.startsWith('ai:')), false);
});

test('runCliRootRouter routes fabric command before ai cli fallback', async () => {
  const calls = [];
  const h = createHarness({
    runFabricCommandRouter: async (args, context) => {
      calls.push({ args, context });
      return 0;
    },
    fabricContext: { fabric: true }
  });
  await runCliRootRouter(['fabric', 'transport', 'probe', 'tcp://127.0.0.1:9527'], h.deps);
  assert.deepEqual(calls, [{
    args: ['fabric', 'transport', 'probe', 'tcp://127.0.0.1:9527'],
    context: { fabric: true }
  }]);
  assert.equal(h.events.some((event) => event.startsWith('ai:')), false);
});

test('runCliRootRouter routes ssh command before ai cli fallback', async () => {
  const calls = [];
  const h = createHarness({
    runAihSshCommand: async (args, context) => {
      calls.push({ args, context });
      return 0;
    },
    sshContext: { ssh: true }
  });
  await runCliRootRouter(['ssh', 'model@host', '--', 'aih', 'claude'], h.deps);
  assert.deepEqual(calls, [{
    args: ['ssh', 'model@host', '--', 'aih', 'claude'],
    context: { ssh: true }
  }]);
  assert.equal(h.events.some((event) => event.startsWith('ai:')), false);
  assert.equal(h.getExitCode(), 0);
});

test('runCliRootRouter routes clip-agent command before ai cli fallback', async () => {
  const calls = [];
  const h = createHarness({
    runClipAgentCommand: async (args, context) => {
      calls.push({ args, context });
      return 0;
    },
    clipAgentContext: { clipAgent: true }
  });
  await runCliRootRouter(['clip-agent', 'start', '--port', '17652'], h.deps);
  assert.deepEqual(calls, [{
    args: ['clip-agent', 'start', '--port', '17652'],
    context: { clipAgent: true }
  }]);
  assert.equal(h.events.some((event) => event.startsWith('ai:')), false);
  assert.equal(h.getExitCode(), 0);
});

test('runCliRootRouter routes ssh-clipboard probe before ai cli fallback', async () => {
  const calls = [];
  const h = createHarness({
    runSshClipboardProbeCommand: async (args, context) => {
      calls.push({ args, context });
      return 0;
    },
    sshClipboardContext: { sshClipboard: true }
  });
  await runCliRootRouter(['ssh-clipboard', 'probe', '--json'], h.deps);
  assert.deepEqual(calls, [{
    args: ['ssh-clipboard', 'probe', '--json'],
    context: { sshClipboard: true }
  }]);
  assert.equal(h.events.some((event) => event.startsWith('ai:')), false);
  assert.equal(h.getExitCode(), 0);
});
