'use strict';

// On macOS, Claude Code stores its OAuth credentials in the login Keychain
// (service "Claude Code-credentials") instead of <config>/.credentials.json.
// aih sandboxes share the host login keychain (Library/Keychains is symlinked
// back to the host), so a native `claude` login inside a sandbox lands in the
// keychain and is invisible to the file-based readers. That makes aih nag
// "Account N exists but seems to have no login state" on every launch and
// report "usage remaining: unknown", even though the account is logged in.
//
// This helper reads the keychain entry and returns it in the exact same shape
// as .credentials.json ({ claudeAiOauth: { accessToken, refreshToken, ... } }),
// so status / usage checks can fall back to it on darwin. It is read-only: we
// never persist the (shared, global) keychain token into a per-account file, to
// avoid both staleness and cross-account credential bleed.

const crypto = require('node:crypto');
const os = require('node:os');

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

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

function readKeychainEntry(execFileSync, service, account) {
  // Prefer the account-scoped lookup (claude-code's exact query); fall back to
  // service-only for entries written without a matching account.
  let raw = account ? runSecurityRead(execFileSync, ['-a', account, '-s', service]) : null;
  if (!String(raw || '').trim()) {
    raw = runSecurityRead(execFileSync, ['-s', service]);
  }

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

// options.configDir scopes the read to a login CLAUDE_CONFIG_DIR keychain entry.
// Callers that capture a login disable the global fallback to avoid importing
// an unrelated host credential.
function readClaudeKeychainCredentials(options = {}) {
  const processObj = options.processObj || process;
  if (!processObj || processObj.platform !== 'darwin') return null;

  let execFileSync = options.execFileSync;
  if (typeof execFileSync !== 'function') {
    try {
      ({ execFileSync } = require('child_process'));
    } catch (_error) {
      return null;
    }
  }

  const account = hasNonEmptyString(options.account) ? String(options.account).trim() : resolveKeychainAccount();
  const services = [];
  if (hasNonEmptyString(options.configDir)) {
    services.push(buildClaudeKeychainService(options.configDir));
  }
  if (options.includeDefaultService !== false || services.length === 0) {
    services.push(CLAUDE_KEYCHAIN_SERVICE);
  }

  for (const service of services) {
    const entry = readKeychainEntry(execFileSync, service, account);
    if (entry) return entry;
  }
  return null;
}

module.exports = {
  CLAUDE_KEYCHAIN_SERVICE,
  buildClaudeKeychainService,
  readClaudeKeychainCredentials
};
