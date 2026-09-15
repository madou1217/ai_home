'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { getPublicAccountRef } = require('../account/public-account-ref');
const { extractOAuthEmail } = require('../account/transfer-core');
const {
  readAccountCredentialRecord
} = require('./account-credential-store');

// options.gatewayPinnedProvider —— 调用方声明「我启动的这个 app-server 被钉在本机网关上」
// （-c model_provider=aih_server）。此时 account/read 按 codex 契约返回
// { account: null, requiresOpenaiAuth: false }：自定义 model provider 下不存在 ChatGPT 登录态，
// 这既不是降级也不是异常，而是那种启动形态的正常应答。
//
// 判别式必须是**启动形态**，不是账号类型 —— 两条真实路径的形态正好相反：
//   ws app-server（codex-app-server-endpoint.js:375-386）无条件用网关 URL/key 覆盖 OPENAI_*，
//     OAuth 账号也必然拿到 null account，下面那套严判据在这条路上结构性不可达；
//   reset-credit 的 stdio app-server 只对自带 OPENAI_API_KEY 的 api-key 账号中转
//     （codex-relay-profile.js:13-18），OAuth 账号仍连官方 provider，严判据在那里活着且必须活着。
// 所以由调用方显式声明，绝不靠「account 为空」反推 —— 那等于让被验证方自己决定用哪把尺子。
function createCodexAppServerAccountIdentityValidator(options = {}) {
  return async ({ initializeResult, accountResult } = {}) => (
    validateCodexAppServerAccountIdentity(resolveExpectedIdentity(options), {
      initializeResult,
      accountResult,
      fs: options.fs,
      platform: options.platform,
      gatewayPinnedProvider: options.gatewayPinnedProvider === true
    })
  );
}

function resolveExpectedIdentity(options = {}) {
  const fsImpl = options.fs || fs;
  const accountRef = text(options.accountRef);
  const aiHomeDir = text(options.aiHomeDir);
  const readRecord = options.readAccountCredentialRecord || readAccountCredentialRecord;
  const credential = readRecord(fsImpl, aiHomeDir, accountRef);
  if (!credential || credential.provider !== 'codex') {
    throw identityError('codex_account_identity_unavailable');
  }
  if (credential.accountRef && text(credential.accountRef) !== accountRef) {
    throw identityError('codex_account_identity_local_mismatch');
  }
  if (hasApiKeyCredential(credential)) {
    return Object.freeze({
      kind: 'api-key',
      executionAccountHash: sha256(accountRef)
    });
  }
  const email = extractOAuthEmail('codex', credential.nativeAuth);
  if (!email) throw identityError('codex_account_identity_unavailable');
  const identitySeed = `oauth:codex:${email}`;
  if (getPublicAccountRef(`unique:${identitySeed}`) !== accountRef) {
    throw identityError('codex_account_identity_local_mismatch');
  }
  const getProfileDir = options.getProfileDir;
  const runtimeDir = typeof getProfileDir === 'function'
    ? text(getProfileDir('codex', accountRef))
    : '';
  if (!runtimeDir) throw identityError('codex_account_runtime_home_unavailable');
  return Object.freeze({
    kind: 'oauth',
    identityHash: sha256(identitySeed),
    expectedCodexHome: path.join(runtimeDir, '.codex')
  });
}

function validateCodexAppServerAccountIdentity(expected, options = {}) {
  if (expected.kind === 'api-key') return validateApiKeyExecutionCredential(expected, options);
  const accountResult = record(options.accountResult);
  // 放行必须是合取。只看 account 为空会放过「原生模式但没登录」：那种应答同样没有 account，
  // 而 codexHome 照样匹配（那本来就是我们自己的投影目录），整道闸门会静默失效。
  // api-key 分支早就用 requiresOpenaiAuth 挡住了同一个洞，这里对齐它。
  if (options.gatewayPinnedProvider === true && accountResult.account == null) {
    if (accountResult.requiresOpenaiAuth !== false) {
      throw identityError('codex_app_server_account_identity_missing');
    }
    return validateOAuthRuntimeHome(expected, options);
  }
  // account 非空说明这个进程其实自报了身份（例如根本没被钉住）。那就按下面的严判据逐项核对 ——
  // 能用强判据时绝不退到弱判据。
  const account = record(accountResult.account);
  const actualType = text(account.type).toLowerCase();
  if (actualType !== 'chatgpt') throw identityError('codex_app_server_account_type_mismatch');
  const actualEmail = normalizeEmail(account.email);
  if (!actualEmail) throw identityError('codex_app_server_account_identity_missing');
  const actualIdentityHash = sha256(`oauth:codex:${actualEmail}`);
  if (!sameHash(expected.identityHash, actualIdentityHash)) {
    throw identityError('codex_app_server_account_identity_mismatch');
  }
  return Object.freeze({
    verified: true,
    kind: 'oauth',
    assurance: 'identity',
    identityHash: expected.identityHash,
    runtimeHomeHash: sha256(requireExpectedRuntimeHome(expected, options))
  });
}

// 钉住网关后 codex 不再自报身份，账号绑定整个落到 CODEX_HOME 上：expectedCodexHome 来自
// getProfileDir('codex', accountRef) 的 per-account 凭据投影目录，要求 app-server 自报的
// codexHome 逐字等于它，等价于断言「这个进程正在用、且只能用这个账号的凭据」。
// 它比既有的 api-key 档次更强 —— 后者只要求 codexHome 非空，根本不与任何期望值比对。
// assurance 如实写成 runtime-home 而不是冒充 identity：验到的是运行时家目录，不是对方自报的邮箱。
function validateOAuthRuntimeHome(expected, options = {}) {
  return Object.freeze({
    verified: true,
    kind: 'oauth',
    assurance: 'runtime-home',
    identityHash: expected.identityHash,
    runtimeHomeHash: sha256(requireExpectedRuntimeHome(expected, options))
  });
}

function requireExpectedRuntimeHome(expected, options = {}) {
  const fsImpl = options.fs || fs;
  const expectedHome = normalizePath(expected.expectedCodexHome, fsImpl, options.platform);
  const actualHome = normalizePath(record(options.initializeResult).codexHome, fsImpl, options.platform);
  if (!actualHome || actualHome !== expectedHome) {
    throw identityError('codex_app_server_runtime_home_mismatch');
  }
  return actualHome;
}

function validateApiKeyExecutionCredential(expected, options = {}) {
  const accountResult = record(options.accountResult);
  const account = record(accountResult.account);
  const accountType = text(account.type).toLowerCase();
  if (accountType && accountType !== 'apikey') {
    throw identityError('codex_app_server_account_type_mismatch');
  }
  if (accountResult.requiresOpenaiAuth === true) {
    throw identityError('codex_app_server_account_identity_missing');
  }
  const initializeResult = record(options.initializeResult);
  const runtimeHome = normalizePath(
    initializeResult.codexHome,
    options.fs || fs,
    options.platform
  );
  if (!runtimeHome) throw identityError('codex_app_server_runtime_home_mismatch');
  return Object.freeze({
    verified: true,
    kind: 'api-key',
    assurance: 'execution-credential',
    executionAccountHash: expected.executionAccountHash,
    runtimeHomeHash: sha256(runtimeHome)
  });
}

function hasApiKeyCredential(credential) {
  const env = record(credential.env);
  const nativeAuth = record(credential.nativeAuth);
  const auth = Object.keys(record(nativeAuth.auth)).length > 0
    ? record(nativeAuth.auth)
    : nativeAuth;
  return Boolean(text(env.OPENAI_API_KEY) || text(auth.OPENAI_API_KEY));
}

function normalizeEmail(value) {
  const email = text(value).toLowerCase();
  return email.includes('@') ? email : '';
}

function normalizePath(value, fsImpl, platform = process.platform) {
  const input = text(value);
  if (!input) return '';
  let normalized;
  try {
    normalized = path.resolve(fsImpl.realpathSync(input));
  } catch (_error) {
    normalized = path.resolve(input);
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameHash(left, right) {
  const leftBuffer = Buffer.from(text(left), 'hex');
  const rightBuffer = Buffer.from(text(right), 'hex');
  return leftBuffer.length > 0
    && leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function identityError(code) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = 409;
  return error;
}

module.exports = {
  createCodexAppServerAccountIdentityValidator,
  resolveExpectedIdentity,
  validateCodexAppServerAccountIdentity
};
