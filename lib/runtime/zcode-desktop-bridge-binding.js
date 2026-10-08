'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readAccountCredentialRecord } = require('../server/account-credential-store');
const { readZcodeOAuthCredential } = require('../account/zcode-credential');
const { resolveAccountRuntimeDir } = require('./aih-storage-layout');
const { isAccountRef } = require('../account/public-account-ref');
const { consistentSubject, readSubjectAliases, tokenSubject } = require('../account/identity-subject');
const { readPrivateJson, ensurePrivateDirectory, bridgeError } = require('./native-session-bridge-files');

const BRIDGE_DIR_ENV = 'AIH_ZCODE_DESKTOP_BRIDGE_DIR';
const BRIDGE_IDENTITY_ENV = 'AIH_ZCODE_DESKTOP_BRIDGE_IDENTITY';
const SOURCES = ['zcode-desktop-bridge-binding.js', 'zcode-desktop-protocol-bridge.js',
  'native-stdio-protocol-tap.js', 'native-session-bridge-files.js'];

function identityFingerprint(oauth) {
  const identity = consistentSubject([readSubjectAliases(oauth?.userInfo || {}, ['user_id', 'userId']),
    tokenSubject(oauth?.jwtToken), tokenSubject(oauth?.accessToken)]);
  return identity ? crypto.createHash('sha256').update(`zcode-desktop:${identity}`).digest('hex') : '';
}

function bridgeVersion() {
  const hash = crypto.createHash('sha256');
  for (const source of SOURCES) hash.update(fs.readFileSync(path.join(__dirname, source)));
  return hash.digest('hex').slice(0, 16);
}

function resolveZcodeDesktopBridgeBinding(options) {
  if (!isAccountRef(options.accountRef) || !options.aiHomeDir) throw bridgeError('zcode_desktop_account_unavailable');
  const record = readAccountCredentialRecord(fs, options.aiHomeDir, options.accountRef);
  if (record?.provider !== 'zcode') throw bridgeError('zcode_desktop_account_unavailable');
  if (record.env.ZCODE_API_KEY) throw bridgeError('zcode_desktop_oauth_required', '该桥接使用 ZCode Desktop 已登录的 OAuth 账号；API Key 请求使用网关。');
  const identity = identityFingerprint(readZcodeOAuthCredential(record.nativeAuth));
  if (!identity) throw bridgeError('zcode_desktop_identity_unavailable');
  const profileDir = resolveAccountRuntimeDir(options.aiHomeDir, 'zcode', options.accountRef);
  return { version: bridgeVersion(), accountRef: options.accountRef, provider: 'zcode', profileDir, identity,
    mailboxDir: path.join(profileDir, '.aih-runtime', 'zcode-desktop-bridge') };
}

function prepareZcodeDesktopBridge(options) {
  if (options.fs && options.fs !== fs) return null;
  const record = readAccountCredentialRecord(fs, options.aiHomeDir, options.accountRef);
  if (record?.provider !== 'zcode' || record.env.ZCODE_API_KEY
    || !identityFingerprint(readZcodeOAuthCredential(record.nativeAuth))) return null;
  const binding = resolveZcodeDesktopBridgeBinding(options);
  for (const part of ['', 'hosts', 'requests', 'results', 'cancellations']) {
    ensurePrivateDirectory(path.join(binding.mailboxDir, part));
  }
  return binding;
}

function nativeIdentityMatches(binding, env = process.env) {
  const credentials = readPrivateJson(path.join(binding.profileDir, '.zcode', 'v2', 'credentials.json'));
  return Boolean(credentials && identityFingerprint(readZcodeOAuthCredential({ credentials }, { env })) === binding.identity);
}

module.exports = { BRIDGE_DIR_ENV, BRIDGE_IDENTITY_ENV, bridgeVersion, identityFingerprint,
  resolveZcodeDesktopBridgeBinding, prepareZcodeDesktopBridge, nativeIdentityMatches };
