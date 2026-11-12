'use strict';

// 回归守卫（2026-11-03 真机）：WebUI 登录成功，打开桌面端却显示「请先登录」。
//
// 链路：桌面端 `OAuthCredentialRepo.loadUserProfileFromKey` 只接受
// `{id, username, displayName}` 三个字符串；bigmodel 没有旧格式兜底。aih 的登录
// 写入器过去把上游 user_info 原样落盘（`{user_id,email,avatar,name}`），于是
// `resolveCurrentAccountAccess` 返回 null → providerCount 0 → 「请先登录」。
//
// 守卫两段：
//   1. 归一化函数本身的字段映射（id 取 user_id，展示名取 name，rawProfile 保留）；
//   2. 存量投影文件的就地修复：只动 user_info，token 原样，幂等。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  decryptZcodeCredentialValue,
  encryptZcodeCredentialValue
} = require('../lib/account/zcode-credential');
const { normalizeZcodeUserProfile, resolveZcodeDisplayName } = require('../lib/account/zcode-identity');
const {
  repairZcodeProjectionCredentialProfile
} = require('../lib/account/zcode-projection-credentials');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-cred-'));
  const v2 = path.join(root, '.zcode', 'v2');
  fs.mkdirSync(v2, { recursive: true });
  return { root, credentialsPath: path.join(v2, 'credentials.json') };
}

function writeCredentials(credentialsPath, credentials) {
  fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
}

function readUserInfo(credentialsPath, key) {
  const stored = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))[key];
  return JSON.parse(decryptZcodeCredentialValue(stored));
}

test('normalizeZcodeUserProfile：bigmodel 原始形状映射成桌面端契约', () => {
  const profile = normalizeZcodeUserProfile(
    { user_id: '23701694489963901', email: 'ma****17@126.com', avatar: '', name: 'MeaDeo' },
    { region: 'bigmodel' }
  );
  assert.equal(profile.id, '23701694489963901');
  assert.equal(profile.username, 'MeaDeo');
  assert.equal(profile.displayName, 'MeaDeo');
  assert.equal(profile.avatarUrl, undefined);
  assert.equal(profile.rawProfile.name, 'MeaDeo');
  assert.equal(profile.rawProfile.zcodeProfileSchemaVersion, 2);

  // 上游没给名字时退回邮箱；打码邮箱不能当账号展示名。
  const masked = normalizeZcodeUserProfile({ user_id: 'u1', email: 'ma****17@126.com' }, { region: 'bigmodel' });
  assert.equal(masked.displayName, 'ma****17@126.com');
  assert.equal(resolveZcodeDisplayName(masked), 'ZCode OAuth');

  // 没有 id 时不生成半截身份。
  assert.equal(normalizeZcodeUserProfile({ email: 'a@b.com' }), null);
  assert.equal(normalizeZcodeUserProfile(null), null);
});

test('存量投影：旧 user_info 就地归一化，token 不动且幂等', () => {
  const { root, credentialsPath } = makeSandbox();
  const accessToken = encryptZcodeCredentialValue('access-token-1');
  const jwt = encryptZcodeCredentialValue('jwt-1');
  writeCredentials(credentialsPath, {
    'oauth:active_provider': encryptZcodeCredentialValue('bigmodel'),
    'oauth:bigmodel:access_token': accessToken,
    zcodejwttoken: jwt,
    'oauth:bigmodel:user_info': encryptZcodeCredentialValue(JSON.stringify({
      user_id: '23701694489963901',
      email: 'ma****17@126.com',
      avatar: '',
      name: 'MeaDeo'
    }))
  });

  const first = repairZcodeProjectionCredentialProfile({ sandboxDir: root });
  assert.deepEqual(first.repaired, ['oauth:bigmodel:user_info']);
  assert.deepEqual(first.errors, []);

  const userInfo = readUserInfo(credentialsPath, 'oauth:bigmodel:user_info');
  assert.equal(userInfo.id, '23701694489963901');
  assert.equal(userInfo.username, 'MeaDeo');
  assert.equal(userInfo.displayName, 'MeaDeo');
  assert.equal(userInfo.rawProfile.email, 'ma****17@126.com');

  const after = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  assert.equal(decryptZcodeCredentialValue(after['oauth:bigmodel:access_token']), 'access-token-1');
  assert.equal(decryptZcodeCredentialValue(after.zcodejwttoken), 'jwt-1');

  const second = repairZcodeProjectionCredentialProfile({ sandboxDir: root });
  assert.deepEqual(second.repaired, []);
  assert.deepEqual(second.errors, []);

  fs.rmSync(root, { recursive: true, force: true });
});

test('存量投影：读不出来的密文保持原样（跨机导入不能就地覆盖）', () => {
  const { root, credentialsPath } = makeSandbox();
  const broken = 'enc:v1:AAAA.BBBB.CCCC';
  writeCredentials(credentialsPath, {
    'oauth:zai:user_info': broken,
    'oauth:zai:access_token': encryptZcodeCredentialValue('zai-token')
  });

  const result = repairZcodeProjectionCredentialProfile({ sandboxDir: root });
  assert.deepEqual(result.repaired, []);
  assert.deepEqual(result.errors, []);
  const after = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  assert.equal(after['oauth:zai:user_info'], broken);

  fs.rmSync(root, { recursive: true, force: true });
});

test('存量投影：明文旧形态（老 zai 投影）同样归一化，且保持明文', () => {
  const { root, credentialsPath } = makeSandbox();
  writeCredentials(credentialsPath, {
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': 'plain-access',
    'oauth:zai:user_info': JSON.stringify({
      user_id: '68a8c2ed-35aa-4f66-82bf-3e34a5239ab7',
      email: '18997991630@phone.local',
      avatar: 'https://chat.z.ai/user.png',
      name: '旅行者1630'
    })
  });

  const result = repairZcodeProjectionCredentialProfile({ sandboxDir: root });
  assert.deepEqual(result.repaired, ['oauth:zai:user_info']);

  const after = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  assert.equal(after['oauth:zai:access_token'], 'plain-access');
  const userInfo = JSON.parse(after['oauth:zai:user_info']);
  assert.equal(userInfo.id, '68a8c2ed-35aa-4f66-82bf-3e34a5239ab7');
  assert.equal(userInfo.displayName, '旅行者1630');
  assert.equal(userInfo.avatarUrl, 'https://chat.z.ai/user.png');
  // zai 不写 bigmodel 专属的 schema 版本号。
  assert.equal(userInfo.rawProfile.zcodeProfileSchemaVersion, undefined);

  fs.rmSync(root, { recursive: true, force: true });
});

test('没有 credentials.json 时不报错（未登录账号）', () => {
  const { root } = makeSandbox();
  const result = repairZcodeProjectionCredentialProfile({ sandboxDir: root });
  assert.deepEqual(result.repaired, []);
  assert.deepEqual(result.errors, []);
  fs.rmSync(root, { recursive: true, force: true });
});
