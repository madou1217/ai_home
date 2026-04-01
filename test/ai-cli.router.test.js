const test = require('node:test');
const assert = require('node:assert/strict');
const { runAiCliCommandRouter } = require('../lib/cli/commands/ai-cli/router');

test('`aih codex` without explicit action uses auto account routing', () => {
  const runCalls = [];
  const exits = [];
  const logs = [];

  const processImpl = {
    exit: (code) => exits.push(code)
  };
  const fs = {
    existsSync: () => true
  };

  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg) => logs.push(String(msg));
  console.error = () => {};

  try {
    runAiCliCommandRouter('codex', ['codex'], {
      processImpl,
      fs,
      PROFILES_DIR: '/tmp/aih-test-profiles',
      HOST_HOME_DIR: '/tmp',
      extractActiveEnv: () => null,
      getNextAvailableId: () => '2',
      runCliPty: (cliName, id, forwardArgs) => runCalls.push({ cliName, id, forwardArgs })
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(exits, []);
  assert.deepEqual(runCalls, [{ cliName: 'codex', id: '2', forwardArgs: [] }]);
  assert.equal(logs.some((line) => line.includes('Auto-selected Account ID')), true);
});

test('`aih codex ls <id>` forwards id filter to listProfiles', () => {
  const exits = [];
  const listCalls = [];
  runAiCliCommandRouter('codex', ['codex', 'ls', '24444'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    listProfiles: (cliName, id) => listCalls.push({ cliName, id }),
    showLsHelp: () => {}
  });
  assert.deepEqual(listCalls, [{ cliName: 'codex', id: '24444' }]);
  assert.deepEqual(exits, [0]);
});

test('`aih codex count` prints provider count', () => {
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'count'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      countProfiles: () => ({ total: 12, providers: { codex: 12 } })
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('codex accounts: 12')), true);
});

test('`aih codex delete 1,2,3` deletes multiple accounts', () => {
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'delete', '1,2,3'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      parseDeleteSelectorTokens: () => ['1', '2', '3'],
      deleteAccountsForCli: () => ({ deletedIds: ['1', '2', '3'], missingIds: [] })
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('deleted 3 codex account')), true);
  assert.equal(logs.some((line) => line.includes('1, 2, 3')), true);
});

test('`aih codex delete 1-9` supports range selectors', () => {
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'delete', '1-3'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      parseDeleteSelectorTokens: () => ['1', '2', '3'],
      deleteAccountsForCli: () => ({ deletedIds: ['1', '2'], missingIds: ['3'] })
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('deleted 2 codex account')), true);
  assert.equal(logs.some((line) => line.includes('missing: 3')), true);
});

test('`aih codex deleteall` deletes all accounts for a provider', () => {
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'deleteall'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      deleteAllAccountsForCli: () => ({ deletedIds: ['1', '2'], totalBeforeDelete: 2 })
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(exits, [0]);
  assert.equal(logs.some((line) => line.includes('deleted 2/2 codex account')), true);
});

test('`aih codex ls foo` returns invalid id error', () => {
  const exits = [];
  const errors = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'ls', 'foo'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      listProfiles: () => {},
      showLsHelp: () => {}
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(exits, [1]);
  assert.equal(errors.some((line) => line.includes('Invalid ID. Usage: aih codex ls [id]')), true);
});

test('`aih codex login --no-browser` forwards flag to login PTY flow', () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', 'login', '--no-browser'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    extractActiveEnv: () => null,
    getNextId: () => '42',
    createAccount: () => true,
    runCliPty: (cliName, id, forwardArgs, isLogin) => calls.push({ cliName, id, forwardArgs, isLogin })
  });

  assert.deepEqual(exits, []);
  assert.deepEqual(calls, [{
    cliName: 'codex',
    id: '42',
    forwardArgs: ['--no-browser'],
    isLogin: true
  }]);
});

test('`aih codex <id> --no-browser` logs in the same account when unconfigured', () => {
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', '12', '--no-browser'], {
    processImpl: { exit: () => {} },
    fs: { existsSync: () => true },
    extractActiveEnv: () => null,
    getProfileDir: () => '/tmp/aih-test/codex/12',
    checkStatus: () => ({ configured: false, accountName: 'Unknown' }),
    runCliPty: (cliName, id, forwardArgs, isLogin) => calls.push({ cliName, id, forwardArgs, isLogin })
  });
  assert.deepEqual(calls, [{
    cliName: 'codex',
    id: '12',
    forwardArgs: ['--no-browser'],
    isLogin: true
  }]);
});

test('`aih codex <id> --no-browser` creates new account when target account is already configured', () => {
  const calls = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', '12', '--no-browser'], {
      processImpl: { exit: () => {} },
      fs: { existsSync: () => true },
      extractActiveEnv: () => null,
      getProfileDir: () => '/tmp/aih-test/codex/12',
      checkStatus: () => ({ configured: true, accountName: 'u@example.com' }),
      getNextId: () => '13',
      createAccount: () => true,
      runCliPty: (cliName, id, forwardArgs, isLogin) => calls.push({ cliName, id, forwardArgs, isLogin })
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.some((line) => line.includes('already logged in') && line.includes('Creating Account 13')), true);
  assert.deepEqual(calls, [{
    cliName: 'codex',
    id: '13',
    forwardArgs: ['--no-browser'],
    isLogin: true
  }]);
});

test('`aih codex usage -j 200` forwards jobs option to usage scan', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', 'usage', '-j', '200'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    printAllUsageSnapshots: async (cliName, opts) => { calls.push({ cliName, opts }); }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ cliName: 'codex', opts: { jobs: 200 } }]);
  assert.deepEqual(exits, [0]);
});

test('`aih codex usage --jobs 200` is rejected (single -j flag policy)', () => {
  const exits = [];
  const errors = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'usage', '--jobs', '200'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      printAllUsageSnapshots: async () => {}
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(exits, [1]);
  assert.equal(errors.some((line) => line.includes('Unknown usage scan arg: --jobs')), true);
});

test('`aih codex usage <id> --no-cache` forwards noCache query option', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', 'usage', '12', '--no-cache'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    getProfileDir: () => '/tmp/aih-test/codex/12',
    printUsageSnapshotAsync: async (cliName, id, opts) => {
      calls.push({ cliName, id, opts });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    cliName: 'codex',
    id: '12',
    opts: { noCache: true }
  }]);
  assert.deepEqual(exits, [0]);
});

test('`aih codex <id> usage --no-cache` forwards noCache query option', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', '12', 'usage', '--no-cache'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    extractActiveEnv: () => null,
    getProfileDir: () => '/tmp/aih-test/codex/12',
    printUsageSnapshotAsync: async (cliName, id, opts) => {
      calls.push({ cliName, id, opts });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    cliName: 'codex',
    id: '12',
    opts: { noCache: true }
  }]);
  assert.deepEqual(exits, [0]);
});

test('`aih codex import` routes through unified import with fixed provider', async () => {
  const exits = [];
  const calls = [];
  runAiCliCommandRouter('codex', ['codex', 'import', 'folder1', 'zip1.zip', 'cliproxyapi'], {
    processImpl: { exit: (code) => exits.push(code) },
    fs: { existsSync: () => true },
    renderStageProgress: () => {},
    runUnifiedImport: async (args, opts) => {
      calls.push({ args, opts });
      return {
        providers: ['codex'],
        failedSources: []
      };
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['folder1', 'zip1.zip', 'cliproxyapi']);
  assert.equal(calls[0].opts.provider, 'codex');
  assert.equal(calls[0].opts.log, console.log);
  assert.equal(calls[0].opts.error, console.error);
  assert.equal(typeof calls[0].opts.renderStageProgress, 'function');
  assert.deepEqual(exits, [0]);
});

test('`aih codex cleanup` deletes matching accounts immediately', async () => {
  const exits = [];
  const logs = [];
  const progress = [];
  const calls = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    runAiCliCommandRouter('codex', ['codex', 'cleanup'], {
      processImpl: { exit: (code) => exits.push(code) },
      fs: { existsSync: () => true },
      renderStageProgress: (prefix, current, total, label) => progress.push({ prefix, current, total, label }),
      cleanupCodexAccounts: async (opts) => {
        calls.push(opts);
        opts.onScanProgress({ scanned: 1, total: 2, id: '7', matched: true, reasons: ['remaining_0'] });
        opts.onDelete({ id: '7', reasons: ['remaining_0'], email: 'u@example.com' });
        opts.onScanProgress({ scanned: 2, total: 2, id: '8', matched: false, reasons: [] });
        return {
          scannedAccounts: 2,
          removedAccounts: [{ id: '7', reasons: ['remaining_0'], email: 'u@example.com' }],
          removedCliproxyapiFiles: []
        };
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(exits, [0]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].jobs, 1000);
  assert.equal(progress.some((item) => item.prefix === '[aih cleanup]' && item.current === 2 && item.total === 2), true);
  assert.equal(progress.some((item) => String(item.label || '').includes('deleted 1')), true);
  assert.equal(logs.some((line) => line.includes('scanning free OAuth accounts with concurrency 1000')), true);
  assert.equal(logs.some((line) => line.includes('scanned 2 free account(s) and removed 1 account')), true);
});
