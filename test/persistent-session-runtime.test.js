const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const persistentSession = require('../lib/runtime/persistent-session');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { collectPersistentSessionRunKeys } = require('../lib/server/persistent-session-runtime');

function registerTestAccount(aiHomeDir, provider, cliAccountId) {
  return registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `test:persistent-session-runtime:${provider}:${cliAccountId}`
  }).accountRef;
}

test('collectPersistentSessionRunKeys maps attached tmux sessions to known web ui run keys', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-persistent-runtime-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = registerTestAccount(aiHomeDir, 'codex', '1');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
  db.prepare('DELETE FROM account_cli_aliases WHERE account_ref = ?').run(accountRef);
  db.close();

  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const projectPath = '/work/ai_home';
  const tmuxOutput = [
    ['p-ai-home-live', '1', '100', projectPath, 'ai_home', 'node', 'node', '4321'].join(sep),
    ['p-ai-home-idle', '0', '101', projectPath, 'ai_home', 'node', 'node', '4322'].join(sep)
  ].join('\n');

  const keys = collectPersistentSessionRunKeys([{
    id: 'ai_home',
    name: 'ai-home',
    path: projectPath,
    providers: ['codex'],
    sessions: [{
      id: 'session-live',
      title: 'live',
      provider: 'codex',
      projectPath,
      projectDirName: 'ai_home'
    }, {
      id: 'session-idle',
      title: 'idle',
      provider: 'codex',
      projectPath,
      projectDirName: 'ai_home'
    }]
  }], {
    fs,
    aiHomeDir,
    hostHomeDir: '/host',
    platform: 'darwin',
    spawnSync: (_command, args) => {
      if (args.includes('-V')) return { status: 0, stdout: 'tmux 3.4\n' };
      if (args.includes('list-sessions')) return { status: 0, stdout: tmuxOutput };
      return { status: 0, stdout: '' };
    },
    resolveAgentSessionTitles: (_provider, sessions) => sessions.map((session) => ({
      ...session,
      agentSessionId: session.name === 'p-ai-home-live' ? 'session-live' : 'session-idle'
    }))
  });

  assert.deepEqual([...keys], ['codex:session-live:ai_home']);
});

test('collectPersistentSessionRunKeys ignores attached sessions without a known session id', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-persistent-runtime-unmatched-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  registerTestAccount(aiHomeDir, 'codex', '1');

  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const keys = collectPersistentSessionRunKeys([{
    id: 'ai_home',
    path: '/work/ai_home',
    providers: ['codex'],
    sessions: [{
      id: 'session-known',
      provider: 'codex',
      projectDirName: 'ai_home',
      projectPath: '/work/ai_home'
    }]
  }], {
    fs,
    aiHomeDir,
    platform: 'darwin',
    spawnSync: (_command, args) => {
      if (args.includes('-V')) return { status: 0, stdout: 'tmux 3.4\n' };
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: ['p-other', '1', '100', '/work/ai_home', 'ai_home', 'node', 'node', '4321'].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    },
    resolveAgentSessionTitles: (_provider, sessions) => sessions
  });

  assert.deepEqual([...keys], []);
});
