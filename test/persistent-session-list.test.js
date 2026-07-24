const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const persistentSession = require('../lib/runtime/persistent-session');
const persistentSessionRegistry = require('../lib/runtime/persistent-session-registry');
const {
  CODEX_MANAGED_LAUNCH_VALUE
} = require('../lib/runtime/codex-launch-context');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { AIH_SERVER_PROFILE_ID } = require('../lib/account/self-relay-account');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const {
  formatGlobalPersistentSessionsByProject,
  getSessionDisplayDescription,
  listPersistentSessions,
  listProviderAccountScopes,
  needsFreshCompatibleSession,
  runGlobalPersistentSessionsCommand,
  selectPersistentSessionRow,
  selectPersistentSessionRowAsync,
  shouldUseSyncSessionPicker
} = require('../lib/cli/services/ai-cli/persistent-session-list');

function registerTestAccount(aiHomeDir, provider, cliAccountId) {
  return registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `test:persistent-session-list:${provider}:${cliAccountId}`
  }).accountRef;
}

function tmuxSocket(args) {
  const index = Array.isArray(args) ? args.indexOf('-L') : -1;
  return index >= 0 ? args[index + 1] : '';
}

function testCellWidth(value) {
  return Array.from(String(value || '')).reduce((sum, char) => {
    const code = char.codePointAt(0);
    if (!code) return sum;
    if (code < 32 || (code >= 0x7f && code < 0xa0)) return sum;
    if (
      (code >= 0x1100 && code <= 0x115f)
      || code === 0x2329
      || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    ) return sum + 2;
    return sum + 1;
  }, 0);
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '');
}

test('session list marks legacy psmux Codex launch runtime rows as fresh-session only', () => {
  const row = {
    cliName: 'codex',
    description: 'Working task',
    requirePsmuxCodexLaunchRuntime: true,
    psmuxCodexLaunchRuntime: '',
    psmuxCodexLaunchRuntimeChecked: true,
    psmuxCodexLaunchRuntimeReady: false
  };

  assert.equal(needsFreshCompatibleSession(row), true);
  assert.equal(getSessionDisplayDescription(row), 'Working task');
});

test('session list marks Codex sessions without managed authentication context as fresh-session only', () => {
  assert.equal(needsFreshCompatibleSession({
    cliName: 'codex',
    requireCodexManagedLaunch: true,
    codexManagedLaunch: '',
    codexManagedLaunchChecked: true,
    codexManagedLaunchReady: false
  }), true);
});

test('session picker applies the same render and supervisor compatibility requirements as launch', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-compatibility-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeAccountRef = registerTestAccount(root, 'claude', '1');
  const codexOauthAccountRef = registerTestAccount(root, 'codex', '2');
  const codexApiKeyAccountRef = registerTestAccount(root, 'codex', '3');
  writeAccountCredentials(fs, root, codexApiKeyAccountRef, { OPENAI_API_KEY: 'test-key' });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const row = (name, cwd) => [
    name,
    '0',
    '100',
    cwd,
    name,
    'codex',
    'node',
    '123',
    persistentSession.UTF8_RUNTIME_MARKER_VALUE,
    '',
    '0',
    '',
    cwd,
    '',
    CODEX_MANAGED_LAUNCH_VALUE
  ].join(sep);
  const collect = (cliName, accountRef, cliAccountId, sessionRow) => listPersistentSessions(
    cliName,
    accountRef,
    {
      fs,
      aiHomeDir: root,
      cliAccountId,
      collectOnly: true,
      processImpl: {
        platform: 'darwin',
        env: {},
        cwd: () => '/work/current'
      },
      resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
      spawnSync: (_command, args) => (
        args.includes('list-sessions')
          ? { status: 0, stdout: sessionRow }
          : { status: 0, stdout: '' }
      ),
      agentSessionTitleResolver: (_provider, sessions) => sessions
    }
  ).rows[0];

  const claudeRow = collect(
    'claude',
    claudeAccountRef,
    '1',
    row('p-legacy-claude-render', '/work/claude')
  );
  assert.equal(claudeRow.requireClaudeRenderRuntime, true);
  assert.equal(claudeRow.requireProviderSupervisorRuntime, false);
  assert.equal(needsFreshCompatibleSession(claudeRow), true);

  const codexOauthRow = collect(
    'codex',
    codexOauthAccountRef,
    '2',
    row('p-legacy-supervisor', '/work/codex-oauth')
  );
  assert.equal(codexOauthRow.requirePsmuxCodexLaunchRuntime, false);
  assert.equal(codexOauthRow.requireCodexManagedLaunch, true);
  assert.equal(codexOauthRow.requireProviderSupervisorRuntime, true);
  assert.equal(needsFreshCompatibleSession(codexOauthRow), true);

  const codexApiKeyRow = collect(
    'codex',
    codexApiKeyAccountRef,
    '3',
    row('p-compatible-api-key', '/work/codex-api-key')
  );
  assert.equal(codexApiKeyRow.requirePsmuxCodexLaunchRuntime, false);
  assert.equal(codexApiKeyRow.requireCodexManagedLaunch, true);
  assert.equal(codexApiKeyRow.requireProviderSupervisorRuntime, false);
  assert.equal(needsFreshCompatibleSession(codexApiKeyRow), false);
});

test('formatGlobalPersistentSessionsByProject groups by project and sorts newest first', () => {
  const firstProject = '/work/first';
  const secondProject = '/work/second';
  const output = formatGlobalPersistentSessionsByProject([
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: secondProject,
      command: 'cd "/work/second" && aih codex 1',
      description: 'old session',
      created: 100,
      live: false
    },
    {
      cliName: 'claude',
      cliAccountId: '2',
      path: firstProject,
      gitBranch: 'feature/session-ui',
      command: 'cd "/work/first" && aih claude 2 -M',
      description: 'new session',
      created: 300,
      live: true
    },
    {
      cliName: 'gemini',
      cliAccountId: '3',
      path: firstProject,
      command: 'cd "/work/first" && aih gemini 3',
      description: 'middle session',
      created: 200,
      live: false
    }
  ]);

  assert.equal(output.includes(firstProject), true);
  assert.equal(output.includes(secondProject), true);
  assert.equal(output.includes(' ' + firstProject), true);
  assert.equal(output.includes('⌁ feature/session-ui'), true);
  assert.equal(output.indexOf(firstProject) < output.indexOf(secondProject), true);
  assert.equal(output.indexOf('claude#2') < output.indexOf('gemini#3'), true);
  assert.equal(output.includes('codex#1'), true);
});

test('runGlobalPersistentSessionsCommand previews active sessions across providers by project', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const codexAccountRef = registerTestAccount(root, 'codex', '1');
  const claudeAccountRef = registerTestAccount(root, 'claude', '2');
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const projectDir = '/work/shared';
  const logs = [];
  const spawnCalls = [];

  const code = runGlobalPersistentSessionsCommand(['--list'], {
    fs,
    profilesDir,
    aiHomeDir: root,
    hostHomeDir: root,
    providers: ['codex', 'claude'],
    processImpl: {
      platform: 'darwin',
      env: {},
      cwd: () => '/work/current'
    },
    consoleImpl: {
      log: (msg) => logs.push(String(msg)),
      error: (msg) => logs.push(`error:${msg}`)
    },
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    spawnSync: (_command, args, options) => {
      spawnCalls.push({ args, options });
      if (args.includes('source-file')) return { status: 0, stdout: '' };
      if (tmuxSocket(args) === `aih-codex-${codexAccountRef}`) {
        return {
          status: 0,
          stdout: ['p-shared-a', '1', '300', projectDir, 'codex task', 'codex', 'node'].join(sep)
        };
      }
      if (tmuxSocket(args) === 'aih-codex-gateway') {
        return {
          status: 0,
          stdout: ['p-server-a', '1', '400', projectDir, 'server task', 'codex', 'node'].join(sep)
        };
      }
      if (tmuxSocket(args) === `aih-claude-${claudeAccountRef}`) {
        return {
          status: 0,
          stdout: ['p-shared-b', '0', '200', projectDir, 'claude task', 'claude', 'node'].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    },
    gitBranchResolver: (projectPath) => (projectPath === projectDir ? 'main' : '')
  });

  const output = logs.join('\n');
  assert.equal(code, 0);
  assert.equal(output.includes(projectDir), true);
  assert.equal(output.includes('⌁ main'), true);
  assert.equal(output.includes('codex#1'), true);
  assert.equal(output.includes(`codex#${AIH_SERVER_PROFILE_ID}`), true);
  assert.equal(output.includes('claude#2'), true);
  assert.equal(output.includes('codex task'), true);
  assert.equal(output.includes('server task'), true);
  assert.equal(output.includes('claude task'), true);
  assert.equal(spawnCalls.filter((call) => call.args.includes('list-sessions')).length, 4);
});

test('selectPersistentSessionRow keeps repeated project rows under the same project header', () => {
  const writes = [];
  const keys = ['\x1b[B', '\r'];
  const rows = [
    {
      cliName: 'claude',
      cliAccountId: '2',
      path: '/work/ai_home',
      command: 'aih claude 2 -M',
      description: 'claude task',
      targetSession: 'claude-ai-home',
      live: false
    },
    {
      cliName: 'claude',
      cliAccountId: '2',
      path: '/work/password-gen-ext',
      command: 'aih claude 2 -M',
      description: 'password task',
      targetSession: 'claude-password',
      live: false
    },
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: '/work/ai_home',
      command: 'aih codex 1 -M',
      description: 'codex task',
      targetSession: 'codex-ai-home',
      live: true
    }
  ];

  const selected = selectPersistentSessionRow(rows, {
    fs,
    readKey: () => keys.shift() || '\r',
    processImpl: {
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      }
    }
  });

  const output = writes.join('');
  const plainOutput = stripAnsi(output);
  assert.equal(selected.targetSession, 'codex-ai-home');
  assert.equal(plainOutput.indexOf('/work/ai_home') < plainOutput.indexOf('codex#1'), true);
  assert.equal(plainOutput.indexOf('codex#1') < plainOutput.indexOf('/work/password-gen-ext'), true);
});

test('selectPersistentSessionRow renders project icon and git branch', () => {
  const writes = [];
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: '/work/ai_home',
      gitBranch: 'main',
      command: 'aih codex 1',
      description: 'codex task',
      targetSession: 'codex-ai-home',
      live: true
    }
  ];

  const selected = selectPersistentSessionRow(rows, {
    fs,
    readKey: () => 'q',
    processImpl: {
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      }
    }
  });

  const output = stripAnsi(writes.join(''));
  assert.equal(selected, null);
  assert.equal(output.includes(' /work/ai_home  ⌁ main'), true);
  assert.equal(/\x1b\[38;5;\d+m/.test(writes.join('')), false);
  assert.equal(/\x1b\[38;5;\d+m⌁/.test(writes.join('')), false);
});

test('selectPersistentSessionRow uses plain project symbols on native Windows', () => {
  const writes = [];
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: 'C:\\Users\\model\\projects\\ai_home',
      gitBranch: 'main',
      command: 'aih codex 1',
      description: 'codex task',
      targetSession: 'codex-ai-home',
      live: true
    }
  ];

  const selected = selectPersistentSessionRow(rows, {
    fs,
    readKey: () => 'q',
    processImpl: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\model' },
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      }
    }
  });

  const output = stripAnsi(writes.join(''));
  assert.equal(selected, null);
  assert.equal(output.includes('dir ~/projects/ai_home  git: main'), true);
  assert.equal(output.includes(''), false);
  assert.equal(output.includes('⌁'), false);
  assert.equal(output.includes('⠿'), false);
});

test('shouldUseSyncSessionPicker defaults to sync picker on native Windows', () => {
  assert.equal(shouldUseSyncSessionPicker({}, { platform: 'win32' }), true);
  assert.equal(shouldUseSyncSessionPicker({}, { platform: 'linux' }), false);
  assert.equal(shouldUseSyncSessionPicker({ forceSyncSessionPicker: true }, { platform: 'linux' }), true);
});

test('selectPersistentSessionRow handles split Windows Terminal arrows in sync picker', () => {
  const writes = [];
  const keys = ['\x1b', '[B', '\r'];
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '.aih-server',
      path: 'C:\\Users\\madou',
      command: 'aih codex',
      description: '5555',
      targetSession: 'p-first',
      live: false
    },
    {
      cliName: 'codex',
      cliAccountId: '.aih-server',
      path: 'C:\\Users\\madou',
      command: 'aih codex',
      description: '6666',
      targetSession: 'p-second',
      live: false
    }
  ];

  const selected = selectPersistentSessionRow(rows, {
    fs,
    readKey: () => keys.shift() || '\r',
    processImpl: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\madou' },
      stdout: {
        isTTY: true,
        columns: 100,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      }
    }
  });

  assert.equal(selected.targetSession, 'p-second');
  assert.equal(stripAnsi(writes.join('')).includes('6666'), true);
});

test('selectPersistentSessionRowAsync handles split Windows Terminal arrow keys', async () => {
  const writes = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => { stdin.isRaw = Boolean(enabled); };
  stdin.resume = () => {};
  stdin.isPaused = () => false;
  stdin.pause = () => {};
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: 'C:\\Users\\model',
      command: 'aih codex 1',
      description: 'first',
      targetSession: 'p-first',
      live: true
    },
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: 'C:\\Users\\model\\projects\\ai_home',
      command: 'aih codex 1',
      description: 'second',
      targetSession: 'p-second',
      live: true
    }
  ];

  const selectedPromise = selectPersistentSessionRowAsync(rows, {
    processImpl: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\model' },
      stdout: {
        isTTY: true,
        columns: 100,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin
    },
    refreshIntervalMs: 60000
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\x1b'));
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('[B'));
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\r'));
  const selected = await selectedPromise;

  assert.equal(selected.targetSession, 'p-second');
  assert.equal(stripAnsi(writes.join('')).includes('dir ~/projects/ai_home'), true);
});

test('selectPersistentSessionRowAsync waits for delayed Windows Terminal arrow suffix', async () => {
  const writes = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => { stdin.isRaw = Boolean(enabled); };
  stdin.resume = () => {};
  stdin.isPaused = () => false;
  stdin.pause = () => {};
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '.aih-server',
      path: 'C:\\Users\\madou',
      command: 'aih codex',
      description: '5555',
      targetSession: 'p-first',
      live: false
    },
    {
      cliName: 'codex',
      cliAccountId: '.aih-server',
      path: 'C:\\Users\\madou',
      command: 'aih codex',
      description: '6666',
      targetSession: 'p-second',
      live: false
    }
  ];

  const selectedPromise = selectPersistentSessionRowAsync(rows, {
    processImpl: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\madou' },
      stdout: {
        isTTY: true,
        columns: 100,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin
    },
    refreshIntervalMs: 60000,
    escapeDelayMs: 500
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\x1b'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  stdin.emit('data', Buffer.from('[B'));
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\r'));
  const selected = await selectedPromise;

  assert.equal(selected.targetSession, 'p-second');
  assert.equal(stripAnsi(writes.join('')).includes('6666'), true);
});

test('selectPersistentSessionRowAsync keeps split ESC timer referenced on Windows', async () => {
  const writes = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => { stdin.isRaw = Boolean(enabled); };
  stdin.resume = () => {};
  stdin.isPaused = () => false;
  stdin.pause = () => {};
  const timers = [];
  let unrefCalled = false;
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '.aih-server',
      path: 'C:\\Users\\madou',
      command: 'aih codex',
      description: 'first',
      targetSession: 'p-first',
      live: false
    },
    {
      cliName: 'codex',
      cliAccountId: '.aih-server',
      path: 'C:\\Users\\madou',
      command: 'aih codex',
      description: 'second',
      targetSession: 'p-second',
      live: false
    }
  ];

  const selectedPromise = selectPersistentSessionRowAsync(rows, {
    processImpl: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\madou' },
      stdout: {
        isTTY: true,
        columns: 100,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin
    },
    refreshIntervalMs: 60000,
    setEscapeTimer: (fn, ms) => {
      const timer = {
        fn,
        ms,
        unref: () => { unrefCalled = true; }
      };
      timers.push(timer);
      return timer;
    },
    clearEscapeTimer: (timer) => {
      timer.cleared = true;
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\x1b'));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 500);
  assert.equal(unrefCalled, false);
  stdin.emit('data', Buffer.from('[B'));
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\r'));
  const selected = await selectedPromise;

  assert.equal(selected.targetSession, 'p-second');
  assert.equal(timers[0].cleared, true);
});

test('selectPersistentSessionRowAsync ignores unknown escape bytes instead of exiting', async () => {
  const writes = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => { stdin.isRaw = Boolean(enabled); };
  stdin.resume = () => {};
  stdin.isPaused = () => false;
  stdin.pause = () => {};
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '.aih-server',
      path: 'C:\\Users\\madou',
      command: 'aih codex',
      description: 'first',
      targetSession: 'p-first',
      live: false
    },
    {
      cliName: 'codex',
      cliAccountId: '.aih-server',
      path: 'C:\\Users\\madou',
      command: 'aih codex',
      description: 'second',
      targetSession: 'p-second',
      live: false
    }
  ];

  const selectedPromise = selectPersistentSessionRowAsync(rows, {
    processImpl: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\madou' },
      stdout: {
        isTTY: true,
        columns: 100,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin
    },
    refreshIntervalMs: 60000
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\x1b?'));
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\x1b[B'));
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('\r'));
  const selected = await selectedPromise;

  assert.equal(selected.targetSession, 'p-second');
});

test('selectPersistentSessionRowAsync keeps narrow terminal output on single visual lines', async () => {
  const writes = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => { stdin.isRaw = Boolean(enabled); };
  stdin.resume = () => {};
  stdin.isPaused = () => false;
  stdin.pause = () => {};
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: '/Users/model/projects/feature/ai_home/very-long-mobile-terminal-path',
      command: 'aih codex 1',
      description: '这是一个非常长的移动端会话标题，用来模拟 Termius 窄屏自动换行',
      targetSession: 'p-mobile-narrow',
      live: true
    },
    {
      cliName: 'claude',
      cliAccountId: '10',
      path: '/Users/model/projects/feature/ai_home/very-long-mobile-terminal-path',
      command: 'aih claude 10',
      description: '另一个非常长的会话标题',
      targetSession: 'p-mobile-second',
      live: false
    }
  ];

  const selectedPromise = selectPersistentSessionRowAsync(rows, {
    processImpl: {
      stdout: {
        isTTY: true,
        columns: 32,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin
    },
    refreshIntervalMs: 60000
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', Buffer.from('q'));
  const selected = await selectedPromise;
  const output = writes.join('');
  const lines = stripAnsi(output)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);

  assert.equal(selected, null);
  assert.equal(output.includes('选择要进入的持久会话'), false);
  assert.equal(output.includes('[aih] 会话 Enter/q'), true);
  assert.equal(lines.every((line) => testCellWidth(line) <= 31), true);
});

test('selectPersistentSessionRowAsync animates the selected live marker without repainting header', async () => {
  const writes = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => { stdin.isRaw = Boolean(enabled); };
  stdin.resume = () => {};
  stdin.isPaused = () => false;
  stdin.pause = () => {};
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: '/work/ai_home',
      command: 'aih codex 1',
      description: 'live task',
      targetSession: 'p-live',
      live: true
    }
  ];

  const selectedPromise = selectPersistentSessionRowAsync(rows, {
    processImpl: {
      stdout: {
        isTTY: true,
        columns: 80,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin
    },
    refreshIntervalMs: 60000,
    animationIntervalMs: 120
  });

  await new Promise((resolve) => setTimeout(resolve, 280));
  stdin.emit('data', Buffer.from('q'));
  const selected = await selectedPromise;
  const output = writes.join('');

  assert.equal(selected, null);
  assert.equal((output.match(/\[aih\] 选择/g) || []).length, 1);
  assert.match(output, /[⠙⠹]/);
  assert.match(output, /\x1b\[38;5;(196|202|226|46|51|33|129)m/);
  assert.equal(/\x1b\[[0-9;]*48;5;/.test(output), false);
});

test('selectPersistentSessionRowAsync breathes the selected idle marker without repainting header', async () => {
  const writes = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => { stdin.isRaw = Boolean(enabled); };
  stdin.resume = () => {};
  stdin.isPaused = () => false;
  stdin.pause = () => {};
  const rows = [
    {
      cliName: 'claude',
      cliAccountId: '2',
      path: '/work/ai_home',
      command: 'aih claude 2',
      description: 'idle task',
      targetSession: 'p-idle',
      live: false
    }
  ];

  const selectedPromise = selectPersistentSessionRowAsync(rows, {
    processImpl: {
      stdout: {
        isTTY: true,
        columns: 80,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin
    },
    refreshIntervalMs: 60000,
    animationIntervalMs: 120
  });

  await new Promise((resolve) => setTimeout(resolve, 280));
  stdin.emit('data', Buffer.from('q'));
  const selected = await selectedPromise;
  const output = writes.join('');

  assert.equal(selected, null);
  assert.equal((output.match(/\[aih\] 选择/g) || []).length, 1);
  assert.match(output, /[◉●]/);
  assert.match(output, /\x1b\[38;5;(196|202|226|46|51|33|129)m/);
  assert.equal(/\x1b\[[0-9;]*48;5;/.test(output), false);
});

test('selectPersistentSessionRowAsync disables animation by default on native Windows', async () => {
  const writes = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => { stdin.isRaw = Boolean(enabled); };
  stdin.resume = () => {};
  stdin.isPaused = () => false;
  stdin.pause = () => {};
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '.aih-server',
      path: 'C:\\Users\\madou',
      command: 'aih codex',
      description: 'idle task',
      targetSession: 'p-idle',
      live: false
    }
  ];

  const selectedPromise = selectPersistentSessionRowAsync(rows, {
    processImpl: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\madou' },
      stdout: {
        isTTY: true,
        columns: 80,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin
    },
    refreshIntervalMs: 60000,
    animationIntervalMs: 120
  });

  await new Promise((resolve) => setTimeout(resolve, 280));
  stdin.emit('data', Buffer.from('q'));
  const selected = await selectedPromise;
  const output = stripAnsi(writes.join(''));

  assert.equal(selected, null);
  assert.equal((output.match(/\[aih\] 选择/g) || []).length, 1);
  assert.equal((output.match(/> o codex#\.aih-server/g) || []).length, 1);
});

test('selectPersistentSessionRowAsync skips idle repaint when refreshed rows are unchanged', async () => {
  const writes = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => { stdin.isRaw = Boolean(enabled); };
  stdin.resume = () => {};
  stdin.isPaused = () => false;
  stdin.pause = () => {};
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: '/work/ai_home',
      command: 'aih codex 1',
      description: 'stable task',
      targetSession: 'p-stable',
      live: true
    }
  ];
  let refreshCalls = 0;

  const selectedPromise = selectPersistentSessionRowAsync(rows, {
    processImpl: {
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin
    },
    refreshRows: () => {
      refreshCalls += 1;
      return rows;
    },
    refreshIntervalMs: 300
  });

  await new Promise((resolve) => setTimeout(resolve, 450));
  stdin.emit('data', Buffer.from('q'));
  const selected = await selectedPromise;
  const output = writes.join('');

  assert.equal(selected, null);
  assert.equal(refreshCalls >= 1, true);
  assert.equal((output.match(/\[aih\] 选择/g) || []).length, 1);
});

test('selectPersistentSessionRow closes the selected session and keeps the picker open', () => {
  const writes = [];
  const keys = ['x', 'q'];
  const closed = [];
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: '/work/ai_home',
      command: 'aih codex 1 -M',
      description: 'live task',
      targetSession: 'live-one',
      live: true
    },
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: '/work/other',
      command: 'aih codex 1',
      description: 'idle task',
      targetSession: 'idle-one',
      live: false
    }
  ];

  const selected = selectPersistentSessionRow(rows, {
    fs,
    readKey: () => keys.shift() || 'q',
    refreshRows: () => rows.filter((row) => !closed.includes(row.targetSession)),
    closeSession: (row) => {
      closed.push(row.targetSession);
      return { ok: true };
    },
    processImpl: {
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      }
    }
  });

  assert.equal(selected, null);
  assert.deepEqual(closed, ['live-one']);
  assert.equal(writes.join('').includes('已关闭 codex#1 live-one'), true);
});

test('selectPersistentSessionRow closes all idle sessions with one key', () => {
  const writes = [];
  const keys = ['X', 'q'];
  const closed = [];
  const rows = [
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: '/work/live',
      command: 'aih codex 1 -M',
      description: 'live task',
      targetSession: 'live-one',
      live: true
    },
    {
      cliName: 'codex',
      cliAccountId: '1',
      path: '/work/idle-a',
      command: 'aih codex 1',
      description: 'idle a',
      targetSession: 'idle-one',
      live: false
    },
    {
      cliName: 'claude',
      cliAccountId: '2',
      path: '/work/idle-b',
      command: 'aih claude 2',
      description: 'idle b',
      targetSession: 'idle-two',
      live: false
    }
  ];

  const selected = selectPersistentSessionRow(rows, {
    fs,
    readKey: () => keys.shift() || 'q',
    refreshRows: () => rows.filter((row) => !closed.includes(row.targetSession)),
    closeSession: (row) => {
      closed.push(row.targetSession);
      return { ok: true };
    },
    processImpl: {
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      }
    }
  });

  assert.equal(selected, null);
  assert.deepEqual(closed, ['idle-one', 'idle-two']);
  assert.equal(writes.join('').includes('已关闭 2 个闲置会话'), true);
});

test('listProviderAccountScopes reads DB accounts and adds explicit gateway scope', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-profile-ids-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codex1 = registerTestAccount(root, 'codex', '1');
  const codex3 = registerTestAccount(root, 'codex', '3');
  const gemini2 = registerTestAccount(root, 'gemini', '2');

  assert.deepEqual(listProviderAccountScopes('codex', { fs, aiHomeDir: root }), [
    {
      provider: 'codex',
      accountRef: '',
      cliAccountId: AIH_SERVER_PROFILE_ID,
      gateway: true,
      runtimeScope: 'gateway'
    },
    {
      provider: 'codex',
      accountRef: codex1,
      cliAccountId: '1',
      gateway: false,
      runtimeScope: codex1
    },
    {
      provider: 'codex',
      accountRef: codex3,
      cliAccountId: '3',
      gateway: false,
      runtimeScope: codex3
    }
  ]);
  assert.deepEqual(listProviderAccountScopes('gemini', { fs, aiHomeDir: root }), [{
    provider: 'gemini',
    accountRef: gemini2,
    cliAccountId: '2',
    gateway: false,
    runtimeScope: gemini2
  }]);
});

test('runGlobalPersistentSessionsCommand uses registry targets before scanning every account', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-sessions-registry-fast-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  registerTestAccount(root, 'codex', '2');
  registerTestAccount(root, 'agy', '1');
  registerTestAccount(root, 'gemini', '1');
  persistentSessionRegistry.writeEntry(root, {
    provider: 'codex',
    runtimeScope: 'gateway',
    gateway: true,
    accountRef: '',
    cliAccountId: AIH_SERVER_PROFILE_ID,
    socket: 'aih-codex-gateway',
    session: 'p-fast',
    cwd: 'C:\\Users\\madou',
    forwardArgs: []
  }, { now: 1000 });

  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const listSockets = [];
  const spawnOps = [];
  const logs = [];
  const code = runGlobalPersistentSessionsCommand(['--list'], {
    fs,
    profilesDir,
    aiHomeDir: root,
    hostHomeDir: root,
    providers: ['agy', 'gemini', 'codex'],
    processImpl: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\madou' },
      stdout: { isTTY: true, columns: 120, write: (chunk) => logs.push(String(chunk || '')) },
      stdin: { isTTY: false },
      cwd: () => 'C:\\Users\\madou'
    },
    consoleImpl: {
      log: (msg) => logs.push(`${String(msg)}\n`),
      error: (msg) => logs.push(`error:${msg}\n`)
    },
    resolveCliPath: (name) => (name === 'psmux' ? 'psmux.exe' : ''),
    agentSessionTitleResolver: (_cliName, sessions) => sessions,
    spawnSync: (_command, args) => {
      spawnOps.push(args.find((arg) => /^(?:set-environment|source-file|list-sessions|capture-pane)$/.test(arg)) || '');
      if (args.includes('list-sessions')) {
        const socket = tmuxSocket(args);
        listSockets.push(socket);
        if (socket === 'aih-codex-gateway') {
          return {
            status: 0,
            stdout: [
              'p-fast',
              '0',
              '100',
              'C:\\Users\\madou',
              'fast session',
              'codex',
              'node',
              '123',
              persistentSession.UTF8_RUNTIME_MARKER_VALUE,
              '',
              '0',
              persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE,
              'C:\\Users\\madou'
            ].join(sep)
          };
        }
      }
      return { status: 0, stdout: '' };
    }
  });

  assert.equal(code, 0);
  assert.deepEqual(listSockets, ['aih-codex-gateway']);
  assert.equal(spawnOps.includes('set-environment'), false);
  assert.equal(spawnOps.includes('source-file'), false);
  assert.equal(logs.join('').includes('fast session'), true);
});

test('runGlobalPersistentSessionsCommand skips reboot restore when live sessions are already visible', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-sessions-restore-hot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const codexAccountRef = registerTestAccount(root, 'codex', '1');
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  let restoreCalls = 0;
  const logs = [];

  const code = runGlobalPersistentSessionsCommand(['--list'], {
    fs,
    profilesDir,
    aiHomeDir: root,
    hostHomeDir: root,
    providers: ['codex'],
    processImpl: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\madou' },
      stdout: { isTTY: true, columns: 120, write: (chunk) => logs.push(String(chunk || '')) },
      stdin: { isTTY: false },
      cwd: () => 'C:\\Users\\madou'
    },
    consoleImpl: {
      log: (msg) => logs.push(`${String(msg)}\n`),
      error: (msg) => logs.push(`error:${msg}\n`)
    },
    resolveCliPath: (name) => (name === 'psmux' ? 'psmux.exe' : ''),
    restorePersistentSessions: () => { restoreCalls += 1; },
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions') && tmuxSocket(args) === `aih-codex-${codexAccountRef}`) {
        return {
          status: 0,
          stdout: [
            'p-live',
            '0',
            '100',
            'C:\\Users\\madou',
            'already live',
            'codex',
            'node',
            '123',
            persistentSession.UTF8_RUNTIME_MARKER_VALUE,
            '',
            '0',
            persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE,
            'C:\\Users\\madou'
          ].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  assert.equal(code, 0);
  assert.equal(restoreCalls, 0);
  assert.equal(logs.join('').includes('already live'), true);
});

test('runGlobalPersistentSessionsCommand restores and rescans only after an empty first scan', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-sessions-restore-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const codexAccountRef = registerTestAccount(root, 'codex', '1');
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  let restored = false;
  let listCalls = 0;
  const logs = [];

  const code = runGlobalPersistentSessionsCommand(['--list'], {
    fs,
    profilesDir,
    aiHomeDir: root,
    hostHomeDir: root,
    providers: ['codex'],
    processImpl: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\madou' },
      stdout: { isTTY: true, columns: 120, write: (chunk) => logs.push(String(chunk || '')) },
      stdin: { isTTY: false },
      cwd: () => 'C:\\Users\\madou'
    },
    consoleImpl: {
      log: (msg) => logs.push(`${String(msg)}\n`),
      error: (msg) => logs.push(`error:${msg}\n`)
    },
    resolveCliPath: (name) => (name === 'psmux' ? 'psmux.exe' : ''),
    restorePersistentSessions: () => { restored = true; },
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions') && tmuxSocket(args) === `aih-codex-${codexAccountRef}`) {
        listCalls += 1;
        if (!restored) return { status: 0, stdout: '' };
        return {
          status: 0,
          stdout: [
            'p-restored',
            '0',
            '200',
            'C:\\Users\\madou',
            'restored session',
            'codex',
            'node',
            '123',
            persistentSession.UTF8_RUNTIME_MARKER_VALUE,
            '',
            '0',
            persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE,
            'C:\\Users\\madou'
          ].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  assert.equal(code, 0);
  assert.equal(restored, true);
  assert.equal(listCalls, 2);
  assert.equal(logs.join('').includes('restored session'), true);
});

test('runGlobalPersistentSessionsCommand enters selected global session', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-sessions-enter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const codexAccountRef = registerTestAccount(root, 'codex', '1');
  const claudeAccountRef = registerTestAccount(root, 'claude', '2');
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const env = { LANG: 'C.UTF-8' };
  const writes = [];
  const rawModeCalls = [];
  const runCalls = [];
  const spawnCalls = [];
  const keys = ['\x1b[B', '\r'];

  const result = runGlobalPersistentSessionsCommand([], {
    fs,
    profilesDir,
    aiHomeDir: root,
    hostHomeDir: root,
    providers: ['codex', 'claude'],
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        columns: 100,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: (enabled) => rawModeCalls.push(Boolean(enabled)),
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      },
      cwd: () => '/work/current'
    },
    consoleImpl: {
      log: (msg) => writes.push(`${String(msg)}\n`),
      error: (msg) => writes.push(`error:${msg}\n`)
    },
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    readSessionPickerKey: () => keys.shift() || '\r',
    spawnSync: (_command, args, options) => {
      spawnCalls.push({ args, options });
      if (args.includes('source-file')) return { status: 0, stdout: '' };
      if (tmuxSocket(args) === `aih-codex-${codexAccountRef}`) {
        return {
          status: 0,
          stdout: ['p-codex', '1', '300', '/work/codex', 'codex task', 'codex', 'node'].join(sep)
        };
      }
      if (tmuxSocket(args) === `aih-claude-${claudeAccountRef}`) {
        return {
          status: 0,
          stdout: ['p-claude', '1', '200', '/work/claude', 'claude task', 'claude', 'node'].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    },
    runCliPty: (cliName, accountRef, forwardArgs, isLogin, options) => {
      runCalls.push({
        cliName,
        accountRef,
        cliAccountId: options && options.cliAccountId,
        forwardArgs,
        isLogin,
        target: env[persistentSession.TARGET_ENV],
        mirror: env[persistentSession.MIRROR_ENV]
      });
    }
  });

  assert.deepEqual(result, { entered: true });
  assert.equal(spawnCalls.filter((call) => call.args.includes('source-file')).every((call) => call.args[0] === '-u'), true);
  assert.equal(spawnCalls.filter((call) => call.args.includes('list-sessions')).every((call) => call.args[0] === '-u'), true);
  assert.equal(spawnCalls.filter((call) => call.args.includes('list-sessions')).every((call) => call.options.env.LANG === 'zh_CN.UTF-8'), true);
  assert.equal(spawnCalls.filter((call) => call.args.includes('list-sessions')).every((call) => call.options.env.LC_CTYPE === 'zh_CN.UTF-8'), true);
  assert.equal(spawnCalls.filter((call) => call.args.includes('list-sessions')).every((call) => call.options.env.LC_ALL === 'zh_CN.UTF-8'), true);
  const setEnvCalls = spawnCalls.filter((call) => call.args.includes('set-environment'));
  assert.equal(setEnvCalls.length, 0);
  assert.deepEqual(runCalls, [{
    cliName: 'claude',
    accountRef: claudeAccountRef,
    cliAccountId: '2',
    forwardArgs: [],
    isLogin: false,
    target: 'p-claude',
    mirror: '1'
  }]);
  assert.deepEqual(rawModeCalls, [true, false]);
  assert.equal((writes.join('').match(/\[aih\] 选择/g) || []).length, 1);
});

test('runGlobalPersistentSessionsCommand opens a compatible session for legacy UTF-8 runtime rows', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-sessions-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const codexAccountRef = registerTestAccount(root, 'codex', '1');
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const env = {
    [persistentSession.TARGET_ENV]: 'stale-target',
    [persistentSession.MIRROR_ENV]: '1'
  };
  let cwd = '/work/current';
  const chdirCalls = [];
  const writes = [];
  const runCalls = [];
  const keys = ['\r'];

  const result = runGlobalPersistentSessionsCommand([], {
    fs,
    profilesDir,
    aiHomeDir: root,
    hostHomeDir: root,
    providers: ['codex'],
    processImpl: {
      platform: 'darwin',
      env,
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      },
      cwd: () => cwd,
      chdir: (nextCwd) => {
        chdirCalls.push(nextCwd);
        cwd = nextCwd;
      }
    },
    consoleImpl: {
      log: (msg) => writes.push(`${String(msg)}\n`),
      error: (msg) => writes.push(`error:${msg}\n`)
    },
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    readSessionPickerKey: () => keys.shift() || '\r',
    spawnSync: (_command, args) => {
      if (args.includes('source-file')) return { status: 0, stdout: '' };
      if (args.includes('list-sessions') && tmuxSocket(args) === `aih-codex-${codexAccountRef}`) {
        return {
          status: 0,
          stdout: ['p-legacy', '1', '300', '/work/legacy', 'legacy task', 'codex', 'node', '123', ''].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    },
    runCliPty: (cliName, accountRef, forwardArgs, isLogin, options) => {
      runCalls.push({
        cliName,
        accountRef,
        cliAccountId: options && options.cliAccountId,
        forwardArgs,
        isLogin,
        cwd,
        target: env[persistentSession.TARGET_ENV],
        mirror: env[persistentSession.MIRROR_ENV]
      });
    }
  });

  assert.deepEqual(result, { entered: true });
  assert.deepEqual(chdirCalls, ['/work/legacy', '/work/current']);
  assert.equal(cwd, '/work/current');
  assert.deepEqual(runCalls, [{
    cliName: 'codex',
    accountRef: codexAccountRef,
    cliAccountId: '1',
    forwardArgs: [],
    isLogin: false,
    cwd: '/work/legacy',
    target: undefined,
    mirror: undefined
  }]);
  assert.equal(writes.join('').includes('[旧 tmux UTF-8 运行时]'), true);
});

test('runGlobalPersistentSessionsCommand opens a fresh session for legacy psmux Codex launch runtime rows', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-sessions-psmux-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const codexAccountRef = registerTestAccount(root, 'codex', '1');
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const env = {
    [persistentSession.TARGET_ENV]: 'stale-target',
    [persistentSession.MIRROR_ENV]: '1'
  };
  const cwd = 'C:\\work\\current';
  const writes = [];
  const runCalls = [];
  const keys = ['\r'];

  const result = runGlobalPersistentSessionsCommand([], {
    fs,
    profilesDir,
    aiHomeDir: root,
    hostHomeDir: root,
    providers: ['codex'],
    processImpl: {
      platform: 'win32',
      env,
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      },
      cwd: () => cwd,
      chdir: () => {}
    },
    consoleImpl: {
      log: (msg) => writes.push(`${String(msg)}\n`),
      error: (msg) => writes.push(`error:${msg}\n`)
    },
    resolveCliPath: (name) => (name === 'psmux' ? 'C:\\tools\\psmux.exe' : ''),
    readSessionPickerKey: () => keys.shift() || '\r',
    spawnSync: (_command, args) => {
      if (args.includes('source-file')) return { status: 0, stdout: '' };
      if (args.includes('list-sessions') && tmuxSocket(args) === `aih-codex-${codexAccountRef}`) {
        return {
          status: 0,
          stdout: [
            'p-legacy-psmux',
            '1',
            '300',
            cwd,
            'legacy psmux task',
            'codex',
            'node',
            '123',
            persistentSession.UTF8_RUNTIME_MARKER_VALUE,
            '',
            '0',
            ''
          ].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    },
    runCliPty: (cliName, accountRef, forwardArgs, isLogin, options) => {
      runCalls.push({
        cliName,
        accountRef,
        cliAccountId: options && options.cliAccountId,
        forwardArgs,
        isLogin,
        target: env[persistentSession.TARGET_ENV],
        mirror: env[persistentSession.MIRROR_ENV]
      });
    }
  });

  assert.deepEqual(result, { entered: true });
  assert.deepEqual(runCalls, [{
    cliName: 'codex',
    accountRef: codexAccountRef,
    cliAccountId: '1',
    forwardArgs: [],
    isLogin: false,
    target: undefined,
    mirror: undefined
  }]);
  assert.equal(writes.join('').includes('legacy psmux task'), true);
});

test('runGlobalPersistentSessionsCommand closes idle sessions across providers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-sessions-close-idle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const codexAccountRef = registerTestAccount(root, 'codex', '1');
  const claudeAccountRef = registerTestAccount(root, 'claude', '2');
  const codexSocket = `aih-codex-${codexAccountRef}`;
  const claudeSocket = `aih-claude-${claudeAccountRef}`;
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const killed = new Set();
  const killCalls = [];
  const writes = [];
  const keys = ['X', 'q'];

  const listRows = (socket) => {
    const rowsBySocket = {
      [codexSocket]: [
        ['p-live', '1', '300', '/work/live', 'live task', 'codex', 'node'],
        ['p-idle-codex', '0', '200', '/work/idle-codex', 'idle codex', 'codex', 'node']
      ],
      [claudeSocket]: [
        ['p-idle-claude', '0', '100', '/work/idle-claude', 'idle claude', 'claude', 'node']
      ]
    };
    return (rowsBySocket[socket] || [])
      .filter((parts) => !killed.has(`${socket}:${parts[0]}`))
      .map((parts) => parts.join(sep))
      .join('\n');
  };

  const result = runGlobalPersistentSessionsCommand([], {
    fs,
    profilesDir,
    aiHomeDir: root,
    hostHomeDir: root,
    providers: ['codex', 'claude'],
    processImpl: {
      platform: 'darwin',
      env: {},
      stdout: {
        isTTY: true,
        columns: 120,
        write: (chunk) => writes.push(String(chunk || ''))
      },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
        resume: () => {},
        isPaused: () => true,
        pause: () => {}
      },
      cwd: () => '/work/current'
    },
    consoleImpl: {
      log: (msg) => writes.push(`${String(msg)}\n`),
      error: (msg) => writes.push(`error:${msg}\n`)
    },
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    readSessionPickerKey: () => keys.shift() || 'q',
    spawnSync: (_command, args) => {
      if (args.includes('source-file')) return { status: 0, stdout: '' };
      if (args.includes('kill-session')) {
        const target = args[args.indexOf('-t') + 1];
        killed.add(`${tmuxSocket(args)}:${target}`);
        killCalls.push({ socket: tmuxSocket(args), target });
        return { status: 0 };
      }
      if (args.includes('list-sessions')) {
        return { status: 0, stdout: listRows(tmuxSocket(args)) };
      }
      return { status: 0, stdout: '' };
    }
  });

  assert.equal(result, 0);
  assert.deepEqual(killCalls, [
    { socket: codexSocket, target: 'p-idle-codex' },
    { socket: claudeSocket, target: 'p-idle-claude' }
  ]);
  assert.equal(writes.join('').includes('已关闭 2 个闲置会话'), true);
});

test('runGlobalPersistentSessionsCommand reports empty active sessions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-sessions-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  registerTestAccount(root, 'codex', '1');
  const logs = [];

  const code = runGlobalPersistentSessionsCommand([], {
    fs,
    profilesDir,
    aiHomeDir: root,
    providers: ['codex'],
    processImpl: {
      platform: 'darwin',
      env: {},
      cwd: () => '/work/current'
    },
    consoleImpl: {
      log: (msg) => logs.push(String(msg)),
      error: (msg) => logs.push(`error:${msg}`)
    },
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : ''),
    spawnSync: (_command, args) => {
      if (args.includes('source-file')) return { status: 0, stdout: '' };
      return { status: 0, stdout: '' };
    }
  });

  assert.equal(code, 0);
  assert.equal(logs.some((line) => line.includes('当前没有活跃的持久会话')), true);
});

test('runGlobalPersistentSessionsCommand reports tmux unavailable once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-sessions-unavailable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  registerTestAccount(root, 'codex', '1');
  registerTestAccount(root, 'claude', '2');
  const logs = [];

  const code = runGlobalPersistentSessionsCommand([], {
    fs,
    profilesDir,
    aiHomeDir: root,
    providers: ['codex', 'claude'],
    processImpl: {
      platform: 'darwin',
      env: {},
      cwd: () => '/work/current'
    },
    consoleImpl: {
      log: (msg) => logs.push(String(msg)),
      error: (msg) => logs.push(`error:${msg}`)
    },
    resolveCliPath: () => ''
  });

  assert.equal(code, 0);
  assert.equal(logs.filter((line) => line.includes('Persistent sessions unavailable')).length, 1);
});

test('runGlobalPersistentSessionsCommand validates args', () => {
  const logs = [];
  const code = runGlobalPersistentSessionsCommand(['--json'], {
    consoleImpl: {
      log: (msg) => logs.push(String(msg)),
      error: (msg) => logs.push(`error:${msg}`)
    }
  });

  assert.equal(code, 1);
  assert.equal(logs.some((line) => line.includes('Usage: aih sessions')), true);
});
