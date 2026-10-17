'use strict';

// 设备指纹策略：两种策略（stable-derived / host-derived）的行为与不变量。
//
// 为什么值得一个专门的测试：设备指纹直接影响上游风控。此前设备 id 的末级回落是
// `crypto.randomUUID()` —— 同一账号每请求换一个指纹，这是最容易被标记的行为，
// 而且静默。本测试把「同一账号永远同一指纹」钉成不变量。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEVICE_PROFILE_STRATEGY_HOST,
  DEVICE_PROFILE_STRATEGY_STABLE,
  defaultDeviceProfile,
  deleteDeviceProfile,
  deriveStableDeviceId,
  normalizeDeviceProfile,
  readDeviceProfile,
  resetDeviceProfile,
  resolveDeviceHeaders,
  writeDeviceProfile
} = require('../lib/account/device-profile');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');

const REF_A = 'acct_33b6d72c47665c11d5ef';
const REF_B = 'acct_611e41c56cc531372d23';

// 凭据写入受外键约束：账号必须先登记。
function registerAccount(aiHomeDir, provider, cliAccountId) {
  return upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `oauth:${provider}:device-profile-${cliAccountId}@example.invalid`
  });
}

function withTempHome(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-device-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('default profile is stable-derived for every field', () => {
  const profile = defaultDeviceProfile();
  for (const field of ['deviceId', 'deviceName', 'deviceModel', 'osVersion']) {
    assert.equal(profile[field], DEVICE_PROFILE_STRATEGY_STABLE, `${field} 默认必须是 stable-derived`);
  }
});

test('stable device id is deterministic for the same account', () => {
  // 核心不变量：同一账号永远同一指纹。这取代了此前的 randomUUID 回落。
  const first = deriveStableDeviceId(REF_A);
  const second = deriveStableDeviceId(REF_A);
  assert.equal(first, second, '同一账号必须派生同一 device id');
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    '必须形如 uuid');
});

test('different accounts derive different device ids', () => {
  assert.notEqual(deriveStableDeviceId(REF_A), deriveStableDeviceId(REF_B));
});

test('reset seed changes the derived id, and only when set', () => {
  const base = deriveStableDeviceId(REF_A);
  const reset = deriveStableDeviceId(REF_A, 'seed-1');
  assert.notEqual(base, reset, '换种子必须换指纹');
  assert.equal(reset, deriveStableDeviceId(REF_A, 'seed-1'), '同种子必须可复现');
  assert.equal(deriveStableDeviceId(REF_A, ''), base, '空种子等价于未重置');
});

test('credential-declared device id always wins over any strategy', () => {
  // 凭据里的 device_id 是官方签发的，策略不该覆盖它 —— 那是账号自己的设备身份。
  const resolved = resolveDeviceHeaders({
    accountRef: REF_A,
    credentialDeviceId: 'official-device-id',
    profile: { deviceId: DEVICE_PROFILE_STRATEGY_HOST }
  });
  assert.equal(resolved.deviceId, 'official-device-id');
});

test('stable-derived does not leak host information', () => {
  const resolved = resolveDeviceHeaders({
    accountRef: REF_A,
    profile: defaultDeviceProfile()
  });
  const hostname = os.hostname();
  const release = os.release();
  assert.ok(!resolved.deviceName.includes(hostname), '设备名不得含宿主主机名');
  assert.ok(!resolved.deviceModel.includes(release), '设备型号不得含宿主系统版本');
  assert.notEqual(resolved.osVersion, release, 'OS 版本不得等于宿主内核版本');
  assert.match(resolved.deviceName, /^kimi-code-cli-/, '设备名取产品身份前缀');
});

test('host-derived uses the running machine', () => {
  const resolved = resolveDeviceHeaders({
    accountRef: REF_A,
    profile: {
      deviceId: DEVICE_PROFILE_STRATEGY_HOST,
      deviceName: DEVICE_PROFILE_STRATEGY_HOST,
      deviceModel: DEVICE_PROFILE_STRATEGY_HOST,
      osVersion: DEVICE_PROFILE_STRATEGY_HOST
    }
  });
  assert.equal(resolved.deviceName, os.hostname());
  assert.equal(resolved.osVersion, os.release());
});

test('strategies are per-field: a mixed profile works', () => {
  // 「id 要稳定、型号要真实」这类组合是合理的，策略不该是全局开关。
  const resolved = resolveDeviceHeaders({
    accountRef: REF_A,
    profile: {
      deviceId: DEVICE_PROFILE_STRATEGY_STABLE,
      deviceName: DEVICE_PROFILE_STRATEGY_STABLE,
      deviceModel: DEVICE_PROFILE_STRATEGY_HOST,
      osVersion: DEVICE_PROFILE_STRATEGY_HOST
    }
  });
  assert.equal(resolved.deviceId, deriveStableDeviceId(REF_A), 'id 走 stable');
  assert.equal(resolved.deviceModel, `${os.type()} ${os.release()} ${os.arch()}`.trim(), '型号走 host');
});

test('unknown strategy values fall back to stable-derived', () => {
  const profile = normalizeDeviceProfile({ deviceId: 'nonsense', deviceName: 42, deviceModel: null });
  for (const field of ['deviceId', 'deviceName', 'deviceModel']) {
    assert.equal(profile[field], DEVICE_PROFILE_STRATEGY_STABLE, '认不出的策略必须回落到保守侧');
  }
});

test('profile round-trips through the credential document', () => {
  withTempHome((aiHomeDir) => {
    const accountRef = registerAccount(aiHomeDir, 'kimi', 1);
    const written = writeDeviceProfile(fs, aiHomeDir, accountRef, {
      deviceId: DEVICE_PROFILE_STRATEGY_HOST,
      deviceName: DEVICE_PROFILE_STRATEGY_STABLE
    });
    assert.equal(written.deviceId, DEVICE_PROFILE_STRATEGY_HOST);

    const read = readDeviceProfile(fs, aiHomeDir, accountRef);
    assert.equal(read.deviceId, DEVICE_PROFILE_STRATEGY_HOST);
    assert.equal(read.deviceName, DEVICE_PROFILE_STRATEGY_STABLE);
    assert.ok(read.updatedAt > 0, '写入必须带时间戳');
  });
});

test('profiles are isolated per account', () => {
  withTempHome((aiHomeDir) => {
    const accountRef = registerAccount(aiHomeDir, 'kimi', 1);
    const otherRef = registerAccount(aiHomeDir, 'kimi', 2);
    writeDeviceProfile(fs, aiHomeDir, accountRef, { deviceId: DEVICE_PROFILE_STRATEGY_HOST });
    assert.equal(readDeviceProfile(fs, aiHomeDir, otherRef).deviceId, DEVICE_PROFILE_STRATEGY_STABLE);
  });
});

test('reset changes the resolved fingerprint and is observable', () => {
  withTempHome((aiHomeDir) => {
    const accountRef = registerAccount(aiHomeDir, 'kimi', 1);
    const before = resolveDeviceHeaders({
      accountRef,
      profile: readDeviceProfile(fs, aiHomeDir, accountRef)
    }).deviceId;

    const reset = resetDeviceProfile(fs, aiHomeDir, accountRef);
    assert.ok(reset.resetSeed, '重置必须写入新种子');

    const after = resolveDeviceHeaders({
      accountRef,
      profile: readDeviceProfile(fs, aiHomeDir, accountRef)
    }).deviceId;
    assert.notEqual(after, before, '重置后指纹必须变化');

    // 重置是持久的：再读一次仍是新值（不会又变回去）。
    const reread = resolveDeviceHeaders({
      accountRef,
      profile: readDeviceProfile(fs, aiHomeDir, accountRef)
    }).deviceId;
    assert.equal(reread, after);
  });
});

test('delete removes the profile so the account falls back to defaults', () => {
  withTempHome((aiHomeDir) => {
    const accountRef = registerAccount(aiHomeDir, 'kimi', 1);
    writeDeviceProfile(fs, aiHomeDir, accountRef, { deviceId: DEVICE_PROFILE_STRATEGY_HOST });
    assert.equal(deleteDeviceProfile(fs, aiHomeDir, accountRef), true);
    assert.equal(readDeviceProfile(fs, aiHomeDir, accountRef).deviceId, DEVICE_PROFILE_STRATEGY_STABLE);
  });
});

test('malformed account refs are rejected instead of writing a stray key', () => {
  withTempHome((aiHomeDir) => {
    const written = writeDeviceProfile(fs, aiHomeDir, 'not-a-ref', { deviceId: DEVICE_PROFILE_STRATEGY_HOST });
    assert.equal(written.deviceId, DEVICE_PROFILE_STRATEGY_STABLE, '非法 ref 必须回落到默认值');
    assert.equal(readDeviceProfile(fs, aiHomeDir, 'not-a-ref').updatedAt, 0);
  });
});

test('the profile lives inside the credential document so it rides the Go projection', () => {
  // 这是存储位置的设计约束：策略必须随凭据一起推送 Go（Go 侧要按同一策略解析指纹）。
  // 存在凭据文档里，投影链路天然带过去；存在别处就要再搭一条同步通道。
  withTempHome((aiHomeDir) => {
    const accountRef = registerAccount(aiHomeDir, 'kimi', 1);
    writeDeviceProfile(fs, aiHomeDir, accountRef, { deviceId: DEVICE_PROFILE_STRATEGY_HOST });
    const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
    assert.ok(nativeAuth.deviceProfile, '必须写在 native_auth_json.deviceProfile');
    assert.equal(nativeAuth.deviceProfile.deviceId, DEVICE_PROFILE_STRATEGY_HOST);
  });
});

test('writing the profile preserves the other credential fields', () => {
  // read-modify-write：凭据文档里还有 token 等字段，整份覆盖会把它们抹掉。
  withTempHome((aiHomeDir) => {
    const accountRef = registerAccount(aiHomeDir, 'kimi', 1);
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
      credentials: { access_token: 'token-1' },
      deviceId: 'official-device-id'
    });
    writeDeviceProfile(fs, aiHomeDir, accountRef, { deviceId: DEVICE_PROFILE_STRATEGY_HOST });

    const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
    assert.equal(nativeAuth.deviceId, 'official-device-id', '既有 deviceId 不得被抹掉');
    assert.equal(nativeAuth.credentials.access_token, 'token-1', '凭据不得被抹掉');
    assert.ok(nativeAuth.deviceProfile, '策略已写入');
  });
});
