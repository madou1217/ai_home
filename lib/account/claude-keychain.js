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
// '-' + sha256(CLAUDE_CONFIG_DIR).hex.slice(0,8) : ''}`. aih gives every
// account its own CLAUDE_CONFIG_DIR (`<profile>/.claude`), so a native `claude`
// login inside account N lands in the SUFFIXED service — reading only the bare
// "Claude Code-credentials" picks up an unrelated (often default-account) token.
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

// options.configDir scopes the read to the account's per-CLAUDE_CONFIG_DIR
// keychain entry (the correct one for aih sandboxes). Falls back to the bare
// global service so accounts that logged in without a custom config dir still
// resolve.
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
  services.push(CLAUDE_KEYCHAIN_SERVICE);

  for (const service of services) {
    const entry = readKeychainEntry(execFileSync, service, account);
    if (entry) return entry;
  }
  return null;
}

// Bridge the keychain credential into the sandbox's .credentials.json once, so
// every file-based reader (status / usage / server / token-refresh) works and
// aih can keep the token fresh itself via the refreshToken — independent of the
// keychain from then on. Intentionally conservative:
//   * darwin only;
//   * never overwrites an existing .credentials.json, so a per-account Web-UI
//     OAuth login (its own file) is preserved and never clobbered by the
//     machine-global keychain;
//   * only writes into an already-initialized .claude directory.
// Returns true only when it actually wrote the file.
function materializeClaudeKeychainCredentials(options = {}) {
  const processObj = options.processObj || process;
  if (!processObj || processObj.platform !== 'darwin') return false;

  const fs = options.fs;
  const path = options.path;
  const profileDir = options.profileDir;
  if (!fs || !path || !profileDir) return false;

  const claudeDir = path.join(profileDir, '.claude');
  if (!fs.existsSync(claudeDir)) return false;

  const credentialsPath = path.join(claudeDir, '.credentials.json');
  if (fs.existsSync(credentialsPath)) return false;

  const creds = readClaudeKeychainCredentials({ processObj, execFileSync: options.execFileSync, configDir: claudeDir });
  if (!creds) return false;

  try {
    const serialized = `${JSON.stringify(creds, null, 2)}\n`;
    const tmpPath = `${credentialsPath}.${processObj.pid || 'aih'}.tmp`;
    fs.writeFileSync(tmpPath, serialized, { mode: 0o600 });
    fs.renameSync(tmpPath, credentialsPath);
    try { fs.chmodSync(credentialsPath, 0o600); } catch (_error) {}
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  CLAUDE_KEYCHAIN_SERVICE,
  buildClaudeKeychainService,
  readClaudeKeychainCredentials,
  materializeClaudeKeychainCredentials
};
