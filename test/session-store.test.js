const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const {
  collectSharedToolEntryNames,
  createSessionStoreService
} = require('../lib/cli/services/session-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const {
  resolveAccountRuntimeDir,
  resolveCodexDesktopRuntimeDir
} = require('../lib/runtime/aih-storage-layout');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-store-'));
}

function encodedWindowsCodexHomeEntry() {
  const colon = String.fromCharCode(0xf03a);
  const backslash = String.fromCharCode(0xf05c);
  return `C${colon}${backslash}Users${backslash}madou${backslash}.codex`;
}

test('collectSharedToolEntryNames ignores encoded Windows absolute path entries', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const codexDir = path.join(root, '.codex');
  fs.mkdirSync(path.join(codexDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(codexDir, encodedWindowsCodexHomeEntry()), { recursive: true });

  const entries = collectSharedToolEntryNames(fs, 'codex', [codexDir]);

  assert.equal(entries.includes('sessions'), true);
  assert.equal(entries.includes(encodedWindowsCodexHomeEntry()), false);
});

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
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return makeStat(entry);
      },
      statSync(filePath) {
        const entry = resolveEntry(filePath, true);
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
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

test('ensureSessionStoreLinks shares every non-private codex entry using exact artifact names', (t) => {
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
  fs.writeFileSync(path.join(hostCodexDir, 'oauth-analysis.md'), 'not a credential\n');
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
  assert.equal(fs.lstatSync(path.join(accountConfigDir, 'oauth-analysis.md')).isSymbolicLink(), true);
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
  const aiHomeDir = path.join(root, '.ai_home');
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: `test:codex:${root}:1`
  });
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  const accountConfigDir = path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef), '.codex');
  const runtimeHome = resolveCodexDesktopRuntimeDir(aiHomeDir, accountRef);
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
    aiHomeDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, ref) => resolveAccountRuntimeDir(aiHomeDir, cliName, ref),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('codex', accountRef);

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

test('ensureSessionStoreLinks touches only the explicitly launched codex account', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const aiHomeDir = path.join(root, '.ai_home');
  const accountRef1 = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: `test:codex:${root}:1`
  });
  const accountRef2 = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '2',
    identitySeed: `test:codex:${root}:2`
  });
  const hostCodexDir = path.join(hostHomeDir, '.codex');
  const account1Dir = path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef1), '.codex');
  const account2Dir = path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef2), '.codex');
  const desktopRuntime1 = resolveCodexDesktopRuntimeDir(aiHomeDir, accountRef1);
  const desktopRuntime2 = resolveCodexDesktopRuntimeDir(aiHomeDir, accountRef2);
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
  fs.mkdirSync(path.join(desktopRuntime1, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(desktopRuntime2, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(desktopRuntime1, 'sessions', 'one.jsonl'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(desktopRuntime2, 'sessions', 'two.jsonl'), 'two\n', 'utf8');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    aiHomeDir,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: (cliName, ref) => resolveAccountRuntimeDir(aiHomeDir, cliName, ref),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('codex', accountRef1);

  const merged = JSON.parse(fs.readFileSync(path.join(hostCodexDir, '.codex-global-state.json'), 'utf8'));
  assert.deepEqual(merged['active-workspace-roots'], ['/workspace/a']);
  assert.equal(fs.lstatSync(path.join(account2Dir, '.codex-global-state.json')).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(desktopRuntime1, 'sessions')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(desktopRuntime2, 'sessions')).isSymbolicLink(), false);
});

test('ensureSessionStoreLinks does not create runtime directories for env-auth accounts', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const aiHomeDir = path.join(root, '.ai_home');
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'gemini',
    cliAccountId: '1',
    identitySeed: `test:gemini:${root}:1`
  });
  writeAccountCredentials(fs, aiHomeDir, accountRef, { GEMINI_API_KEY: 'db-key' });
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'gemini', accountRef);
  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    aiHomeDir,
    hostHomeDir,
    cliConfigs: { gemini: { globalDir: '.gemini' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  assert.deepEqual(service.ensureSessionStoreLinks('gemini', accountRef), { migrated: 0, linked: 0 });
  assert.equal(fs.existsSync(runtimeDir), false);
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
  assert.deepEqual(fake.calls.symlink.filter((call) => (
    call.type === 'junction' && call.linkPath === pathImpl.join(accountCodexDir, 'sessions')
  )), [{
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
  assert.deepEqual(fake.calls.symlink.filter((call) => call.linkPath === accountSessionsDir), []);
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
  assert.deepEqual(fake.calls.symlink.filter((call) => (
    call.linkPath === accountTmpDir
    || call.linkPath === pathImpl.join(accountGeminiDir, 'tmp-real')
  )), [
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
  assert.deepEqual(fake.calls.symlink.filter((call) => (
    call.linkPath === accountTmpDir
    || call.linkPath === pathImpl.join(accountGeminiDir, 'tmp-real')
  )), [
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

test('ensureSessionStoreLinks never creates or migrates a Claude account state directory', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const profileDir = path.join(root, 'profiles', 'claude', '1');
  fs.mkdirSync(path.join(hostHomeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(hostHomeDir, '.claude', 'history.jsonl'), '{"host":true}\n');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { claude: { globalDir: '.claude' } },
    getProfileDir: () => profileDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  assert.equal(service.getToolConfigDir('claude', '1'), path.join(hostHomeDir, '.claude'));
  assert.deepEqual(service.ensureSessionStoreLinks('claude', '1'), { migrated: 0, linked: 0 });
  assert.equal(fs.existsSync(profileDir), false);
  assert.equal(fs.readFileSync(path.join(hostHomeDir, '.claude', 'history.jsonl'), 'utf8'), '{"host":true}\n');
});

test('ensureSessionStoreLinks migrates legacy Claude resources but keeps credentials account-owned', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const aiHomeDir = path.join(root, '.ai_home');
  const accountRef = 'acct_0123456789abcdef0123';
  const profileDir = resolveAccountRuntimeDir(aiHomeDir, 'claude', accountRef);
  const guestClaudeDir = path.join(profileDir, '.claude');
  const hostClaudeDir = path.join(hostHomeDir, '.claude');
  fs.mkdirSync(path.join(guestClaudeDir, 'projects', 'project-a'), { recursive: true });
  fs.writeFileSync(path.join(guestClaudeDir, 'projects', 'project-a', 'session.jsonl'), '{"session":true}\n');
  fs.writeFileSync(path.join(guestClaudeDir, '.credentials.json'), '{"oauth":"private"}\n');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    aiHomeDir,
    hostHomeDir,
    cliConfigs: { claude: { globalDir: '.claude' } },
    // Production Claude launches use the host home; the reconciler must still
    // resolve the disposable auth projection through the canonical layout.
    getProfileDir: () => hostHomeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('claude', accountRef);

  assert.equal(result.migrated > 0, true);
  assert.equal(fs.lstatSync(path.join(guestClaudeDir, 'projects')).isSymbolicLink(), true);
  assert.equal(
    fs.readFileSync(path.join(hostClaudeDir, 'projects', 'project-a', 'session.jsonl'), 'utf8'),
    '{"session":true}\n'
  );
  assert.equal(fs.lstatSync(path.join(guestClaudeDir, '.credentials.json')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(hostClaudeDir, '.credentials.json')), false);
});

test('ensureSessionStoreLinks shares settings and keeps credentials isolated for gemini and agy', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostHomeDir = path.join(root, 'home');
  const profilesDir = path.join(root, 'profiles');
  
  const hostGeminiDir = path.join(hostHomeDir, '.gemini');
  const hostGeminiConfigDir = path.join(hostGeminiDir, 'config');
  const hostAgyDir = path.join(hostGeminiDir, 'antigravity-cli');
  
  fs.mkdirSync(hostHomeDir, { recursive: true });
  fs.mkdirSync(hostGeminiDir, { recursive: true });
  fs.mkdirSync(hostGeminiConfigDir, { recursive: true });
  fs.mkdirSync(path.join(hostAgyDir, 'builtin'), { recursive: true });
  
  fs.writeFileSync(path.join(hostGeminiDir, 'settings.json'), '{"global":true}');
  fs.writeFileSync(path.join(hostGeminiConfigDir, 'mcp_config.json'), '{"global":true}');
  fs.writeFileSync(path.join(hostAgyDir, 'keybindings.json'), '{"shared":true}');
  fs.writeFileSync(path.join(hostAgyDir, 'email.cache.corrupted.bak'), 'shared@example.com');
  fs.writeFileSync(path.join(hostAgyDir, 'antigravity-oauth-token.corrupted.bak'), 'shared-token');
  fs.writeFileSync(path.join(hostAgyDir, 'builtin', 'shared.txt'), 'shared builtin');
  
  const geminiProfileDir = path.join(profilesDir, 'gemini', '1');
  const agyProfileDir = path.join(profilesDir, 'agy', '1');
  
  const guestGeminiDir = path.join(geminiProfileDir, '.gemini');
  
  const guestAgyParentDir = path.join(agyProfileDir, '.gemini');
  const guestAgyConfigDir = path.join(guestAgyParentDir, 'config');
  const guestAgyDir = path.join(guestAgyParentDir, 'antigravity-cli');
  
  fs.mkdirSync(guestGeminiDir, { recursive: true });
  fs.mkdirSync(guestAgyDir, { recursive: true });
  fs.mkdirSync(guestAgyConfigDir, { recursive: true });
  
  fs.writeFileSync(path.join(guestGeminiDir, 'settings.json'), '{"local":true}');
  fs.writeFileSync(path.join(guestGeminiDir, 'google_accounts.json'), '{"active":1}');
  fs.writeFileSync(path.join(guestGeminiDir, 'oauth_creds.json'), '{"token":2}');
  
  fs.mkdirSync(path.join(guestAgyDir, 'log'), { recursive: true });
  fs.writeFileSync(path.join(guestAgyDir, 'log', 'client.log'), 'authenticated');
  fs.writeFileSync(path.join(guestAgyDir, 'settings.json'), '{"agy":true}');
  fs.writeFileSync(path.join(guestAgyDir, 'antigravity-oauth-token'), 'oauth_token_secret');
  fs.symlinkSync(
    path.join(hostAgyDir, 'antigravity-oauth-token.corrupted.bak'),
    path.join(guestAgyDir, 'antigravity-oauth-token.corrupted.bak')
  );
  fs.writeFileSync(path.join(guestAgyDir, 'email.cache'), 'agy@example.com');
  fs.symlinkSync(
    path.join(hostAgyDir, 'email.cache.corrupted.bak'),
    path.join(guestAgyDir, 'email.cache.corrupted.bak')
  );
  fs.writeFileSync(path.join(guestAgyDir, 'keybindings.json'), '{"local":true}');
  fs.mkdirSync(path.join(guestAgyDir, 'builtin'), { recursive: true });
  fs.writeFileSync(path.join(guestAgyDir, 'builtin', 'local.txt'), 'local builtin');
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
      gemini: { globalDir: '.gemini' },
      agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' }
    },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const geminiRes = service.ensureSessionStoreLinks('gemini', '1');
  assert.ok(geminiRes.linked >= 1);
  
  assert.ok(fs.lstatSync(path.join(guestGeminiDir, 'settings.json')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(hostGeminiDir, 'settings.json'), 'utf8'), '{"global":true}');
  assert.equal(
    fs.readFileSync(path.join(hostGeminiDir, '.aih-migration-conflicts', '1', 'settings.json'), 'utf8'),
    '{"local":true}'
  );
  assert.ok(!fs.lstatSync(path.join(guestGeminiDir, 'google_accounts.json')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(guestGeminiDir, 'oauth_creds.json')).isSymbolicLink());

  const agyRes = service.ensureSessionStoreLinks('agy', '1');
  assert.ok(agyRes.linked >= 1);
  
  assert.ok(fs.lstatSync(path.join(guestAgyDir, 'settings.json')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(guestAgyDir, 'log')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(guestAgyDir, 'antigravity-oauth-token')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(guestAgyDir, 'antigravity-oauth-token.corrupted.bak')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(guestAgyDir, 'email.cache')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(guestAgyDir, 'email.cache.corrupted.bak')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(guestAgyDir, 'email.cache.corrupted.bak'), 'utf8'), 'shared@example.com');
  assert.ok(fs.lstatSync(path.join(guestAgyDir, 'cli.log')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(guestAgyDir, 'keybindings.json')).isSymbolicLink());
  assert.equal(
    fs.readFileSync(path.join(hostAgyDir, '.aih-migration-conflicts', '1', 'keybindings.json'), 'utf8'),
    '{"local":true}'
  );
  assert.ok(fs.lstatSync(path.join(guestAgyDir, 'builtin')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(hostAgyDir, 'builtin', 'local.txt'), 'utf8'), 'local builtin');
  
  // Verify that the parent .gemini/config directory is also shared (symlinked)
  assert.ok(fs.lstatSync(guestAgyConfigDir).isSymbolicLink());
  assert.equal(
    fs.readFileSync(path.join(
      hostAgyDir,
      '.aih-migration-conflicts',
      '1',
      'parent-gemini',
      'config',
      'mcp_config.json'
    ), 'utf8'),
    '{"local":true}'
  );
});

test('AGY reconciliation preserves a provider-local dynamic log alias', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'agy', 'acct_12121212121212121212');
  const hostAgyDir = path.join(hostHomeDir, '.gemini', 'antigravity-cli');
  const guestAgyDir = path.join(runtimeDir, '.gemini', 'antigravity-cli');
  const hostLogDir = path.join(hostAgyDir, 'log');
  const guestLogDir = path.join(guestAgyDir, 'log');
  const hostCliLog = path.join(hostAgyDir, 'cli.log');
  const guestCliLog = path.join(guestAgyDir, 'cli.log');
  fs.mkdirSync(hostLogDir, { recursive: true });
  fs.mkdirSync(guestAgyDir, { recursive: true });
  fs.writeFileSync(path.join(hostLogDir, 'host-current.log'), 'host agy log');
  fs.writeFileSync(path.join(hostLogDir, 'guest-current.log'), 'guest agy log');
  fs.symlinkSync('log/host-current.log', hostCliLog);
  fs.symlinkSync(hostLogDir, guestLogDir);
  fs.symlinkSync('log/guest-current.log', guestCliLog);

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('agy', 'acct_12121212121212121212');

  assert.equal(result.unresolved, undefined);
  assert.equal(fs.readlinkSync(guestCliLog), 'log/guest-current.log');
  assert.equal(fs.realpathSync(guestCliLog), fs.realpathSync(path.join(hostLogDir, 'guest-current.log')));
});

test('AGY reconciliation rejects an equivalent symlink outside the provider root', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'agy', 'acct_13131313131313131313');
  const hostAgyDir = path.join(hostHomeDir, '.gemini', 'antigravity-cli');
  const guestAgyDir = path.join(runtimeDir, '.gemini', 'antigravity-cli');
  const externalLog = path.join(root, 'external', 'current.log');
  const hostCliLog = path.join(hostAgyDir, 'cli.log');
  const guestCliLog = path.join(guestAgyDir, 'cli.log');
  fs.mkdirSync(path.dirname(externalLog), { recursive: true });
  fs.mkdirSync(hostAgyDir, { recursive: true });
  fs.mkdirSync(guestAgyDir, { recursive: true });
  fs.writeFileSync(externalLog, 'external log');
  fs.symlinkSync(externalLog, hostCliLog);
  fs.symlinkSync(externalLog, guestCliLog);

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('agy', 'acct_13131313131313131313');

  assert.deepEqual(result.unresolved, ['cli.log']);
  assert.equal(fs.readlinkSync(guestCliLog), externalLog);
});

test('fresh provider runtimes link durable resource directories before the first launch', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const runtimeRoot = path.join(root, 'run', 'auth-projections');
  fs.mkdirSync(hostHomeDir, { recursive: true });

  const configs = {
    codex: { globalDir: '.codex' },
    gemini: { globalDir: '.gemini' },
    agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' }
  };
  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: configs,
    getProfileDir: (provider, accountRef) => path.join(runtimeRoot, provider, accountRef),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const cases = [
    ['codex', 'acct_11111111111111111111', ['.codex'], 'sessions'],
    ['gemini', 'acct_22222222222222222222', ['.gemini'], 'tmp'],
    ['agy', 'acct_33333333333333333333', ['.gemini', 'antigravity-cli'], 'brain'],
    ['agy', 'acct_44444444444444444444', ['.gemini', 'antigravity-cli'], 'conversations'],
    ['agy', 'acct_55555555555555555555', ['.gemini', 'antigravity-cli'], 'knowledge'],
    ['agy', 'acct_66666666666666666666', ['.gemini', 'antigravity-cli'], 'scratch']
  ];

  cases.forEach(([provider, accountRef, configSegments, entryName]) => {
    service.ensureSessionStoreLinks(provider, accountRef);
    const runtimeEntry = path.join(runtimeRoot, provider, accountRef, ...configSegments, entryName);
    const hostEntry = path.join(hostHomeDir, ...configSegments, entryName);
    assert.equal(fs.lstatSync(runtimeEntry).isSymbolicLink(), true, runtimeEntry);
    assert.equal(fs.realpathSync(runtimeEntry), fs.realpathSync(hostEntry));
    fs.writeFileSync(path.join(runtimeEntry, 'first-run.txt'), provider, 'utf8');
    assert.equal(fs.readFileSync(path.join(hostEntry, 'first-run.txt'), 'utf8'), provider);
  });
});

test('agy GEMINI.md migrates once to the native provider home and remains linked', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'agy', 'acct_77777777777777777777');
  const guestInstruction = path.join(runtimeDir, '.gemini', 'GEMINI.md');
  const hostInstruction = path.join(hostHomeDir, '.gemini', 'GEMINI.md');
  fs.mkdirSync(path.dirname(guestInstruction), { recursive: true });
  fs.mkdirSync(path.dirname(hostInstruction), { recursive: true });
  fs.writeFileSync(guestInstruction, 'shared AGY instructions\n', 'utf8');
  fs.writeFileSync(hostInstruction, '', 'utf8');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('agy', 'acct_77777777777777777777');

  assert.equal(fs.readFileSync(hostInstruction, 'utf8'), 'shared AGY instructions\n');
  assert.equal(fs.lstatSync(guestInstruction).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(guestInstruction), fs.realpathSync(hostInstruction));
});

test('late-created AGY resources reconcile to the native provider root before cleanup', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const accountRef = 'acct_88888888888888888888';
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'agy', accountRef);
  const guestRoot = path.join(runtimeDir, '.gemini', 'antigravity-cli');
  const guestResource = path.join(guestRoot, 'late-resource.txt');
  const hostResource = path.join(hostHomeDir, '.gemini', 'antigravity-cli', 'late-resource.txt');
  fs.mkdirSync(guestRoot, { recursive: true });
  fs.writeFileSync(guestResource, 'late resource', 'utf8');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('agy', accountRef);

  assert.equal(fs.readFileSync(hostResource, 'utf8'), 'late resource');
  assert.equal(fs.lstatSync(guestResource).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(guestResource), fs.realpathSync(hostResource));
});

test('nested directory symlinks stay unresolved without traversing their targets', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const accountRef = 'acct_99999999999999999999';
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'agy', accountRef);
  const guestBrainDir = path.join(runtimeDir, '.gemini', 'antigravity-cli', 'brain');
  const hostBrainDir = path.join(hostHomeDir, '.gemini', 'antigravity-cli', 'brain');
  const externalDir = path.join(root, 'external');
  const nestedLink = path.join(guestBrainDir, 'external-session');
  fs.mkdirSync(guestBrainDir, { recursive: true });
  fs.mkdirSync(hostBrainDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  fs.writeFileSync(path.join(externalDir, 'must-stay.txt'), 'external-state', 'utf8');
  fs.symlinkSync(externalDir, nestedLink, 'dir');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('agy', accountRef);

  assert.deepEqual(result.unresolved, ['brain']);
  assert.equal(fs.lstatSync(nestedLink).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(externalDir, 'must-stay.txt'), 'utf8'), 'external-state');
  assert.equal(fs.existsSync(path.join(hostBrainDir, 'external-session', 'must-stay.txt')), false);
});

test('AGY fake-home resources migrate into the provider-native home and remain linked', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const accountRef = 'acct_aaaaaaaaaaaaaaaaaaaa';
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'agy', accountRef);
  const resources = [
    ['Library', 'Caches', 'agy.cache'],
    ['Library', 'Application Support', 'Antigravity', 'User', 'state.json'],
    ['.local', 'share', 'agy', 'state.json'],
    ['.config', 'agy', 'settings.json'],
    ['unknown-provider-state', 'artifact.bin']
  ];
  for (const segments of resources) {
    const sourcePath = path.join(runtimeDir, ...segments);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, segments.join('/'), 'utf8');
  }
  const keychainPath = path.join(runtimeDir, 'Library', 'Keychains', 'account.keychain-db');
  fs.mkdirSync(path.dirname(keychainPath), { recursive: true });
  fs.writeFileSync(keychainPath, 'account-private', 'utf8');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: { platform: 'darwin' },
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('agy', accountRef);

  assert.equal(Array.isArray(result.unresolved), false);
  for (const segments of resources) {
    const sourcePath = path.join(runtimeDir, ...segments);
    const runtimeHome = path.join(
      hostHomeDir,
      '.gemini',
      'antigravity-cli',
      '.aih-runtime-home'
    );
    const targetPath = segments[0] === 'Library'
      ? path.join(runtimeHome, ...segments)
      : segments[0] === '.local' && segments[1] === 'share'
        ? path.join(runtimeHome, 'xdg', 'data', ...segments.slice(2))
        : segments[0] === '.config'
          ? path.join(runtimeHome, 'xdg', 'config', ...segments.slice(1))
          : path.join(runtimeHome, 'home', ...segments);
    assert.equal(fs.realpathSync(sourcePath), fs.realpathSync(targetPath), sourcePath);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), segments.join('/'));
    const linkedEntryPath = segments[0] === 'Library'
      ? path.join(runtimeDir, 'Library', segments[1])
      : segments[0] === '.local'
        ? path.join(runtimeDir, '.local', 'share')
      : path.join(runtimeDir, segments[0]);
    assert.equal(fs.lstatSync(linkedEntryPath).isSymbolicLink(), true, linkedEntryPath);
  }
  assert.equal(fs.lstatSync(keychainPath).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(keychainPath, 'utf8'), 'account-private');
});

test('AGY fake-home fallback keeps HOME entries separate from XDG config entries', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const accountRef = 'acct_abababababababababab';
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'agy', accountRef);
  const projectedConfig = path.join(runtimeDir, '.config', 'same.txt');
  const projectedHome = path.join(runtimeDir, 'same.txt');
  fs.mkdirSync(path.dirname(projectedConfig), { recursive: true });
  fs.writeFileSync(projectedConfig, 'xdg-config', 'utf8');
  fs.writeFileSync(projectedHome, 'home-root', 'utf8');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('agy', accountRef);
  const runtimeHome = path.join(
    hostHomeDir,
    '.gemini',
    'antigravity-cli',
    '.aih-runtime-home'
  );
  const nativeConfig = path.join(runtimeHome, 'xdg', 'config', 'same.txt');
  const nativeHome = path.join(runtimeHome, 'home', 'same.txt');

  assert.equal(Array.isArray(result.unresolved), false);
  assert.equal(fs.readFileSync(nativeConfig, 'utf8'), 'xdg-config');
  assert.equal(fs.readFileSync(nativeHome, 'utf8'), 'home-root');
  assert.equal(fs.realpathSync(projectedConfig), fs.realpathSync(nativeConfig));
  assert.equal(fs.realpathSync(projectedHome), fs.realpathSync(nativeHome));
  assert.notEqual(fs.realpathSync(projectedConfig), fs.realpathSync(projectedHome));
});

test('provider fallback resources are linked into every account projection', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const accountA = 'acct_aeaeaeaeaeaeaeaeaeae';
  const accountB = 'acct_afafafafafafafafafaf';
  const runtimeRoot = path.join(root, 'run', 'auth-projections', 'agy');
  const runtimeA = path.join(runtimeRoot, accountA);
  const runtimeB = path.join(runtimeRoot, accountB);
  const resourceA = path.join(runtimeA, 'mystery-state', 'session.jsonl');
  const nestedFallbackA = path.join(runtimeA, '.local', 'other-state.json');
  fs.mkdirSync(path.dirname(resourceA), { recursive: true });
  fs.mkdirSync(path.dirname(nestedFallbackA), { recursive: true });
  fs.mkdirSync(runtimeB, { recursive: true });
  fs.writeFileSync(resourceA, '{"shared":true}\n', 'utf8');
  fs.writeFileSync(nestedFallbackA, '{"nested":true}\n', 'utf8');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: (_provider, accountRef) => path.join(runtimeRoot, accountRef),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  service.ensureSessionStoreLinks('agy', accountA);
  const resultB = service.ensureSessionStoreLinks('agy', accountB);
  const nativeResource = path.join(
    hostHomeDir,
    '.gemini',
    'antigravity-cli',
    '.aih-runtime-home',
    'home',
    'mystery-state',
    'session.jsonl'
  );
  const resourceB = path.join(runtimeB, 'mystery-state', 'session.jsonl');
  const nestedFallbackB = path.join(runtimeB, '.local', 'other-state.json');

  assert.equal(Array.isArray(resultB.unresolved), false);
  assert.equal(fs.readFileSync(nativeResource, 'utf8'), '{"shared":true}\n');
  assert.equal(fs.realpathSync(resourceA), fs.realpathSync(nativeResource));
  assert.equal(fs.realpathSync(resourceB), fs.realpathSync(nativeResource));
  assert.equal(fs.lstatSync(path.join(runtimeB, 'mystery-state')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(nestedFallbackB, 'utf8'), '{"nested":true}\n');
  assert.equal(
    fs.realpathSync(nestedFallbackB),
    fs.realpathSync(path.join(
      hostHomeDir,
      '.gemini',
      'antigravity-cli',
      '.aih-runtime-home',
      'home',
      '.local',
      'other-state.json'
    ))
  );
});

test('fallback reverse projection never links private descendants', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const accountRef = 'acct_acacacacacacacacacac';
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'codex', accountRef);
  const runtimeHome = path.join(hostHomeDir, '.codex', '.aih-runtime-home');
  const nativeCache = path.join(runtimeHome, 'Library', 'Caches', 'provider.cache');
  const nativeKeychain = path.join(runtimeHome, 'Library', 'Keychains', 'secret.db');
  fs.mkdirSync(path.dirname(nativeCache), { recursive: true });
  fs.mkdirSync(path.dirname(nativeKeychain), { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(nativeCache, 'cache', 'utf8');
  fs.writeFileSync(nativeKeychain, 'secret', 'utf8');

  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('codex', accountRef);
  const projectedLibrary = path.join(runtimeDir, 'Library');
  const projectedCache = path.join(projectedLibrary, 'Caches', 'provider.cache');
  const projectedKeychain = path.join(projectedLibrary, 'Keychains');

  assert.equal(Array.isArray(result.unresolved), false);
  assert.equal(fs.lstatSync(projectedLibrary).isSymbolicLink(), false);
  assert.equal(fs.realpathSync(projectedCache), fs.realpathSync(nativeCache));
  assert.equal(fs.existsSync(projectedKeychain), false);
});

test('projection directory symlinks fail closed without traversing external targets', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');

  const cases = [
    {
      name: 'projection root',
      accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb',
      create(runtimeDir, externalDir) {
        fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });
        fs.mkdirSync(path.join(externalDir, '.gemini', 'antigravity-cli', 'brain'), { recursive: true });
        fs.symlinkSync(externalDir, runtimeDir, 'dir');
        return path.join(externalDir, '.gemini', 'antigravity-cli', 'brain', 'session.jsonl');
      }
    },
    {
      name: 'provider parent root',
      accountRef: 'acct_bcbcbcbcbcbcbcbcbcbc',
      create(runtimeDir, externalDir) {
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.mkdirSync(path.join(externalDir, 'antigravity-cli', 'brain'), { recursive: true });
        fs.symlinkSync(externalDir, path.join(runtimeDir, '.gemini'), 'dir');
        return path.join(externalDir, 'antigravity-cli', 'brain', 'session.jsonl');
      }
    },
    {
      name: 'tool config root',
      accountRef: 'acct_bdbdbdbdbdbdbdbdbdbd',
      create(runtimeDir, externalDir) {
        fs.mkdirSync(path.join(runtimeDir, '.gemini'), { recursive: true });
        fs.mkdirSync(path.join(externalDir, 'brain'), { recursive: true });
        fs.symlinkSync(externalDir, path.join(runtimeDir, '.gemini', 'antigravity-cli'), 'dir');
        return path.join(externalDir, 'brain', 'session.jsonl');
      }
    }
  ];

  cases.forEach(({ name, accountRef, create }) => {
    const runtimeDir = path.join(root, 'run', 'auth-projections', 'agy', accountRef);
    const externalDir = path.join(root, `external-${accountRef}`);
    const externalFile = create(runtimeDir, externalDir);
    fs.writeFileSync(externalFile, name, 'utf8');
    const service = createSessionStoreService({
      fs,
      fse,
      path,
      processObj: process,
      hostHomeDir,
      cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
      getProfileDir: () => runtimeDir,
      ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
    });

    assert.throws(
      () => service.ensureSessionStoreLinks('agy', accountRef),
      (error) => error && error.code === 'provider_projection_path_symlink',
      name
    );
    assert.equal(fs.readFileSync(externalFile, 'utf8'), name);
    assert.equal(
      fs.existsSync(path.join(hostHomeDir, '.gemini', 'antigravity-cli', 'brain', 'session.jsonl')),
      false,
      name
    );
  });
});

test('ensureSessionStoreLinks replaces legacy macOS Library aliases with provider-owned state', (t) => {
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
  
  const geminiProfileDir = path.join(profilesDir, 'gemini', '1');
  const guestGeminiDir = path.join(geminiProfileDir, '.gemini');
  fs.mkdirSync(guestGeminiDir, { recursive: true });
  const guestLibraryDir = path.join(geminiProfileDir, 'Library');
  fs.mkdirSync(guestLibraryDir, { recursive: true });
  fs.symlinkSync(hostKeychainsDir, path.join(guestLibraryDir, 'Keychains'), 'dir');
  fs.symlinkSync(hostPreferencesDir, path.join(guestLibraryDir, 'Preferences'), 'dir');
  
  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: { platform: 'darwin' },
    profilesDir,
    hostHomeDir,
    cliConfigs: {
      gemini: { globalDir: '.gemini' }
    },
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('gemini', '1');
  assert.ok(result);

  const guestKeychainsDir = path.join(geminiProfileDir, 'Library', 'Keychains');
  assert.equal(fs.existsSync(guestKeychainsDir), false);

  const guestPreferencesDir = path.join(geminiProfileDir, 'Library', 'Preferences');
  const providerPreferencesDir = path.join(
    hostHomeDir,
    '.gemini',
    '.aih-runtime-home',
    'Library',
    'Preferences'
  );
  assert.equal(fs.lstatSync(guestPreferencesDir).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(guestPreferencesDir), fs.realpathSync(providerPreferencesDir));
  assert.equal(
    fs.readFileSync(path.join(providerPreferencesDir, 'com.apple.security.plist'), 'utf8'),
    'preferences content'
  );
});

test('ensureSessionStoreLinks fails closed when lstat returns EIO', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'agy', 'acct_bbbbbbbbbbbbbbbbbbbb');
  const resourcePath = path.join(runtimeDir, '.gemini', 'antigravity-cli', 'brain');
  fs.mkdirSync(resourcePath, { recursive: true });
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'lstatSync') return Reflect.get(target, property);
      return (filePath) => {
        if (path.resolve(filePath) === path.resolve(resourcePath)) {
          throw Object.assign(new Error('simulated lstat failure'), { code: 'EIO' });
        }
        return target.lstatSync(filePath);
      };
    }
  });
  const service = createSessionStoreService({
    fs: failingFs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  assert.throws(
    () => service.ensureSessionStoreLinks('agy', 'acct_bbbbbbbbbbbbbbbbbbbb'),
    (error) => error && error.code === 'EIO'
  );
  assert.equal(fs.existsSync(resourcePath), true);
});

test('unknown projection resources move under each provider native runtime home', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'codex', 'acct_cccccccccccccccccccc');
  const sourcePath = path.join(runtimeDir, 'Library', 'Caches', 'provider.cache');
  const authPath = path.join(runtimeDir, '.codex', 'auth.json');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(sourcePath, 'provider-cache', 'utf8');
  fs.writeFileSync(authPath, '{"tokens":{}}\n', 'utf8');
  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { codex: { globalDir: '.codex' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('codex', 'acct_cccccccccccccccccccc');
  const targetPath = path.join(
    hostHomeDir,
    '.codex',
    '.aih-runtime-home',
    'Library',
    'Caches',
    'provider.cache'
  );

  assert.equal(Array.isArray(result.unresolved), false);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'provider-cache');
  assert.equal(fs.realpathSync(sourcePath), fs.realpathSync(targetPath));
  assert.equal(fs.lstatSync(authPath).isSymbolicLink(), false);
});

test('non-canonical top-level symlinks remain unresolved and are never traversed', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const runtimeDir = path.join(root, 'run', 'auth-projections', 'agy', 'acct_dddddddddddddddddddd');
  const externalDir = path.join(root, 'external-provider-state');
  const sourceLink = path.join(runtimeDir, 'unknown-provider-state');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  fs.writeFileSync(path.join(externalDir, 'must-stay.txt'), 'external', 'utf8');
  fs.symlinkSync(externalDir, sourceLink, 'dir');
  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: () => runtimeDir,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('agy', 'acct_dddddddddddddddddddd');

  assert.deepEqual(result.unresolved, ['unknown-provider-state']);
  assert.equal(fs.lstatSync(sourceLink).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(externalDir, 'must-stay.txt'), 'utf8'), 'external');
});

test('transient login projection resources reconcile before runtime cleanup', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const accountRef = 'acct_eeeeeeeeeeeeeeeeeeee';
  const canonicalRuntime = path.join(root, 'run', 'auth-projections', 'agy', accountRef);
  const loginRuntime = path.join(root, 'run', 'login', 'agy', 'auth-test');
  const loginBrain = path.join(loginRuntime, '.gemini', 'antigravity-cli', 'brain');
  const loginAuth = path.join(loginRuntime, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  fs.mkdirSync(loginBrain, { recursive: true });
  fs.writeFileSync(path.join(loginBrain, 'session.jsonl'), '{"session":true}\n', 'utf8');
  fs.writeFileSync(loginAuth, '{"access_token":"private"}\n', 'utf8');
  const service = createSessionStoreService({
    fs,
    fse,
    path,
    processObj: process,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: () => canonicalRuntime,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true })
  });

  const result = service.ensureSessionStoreLinks('agy', accountRef, {
    projectionRoot: loginRuntime
  });
  const nativeSession = path.join(
    hostHomeDir,
    '.gemini',
    'antigravity-cli',
    'brain',
    'session.jsonl'
  );

  assert.equal(Array.isArray(result.unresolved), false);
  assert.equal(fs.readFileSync(nativeSession, 'utf8'), '{"session":true}\n');
  assert.equal(fs.realpathSync(loginBrain), fs.realpathSync(path.dirname(nativeSession)));
  assert.equal(fs.lstatSync(loginAuth).isSymbolicLink(), false);
});
