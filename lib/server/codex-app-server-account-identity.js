'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { getPublicAccountRef } = require('../account/public-account-ref');
const { extractOAuthEmail } = require('../account/transfer-core');
const {
  readAccountCredentialRecord
} = require('./account-credential-store');

function createCodexAppServerAccountIdentityValidator(options = {}) {
  return async ({ initializeResult, accountResult } = {}) => (
    validateCodexAppServerAccountIdentity(resolveExpectedIdentity(options), {
      initializeResult,
      accountResult,
      fs: options.fs,
      platform: options.platform
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
  const account = record(accountResult.account);
  const actualType = text(account.type).toLowerCase();
  if (actualType !== 'chatgpt') throw identityError('codex_app_server_account_type_mismatch');
  const actualEmail = normalizeEmail(account.email);
  if (!actualEmail) throw identityError('codex_app_server_account_identity_missing');
  const actualIdentityHash = sha256(`oauth:codex:${actualEmail}`);
  if (!sameHash(expected.identityHash, actualIdentityHash)) {
    throw identityError('codex_app_server_account_identity_mismatch');
  }
  const fsImpl = options.fs || fs;
  const expectedHome = normalizePath(expected.expectedCodexHome, fsImpl, options.platform);
  const initializeResult = record(options.initializeResult);
  const actualHome = normalizePath(initializeResult.codexHome, fsImpl, options.platform);
  if (!actualHome || actualHome !== expectedHome) {
    throw identityError('codex_app_server_runtime_home_mismatch');
  }
  return Object.freeze({
    verified: true,
    kind: 'oauth',
    assurance: 'identity',
    identityHash: expected.identityHash,
    runtimeHomeHash: sha256(actualHome)
  });
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
