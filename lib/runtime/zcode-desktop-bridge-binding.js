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

const SOURCES = ['zcode-desktop-bridge-binding.js', 'zcode-desktop-protocol-bridge.js',
  'native-stdio-protocol-tap.js', 'native-session-bridge-files.js'];

function identityFingerprint(oauth) {
  // 身份以 **zcode 自身的两个来源**为准：`user_info.user_id` 与 `zcodejwt` 的 `sub`。
  // z.ai 的 OAuth `access_token` 的 `sub` 属于**另一个标识空间**（真机同一个人：
  // user_info/zcodejwt = `78601b38-…`，access_token sub = `13740999`），把三者一起送进
  // `consistentSubject` 会得到空串 —— 指纹为空则 `prepareZcodeDesktopBridge` 直接返回 null，
  // 桌面协议桥（WebUI 的 zcode 原生会话通道 + 协议留档）**静默不建立**。
  // 因此先只用 zcode 原生两项；两者也判不出来时再退回三来源口径（保持原有严格性）。
  const aliases = readSubjectAliases(oauth?.userInfo || {}, ['user_id', 'userId']);
  const identity = consistentSubject([aliases, tokenSubject(oauth?.jwtToken)])
    || consistentSubject([aliases, tokenSubject(oauth?.jwtToken), tokenSubject(oauth?.accessToken)]);
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
    mailboxDir: resolveBridgeMailboxDir(profileDir) };
}

// `.aih-runtime` 在 zcode 投影里是 aih 自己建的**共享运行目录符号链接**
// （`<hostHome>/.zcode/.aih-runtime-home/.aih-runtime`，见 lib/runtime/provider-storage-policy.js）。
// 而 `ensurePrivateDirectory` 要求 `realpath === resolve`，于是桥目录永远建不起来 ——
// 表现是桌面协议桥（WebUI 的 zcode 原生会话通道、协议留档）**静默不建立**（真机 2026-10-28）。
// 这里先把链接解析掉再拼桥目录：两侧（策略注入的 mailboxDir 与 runner 的 mailboxDir）
// 用的是同一个绑定结果，因此仍然一致。
function resolveBridgeMailboxDir(profileDir) {
  const runtimeDir = path.join(profileDir, '.aih-runtime');
  try {
    if (fs.existsSync(runtimeDir) && fs.lstatSync(runtimeDir).isSymbolicLink()) {
      return path.join(fs.realpathSync(runtimeDir), 'zcode-desktop-bridge');
    }
  } catch (_error) { /* 解析失败就沿用原路径（后续校验会明确报错） */ }
  return path.join(runtimeDir, 'zcode-desktop-bridge');
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

module.exports = { bridgeVersion, identityFingerprint,
  resolveZcodeDesktopBridgeBinding, prepareZcodeDesktopBridge, nativeIdentityMatches };
