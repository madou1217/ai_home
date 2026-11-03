'use strict';

// 设备指纹策略：把「请求要带什么设备标识」变成**可声明、可切换、可重置**的账号属性。
//
// 背景（2026-10-17）：kimi 的推理请求必须带一组 `X-Msh-*` 设备头。此前这些值的来源
// 分散且有三个隐患：
//   ① 设备 id 的末级回落是 `crypto.randomUUID()` —— 每个请求一个新指纹。这在风控看来
//      是「同一账号的设备在不断变化」，是最容易被标记的行为，而且静默（日志里看不出）；
//   ② 设备名/型号/OS 直接取**运行机器**的 `os.hostname()` / `os.release()` —— 既是宿主
//      信息泄漏，也让 Node→Go 迁移时同一账号的指纹突然变化（那本身就是风控信号）；
//   ③ 用户看不到也改不了自己的设备指纹，风控触发后没有恢复手段。
//
// 本模块提供**两种策略**（用户按账号选，可随时切）：
//
//   stable-derived —— 设备身份从**账号**确定性派生，与运行机器无关：
//                     同一账号永远同一指纹，Node/Go 两侧一致，迁移不变，不泄漏宿主。
//   host-derived   —— 沿用历史行为（取运行机器的真实主机名/系统），
//                     适合「单机自用、希望指纹与真实机器一致」的场景。
//
// 策略是**逐字段**的（deviceId / deviceName / deviceModel / osVersion 各自可选），
// 因为「id 要稳定、型号要真实」这类组合是合理的。默认四字段全 stable-derived。
//
// **存储位置**：策略存在账号凭据文档 `native_auth_json.deviceProfile` 里，不另开 app_kv 键。
// 理由是它必须随凭据一起推送 Go（Go 侧要按同一策略解析同样的指纹）——存在凭据里，
// 投影链路天然带过去；存在别处就要再搭一条同步通道，那正是「两份真相」的来源。

const crypto = require('node:crypto');
const os = require('node:os');

const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../server/account-credential-store');
const { isAccountRef } = require('../server/account-ref-store');

// 两种策略。**不设第三档**：策略数量必须少到用户能理解，新增要先证明它解决的是
// 前两者解决不了的问题。
const DEVICE_PROFILE_STRATEGY_STABLE = 'stable-derived';
const DEVICE_PROFILE_STRATEGY_HOST = 'host-derived';
const DEVICE_PROFILE_STRATEGIES = Object.freeze([
  DEVICE_PROFILE_STRATEGY_STABLE,
  DEVICE_PROFILE_STRATEGY_HOST
]);

// 可独立选策略的字段。顺序即 WebUI 展示顺序。
const DEVICE_PROFILE_FIELDS = Object.freeze([
  'deviceId',
  'deviceName',
  'deviceModel',
  'osVersion'
]);

// stable-derived 下设备名/型号/OS 的中性取值。
//
// 刻意**不**暴露宿主信息，也刻意**不**伪装成某个具体型号（那会让「所有账号都是同一台
// 机器」成为可被关联的特征）。取 kimi-code-cli 这一产品身份即可。
const STABLE_DEVICE_NAME_PREFIX = 'kimi-code-cli';
const STABLE_DEVICE_MODEL = 'kimi-code-cli';
const STABLE_OS_VERSION = '1.0.0';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAccountRef(accountRef) {
  const value = String(accountRef || '').trim();
  return isAccountRef(value) ? value : '';
}

function normalizeStrategy(value, fallback = DEVICE_PROFILE_STRATEGY_STABLE) {
  const normalized = normalizeText(value).toLowerCase();
  return DEVICE_PROFILE_STRATEGIES.includes(normalized) ? normalized : fallback;
}

/** 默认策略：四个字段全 stable-derived。 */
function defaultDeviceProfile() {
  return {
    deviceId: DEVICE_PROFILE_STRATEGY_STABLE,
    deviceName: DEVICE_PROFILE_STRATEGY_STABLE,
    deviceModel: DEVICE_PROFILE_STRATEGY_STABLE,
    osVersion: DEVICE_PROFILE_STRATEGY_STABLE,
    // resetSeed 只在用户显式重置时变化：它是 stable-derived 的派生输入之一，
    // 换它 = 换一套确定性指纹（用于风控触发后的恢复）。
    resetSeed: '',
    updatedAt: 0
  };
}

/**
 * 归一化设备策略记录。
 *
 * 不认识的字段值一律回落到 stable-derived（保守侧）：策略表是稳定合同，
 * 手工改坏的值不该让请求带上不可解释的指纹。
 */
function normalizeDeviceProfile(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const profile = defaultDeviceProfile();
  for (const field of DEVICE_PROFILE_FIELDS) {
    profile[field] = normalizeStrategy(source[field]);
  }
  profile.resetSeed = normalizeText(source.resetSeed).slice(0, 128);
  const updatedAt = Number(source.updatedAt);
  profile.updatedAt = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
  return profile;
}

/** 读取账号的设备策略；没有记录时返回默认值（不落盘）。 */
function readDeviceProfile(fs, aiHomeDir, accountRef) {
  const normalizedRef = String(accountRef || '').trim();
  if (!isAccountRef(normalizedRef)) return defaultDeviceProfile();
  const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, normalizedRef) || {};
  return nativeAuth.deviceProfile
    ? normalizeDeviceProfile(nativeAuth.deviceProfile)
    : defaultDeviceProfile();
}

/**
 * 写入账号的设备策略（写进凭据文档的 deviceProfile 字段）。
 *
 * 用 read-modify-write 而不是整份覆盖：凭据文档里还有 token 等字段，
 * 整份覆盖会把它们抹掉。
 */
function writeDeviceProfile(fs, aiHomeDir, accountRef, value) {
  const normalizedRef = String(accountRef || '').trim();
  if (!isAccountRef(normalizedRef)) return defaultDeviceProfile();
  const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, normalizedRef) || {};
  const profile = normalizeDeviceProfile({ ...value, updatedAt: Date.now() });
  writeAccountNativeAuth(fs, aiHomeDir, normalizedRef, { ...nativeAuth, deviceProfile: profile });
  return profile;
}

/**
 * 重置设备指纹：换一个派生种子。
 *
 * 语义是「让上游看到一台新设备」，因此它**可能触发风控而不是解除**（同一账号换设备
 * 本身就是可疑信号）。调用方必须把这个语义传达给用户——本函数只负责换种子，
 * 不做任何静默处理。
 */
function resetDeviceProfile(fs, aiHomeDir, accountRef) {
  const current = readDeviceProfile(fs, aiHomeDir, accountRef);
  return writeDeviceProfile(fs, aiHomeDir, accountRef, {
    ...current,
    resetSeed: crypto.randomBytes(16).toString('hex')
  });
}

/** 删除账号的设备策略（账号删除时清理）；返回是否真的删掉了。 */
function deleteDeviceProfile(fs, aiHomeDir, accountRef) {
  const normalizedRef = String(accountRef || '').trim();
  if (!isAccountRef(normalizedRef)) return false;
  const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, normalizedRef);
  if (!nativeAuth || !nativeAuth.deviceProfile) return false;
  const next = { ...nativeAuth };
  delete next.deviceProfile;
  writeAccountNativeAuth(fs, aiHomeDir, normalizedRef, next);
  return true;
}

/**
 * 从账号派生稳定的设备 id（uuid v5 风格：sha256 取前 32 位十六进制，按 uuid 分段）。
 *
 * 确定性：同一 (accountRef, resetSeed) 永远同一值。这是 stable-derived 策略下
 * 取代 `crypto.randomUUID()` 的关键——随机回落会让同一账号每请求换指纹。
 */
function deriveStableDeviceId(accountRef, resetSeed = '') {
  const normalizedRef = normalizeAccountRef(accountRef);
  if (!normalizedRef) return '';
  const digest = crypto
    .createHash('sha256')
    .update(`aih-device:${normalizedRef}:${normalizeText(resetSeed)}`)
    .digest('hex')
    .slice(0, 32);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32)
  ].join('-');
}

/** 取运行机器的主机名（host-derived 策略用）。 */
function readHostName() {
  try {
    return normalizeText(os.hostname());
  } catch (_error) {
    return '';
  }
}

/** 取运行机器的系统版本串（host-derived 策略用）。 */
function readHostOsVersion() {
  try {
    return normalizeText(os.release());
  } catch (_error) {
    return '';
  }
}

/** 取运行机器的型号串（host-derived 策略用）。 */
function readHostDeviceModel() {
  try {
    const platform = os.type();
    const release = normalizeText(os.release());
    const arch = normalizeText(os.arch());
    return normalizeText(`${platform} ${release} ${arch}`);
  } catch (_error) {
    return '';
  }
}

/**
 * 按策略解析一组设备指纹值。
 *
 * @param {object} input
 * @param {string} input.accountRef      账号引用（stable-derived 的派生输入）
 * @param {string} input.credentialDeviceId 凭据里声明的 device_id（最权威，优先于一切策略）
 * @param {object} input.profile         设备策略（readDeviceProfile 的返回值）
 * @returns {{deviceId: string, deviceName: string, deviceModel: string, osVersion: string}}
 */
function resolveDeviceHeaders(input = {}) {
  const accountRef = normalizeAccountRef(input.accountRef);
  const profile = normalizeDeviceProfile(input.profile);
  const credentialDeviceId = normalizeText(input.credentialDeviceId);

  // 凭据里声明的 device_id 是**官方签发**的，任何策略都不该覆盖它 ——
  // 那是账号自己的设备身份，改它等于伪装成另一台设备。
  const deviceId = credentialDeviceId || (
    profile.deviceId === DEVICE_PROFILE_STRATEGY_HOST
      ? readHostName()
      : deriveStableDeviceId(accountRef, profile.resetSeed)
  );

  const deviceName = profile.deviceName === DEVICE_PROFILE_STRATEGY_HOST
    ? readHostName()
    : `${STABLE_DEVICE_NAME_PREFIX}-${deviceId.slice(0, 8)}`;
  const deviceModel = profile.deviceModel === DEVICE_PROFILE_STRATEGY_HOST
    ? readHostDeviceModel()
    : STABLE_DEVICE_MODEL;
  const osVersion = profile.osVersion === DEVICE_PROFILE_STRATEGY_HOST
    ? readHostOsVersion()
    : STABLE_OS_VERSION;

  return { deviceId, deviceName, deviceModel, osVersion };
}

module.exports = {
  DEVICE_PROFILE_FIELDS,
  DEVICE_PROFILE_STRATEGIES,
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
};
