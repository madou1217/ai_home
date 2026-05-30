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

function createWin32LinkFs(seed = {}) {
  const pathImpl = path.win32;
  const dirs = new Set((seed.dirs || []).map((item) => pathImpl.resolve(item).toLowerCase()));
  const files = new Map();
  const links = new Map();
  const calls = {
    symlink: [],
    hardlink: [],
    unlink: []
  };
  let nextIno = 100;

  function key(filePath) {
    return pathImpl.resolve(String(filePath || '')).toLowerCase();
  }

  function parentKey(filePath) {
    return key(pathImpl.dirname(filePath));
  }

  function basename(filePath) {
    return pathImpl.basename(filePath);
  }

  function addDir(dirPath) {
    dirs.add(key(dirPath));
  }

  function addFile(filePath, content = '') {
    files.set(key(filePath), {
      content,
      dev: 1,
      ino: nextIno += 1,
      size: String(content).length,
      mtimeMs: nextIno
    });
  }

  function makeStat(entry) {
    return {
      dev: entry && entry.dev || 1,
      ino: entry && entry.ino || 0,
      size: entry && entry.size || 0,
      mtimeMs: entry && entry.mtimeMs || 0,
      isDirectory: () => Boolean(entry && entry.kind === 'dir'),
      isSymbolicLink: () => Boolean(entry && entry.kind === 'symlink')
    };
  }

  function resolveEntry(filePath, followLinks = true) {
    const normalized = key(filePath);
    if (links.has(normalized)) {
      const link = links.get(normalized);
      if (!followLinks || link.kind !== 'symlink') return link;
      const target = resolveEntry(link.target, true);
      if (
        seed.fileSymlinkToDirectoryStatsAsFile
        && link.isDir === false
        && target
        && target.kind === 'dir'
      ) {
        return {
          kind: 'file',
          content: '',
          dev: 1,
          ino: nextIno += 1,
          size: 0,
          mtimeMs: nextIno
        };
      }
      return target;
    }
    if (files.has(normalized)) return { kind: 'file', ...files.get(normalized) };
    if (dirs.has(normalized)) return { kind: 'dir', dev: 1, ino: 0 };
    return null;
  }

  function childNames(dirPath) {
    const normalizedParent = key(dirPath);
    const names = new Set();
    [...dirs].forEach((item) => {
      if (item !== normalizedParent && parentKey(item) === normalizedParent) names.add(basename(item));
    });
    [...files.keys()].forEach((item) => {
      if (parentKey(item) === normalizedParent) names.add(basename(item));
    });
    [...links.keys()].forEach((item) => {
      if (parentKey(item) === normalizedParent) names.add(basename(item));
    });
    return Array.from(names);
  }

  (seed.files || []).forEach((item) => addFile(item.path, item.content || ''));
  (seed.links || []).forEach((item) => {
    links.set(key(item.path), {
      kind: 'symlink',
      target: item.target,
      isDir: Boolean(item.isDir),
      dev: 1,
      ino: 0
    });
  });

  return {
    calls,
    fs: {
      existsSync(filePath) {
        return Boolean(resolveEntry(filePath, true));
      },
      realpathSync(filePath) {
        return pathImpl.resolve(filePath);
      },
      readdirSync(dirPath, options = {}) {
        const names = childNames(dirPath);
        if (!options || !options.withFileTypes) return names;
        return names.map((name) => {
          const fullPath = pathImpl.join(dirPath, name);
          return {
            name,
            isDirectory: () => {
              const entry = resolveEntry(fullPath, true);
              return Boolean(entry && entry.kind === 'dir');
            }
          };
        });
      },
      lstatSync(filePath) {
        const entry = resolveEntry(filePath, false);
        if (!entry) throw new Error('ENOENT');
        return makeStat(entry);
      },
      statSync(filePath) {
        const entry = resolveEntry(filePath, true);
        if (!entry) throw new Error('ENOENT');
        return makeStat(entry);
      },
      readlinkSync(filePath) {
        const entry = links.get(key(filePath));
        if (!entry || entry.kind !== 'symlink') throw new Error('EINVAL');
        return entry.target;
      },
      symlinkSync(targetPath, linkPath, type) {
        calls.symlink.push({ targetPath, linkPath, type });
        if (seed.failFileSymlink && type === 'file') throw new Error('EPERM');
        links.set(key(linkPath), {
          kind: 'symlink',
          target: targetPath,
          isDir: type === 'junction' || type === 'dir',
          dev: 1,
          ino: 0
        });
      },
      linkSync(targetPath, linkPath) {
        calls.hardlink.push({ targetPath, linkPath });
        const target = resolveEntry(targetPath, true);
        if (!target || target.kind !== 'file') throw new Error('ENOENT');
        files.set(key(linkPath), {
          content: target.content || '',
          dev: target.dev,
          ino: target.ino,
          size: target.size,
          mtimeMs: target.mtimeMs
        });
      },
      unlinkSync(filePath) {
        calls.unlink.push(filePath);
        links.delete(key(filePath));
        files.delete(key(filePath));
      },
      mkdirSync(dirPath) {
        addDir(dirPath);
      },
      readFileSync(filePath) {
        const entry = resolveEntry(filePath, true);
        return entry && entry.content || '';
      },
      writeFileSync(filePath, content) {
        addFile(filePath, content);
      }
    }
  };
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
  fs.writeFileSync(path.join(hostCodexDir, 'state_5.sqlite'), 'state-db\n');
  fs.writeFileSync(path.join(hostCodexDir, 'goals_1.sqlite'), 'goals-db\n');
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
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'state_5.sqlite')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'goals_1.sqlite')).isSymbolicLink(), true);
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

test('ensureSessionStoreLinks merges codex desktop runtime sessions into host store', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  const accountConfigDir = path.join(profilesDir, 'codex', '1', '.codex');
  const runtimeHome = path.join(root, '.ai_home', 'codex-desktop-runtime', 'app-server-1');
  const runtimeSessionDir = path.join(runtimeHome, 'sessions', '2026', '05', '21');
  const hostSessionDir = path.join(hostCodexDir, 'sessions', '2026', '05', '21');
  const runtimeSessionId = '33333333-3333-4333-8333-333333333333';
  fs.mkdirSync(accountConfigDir, { recursive: true });
  fs.mkdirSync(runtimeSessionDir, { recursive: true });
  fs.mkdirSync(hostSessionDir, { recursive: true });
  fs.writeFileSync(path.join(accountConfigDir, 'auth.json'), '{"token":"account-secret"}\n');
  fs.writeFileSync(path.join(runtimeHome, 'config.toml'), 'model = "gpt-5.5"\n');
  fs.writeFileSync(path.join(runtimeHome, 'auth.json'), '{"token":"runtime-secret"}\n');
  fs.writeFileSync(
    path.join(runtimeSessionDir, `rollout-2026-05-21T13-48-30-${runtimeSessionId}.jsonl`),
    '{"type":"event_msg","payload":{"type":"user_message","message":"runtime"}}\n'
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

  assert.equal(
    fs.existsSync(path.join(hostSessionDir, `rollout-2026-05-21T13-48-30-${runtimeSessionId}.jsonl`)),
    true
  );
  assert.equal(fs.lstatSync(path.join(runtimeHome, 'sessions')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'sessions')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(runtimeHome, 'config.toml')).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(runtimeHome, 'auth.json')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(hostCodexDir, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(hostCodexDir, 'config.toml')), false);
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

test('ensureSessionStoreLinks uses win32 junctions and hardlinks when file symlink is unavailable', () => {
  const pathImpl = path.win32;
  const hostHomeDir = 'C:\\Users\\dev';
  const profilesDir = pathImpl.join(hostHomeDir, '.ai_home', 'profiles');
  const hostCodexDir = pathImpl.join(hostHomeDir, '.codex');
  const accountRoot = pathImpl.join(profilesDir, 'codex', '1');
  const accountCodexDir = pathImpl.join(accountRoot, '.codex');
  const hostSessionsDir = pathImpl.join(hostCodexDir, 'sessions');
  const hostSessionIndexPath = pathImpl.join(hostCodexDir, 'session_index.jsonl');
  const accountSessionIndexPath = pathImpl.join(accountCodexDir, 'session_index.jsonl');

  const fake = createWin32LinkFs({
    failFileSymlink: true,
    dirs: [
      hostHomeDir,
      profilesDir,
      pathImpl.join(profilesDir, 'codex'),
      accountRoot,
      accountCodexDir,
      hostCodexDir,
      hostSessionsDir
    ],
    files: [
      {
        path: hostSessionIndexPath,
        content: '{"id":"thread-1"}\n'
      }
    ]
  });

  const service = createSessionStoreService({
    fs: fake.fs,
    fse: {
      removeSync() { throw new Error('unexpected remove'); },
      moveSync() { throw new Error('unexpected move'); },
      copySync() { throw new Error('unexpected copy'); }
    },
    path: pathImpl,
    processObj: { platform: 'win32' },
    profilesDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => pathImpl.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fake.fs.mkdirSync(dir, { recursive: true })
  });

  const first = service.ensureSessionStoreLinks('codex', '1');
  const second = service.ensureSessionStoreLinks('codex', '1');

  assert.equal(first.linked >= 2, true);
  assert.equal(second.linked >= 2, true);
  assert.deepEqual(fake.calls.symlink.filter((call) => call.type === 'junction'), [{
    targetPath: hostSessionsDir,
    linkPath: pathImpl.join(accountCodexDir, 'sessions'),
    type: 'junction'
  }]);
  assert.deepEqual(fake.calls.hardlink, [{
    targetPath: hostSessionIndexPath,
    linkPath: accountSessionIndexPath
  }]);
  assert.equal(fake.calls.symlink.some((call) => call.type === 'file'), true);
  assert.deepEqual(fake.calls.unlink, []);
});

test('ensureSessionStoreLinks compares win32 symlink targets case-insensitively', () => {
  const pathImpl = path.win32;
  const hostHomeDir = 'C:\\Users\\dev';
  const profilesDir = pathImpl.join(hostHomeDir, '.ai_home', 'profiles');
  const hostCodexDir = pathImpl.join(hostHomeDir, '.codex');
  const accountRoot = pathImpl.join(profilesDir, 'codex', '2');
  const accountCodexDir = pathImpl.join(accountRoot, '.codex');
  const hostSessionsDir = pathImpl.join(hostCodexDir, 'Sessions');
  const accountSessionsDir = pathImpl.join(accountCodexDir, 'sessions');

  const fake = createWin32LinkFs({
    dirs: [
      hostHomeDir,
      profilesDir,
      pathImpl.join(profilesDir, 'codex'),
      accountRoot,
      accountCodexDir,
      hostCodexDir,
      hostSessionsDir
    ],
    links: [
      {
        path: accountSessionsDir,
        target: hostSessionsDir.toLowerCase(),
        isDir: true
      }
    ]
  });

  const service = createSessionStoreService({
    fs: fake.fs,
    fse: {
      removeSync() { throw new Error('unexpected remove'); },
      moveSync() { throw new Error('unexpected move'); },
      copySync() { throw new Error('unexpected copy'); }
    },
    path: pathImpl,
    processObj: { platform: 'win32' },
    profilesDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, id) => pathImpl.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fake.fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('codex', '2');

  assert.equal(result.linked >= 1, true);
  assert.deepEqual(fake.calls.symlink, []);
  assert.deepEqual(fake.calls.hardlink, []);
  assert.deepEqual(fake.calls.unlink, []);
});

test('ensureSessionStoreLinks uses win32 directory links when the host target is a symlinked directory', () => {
  const pathImpl = path.win32;
  const hostHomeDir = 'C:\\Users\\dev';
  const profilesDir = pathImpl.join(hostHomeDir, '.ai_home', 'profiles');
  const hostGeminiDir = pathImpl.join(hostHomeDir, '.gemini');
  const hostTmpDir = pathImpl.join(hostGeminiDir, 'tmp-real');
  const accountRoot = pathImpl.join(profilesDir, 'gemini', '1');
  const accountGeminiDir = pathImpl.join(accountRoot, '.gemini');
  const accountTmpDir = pathImpl.join(accountGeminiDir, 'tmp');

  const fake = createWin32LinkFs({
    dirs: [
      hostHomeDir,
      profilesDir,
      pathImpl.join(profilesDir, 'gemini'),
      accountRoot,
      accountGeminiDir,
      hostGeminiDir,
      hostTmpDir
    ],
    links: [
      {
        path: pathImpl.join(hostGeminiDir, 'tmp'),
        target: hostTmpDir,
        isDir: true
      }
    ]
  });

  const service = createSessionStoreService({
    fs: fake.fs,
    fse: {
      removeSync() { throw new Error('unexpected remove'); },
      moveSync() { throw new Error('unexpected move'); },
      copySync() { throw new Error('unexpected copy'); }
    },
    path: pathImpl,
    processObj: { platform: 'win32' },
    profilesDir,
    hostHomeDir,
    cliConfigs: { gemini: { globalDir: '.gemini' } },
    getProfileDir: (cliName, id) => pathImpl.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fake.fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('gemini', '1');

  assert.equal(result.linked >= 1, true);
  assert.deepEqual(fake.calls.symlink, [
    {
      targetPath: pathImpl.join(hostGeminiDir, 'tmp'),
      linkPath: accountTmpDir,
      type: 'junction'
    },
    {
      targetPath: pathImpl.join(hostGeminiDir, 'tmp-real'),
      linkPath: pathImpl.join(accountGeminiDir, 'tmp-real'),
      type: 'junction'
    }
  ]);
  assert.deepEqual(fake.calls.hardlink, []);
  assert.deepEqual(fake.calls.unlink, []);
});

test('ensureSessionStoreLinks repairs win32 directory links that were created as file links', () => {
  const pathImpl = path.win32;
  const hostHomeDir = 'C:\\Users\\dev';
  const profilesDir = pathImpl.join(hostHomeDir, '.ai_home', 'profiles');
  const hostGeminiDir = pathImpl.join(hostHomeDir, '.gemini');
  const hostTmpDir = pathImpl.join(hostGeminiDir, 'tmp-real');
  const accountRoot = pathImpl.join(profilesDir, 'gemini', '1');
  const accountGeminiDir = pathImpl.join(accountRoot, '.gemini');
  const accountTmpDir = pathImpl.join(accountGeminiDir, 'tmp');

  const fake = createWin32LinkFs({
    fileSymlinkToDirectoryStatsAsFile: true,
    dirs: [
      hostHomeDir,
      profilesDir,
      pathImpl.join(profilesDir, 'gemini'),
      accountRoot,
      accountGeminiDir,
      hostGeminiDir,
      hostTmpDir
    ],
    links: [
      {
        path: pathImpl.join(hostGeminiDir, 'tmp'),
        target: hostTmpDir,
        isDir: true
      },
      {
        path: accountTmpDir,
        target: pathImpl.join(hostGeminiDir, 'tmp'),
        isDir: false
      }
    ]
  });

  const service = createSessionStoreService({
    fs: fake.fs,
    fse: {
      removeSync() { throw new Error('unexpected remove'); },
      moveSync() { throw new Error('unexpected move'); },
      copySync() { throw new Error('unexpected copy'); }
    },
    path: pathImpl,
    processObj: { platform: 'win32' },
    profilesDir,
    hostHomeDir,
    cliConfigs: { gemini: { globalDir: '.gemini' } },
    getProfileDir: (cliName, id) => pathImpl.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fake.fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('gemini', '1');

  assert.equal(result.linked >= 1, true);
  assert.deepEqual(fake.calls.unlink, [accountTmpDir]);
  assert.deepEqual(fake.calls.symlink, [
    {
      targetPath: pathImpl.join(hostGeminiDir, 'tmp'),
      linkPath: accountTmpDir,
      type: 'junction'
    },
    {
      targetPath: pathImpl.join(hostGeminiDir, 'tmp-real'),
      linkPath: pathImpl.join(accountGeminiDir, 'tmp-real'),
      type: 'junction'
    }
  ]);
  assert.deepEqual(fake.calls.hardlink, []);
});

test('ensureSessionStoreLinks shares settings.json and links folders while keeping credentials isolated for claude, gemini, and agy', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  
  const hostClaudeDir = path.join(hostHomeDir, '.claude');
  const hostGeminiDir = path.join(hostHomeDir, '.gemini');
  const hostGeminiConfigDir = path.join(hostGeminiDir, 'config');
  
  fs.mkdirSync(hostHomeDir, { recursive: true });
  fs.mkdirSync(hostClaudeDir, { recursive: true });
  fs.mkdirSync(hostGeminiDir, { recursive: true });
  fs.mkdirSync(hostGeminiConfigDir, { recursive: true });
  
  fs.writeFileSync(path.join(hostClaudeDir, 'settings.json'), '{"global":true}');
  fs.writeFileSync(path.join(hostGeminiDir, 'settings.json'), '{"global":true}');
  fs.writeFileSync(path.join(hostGeminiConfigDir, 'mcp_config.json'), '{"global":true}');
  
  const claudeProfileDir = path.join(profilesDir, 'claude', '1');
  const geminiProfileDir = path.join(profilesDir, 'gemini', '1');
  const agyProfileDir = path.join(profilesDir, 'agy', '1');
  
  const guestClaudeDir = path.join(claudeProfileDir, '.claude');
  const guestGeminiDir = path.join(geminiProfileDir, '.gemini');
  
  const guestAgyParentDir = path.join(agyProfileDir, '.gemini');
  const guestAgyConfigDir = path.join(guestAgyParentDir, 'config');
  const guestAgyDir = path.join(guestAgyParentDir, 'antigravity-cli');
  
  fs.mkdirSync(guestClaudeDir, { recursive: true });
  fs.mkdirSync(guestGeminiDir, { recursive: true });
  fs.mkdirSync(guestAgyDir, { recursive: true });
  fs.mkdirSync(guestAgyConfigDir, { recursive: true });
  
  fs.writeFileSync(path.join(guestClaudeDir, 'settings.json'), '{"local":true}');
  fs.writeFileSync(path.join(guestClaudeDir, '.credentials.json'), '{"token":1}');
  
  fs.writeFileSync(path.join(guestGeminiDir, 'settings.json'), '{"local":true}');
  fs.writeFileSync(path.join(guestGeminiDir, 'google_accounts.json'), '{"active":1}');
  fs.writeFileSync(path.join(guestGeminiDir, 'oauth_creds.json'), '{"token":2}');
  
  fs.mkdirSync(path.join(guestAgyDir, 'log'), { recursive: true });
  fs.writeFileSync(path.join(guestAgyDir, 'log', 'client.log'), 'authenticated');
  fs.writeFileSync(path.join(guestAgyDir, 'settings.json'), '{"agy":true}');
  fs.writeFileSync(path.join(guestAgyDir, 'antigravity-oauth-token'), 'oauth_token_secret');
  fs.writeFileSync(path.join(guestAgyDir, 'cli.log'), 'cli_logs');
  fs.writeFileSync(path.join(guestAgyConfigDir, 'mcp_config.json'), '{"local":true}');
  
  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    profilesDir,
    hostHomeDir,
    cliConfigs: {
      claude: { globalDir: '.claude' },
      gemini: { globalDir: '.gemini' },
      agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' }
    },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const claudeRes = service.ensureSessionStoreLinks('claude', '1');
  assert.ok(claudeRes.linked >= 1);
  
  assert.ok(fs.lstatSync(path.join(guestClaudeDir, 'settings.json')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(guestClaudeDir, '.credentials.json')).isSymbolicLink());

  const geminiRes = service.ensureSessionStoreLinks('gemini', '1');
  assert.ok(geminiRes.linked >= 1);
  
  assert.ok(fs.lstatSync(path.join(guestGeminiDir, 'settings.json')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(guestGeminiDir, 'google_accounts.json')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(guestGeminiDir, 'oauth_creds.json')).isSymbolicLink());

  const agyRes = service.ensureSessionStoreLinks('agy', '1');
  assert.ok(agyRes.linked >= 1);
  
  assert.ok(fs.lstatSync(path.join(guestAgyDir, 'settings.json')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(guestAgyDir, 'log')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(guestAgyDir, 'antigravity-oauth-token')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(guestAgyDir, 'cli.log')).isSymbolicLink());
  
  // Verify that the parent .gemini/config directory is also shared (symlinked)
  assert.ok(fs.lstatSync(guestAgyConfigDir).isSymbolicLink());
});

test('ensureSessionStoreLinks symlinks macOS keychain and preference folders to allow normal keychain access when HOME is sandboxed', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  
  const hostKeychainsDir = path.join(hostHomeDir, 'Library', 'Keychains');
  const hostPreferencesDir = path.join(hostHomeDir, 'Library', 'Preferences');
  fs.mkdirSync(hostKeychainsDir, { recursive: true });
  fs.mkdirSync(hostPreferencesDir, { recursive: true });
  fs.writeFileSync(path.join(hostKeychainsDir, 'login.keychain-db'), 'keychain content');
  fs.writeFileSync(path.join(hostPreferencesDir, 'com.apple.security.plist'), 'preferences content');
  
  const agyProfileDir = path.join(profilesDir, 'agy', '1');
  const guestAgyDir = path.join(agyProfileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(guestAgyDir, { recursive: true });
  
  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: { platform: 'darwin' },
    profilesDir,
    hostHomeDir,
    cliConfigs: {
      agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' }
    },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('agy', '1');
  assert.ok(result);

  const guestKeychainsDir = path.join(agyProfileDir, 'Library', 'Keychains');
  assert.ok(fs.existsSync(guestKeychainsDir));
  assert.ok(fs.lstatSync(guestKeychainsDir).isSymbolicLink());
  assert.equal(
    fs.realpathSync(guestKeychainsDir),
    fs.realpathSync(hostKeychainsDir)
  );

  const guestPreferencesDir = path.join(agyProfileDir, 'Library', 'Preferences');
  assert.ok(fs.existsSync(guestPreferencesDir));
  assert.ok(fs.lstatSync(guestPreferencesDir).isSymbolicLink());
  assert.equal(
    fs.realpathSync(guestPreferencesDir),
    fs.realpathSync(hostPreferencesDir)
  );
});
