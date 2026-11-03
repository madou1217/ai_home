'use strict';

// 登录产物「路径 → 签名」的守卫。
//
// 这两件事决定 WebUI / CLI 的登录作业能不能收尾（见 web-account-auth 的
// _requireFreshOauthArtifacts）：
//   - getOauthArtifactPath / listOauthArtifactPaths：这支队到底看哪个文件；
//   - readOauthArtifactSignature：这个文件是不是本次登录**新写的**。
// 家族成员的候选集（首选 + 跨站次选）由 codebuddy-family-layouts 持有，这里只钉
// 「按候选顺序取第一个真实存在的文件」，不复制文件名。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getOauthArtifactPath,
  hasOauthCompletionArtifacts,
  readOauthArtifactSignature
} = require('../lib/server/web-account-auth-oauth-tokens');
const { familyAuthPaths } = require('../lib/runtime/codebuddy-family-layouts');

const sha1 = (value) => crypto.createHash('sha1').update(value, 'utf8').digest('hex');

function withRuntime(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-oauth-artifact-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeAt(runtimeDir, absolutePath, content) {
  const target = path.join(runtimeDir, absolutePath.slice('/home/'.length));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test('单路径 Provider：Kiro / OpenCode 用各自的固定落点，家族用首选候选', () => {
  assert.equal(getOauthArtifactPath({ provider: 'kiro', runtimeDir: '/r' }), '/r/data.sqlite3');
  assert.equal(
    getOauthArtifactPath({ provider: 'opencode', runtimeDir: '/r' }),
    '/r/.local/share/opencode/auth.json'
  );
  const [primary] = familyAuthPaths('/r', 'codebuddycn', { platform: 'darwin' });
  assert.equal(getOauthArtifactPath({ provider: 'codebuddycn', runtimeDir: '/r', platform: 'darwin' }), primary);
  // 其余 Provider 走 storage policy 的 artifact 声明（configDir 基点）。
  assert.equal(getOauthArtifactPath({ provider: 'codex', configDir: '/c' }), '/c/auth.json');
  assert.equal(getOauthArtifactPath({ provider: 'claude', configDir: '/c' }), '/c/.credentials.json');
  // 不认识 / 契约没声明的 provider：返回空串，不猜路径。
  assert.equal(getOauthArtifactPath({ provider: 'unknown-provider', configDir: '/c' }), '');
  // 没有上下文就没有路径，不能凭空猜。
  assert.equal(getOauthArtifactPath(null), '');
  assert.equal(getOauthArtifactPath({ provider: 'kiro' }), '');
  assert.equal(getOauthArtifactPath({ provider: 'codex' }), '');
});

test('签名：只有次选文件落地时，签名跟着次选走（登录判定与登记同口径）', () => withRuntime((runtimeDir) => {
  const job = { provider: 'codebuddycn', runtimeDir, platform: 'darwin' };
  assert.equal(readOauthArtifactSignature(job, fs), '', '空沙箱没有签名');

  const [, secondary] = familyAuthPaths('/home', 'codebuddycn', { platform: 'darwin' });
  const content = JSON.stringify({ account: { uid: 'u-1' }, auth: { accessToken: 't' } });
  writeAt(runtimeDir, secondary, content);
  assert.equal(readOauthArtifactSignature(job, fs), sha1(content), '次选文件也算本次登录产物');

  // 内容变了签名就变（_requireFreshOauthArtifacts 靠这个判「新」）。
  writeAt(runtimeDir, secondary, content + ' ');
  assert.equal(readOauthArtifactSignature(job, fs), sha1(content + ' '));

  // 首选文件落地后优先看首选。
  const [primary] = familyAuthPaths('/home', 'codebuddycn', { platform: 'darwin' });
  writeAt(runtimeDir, primary, 'primary');
  assert.equal(readOauthArtifactSignature(job, fs), sha1('primary'));
}));

test('签名：读盘异常不抛，按「没有签名」处理', () => {
  const exploding = {
    existsSync() { throw new Error('EACCES'); },
    statSync() { throw new Error('EACCES'); }
  };
  assert.equal(
    readOauthArtifactSignature({ provider: 'codebuddycn', runtimeDir: '/r', platform: 'darwin' }, exploding),
    ''
  );
});

test('签名：kiro 走 sqlite 的 token 行，settings 写入不算新登录', () => {
  const { DatabaseSync } = require('node:sqlite');
  withRuntime((runtimeDir) => {
    const dbPath = path.join(runtimeDir, 'data.sqlite3');
    const create = (statements) => {
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      for (const [sql, args] of statements) db.prepare(sql).run(...args);
      db.close();
    };
    const key = 'kirocli:odic:token';
    create([['INSERT INTO auth_kv (key, value) VALUES (?, ?)', [key, JSON.stringify({ access_token: 'a1', refresh_token: 'r1' })]]]);

    const job = { provider: 'kiro', runtimeDir };
    const first = readOauthArtifactSignature(job, fs);
    assert.ok(first, '有 token 行就有签名');

    // 非 token 行（settings/session）变化不影响签名：mtime 变了也不算新登录。
    create([['INSERT INTO auth_kv (key, value) VALUES (?, ?)', ['settings', '{"theme":"dark"}']]]);
    assert.equal(readOauthArtifactSignature(job, fs), first);

    // token 换了才算新登录。
    create([['UPDATE auth_kv SET value = ? WHERE key = ?', [JSON.stringify({ access_token: 'a2', refresh_token: 'r2' }), key]]]);
    assert.notEqual(readOauthArtifactSignature(job, fs), first);
  });
});

test('签名：目录型产物按目录内 *.log 清单算；空目录不产生签名', () => {
  withRuntime((runtimeDir) => {
    // codex 的产物路径是 <configDir>/auth.json；把它做成目录即命中「目录型产物」防御分支。
    const job = { provider: 'codex', configDir: runtimeDir };
    const dir = path.join(runtimeDir, 'auth.json');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(readOauthArtifactSignature(job, fs), '', '空目录 = 没有签名');

    fs.writeFileSync(path.join(dir, 'b.log'), 'bbb');
    fs.writeFileSync(path.join(dir, 'a.log'), 'a');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore');
    const first = readOauthArtifactSignature(job, fs);
    assert.ok(first);

    // 非 .log 文件不参与签名。
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'changed');
    assert.equal(readOauthArtifactSignature(job, fs), first);

    // .log 内容（大小）变化 → 签名变化。
    fs.writeFileSync(path.join(dir, 'a.log'), 'aaaaaaaa');
    const second = readOauthArtifactSignature(job, fs);
    assert.notEqual(second, first);

    // 悬空链接：statSync 抛错的那条被过滤掉，不影响其它条目。
    fs.symlinkSync(path.join(dir, 'missing.log'), path.join(dir, 'dead.log'));
    assert.ok(readOauthArtifactSignature(job, fs));
  });
});

test('完成判定：空文件不算完成；缺上下文直接否；有新鲜度要求时只认签名变化', () => {
  withRuntime((runtimeDir) => {
    const job = { provider: 'codebuddycn', runtimeDir, platform: 'darwin' };
    const [primary] = familyAuthPaths('/home', 'codebuddycn', { platform: 'darwin' });

    assert.equal(hasOauthCompletionArtifacts(job, fs), false, '文件还没落地');
    writeAt(runtimeDir, primary, '');
    assert.equal(hasOauthCompletionArtifacts(job, fs), false, '空文件不算完成');

    writeAt(runtimeDir, primary, 'credential-v1');
    assert.equal(hasOauthCompletionArtifacts(job, fs), true);

    const freshJob = { ...job, _requireFreshOauthArtifacts: true };
    const atStart = readOauthArtifactSignature(job, fs);
    assert.equal(
      hasOauthCompletionArtifacts({ ...freshJob, _oauthArtifactSignatureAtStart: atStart }, fs),
      false,
      '签名没变 = 还是登录前那份'
    );
    writeAt(runtimeDir, primary, 'credential-v2');
    assert.equal(
      hasOauthCompletionArtifacts({ ...freshJob, _oauthArtifactSignatureAtStart: atStart }, fs),
      true
    );

    // 缺上下文：连看哪个文件都不知道，不能判完成。
    assert.equal(hasOauthCompletionArtifacts(null, fs), false);
    assert.equal(hasOauthCompletionArtifacts({ provider: 'codebuddycn' }, fs), false);
  });
});

test('签名：existsSync 说在、statSync 读不了 → 返回空签名（不抛）', () => {
  const halfBroken = {
    existsSync: () => true,
    statSync() { throw new Error('EACCES'); }
  };
  assert.equal(
    readOauthArtifactSignature({ provider: 'codebuddycn', runtimeDir: '/r', platform: 'darwin' }, halfBroken),
    ''
  );
});

test('完成判定：kiro 直接看 sqlite 里的 token（不是文件存在就算）', () => {
  const { DatabaseSync } = require('node:sqlite');
  withRuntime((runtimeDir) => {
    const job = { provider: 'kiro', runtimeDir };
    assert.equal(hasOauthCompletionArtifacts(job, fs), false, '没有库文件');

    const dbPath = path.join(runtimeDir, 'data.sqlite3');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)')
      .run('kirocli:odic:token', JSON.stringify({ refresh_token: 'r1' }));
    db.close();
    // 只有 refresh_token、没有 access_token：库在但登录还没完成。
    assert.equal(hasOauthCompletionArtifacts(job, fs), false);

    const db2 = new DatabaseSync(dbPath);
    db2.prepare('UPDATE auth_kv SET value = ? WHERE key = ?')
      .run(JSON.stringify({ access_token: 'a1', refresh_token: 'r1' }), 'kirocli:odic:token');
    db2.close();
    assert.equal(hasOauthCompletionArtifacts(job, fs), true);
  });
});
