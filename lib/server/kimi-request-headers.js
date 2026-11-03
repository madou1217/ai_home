'use strict';

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  deriveKimiDeviceId: deriveKimiDeviceIdFromCredentials,
  resolveKimiOAuthDeviceId
} = require('../account/kimi-auth');
const { resolveDeviceHeaders } = require('../account/device-profile');
const { getKimiClientVersionSync } = require('./kimi-client-version');

// 兜底版本（离线、本地无 CLI、registry 不可达时的最后一档）。
// 实际取值由 kimi-client-version 动态解析：本地实测 → 远端最新 → 这个常量。
const DEFAULT_KIMI_CODE_VERSION = '0.36.0';
const KIMI_CODE_PLATFORM = 'kimi_code_cli';
const KIMI_CODE_USER_AGENT_PRODUCT = 'kimi-code-cli';

function sanitizeHeaderValue(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

function resolveKimiCodeVersion(options = {}) {
  const configured = sanitizeHeaderValue(
    options.version
      || options.kimiCodeVersion
  );
  if (configured) return configured;
  // 动态解析：本地 CLI 实测 → 远端 npm 最新（不要求装了 CLI）→ 兜底常量。
  // 结果带 TTL 缓存，请求路径不发起网络请求（见 kimi-client-version 的说明）。
  return sanitizeHeaderValue(getKimiClientVersionSync(options))
    || sanitizeHeaderValue(DEFAULT_KIMI_CODE_VERSION);
}

function readMacOsProductVersion(exec = execFileSync) {
  if (process.platform !== 'darwin' || typeof exec !== 'function') return '';
  try {
    return sanitizeHeaderValue(exec('/usr/bin/sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }));
  } catch (_error) {
    return '';
  }
}

function resolveKimiDeviceModel(options = {}) {
  const configured = sanitizeHeaderValue(options.deviceModel);
  if (configured) return configured;
  return resolveHostDeviceModel();
}

// resolveHostDeviceModel 取运行机器的型号串（host-derived 策略用）。
//
// 与设备指纹策略的分工：本函数只回答「这台机器是什么」，由 device-profile 决定
// 某个账号是否**采用**它。默认策略是 stable-derived，因此正常情况下不会走到这里。
function resolveHostDeviceModel() {
  const platform = os.type();
  const version = readMacOsProductVersion();
  const release = sanitizeHeaderValue(os.release());
  const arch = sanitizeHeaderValue(os.arch());
  if (process.platform === 'darwin') {
    return sanitizeHeaderValue(`macOS ${version || release} ${arch}`);
  }
  if (platform === 'Windows_NT') {
    return sanitizeHeaderValue(`Windows ${release} ${arch}`);
  }
  return sanitizeHeaderValue(`${platform} ${release} ${arch}`);
}

function resolveKimiDeviceId(account) {
  return sanitizeHeaderValue(resolveKimiOAuthDeviceId(account));
}

/**
 * 构建设备指纹头。
 *
 * 值从**账号的设备策略**解析（见 lib/account/device-profile.js）：
 *   - 默认 stable-derived：同一账号永远同一指纹，与运行机器无关；
 *   - host-derived：沿用历史行为（取运行机器信息）。
 *
 * 策略由调用方通过 options.deviceProfile 传入（它需要读账号存储，本模块不做 I/O）；
 * 未传时按默认策略解析，因此「忘了接线」不会退回随机指纹。
 *
 * 凭据里声明的 device_id 永远优先（官方签发，策略不覆盖）。
 */
function buildKimiDeviceHeaders(account, options = {}) {
  const resolved = resolveDeviceHeaders({
    accountRef: resolveAccountRefFromAccount(account),
    credentialDeviceId: resolveKimiDeviceId(account),
    profile: options.deviceProfile
  });
  const headers = {
    'X-Msh-Device-Name': sanitizeHeaderValue(options.deviceName || resolved.deviceName),
    'X-Msh-Device-Model': sanitizeHeaderValue(options.deviceModel || resolved.deviceModel),
    'X-Msh-Os-Version': sanitizeHeaderValue(options.osVersion || resolved.osVersion)
  };
  if (resolved.deviceId) headers['X-Msh-Device-Id'] = resolved.deviceId;
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value));
}

/** 从账号对象取 accountRef（兼容 accountRef / account_ref 两种写法）。 */
function resolveAccountRefFromAccount(account) {
  return sanitizeHeaderValue(
    account && (account.accountRef || account.account_ref || account.accountRefRaw)
  );
}

function buildKimiRequestHeaders(account, options = {}) {
  const version = resolveKimiCodeVersion(options);
  const headers = {
    'User-Agent': sanitizeHeaderValue(
      options.userAgent || `${KIMI_CODE_USER_AGENT_PRODUCT}/${version}`
    ),
    'X-Msh-Platform': sanitizeHeaderValue(options.platform || KIMI_CODE_PLATFORM),
    'X-Msh-Version': version,
    ...buildKimiDeviceHeaders(account, options)
  };
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value));
}

function deriveKimiDeviceId(credentials) {
  return sanitizeHeaderValue(deriveKimiDeviceIdFromCredentials(credentials));
}

module.exports = {
  DEFAULT_KIMI_CODE_VERSION,
  KIMI_CODE_PLATFORM,
  buildKimiRequestHeaders,
  deriveKimiDeviceId,
  resolveKimiCodeVersion,
  resolveKimiDeviceId,
  __private: {
    readMacOsProductVersion,
    resolveKimiDeviceModel,
    sanitizeHeaderValue
  }
};
