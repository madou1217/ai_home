'use strict';

// On macOS, Claude Code stores its OAuth credentials in the login Keychain
// (service "Claude Code-credentials") instead of <config>/.credentials.json.
// aih sandboxes share the host login keychain (Library/Keychains is symlinked
// back to the host), so a native `claude` login inside a sandbox lands in the
// keychain and is invisible to the file-based readers. That makes aih nag
// "Account N exists but seems to have no login state" on every launch and
// report "usage remaining: unknown", even though the account is logged in.
//
// This adapter reads and updates the exact Claude Code keychain item. Account
// reconciliation remains outside this module so shared host credentials can
// never be copied into an unrelated ai-home account by accident.

const crypto = require('node:crypto');
const os = require('node:os');
const { isDeepStrictEqual } = require('node:util');

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
// `security -i` reads one command line into a 4 KiB buffer. Keep a small
// margin, matching Claude Code's own macOS secure-storage implementation.
const SECURITY_STDIN_LINE_LIMIT = 4096 - 64;

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Claude Code derives its keychain service name from CLAUDE_CONFIG_DIR. From
// cli.js: `Claude Code${OAUTH_FILE_SUFFIX}-credentials${CLAUDE_CONFIG_DIR ?
// '-' + sha256(CLAUDE_CONFIG_DIR).hex.slice(0,8) : ''}`. aih gives each login a
// disposable CLAUDE_CONFIG_DIR, so that login lands in a scoped service. Reading
// only the bare service could capture an unrelated host credential.
function buildClaudeKeychainService(configDir) {
  const dir = String(configDir || '').trim();
  if (!dir) return CLAUDE_KEYCHAIN_SERVICE;
  const suffix = crypto.createHash('sha256').update(dir).digest('hex').substring(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

// Claude Code looks the entry up with `-a An() -s <service>`, where
// An() === process.env.USER || os.userInfo().username || "claude-code-user".
// Matching the account is essential: a service can hold several items (e.g. a
// stale `acct=unknown` left by an older write shadowing the live `acct=$USER`
// one), and `-s` alone returns an arbitrary/oldest match.
function resolveKeychainAccount() {
  const envUser = String(process.env.USER || '').trim();
  if (envUser) return envUser;
  try {
    const name = String(os.userInfo().username || '').trim();
    if (name) return name;
  } catch (_error) {}
  return 'claude-code-user';
}

function runSecurityRead(execFileSync, args) {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', ...args, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
    );
  } catch (_error) {
    // No matching keychain item, locked keychain, or `security` unavailable.
    return null;
  }
}

function hasUsableOAuthTokens(credentials) {
  const oauth = credentials && (credentials.claudeAiOauth || credentials.claude_ai_oauth);
  if (!oauth || typeof oauth !== 'object') return false;
  return (hasNonEmptyString(oauth.accessToken) || hasNonEmptyString(oauth.access_token))
    && (hasNonEmptyString(oauth.refreshToken) || hasNonEmptyString(oauth.refresh_token));
}

function parseKeychainCredentials(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const oauth = parsed.claudeAiOauth || parsed.claude_ai_oauth;
  if (!oauth || typeof oauth !== 'object') return null;

  const hasToken = hasNonEmptyString(oauth.accessToken)
    || hasNonEmptyString(oauth.access_token)
    || hasNonEmptyString(oauth.refreshToken)
    || hasNonEmptyString(oauth.refresh_token);
  if (!hasToken) return null;

  return parsed;
}

function readKeychainEntry(execFileSync, service, account) {
  const lookups = account ? [['-a', account, '-s', service]] : [['-s', service]];
  for (const lookupArgs of lookups) {
    const credentials = parseKeychainCredentials(runSecurityRead(execFileSync, lookupArgs));
    if (credentials) return { credentials, lookupArgs };
  }
  return null;
}

function runSecurityMetadataRead(execFileSync, args) {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
    );
  } catch (_error) {
    return '';
  }
}

function parseClaudeKeychainModifiedAt(raw) {
  const match = String(raw || '').match(/"mdat"<timedate>=[^\r\n]*?"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/);
  if (!match) return 0;
  const parts = match.slice(1).map(Number);
  const timestamp = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function resolveExecFileSync(options = {}) {
  if (typeof options.execFileSync === 'function') return options.execFileSync;
  try {
    return require('child_process').execFileSync;
  } catch (_error) {
    return null;
  }
}

function resolveKeychainServices(options = {}) {
  const services = [];
  if (hasNonEmptyString(options.configDir)) {
    services.push(buildClaudeKeychainService(options.configDir));
  }
  if (options.includeDefaultService !== false || services.length === 0) {
    services.push(CLAUDE_KEYCHAIN_SERVICE);
  }
  return services;
}

function findClaudeKeychainEntry(options = {}) {
  const processObj = options.processObj || process;
  if (!processObj || processObj.platform !== 'darwin') return null;
  const execFileSync = resolveExecFileSync(options);
  if (!execFileSync) return null;

  const account = hasNonEmptyString(options.account) ? String(options.account).trim() : resolveKeychainAccount();
  for (const service of resolveKeychainServices(options)) {
    const entry = readKeychainEntry(execFileSync, service, account);
    if (!entry) continue;
    return {
      credentials: entry.credentials,
      execFileSync,
      lookupArgs: entry.lookupArgs,
      account,
      service
    };
  }
  return null;
}

function readClaudeKeychainCredentialRecord(options = {}) {
  const entry = findClaudeKeychainEntry(options);
  if (!entry) return null;
  const metadata = runSecurityMetadataRead(entry.execFileSync, entry.lookupArgs);
  return {
    credentials: entry.credentials,
    modifiedAtMs: parseClaudeKeychainModifiedAt(metadata),
    account: entry.account,
    service: entry.service
  };
}

// options.configDir scopes the read to a login CLAUDE_CONFIG_DIR keychain entry.
// Callers that capture a login disable the global fallback to avoid importing
// an unrelated host credential.
function readClaudeKeychainCredentials(options = {}) {
  const entry = findClaudeKeychainEntry(options);
  return entry ? entry.credentials : null;
}

function runSecurityWrite(execFileSync, credentials, account, service) {
  const json = JSON.stringify(credentials);
  const hex = Buffer.from(json, 'utf8').toString('hex');
  const escapeArgument = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const command = `add-generic-password -U -a "${escapeArgument(account)}" -s "${escapeArgument(service)}" -X "${hex}"\n`;
  if (Buffer.byteLength(command, 'utf8') > SECURITY_STDIN_LINE_LIMIT) {
    const error = new Error('claude_keychain_payload_too_large');
    error.code = 'claude_keychain_payload_too_large';
    throw error;
  }

  // This is the same mechanism used by Claude Code: interactive mode keeps the
  // credential out of argv while `-X` avoids prompt truncation and escaping.
  execFileSync('security', ['-i'], {
    encoding: 'utf8',
    input: command,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000
  });
}

function writeClaudeKeychainCredentials(credentials, options = {}) {
  const processObj = options.processObj || process;
  if (!processObj || processObj.platform !== 'darwin') {
    return { ok: false, reason: 'unsupported_platform' };
  }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  // 没有 token 的信封写进去，等于把宿主的登录态抹成「已登录但没凭据」，
  // Claude Code 读到就报 `Login expired · Please run /login`。宁可写失败，
  // 也不能用一个空信封覆盖掉还能用的登录。
  if (!hasUsableOAuthTokens(credentials)) {
    return { ok: false, reason: 'unusable_credentials' };
  }
  const execFileSync = resolveExecFileSync(options);
  if (!execFileSync) return { ok: false, reason: 'security_unavailable' };

  const account = hasNonEmptyString(options.account) ? String(options.account).trim() : resolveKeychainAccount();
  const service = buildClaudeKeychainService(options.configDir);
  try {
    runSecurityWrite(execFileSync, credentials, account, service);
    const stored = parseKeychainCredentials(runSecurityRead(execFileSync, ['-a', account, '-s', service]));
    if (!isDeepStrictEqual(stored, credentials)) {
      return { ok: false, reason: 'verification_failed', account, service };
    }
    return { ok: true, account, service };
  } catch (error) {
    const reason = error && error.code === 'claude_keychain_payload_too_large'
      ? 'payload_too_large'
      : 'security_failed';
    return { ok: false, reason, account, service };
  }
}

module.exports = {
  CLAUDE_KEYCHAIN_SERVICE,
  buildClaudeKeychainService,
  parseClaudeKeychainModifiedAt,
  readClaudeKeychainCredentialRecord,
  readClaudeKeychainCredentials,
  writeClaudeKeychainCredentials
};
