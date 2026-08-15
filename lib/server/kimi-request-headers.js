'use strict';

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  deriveKimiDeviceId: deriveKimiDeviceIdFromCredentials,
  resolveKimiOAuthDeviceId
} = require('../account/kimi-auth');

const DEFAULT_KIMI_CODE_VERSION = '0.36.0';
const KIMI_CODE_PLATFORM = 'kimi_code_cli';
const KIMI_CODE_USER_AGENT_PRODUCT = 'kimi-code-cli';

function sanitizeHeaderValue(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

function resolveKimiCodeVersion(options = {}) {
  return sanitizeHeaderValue(
    options.version
      || options.kimiCodeVersion
      || process.env.AIH_KIMI_CODE_VERSION
      || DEFAULT_KIMI_CODE_VERSION
  );
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
  const platform = os.type();
  const version = readMacOsProductVersion(options.execFileSync);
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

function buildKimiRequestHeaders(account, options = {}) {
  const version = resolveKimiCodeVersion(options);
  const deviceId = resolveKimiDeviceId(account);
  const headers = {
    'User-Agent': sanitizeHeaderValue(
      options.userAgent || `${KIMI_CODE_USER_AGENT_PRODUCT}/${version}`
    ),
    'X-Msh-Platform': sanitizeHeaderValue(options.platform || KIMI_CODE_PLATFORM),
    'X-Msh-Version': version,
    'X-Msh-Device-Name': sanitizeHeaderValue(options.deviceName || os.hostname()),
    'X-Msh-Device-Model': resolveKimiDeviceModel(options),
    'X-Msh-Os-Version': sanitizeHeaderValue(options.osVersion || os.release())
  };
  if (deviceId) headers['X-Msh-Device-Id'] = deviceId;
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
