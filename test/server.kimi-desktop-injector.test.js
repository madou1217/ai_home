'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

const {
  seedKimiDesktopTokenStore,
  adoptKimiDesktopTokensFromProfile,
  buildTokenStorePayload,
  parseTokenStorePlaintext,
  encryptV10,
  decryptV10
} = require('../lib/server/kimi-desktop-injector');

// fakeDpapiDeps 字节级模拟 DPAPI：protect 返回 base64('FAKEP:'+原文)，
// unprotect 反向还原（先剥 Chromium 的 'DPAPI' 包装前缀）。
function createFakeDpapiDeps() {
  return {
    platform: 'win32',
    execFileSync: (file, args, options) => {
      assert.equal(file, 'powershell');
      const env = options.env || {};
      if (env.AIH_DPAPI_PLAIN) {
        const plain = Buffer.from(env.AIH_DPAPI_PLAIN, 'base64');
        return Buffer.concat([Buffer.from('FAKEP:', 'latin1'), plain]).toString('base64');
      }
      if (env.AIH_DPAPI_BLOB) {
        let blob = Buffer.from(env.AIH_DPAPI_BLOB, 'base64');
        if (blob.slice(0, 5).toString('latin1') === 'DPAPI') blob = blob.slice(5);
        assert.equal(blob.slice(0, 6).toString('latin1'), 'FAKEP:');
        return blob.slice(6).toString('base64');
      }
      throw new Error('unexpected dpapi call');
    }
  };
}

function createProfileFixture(t) {
  const userDataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'aih-kimi-seed-'));
  t.after(() => nodeFs.rmSync(userDataDir, { recursive: true, force: true }));
  return userDataDir;
}

test('v10 加解密互逆', () => {
  const key = nodeCrypto.randomBytes(32);
  const raw = encryptV10(key, '{"hello":"world"}');
  assert.equal(raw.slice(0, 3).toString('latin1'), 'v10');
  assert.equal(decryptV10(key, raw), '{"hello":"world"}');
  assert.equal(decryptV10(nodeCrypto.randomBytes(32), raw), null);
  assert.equal(decryptV10(key, Buffer.from('short')), null);
});

test('buildTokenStorePayload/parseTokenStorePlaintext 结构与官方 schema 一致', () => {
  const payload = buildTokenStorePayload({
    accessToken: 'a-1',
    refreshToken: 'r-1',
    userId: 'u-123'
  });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.origin, 'https://www.kimi.com');
  assert.equal(parsed.tokens.access_token, 'a-1');
  assert.equal(parsed.tokens.refresh_token, 'r-1');
  assert.equal(parsed.tokens.msh_user_id, 'u-123');

  assert.deepEqual(parseTokenStorePlaintext(payload), {
    accessToken: 'a-1',
    refreshToken: 'r-1',
    userId: 'u-123'
  });
  assert.equal(parseTokenStorePlaintext('not json'), null);
  assert.equal(parseTokenStorePlaintext('{"tokens":{}}'), null);
});

test('seed 在空 profile 上预写 Local State 密钥并落盘 token 仓，adopt 可回读', (t) => {
  const userDataDir = createProfileFixture(t);
  const result = seedKimiDesktopTokenStore({
    userDataDir,
    accessToken: 'web-access',
    refreshToken: 'web-refresh',
    userId: 'u-1'
  }, { fs: nodeFs, path: nodePath, ...createFakeDpapiDeps() });
  assert.equal(result.seeded, true);

  // Local State 被预写且含 base64('DPAPI'+blob) 形式的 encrypted_key
  const localState = JSON.parse(nodeFs.readFileSync(nodePath.join(userDataDir, 'Local State'), 'utf8'));
  const wrapped = Buffer.from(localState.os_crypt.encrypted_key, 'base64');
  assert.equal(wrapped.slice(0, 5).toString('latin1'), 'DPAPI');

  const store = JSON.parse(nodeFs.readFileSync(
    nodePath.join(userDataDir, 'bridge-store', 'token-store.json'), 'utf8'
  ));
  assert.equal(store.encryption, 'safeStorage.v1');

  const adopted = adoptKimiDesktopTokensFromProfile(userDataDir, {
    fs: nodeFs, path: nodePath, ...createFakeDpapiDeps()
  });
  assert.deepEqual(adopted, { accessToken: 'web-access', refreshToken: 'web-refresh', userId: 'u-1' });
});

test('seed 复用既有 Local State 密钥而不覆盖', (t) => {
  const userDataDir = createProfileFixture(t);
  const deps = { fs: nodeFs, path: nodePath, ...createFakeDpapiDeps() };
  seedKimiDesktopTokenStore({ userDataDir, accessToken: 'a', refreshToken: 'r', userId: 'u' }, deps);
  const before = nodeFs.readFileSync(nodePath.join(userDataDir, 'Local State'), 'utf8');
  seedKimiDesktopTokenStore({ userDataDir, accessToken: 'a2', refreshToken: 'r2', userId: 'u' }, deps);
  const after = nodeFs.readFileSync(nodePath.join(userDataDir, 'Local State'), 'utf8');
  assert.equal(before, after);
  const adopted = adoptKimiDesktopTokensFromProfile(userDataDir, deps);
  assert.equal(adopted.refreshToken, 'r2');
});

test('seed 在非 Windows 平台跳过', (t) => {
  const userDataDir = createProfileFixture(t);
  const result = seedKimiDesktopTokenStore({
    userDataDir,
    accessToken: 'a',
    refreshToken: 'r'
  }, { fs: nodeFs, path: nodePath, platform: 'darwin' });
  assert.deepEqual(result, { seeded: false, reason: 'unsupported_platform' });
});

test('seed 缺参数时不落盘', (t) => {
  const userDataDir = createProfileFixture(t);
  const result = seedKimiDesktopTokenStore({ userDataDir, accessToken: '', refreshToken: 'r' }, {
    fs: nodeFs, path: nodePath, platform: 'win32'
  });
  assert.deepEqual(result, { seeded: false, reason: 'missing_params' });
  assert.equal(nodeFs.existsSync(nodePath.join(userDataDir, 'bridge-store')), false);
});

test('adopt 在无 token 仓或数据损坏时返回 null', (t) => {
  const userDataDir = createProfileFixture(t);
  const deps = { fs: nodeFs, path: nodePath, ...createFakeDpapiDeps() };
  assert.equal(adoptKimiDesktopTokensFromProfile(userDataDir, deps), null);

  nodeFs.mkdirSync(nodePath.join(userDataDir, 'bridge-store'), { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(userDataDir, 'bridge-store', 'token-store.json'),
    JSON.stringify({ encryption: 'safeStorage.v1', data: Buffer.from('v10corrupted').toString('base64') })
  );
  // Local State 不存在时会新建密钥，但密文不是该密钥所出 → 解密失败 → null
  assert.equal(adoptKimiDesktopTokensFromProfile(userDataDir, deps), null);
});
