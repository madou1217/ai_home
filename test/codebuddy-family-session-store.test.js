'use strict';

// 回归守卫（2026-10-31 用户口径）：CodeBuddy 家族会话**不分地区**，一份历史。
//
// 落地方式见 lib/runtime/codebuddy-family-session-store.js：`~/.codebuddy/projects` 是
// 规范存储，`~/.codebuddy-cn` / `~/.workbuddy` / `~/.workbuddy-ai` 下的 `projects`
// 都变成指向它的软链接。这里守四件事：
//   1) 已有数据被搬进规范存储，旧根变成链接（不复制、不覆盖）；
//   2) 同名同内容视为重复拷贝，删掉来源那份（内容仍在）；
//   3) 同名不同内容 → 整根不动、不建链接（宁可各看各的，也不覆盖）；
//   4) 幂等：重复执行不搬、不报错，仍是同一个物理目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FAMILY_SESSION_STORE_CONFIG_DIR,
  familySessionStoreSegments,
  listFamilySessionRoots,
  unifyFamilySessionStore
} = require('../lib/runtime/codebuddy-family-session-store');
const { getProviderStoragePolicy } = require('../lib/runtime/provider-storage-policy');

function withHome(t, fn) {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-family-sessions-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  return fn(hostHomeDir);
}

function writeSession(home, configDir, projectDir, sessionId, content) {
  const dir = path.join(home, configDir, 'projects', projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}

function readRealpath(target) {
  return fs.realpathSync(target);
}

function isSymlink(target) {
  return fs.lstatSync(target).isSymbolicLink();
}

const LINE = '{}\n';

test('规范存储就是 codebuddy 的原生配置根（不另造新路径）', () => {
  assert.equal(FAMILY_SESSION_STORE_CONFIG_DIR, '.codebuddy');
  assert.equal(getProviderStoragePolicy('codebuddy').nativeRoot[0], FAMILY_SESSION_STORE_CONFIG_DIR);
  assert.deepEqual(familySessionStoreSegments(), ['.codebuddy', 'projects']);
});

test('家族四个成员都在收敛名单里，规范存储排第一', (t) => withHome(t, (home) => {
  const roots = listFamilySessionRoots(home).map((root) => root.configDir);
  assert.equal(roots[0], '.codebuddy');
  assert.deepEqual(
    [...roots].sort(),
    ['.codebuddy', '.codebuddy-cn', '.workbuddy', '.workbuddy-ai'].sort()
  );
}));

test('四个地区已有会话搬进同一份存储，旧根变成指向它的链接', (t) => withHome(t, (home) => {
  const intl = writeSession(home, '.codebuddy', 'proj-a', 'intl-1', LINE);
  writeSession(home, '.codebuddy-cn', 'proj-a', 'cn-1', LINE);
  writeSession(home, '.workbuddy', 'proj-a', 'wb-1', LINE);
  writeSession(home, '.workbuddy-ai', 'proj-b', 'wbai-1', LINE);

  const result = unifyFamilySessionStore({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.unresolved, []);
  const canonical = path.join(home, '.codebuddy', 'projects');
  assert.equal(fs.existsSync(intl), true);
  for (const sessionId of ['intl-1', 'cn-1', 'wb-1', 'wbai-1']) {
    const found = fs.existsSync(path.join(canonical, 'proj-a', `${sessionId}.jsonl`))
      || fs.existsSync(path.join(canonical, 'proj-b', `${sessionId}.jsonl`));
    assert.equal(found, true, sessionId);
  }
  // 旧根现在是链接（断言 lstat，避免跟随链接后误判"文件还在原地"）。
  for (const dirName of ['.codebuddy-cn', '.workbuddy', '.workbuddy-ai']) {
    assert.equal(isSymlink(path.join(home, dirName, 'projects')), true, dirName);
    assert.equal(readRealpath(path.join(home, dirName, 'projects')), readRealpath(canonical));
  }
}));

test('同名同内容视为重复拷贝，来源那份被清掉、目标保持不变', (t) => withHome(t, (home) => {
  const canonicalFile = writeSession(home, '.codebuddy', 'proj-a', 'dup-1', '{"same":true}\n');
  writeSession(home, '.codebuddy-cn', 'proj-a', 'dup-1', '{"same":true}\n');

  const result = unifyFamilySessionStore({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.deepEqual(result.unresolved, []);
  assert.equal(fs.readFileSync(canonicalFile, 'utf8'), '{"same":true}\n');
  assert.equal(fs.existsSync(path.join(home, '.codebuddy-cn', 'proj-a')), false);
  assert.equal(isSymlink(path.join(home, '.codebuddy-cn', 'projects')), true);
}));

test('同名不同内容：整根不建链接、两边内容都还在', (t) => withHome(t, (home) => {
  const canonicalFile = writeSession(home, '.codebuddy', 'proj-a', 'dup-1', '{"site":"global"}\n');
  const cnFile = writeSession(home, '.codebuddy-cn', 'proj-a', 'dup-1', '{"site":"cn"}\n');

  const result = unifyFamilySessionStore({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.deepEqual(result.unresolved, [path.join(home, '.codebuddy-cn', 'projects')]);
  assert.equal(isSymlink(path.join(home, '.codebuddy-cn', 'projects')), false);
  assert.equal(fs.readFileSync(canonicalFile, 'utf8'), '{"site":"global"}\n');
  assert.equal(fs.readFileSync(cnFile, 'utf8'), '{"site":"cn"}\n');
}));

test('幂等：重复执行不搬动、不改写，仍是同一份物理目录', (t) => withHome(t, (home) => {
  writeSession(home, '.workbuddy', 'proj-a', 'wb-1', LINE);
  const first = unifyFamilySessionStore({ fs, path, platform: 'darwin', hostHomeDir: home });
  const second = unifyFamilySessionStore({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.equal(first.adopted.length, 1);
  assert.equal(second.adopted.length, 0);
  assert.equal(second.linked.length, 0);
  assert.equal(second.unchanged.length, 4);
  assert.equal(fs.existsSync(path.join(home, '.codebuddy', 'projects', 'proj-a', 'wb-1.jsonl')), true);
}));

test('缺失的配置根直接建链接，不产生第二份存储', (t) => withHome(t, (home) => {
  writeSession(home, '.codebuddy', 'proj-a', 'intl-1', LINE);
  const result = unifyFamilySessionStore({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.deepEqual(result.adopted, []);
  assert.equal(result.linked.length, 3);
  const canonical = path.join(home, '.codebuddy', 'projects');
  for (const dirName of ['.codebuddy-cn', '.workbuddy', '.workbuddy-ai']) {
    assert.equal(readRealpath(path.join(home, dirName, 'projects')), readRealpath(canonical));
  }
}));

test('来源里已有的软链接不跟、不搬，整根保留', (t) => withHome(t, (home) => {
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'x.jsonl'), LINE);
  fs.mkdirSync(path.join(home, '.codebuddy-cn'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(home, '.codebuddy-cn', 'projects'));

  const result = unifyFamilySessionStore({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.deepEqual(result.unresolved, [path.join(home, '.codebuddy-cn', 'projects')]);
  assert.equal(readRealpath(path.join(home, '.codebuddy-cn', 'projects')), readRealpath(elsewhere));
}));

test('归一之后，国内站 Provider 也能读到国际站写的会话（同一份历史）', (t) => withHome(t, (home) => {
  const { readCodebuddyProjects } = require('../lib/sessions/session-reader-codebuddy');
  const intl = writeSession(home, '.codebuddy', 'proj-x', 'intl-9', [
    JSON.stringify({ id: 'r1', timestamp: Date.now(), type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
    JSON.stringify({ id: 'r2', timestamp: Date.now(), type: 'ai-title', aiTitle: 'intl only' })
  ].join('\n') + '\n');
  assert.equal(fs.existsSync(intl), true);

  const before = readCodebuddyProjects('codebuddycn', { hostHomeDir: home });
  assert.equal(before.length, 0);

  unifyFamilySessionStore({ fs, path, platform: 'darwin', hostHomeDir: home });

  for (const provider of ['codebuddycn', 'workbuddycn', 'codebuddy', 'workbuddy']) {
    const projects = readCodebuddyProjects(provider, { hostHomeDir: home });
    const ids = projects.flatMap((project) => project.sessions.map((session) => session.id));
    assert.deepEqual(ids, ['intl-9'], provider);
  }
}));

test('跨设备 rename 失败时不复制、不建链接（用户硬规则：只许移动与软链接）', (t) => withHome(t, (home) => {
  const source = writeSession(home, '.codebuddy-cn', 'proj-a', 'cn-1', LINE);
  const exdevFs = {
    ...fs,
    renameSync: (from, to) => {
      if (String(from).includes('.codebuddy-cn')) {
        const error = new Error('EXDEV: cross-device link not permitted');
        error.code = 'EXDEV';
        throw error;
      }
      return fs.renameSync(from, to);
    }
  };

  const result = unifyFamilySessionStore({ fs: exdevFs, path, platform: 'darwin', hostHomeDir: home });

  assert.equal(result.failed.length, 1);
  assert.equal(result.adopted.length, 0);
  assert.equal(isSymlink(path.join(home, '.codebuddy-cn', 'projects')), false);
  // 来源还在原位，目标没有多出一份拷贝。
  assert.equal(fs.readFileSync(source, 'utf8'), LINE);
  assert.equal(fs.existsSync(path.join(home, '.codebuddy', 'projects', 'proj-a', 'cn-1.jsonl')), false);
}));
