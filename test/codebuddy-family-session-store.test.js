'use strict';

// 回归守卫（2026-10-31 用户口径，两次修订）：
//   1) 家族会话不分地区，一份历史；
//   2) 磁盘上绝不允许出现第二份，**运行期也不许搬移目录**——多账号并发时把目录
//      从别人脚下 rename 走会制造半截状态。
//
// 所以这里守的是「只建链接」：缺的/空的 projects 换成软链接；真实目录原样不动、
// 报 unresolved；读路径把家族四个根一起读（不依赖物理归一是否已完成）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FAMILY_SESSION_STORE_CONFIG_DIR,
  familyConfigDirNames,
  familySessionStoreSegments,
  listFamilySessionRoots,
  ensureFamilySessionLinks
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
  const file = path.join(dir, sessionId + '.jsonl');
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

test('家族四个成员都在名单里，规范存储排第一', (t) => withHome(t, (home) => {
  assert.deepEqual(familyConfigDirNames(), ['.codebuddy', '.codebuddy-cn', '.workbuddy-ai', '.workbuddy']);
  assert.deepEqual(
    listFamilySessionRoots(home).map((root) => root.configDir),
    ['.codebuddy', '.codebuddy-cn', '.workbuddy-ai', '.workbuddy']
  );
}));

test('缺失的配置根建链，不产生第二份存储', (t) => withHome(t, (home) => {
  const result = ensureFamilySessionLinks({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.linked.length, 3);
  const canonical = path.join(home, '.codebuddy', 'projects');
  for (const dirName of ['.codebuddy-cn', '.workbuddy', '.workbuddy-ai']) {
    assert.equal(isSymlink(path.join(home, dirName, 'projects')), true, dirName);
    assert.equal(readRealpath(path.join(home, dirName, 'projects')), readRealpath(canonical));
  }
}));

test('空目录换成链接（里面没有任何数据，安全）', (t) => withHome(t, (home) => {
  fs.mkdirSync(path.join(home, '.workbuddy', 'projects'), { recursive: true });
  const result = ensureFamilySessionLinks({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.deepEqual(result.unresolved, []);
  assert.equal(isSymlink(path.join(home, '.workbuddy', 'projects')), true);
}));

test('真实目录里有会话：原样不动、报 unresolved（不搬、不删、不复制）', (t) => withHome(t, (home) => {
  const cnFile = writeSession(home, '.codebuddy-cn', 'proj-a', 'cn-1', LINE);
  const before = fs.readFileSync(cnFile, 'utf8');

  const result = ensureFamilySessionLinks({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.deepEqual(result.unresolved, [path.join(home, '.codebuddy-cn', 'projects')]);
  assert.equal(isSymlink(path.join(home, '.codebuddy-cn', 'projects')), false);
  assert.equal(fs.readFileSync(cnFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(home, '.codebuddy', 'projects', 'proj-a', 'cn-1.jsonl')), false);
  assert.deepEqual(fs.readdirSync(path.join(home, '.codebuddy-cn', 'projects')), ['proj-a']);
}));

test('指向别处的链接不认，报 unresolved（不覆盖别人的链接）', (t) => withHome(t, (home) => {
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(home, '.workbuddy', 'projects'));

  const result = ensureFamilySessionLinks({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.deepEqual(result.unresolved, [path.join(home, '.workbuddy', 'projects')]);
  assert.equal(readRealpath(path.join(home, '.workbuddy', 'projects')), readRealpath(elsewhere));
}));

test('幂等：重复执行（含并发式重复调用）都收敛到同一份链接', (t) => withHome(t, (home) => {
  const first = ensureFamilySessionLinks({ fs, path, platform: 'darwin', hostHomeDir: home });
  const second = ensureFamilySessionLinks({ fs, path, platform: 'darwin', hostHomeDir: home });

  assert.equal(first.linked.length, 3);
  assert.equal(second.linked.length, 0);
  assert.equal(second.unchanged.length, 4);
  const canonical = path.join(home, '.codebuddy', 'projects');
  for (const dirName of ['.codebuddy-cn', '.workbuddy', '.workbuddy-ai']) {
    assert.equal(readRealpath(path.join(home, dirName, 'projects')), readRealpath(canonical));
  }
  assert.deepEqual(fs.readdirSync(path.join(home, '.workbuddy')), ['projects']);
}));

test('读路径：不依赖物理归一，国内站也能看到国际站写的会话', (t) => withHome(t, (home) => {
  const { readCodebuddyProjects } = require('../lib/sessions/session-reader-codebuddy');
  const intl = writeSession(home, '.codebuddy', 'proj-x', 'intl-9', [
    JSON.stringify({ id: 'r1', timestamp: Date.now(), type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
    JSON.stringify({ id: 'r2', timestamp: Date.now(), type: 'ai-title', aiTitle: 'intl only' })
  ].join('\n') + '\n');
  assert.equal(fs.existsSync(intl), true);
  const projects = readCodebuddyProjects('codebuddycn', { hostHomeDir: home });
  const ids = projects.flatMap((project) => project.sessions.map((session) => session.id));
  assert.deepEqual(ids, ['intl-9']);
}));
