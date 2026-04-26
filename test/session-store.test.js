const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { createSessionStoreService } = require('../lib/cli/services/session-store');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-store-'));
}

test('ensureSessionStoreLinks keeps codex config isolated while dropping shared session dirs', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountConfigDir = path.join(profilesDir, 'codex', '1', '.codex');
  fs.mkdirSync(accountConfigDir, { recursive: true });
  fs.writeFileSync(path.join(accountConfigDir, 'auth.json'), '{"token":"secret"}\n');
  fs.writeFileSync(path.join(accountConfigDir, 'config.toml'), 'model = "gpt-5"\n');
  fs.mkdirSync(path.join(accountConfigDir, 'memories'), { recursive: true });
  fs.writeFileSync(path.join(accountConfigDir, 'memories', 'note.md'), 'remember me\n');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    profilesDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('codex', '1');
  assert.equal(fs.existsSync(path.join(hostHomeDir, '.codex', 'config.toml')), false);
  assert.equal(fs.existsSync(path.join(hostHomeDir, '.codex', 'memories')), true);
  assert.equal(fs.existsSync(path.join(accountConfigDir, 'config.toml')), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'memories')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'auth.json')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(accountConfigDir, 'auth.json'), 'utf8'), '{"token":"secret"}\n');
});

test('ensureSessionStoreLinks links additional codex host state directories when present', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountConfigDir = path.join(profilesDir, 'codex', '2', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(accountConfigDir, { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, 'sqlite'), { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, 'worktrees'), { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(hostCodexDir, 'sqlite', 'state.db'), 'sqlite\n');
  fs.writeFileSync(path.join(hostCodexDir, 'prompts', 'saved.md'), 'prompt\n');
  fs.writeFileSync(path.join(hostCodexDir, 'worktrees', 'meta.json'), '{}\n');
  fs.writeFileSync(path.join(hostCodexDir, '.tmp', 'runtime.tmp'), 'tmp\n');
  fs.writeFileSync(path.join(hostCodexDir, 'cache', 'entry.json'), '{}\n');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    profilesDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('codex', '2');
  assert.equal(result.linked >= 5, true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'sqlite')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'prompts')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'worktrees')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, '.tmp')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'cache')).isSymbolicLink(), true);
});

test('ensureSessionStoreLinks migrates sandbox codex tmp and cache into host store before linking', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountConfigDir = path.join(profilesDir, 'codex', '3', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(path.join(accountConfigDir, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(accountConfigDir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(accountConfigDir, '.tmp', 'runtime.tmp'), 'tmp-data\n');
  fs.writeFileSync(path.join(accountConfigDir, 'cache', 'entry.json'), '{"ok":true}\n');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    profilesDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('codex', '3');
  assert.equal(fs.readFileSync(path.join(hostCodexDir, '.tmp', 'runtime.tmp'), 'utf8'), 'tmp-data\n');
  assert.equal(fs.readFileSync(path.join(hostCodexDir, 'cache', 'entry.json'), 'utf8'), '{"ok":true}\n');
  assert.equal(fs.lstatSync(path.join(accountConfigDir, '.tmp')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'cache')).isSymbolicLink(), true);
});

test('ensureSessionStoreLinks shares all non-sensitive codex host entries except config and auth', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const accountConfigDir = path.join(profilesDir, 'codex', '9', '.codex');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  fs.mkdirSync(accountConfigDir, { recursive: true });
  fs.mkdirSync(path.join(hostCodexDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(hostCodexDir, 'hooks', 'aih-stop-notify.js'), 'console.log("hook");\n');
  fs.writeFileSync(path.join(hostCodexDir, 'hooks.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(hostCodexDir, 'custom-state.json'), '{"ok":true}\n');
  fs.writeFileSync(path.join(hostCodexDir, 'config.toml'), 'model = "host"\n');
  fs.writeFileSync(path.join(hostCodexDir, 'auth.json'), '{"token":"host-secret"}\n');
  fs.writeFileSync(path.join(accountConfigDir, 'config.toml'), 'model = "account"\n');
  fs.writeFileSync(path.join(accountConfigDir, 'auth.json'), '{"token":"account-secret"}\n');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    profilesDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('codex', '9');

  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'hooks')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'hooks.json')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'custom-state.json')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'config.toml')).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'auth.json')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(accountConfigDir, 'config.toml'), 'utf8'), 'model = "account"\n');
  assert.equal(fs.readFileSync(path.join(accountConfigDir, 'auth.json'), 'utf8'), '{"token":"account-secret"}\n');
});

test('ensureSessionStoreLinks merges historical codex global state into host before linking', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  const accountConfigDir = path.join(profilesDir, 'codex', '10', '.codex');
  fs.mkdirSync(hostCodexDir, { recursive: true });
  fs.mkdirSync(accountConfigDir, { recursive: true });
  fs.writeFileSync(path.join(accountConfigDir, 'auth.json'), '{"token":"account-secret"}\n');
  fs.writeFileSync(
    path.join(hostCodexDir, '.codex-global-state.json'),
    JSON.stringify({
      'electron-saved-workspace-roots': ['/workspace/a'],
      'thread-workspace-root-hints': {
        threadA: '/workspace/a'
      }
    }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(accountConfigDir, '.codex-global-state.json'),
    JSON.stringify({
      'active-workspace-roots': ['/workspace/b'],
      'project-order': ['/workspace/c'],
      'thread-workspace-root-hints': {
        threadB: '/workspace/b'
      }
    }, null, 2) + '\n'
  );

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    profilesDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('codex', '10');

  const merged = JSON.parse(fs.readFileSync(path.join(hostCodexDir, '.codex-global-state.json'), 'utf8'));
  assert.deepEqual(merged['electron-saved-workspace-roots'], ['/workspace/a']);
  assert.deepEqual(merged['active-workspace-roots'], ['/workspace/b']);
  assert.deepEqual(merged['project-order'], ['/workspace/c']);
  assert.deepEqual(merged['thread-workspace-root-hints'], {
    threadA: '/workspace/a',
    threadB: '/workspace/b'
  });
  assert.equal(fs.lstatSync(path.join(accountConfigDir, '.codex-global-state.json')).isSymbolicLink(), true);
});

test('ensureSessionStoreLinks merges historical codex sessions and session index into host store', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  const accountConfigDir = path.join(profilesDir, 'codex', '11', '.codex');
  const hostSessionDir = path.join(hostCodexDir, 'sessions', '2026', '04', '22');
  const accountSessionDir = path.join(accountConfigDir, 'sessions', '2026', '04', '22');
  const hostSessionId = '11111111-1111-4111-8111-111111111111';
  const accountSessionId = '22222222-2222-4222-8222-222222222222';
  fs.mkdirSync(hostSessionDir, { recursive: true });
  fs.mkdirSync(accountSessionDir, { recursive: true });
  fs.writeFileSync(path.join(accountConfigDir, 'auth.json'), '{"token":"account-secret"}\n');
  fs.writeFileSync(
    path.join(hostSessionDir, `rollout-2026-04-22T10-00-00-${hostSessionId}.jsonl`),
    '{"type":"event_msg","payload":{"type":"user_message","message":"host"}}\n'
  );
  fs.writeFileSync(
    path.join(accountSessionDir, `rollout-2026-04-22T11-00-00-${accountSessionId}.jsonl`),
    '{"type":"event_msg","payload":{"type":"user_message","message":"account"}}\n'
  );
  fs.writeFileSync(
    path.join(hostCodexDir, 'session_index.jsonl'),
    JSON.stringify({ id: hostSessionId, thread_name: 'host', updated_at: '2026-04-22T10:00:00.000Z' }) + '\n'
  );
  fs.writeFileSync(
    path.join(accountConfigDir, 'session_index.jsonl'),
    JSON.stringify({ id: accountSessionId, thread_name: 'account', updated_at: '2026-04-22T11:00:00.000Z' }) + '\n'
  );

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    profilesDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('codex', '11');

  assert.equal(fs.existsSync(path.join(hostSessionDir, `rollout-2026-04-22T10-00-00-${hostSessionId}.jsonl`)), true);
  assert.equal(fs.existsSync(path.join(hostSessionDir, `rollout-2026-04-22T11-00-00-${accountSessionId}.jsonl`)), true);
  const indexLines = fs.readFileSync(path.join(hostCodexDir, 'session_index.jsonl'), 'utf8').trim().split('\n');
  assert.equal(indexLines.length, 2);
  assert.equal(indexLines.some((line) => line.includes(hostSessionId)), true);
  assert.equal(indexLines.some((line) => line.includes(accountSessionId)), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'sessions')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'session_index.jsonl')).isSymbolicLink(), true);
});

test('ensureSessionStoreLinks auto-aligns all codex accounts on first run', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  const account1Dir = path.join(profilesDir, 'codex', '1', '.codex');
  const account2Dir = path.join(profilesDir, 'codex', '2', '.codex');
  fs.mkdirSync(hostCodexDir, { recursive: true });
  fs.mkdirSync(account1Dir, { recursive: true });
  fs.mkdirSync(account2Dir, { recursive: true });
  fs.writeFileSync(path.join(account1Dir, 'auth.json'), '{"token":"a1"}\n');
  fs.writeFileSync(path.join(account2Dir, 'auth.json'), '{"token":"a2"}\n');
  fs.writeFileSync(
    path.join(account1Dir, '.codex-global-state.json'),
    JSON.stringify({ 'active-workspace-roots': ['/workspace/a'] }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(account2Dir, '.codex-global-state.json'),
    JSON.stringify({ 'active-workspace-roots': ['/workspace/b'] }, null, 2) + '\n'
  );

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    profilesDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('codex', '1');

  const merged = JSON.parse(fs.readFileSync(path.join(hostCodexDir, '.codex-global-state.json'), 'utf8'));
  assert.deepEqual(merged['active-workspace-roots'], ['/workspace/a', '/workspace/b']);
  assert.equal(fs.lstatSync(path.join(account2Dir, '.codex-global-state.json')).isSymbolicLink(), true);
});
