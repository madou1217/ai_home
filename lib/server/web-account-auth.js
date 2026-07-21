'use strict';

const path = require('node:path');
const { registerProviderAuthProjection } = require('../account/native-auth-projection');
const { registerAccountIdentity } = require('../account/account-registration');
const { resolveIdentitySeedFromAccount } = require('../account/account-identity');
const { isAccountRef, resolveAccountRef } = require('./account-ref-store');
const { resolveLoginRuntimeDir } = require('../runtime/aih-storage-layout');
const crypto = require('node:crypto');

const { AI_CLI_CONFIGS } = require('../cli/services/ai-cli/provider-registry');
const {
  buildProviderRuntimeEnv,
  prepareProviderRuntime
} = require('../cli/services/ai-cli/provider-runtime-env');
const {
  CLAUDE_CREDENTIAL_TYPES,
  writeClaudeCredentialEnv
} = require('../account/claude-credential');
const { normalizeCredentialConfig } = require('../profile/credential-config');
const { writeAccountCredentials } = require('./account-credential-store');
const { resolveNativeCliPath } = require('../runtime/native-cli-resolver');
const { loadNodePty: loadRuntimeNodePty } = require('../runtime/node-pty-loader');
const { buildPtyLaunch, resolveWindowsBatchLaunch } = require('../runtime/pty-launch');
const { resolveCodexSqliteHome } = require('../runtime/codex-home');
const {
  extractCodexMetadata,
  normalizeCodexRefreshToken
} = require('../account/codex-auth-metadata');
const { startOauthLoopbackCallbackServer } = require('./oauth-loopback-callback');
const { resolveLoginStrategy } = require('./oauth-login-strategies');
const {
  OAUTH_PENDING_FALLBACK_STALE_MS,
  resolveOauthJobDeadline
} = require('./oauth-pending-state');

const JOB_LOG_LIMIT = 40000;
const FINISHED_JOB_TTL_MS = 15 * 60 * 1000;
const PROVIDER_AUTH_MODE_MATRIX = Object.freeze({
  codex: Object.freeze(['oauth-browser', 'oauth-device', 'api-key']),
  claude: Object.freeze(['oauth-browser', 'api-key', 'auth-token']),
  gemini: Object.freeze(['oauth-browser', 'api-key']),
  agy: Object.freeze(['oauth-browser']),
  opencode: Object.freeze(['oauth-browser'])
});
const PROVIDER_DEFAULT_AUTH_MODE = Object.freeze({
  codex: 'oauth-browser',
  claude: 'oauth-browser',
  gemini: 'oauth-browser',
  agy: 'oauth-browser',
  opencode: 'oauth-browser'
});

const DEVICE_CODE_DURATION_UNITS_MS = Object.freeze({
  second: 1000,
  seconds: 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000
});
const RFC8628_DEFAULT_POLL_INTERVAL_MS = 5000;
const BROWSER_CAPTURE_UNIX = '.aih-browser-capture.sh';
const BROWSER_CAPTURE_WIN = 'aih-browser-capture.cmd';
const CODEX_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
// Claude Code's own OAuth client. aih drives the same loopback flow the CLI uses
// so it can auto-capture the callback on the same machine and write credentials
// straight to .credentials.json (the only place aih reads claude tokens from).
// The loopback redirect URIs live with each provider's login strategy.
const CLAUDE_OAUTH_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // gitleaks:allow
const CLAUDE_OAUTH_SCOPE = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const MANUAL_CALLBACK_OAUTH_TTL_MS = OAUTH_PENDING_FALLBACK_STALE_MS;
const AUTH_PROGRESS_STATES = Object.freeze({
  STARTING: 'starting',
  AWAITING_LOGIN_METHOD: 'awaiting_login_method',
  LOGIN_METHOD_SELECTED: 'login_method_selected',
  AUTH_URL_READY: 'auth_url_ready',
  AWAITING_CODE: 'awaiting_code',
  SUBMITTED_CODE: 'submitted_code',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  EXPIRED: 'expired'
});

function loadNodePty() {
  return loadRuntimeNodePty();
}

function createLazyPtyAdapter() {
  let cachedPty = null;
  return {
    spawn(command, args, options) {
      if (!cachedPty) cachedPty = loadNodePty();
      return cachedPty.spawn(command, args, options);
    }
  };
}

// Strips terminal escape sequences from CLI output. Modern Claude/Codex CLIs
// emit more than plain SGR colors: Kitty keyboard protocol sequences such as
// \x1b[>1u / \x1b[<u / \x1b[=1;2u (private "<=>" prefix, `u` final byte) and
// OSC 8 hyperlinks that wrap the OAuth URL. The previous regex left fragments
// like "1u" in the log and let hyperlink wrappers corrupt the extracted URL and
// state, which broke browser authorization.
//
// OSC 8 hyperlinks (\x1b]8;params;URI ST  LABEL  \x1b]8;; ST) are unwrapped so
// the URI survives as plain text for URL extraction; every other escape sequence
// is removed outright. Valid string terminators (ST) are BEL or ESC-backslash.
const OSC8_HYPERLINK = /\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// CSI: ESC[ (or single-byte CSI) + private prefix + parameters + intermediates + final byte.
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[<=>?]*[0-9;]*[ -\/]*[@-~]/g;
// Any remaining lone Fe escape (e.g. a stray ESC-backslash terminator).
const LONE_ESCAPE = /\u001b[@-_]/g;

function stripAnsi(text) {
  return String(text || '')
    .replace(OSC8_HYPERLINK, (_match, uri) => (uri ? ` ${uri} ` : ''))
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(LONE_ESCAPE, '');
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function createPkcePair() {
  const codeVerifier = base64Url(crypto.randomBytes(64));
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function createOauthState() {
  return base64Url(crypto.randomBytes(32));
}

function normalizeAuthMode(value) {
  const raw = normalizeString(value).toLowerCase();
  if (!raw || raw === 'oauth' || raw === 'oauth-browser') return 'oauth-browser';
  if (raw === 'oauth-device' || raw === 'device' || raw === 'device-code') return 'oauth-device';
  if (raw === 'api-key' || raw === 'apikey' || raw === 'api_key') return 'api-key';
  if (raw === 'auth-token' || raw === 'auth_token' || raw === 'claude-code-token') return 'auth-token';
  return '';
}

function normalizeExistingAccountRef(value) {
  const accountRef = normalizeString(value);
  return isAccountRef(accountRef) ? accountRef : '';
}

function appendLog(job, chunk) {
  const text = stripAnsi(String(chunk || ''));
  if (!text) return;
  job.logs = `${job.logs}${text}`;
  if (job.logs.length > JOB_LOG_LIMIT) {
    job.logs = job.logs.slice(-JOB_LOG_LIMIT);
  }
  job.lastOutputAt = Date.now();
}

function notifyAuthJobChanged(job) {
  const notifier = job && job._onChanged;
  if (typeof notifier !== 'function') return;
  try {
    notifier(job);
  } catch (_error) {
    // Job progress must not depend on watcher delivery.
  }
}

function appendJobLog(job, message) {
  const text = normalizeString(message);
  if (!job || !text) return;
  appendLog(job, `[${new Date().toISOString()}] ${text}\n`);
  job.updatedAt = Date.now();
  notifyAuthJobChanged(job);
}

function setAuthProgressState(job, state) {
  const nextState = normalizeString(state);
  if (!job || !nextState || job.authProgressState === nextState) return;
  job.authProgressState = nextState;
  job.updatedAt = Date.now();
  notifyAuthJobChanged(job);
}

function serializeAuthJob(job) {
  if (!job) return null;
  return {
    id: String(job.id || ''),
    provider: String(job.provider || ''),
    accountRef: String(job.accountRef || ''),
    authMode: String(job.authMode || ''),
    reauth: Boolean(job.reauth),
    status: String(job.status || ''),
    authProgressState: String(job.authProgressState || ''),
    logs: String(job.logs || ''),
    exitCode: Number.isInteger(job.exitCode) ? job.exitCode : null,
    error: String(job.error || ''),
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    lastOutputAt: Number(job.lastOutputAt || 0),
    // Test the raw value, not Number(value): Number(null) === 0 (finite), which
    // would serialize an absent expiry/interval as 0 and make the web UI render a
    // stray "0" via `{(expiresAt || pollIntervalMs) && <Card/>}`. Keep null null.
    pid: Number.isFinite(job.pid) ? job.pid : null,
    expiresAt: Number.isFinite(job.expiresAt) ? job.expiresAt : null,
    pollIntervalMs: Number.isFinite(job.pollIntervalMs) ? job.pollIntervalMs : null,
    verificationUri: String(job.verificationUri || ''),
    verificationUriComplete: String(job.verificationUriComplete || ''),
    userCode: String(job.userCode || ''),
    authorizationUrl: String(job.authorizationUrl || ''),
    redirectUri: String(job.redirectUri || ''),
    browserCallbackForwardedAt: Number(job.browserCallbackForwardedAt || 0),
    callbackCaptureStatus: String(job.callbackCaptureStatus || ''),
    callbackListeningUrl: String(job.callbackListeningUrl || ''),
    callbackCaptureError: String(job.callbackCaptureError || ''),
    email: String(job.email || ''),
    displayName: String(job.displayName || ''),
    planType: String(job.planType || '')
  };
}

function resolveInitialAuthProgressState(provider, authMode, authorizationUrl = '') {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const normalizedMode = normalizeAuthMode(authMode);
  if (normalizedMode === 'oauth-device') return AUTH_PROGRESS_STATES.AUTH_URL_READY;
  if (normalizedProvider === 'agy') return AUTH_PROGRESS_STATES.AWAITING_LOGIN_METHOD;
  if (normalizedMode === 'oauth-browser' && normalizeString(authorizationUrl)) {
    return AUTH_PROGRESS_STATES.AUTH_URL_READY;
  }
  return AUTH_PROGRESS_STATES.STARTING;
}

function resolveFinishedAuthProgressState(status) {
  const normalized = normalizeString(status).toLowerCase();
  if (normalized === 'succeeded') return AUTH_PROGRESS_STATES.COMPLETED;
  if (normalized === 'cancelled') return AUTH_PROGRESS_STATES.CANCELLED;
  if (normalized === 'expired') return AUTH_PROGRESS_STATES.EXPIRED;
  if (normalized === 'failed') return AUTH_PROGRESS_STATES.FAILED;
  return '';
}

function compactLogText(value, maxLength = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function parseDeviceCodeExpiryMs(logText) {
  const text = stripAnsi(String(logText || ''));
  const match = text.match(/expires?\s+in\s+(\d+)\s+(second|seconds|minute|minutes|hour|hours)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = String(match[2] || '').toLowerCase();
  const multiplier = DEVICE_CODE_DURATION_UNITS_MS[unit];
  if (!Number.isFinite(amount) || amount <= 0 || !multiplier) return null;
  return amount * multiplier;
}

function parseDeviceCodePollIntervalMs(logText) {
  const text = stripAnsi(String(logText || ''));
  const match = text.match(/(?:poll|retry|wait)(?:ing)?(?:\s+again)?(?:\s+in)?\s+(\d+)\s+(second|seconds|minute|minutes)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = String(match[2] || '').toLowerCase();
  const multiplier = DEVICE_CODE_DURATION_UNITS_MS[unit];
  if (!Number.isFinite(amount) || amount <= 0 || !multiplier) return null;
  return amount * multiplier;
}

function isProcessAlive(pid, processObj = process) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return true;
  try {
    processObj.kill(numericPid, 0);
    return true;
  } catch (error) {
    const code = String(error && error.code || '').trim().toUpperCase();
    if (code === 'ESRCH') return false;
    return true;
  }
}

function hasCodexOauthTokens(configDir, fs) {
  const authPath = path.join(String(configDir || ''), 'auth.json');
  if (!authPath || !fs.existsSync(authPath)) return false;
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const tokens = auth && typeof auth.tokens === 'object' ? auth.tokens : null;
    return Boolean(tokens && tokens.access_token && tokens.refresh_token);
  } catch (_error) {
    return false;
  }
}

function hasClaudeOauthTokens(configDir, fs) {
  const credentialsPath = path.join(String(configDir || ''), '.credentials.json');
  if (!credentialsPath || !fs.existsSync(credentialsPath)) return false;
  try {
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const oauth = credentials && (credentials.claudeAiOauth || credentials.claude_ai_oauth);
    return Boolean(oauth && (oauth.accessToken || oauth.access_token));
  } catch (_error) {
    return false;
  }
}

function hasGeminiOauthTokens(configDir, fs) {
  const oauthPath = path.join(String(configDir || ''), 'oauth_creds.json');
  if (!oauthPath || !fs.existsSync(oauthPath)) return false;
  try {
    const oauth = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
    return Boolean(oauth && oauth.access_token);
  } catch (_error) {
    return false;
  }
}

function hasAgyOauthTokens(configDir, fs) {
  const tokenPath = path.join(String(configDir || ''), 'antigravity-oauth-token');
  if (!tokenPath || !fs.existsSync(tokenPath)) return false;
  try {
    const payload = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    const token = payload && payload.token && typeof payload.token === 'object' ? payload.token : {};
    return Boolean(String(token.access_token || token.refresh_token || '').trim());
  } catch (_error) {
    return false;
  }
}

function hasOpenCodeAuthTokens(runtimeDir, fs) {
  const authPath = path.join(String(runtimeDir || ''), '.local', 'share', 'opencode', 'auth.json');
  if (!authPath || !fs.existsSync(authPath)) return false;
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    return Object.values(auth && typeof auth === 'object' ? auth : {}).some((record) => {
      if (!record || typeof record !== 'object') return false;
      return Boolean(
        String(record.key || record.apiKey || record.api_key || record.access_key || '').trim()
        || String(record.access || record.accessToken || record.access_token || '').trim()
        || String(record.refresh || record.refreshToken || record.refresh_token || '').trim()
      );
    });
  } catch (_error) {
    return false;
  }
}

function getOauthArtifactPath(job) {
  if (!job || (!job.configDir && !job.runtimeDir)) return '';
  if (job.provider === 'codex') return path.join(String(job.configDir || ''), 'auth.json');
  if (job.provider === 'claude') return path.join(String(job.configDir || ''), '.credentials.json');
  if (job.provider === 'gemini') return path.join(String(job.configDir || ''), 'oauth_creds.json');
  if (job.provider === 'agy') return path.join(String(job.configDir || ''), 'antigravity-oauth-token');
  if (job.provider === 'opencode') return path.join(String(job.runtimeDir || ''), '.local', 'share', 'opencode', 'auth.json');
  return '';
}

function readOauthArtifactSignature(job, fs) {
  const artifactPath = getOauthArtifactPath(job);
  if (!artifactPath || !fs.existsSync(artifactPath)) return '';
  try {
    const stat = fs.statSync(artifactPath);
    if (stat && stat.isDirectory && stat.isDirectory()) {
      const entries = fs.readdirSync(artifactPath)
        .filter((name) => /\.log$/i.test(String(name || '')))
        .map((name) => {
          const filePath = path.join(artifactPath, name);
          try {
            const itemStat = fs.statSync(filePath);
            return {
              name: String(name),
              mtimeMs: Number(itemStat.mtimeMs) || 0,
              size: Number(itemStat.size) || 0
            };
          } catch (_error) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (entries.length === 0) return '';
      return crypto.createHash('sha1').update(JSON.stringify(entries), 'utf8').digest('hex');
    }
    const raw = fs.readFileSync(artifactPath, 'utf8');
    return crypto.createHash('sha1').update(String(raw || ''), 'utf8').digest('hex');
  } catch (_error) {
    return '';
  }
}

function hasOauthCompletionArtifacts(job, fs) {
  if (!job || !job.configDir) return false;
  let completed = false;
  if (job.provider === 'codex') completed = hasCodexOauthTokens(job.configDir, fs);
  else if (job.provider === 'claude') completed = hasClaudeOauthTokens(job.configDir, fs);
  else if (job.provider === 'gemini') completed = hasGeminiOauthTokens(job.configDir, fs);
  else if (job.provider === 'agy') completed = hasAgyOauthTokens(job.configDir, fs);
  else if (job.provider === 'opencode') completed = hasOpenCodeAuthTokens(job.runtimeDir, fs);
  if (!completed) return false;
  if (!job._requireFreshOauthArtifacts) return true;
  const nextSignature = readOauthArtifactSignature(job, fs);
  return Boolean(nextSignature) && nextSignature !== String(job._oauthArtifactSignatureAtStart || '');
}

function extractOAuthChallenge(logText) {
  const text = stripAnsi(String(logText || ''));
  if (!text) {
    return {
      verificationUri: '',
      verificationUriComplete: '',
      userCode: ''
    };
  }

  const urls = collectHttpUrls(text);
  const verificationUriComplete = urls.find((url) => /device|activate|verify|oauth|auth/i.test(url)) || urls[0] || '';
  let verificationUri = verificationUriComplete;
  if (verificationUri) {
    try {
      const parsed = new URL(verificationUri);
      parsed.search = '';
      parsed.hash = '';
      verificationUri = parsed.toString().replace(/\/$/, '');
    } catch (_error) {
      verificationUri = verificationUriComplete;
    }
  }

  const explicitCodeMatch = text.match(/(?:user|device)[ -_]?code[^A-Z0-9]*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)/i);
  const fallbackCodeMatch = text.match(/\b([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b/);
  const userCode = explicitCodeMatch ? explicitCodeMatch[1] : (fallbackCodeMatch ? fallbackCodeMatch[1] : '');

  return {
    verificationUri,
    verificationUriComplete,
    userCode
  };
}

function getUrlPrefix(value) {
  const match = String(value || '').match(/https?:\/\/[^\s<>"')]+/i);
  return match ? match[0] : '';
}

function isUrlContinuationLine(value) {
  const text = String(value || '').trim();
  return Boolean(text) && /^[A-Za-z0-9._~:/?#\[\]@!$&*+,;=%-]+$/.test(text);
}

function collectWrappedHttpUrls(text) {
  // Collapse runs of CR/LF into a single break. Claude's setup-token output wraps
  // long URLs with "\r\r\n" between segments; splitting on /\r?\n|\r/ would leave
  // an empty segment between two halves of the URL and abort the rejoin.
  const lines = String(text || '').split(/[\r\n]+/g);
  const urls = [];
  for (let index = 0; index < lines.length; index += 1) {
    const first = getUrlPrefix(lines[index]);
    if (!first) continue;

    let candidate = first;
    let nextIndex = index + 1;
    while (nextIndex < lines.length && isUrlContinuationLine(lines[nextIndex])) {
      candidate += lines[nextIndex].trim();
      nextIndex += 1;
    }
    urls.push(candidate.replace(/[.,;]+$/g, ''));
  }
  return urls;
}

function collectHttpUrls(text) {
  const rawText = String(text || '');
  const urls = [
    ...Array.from(rawText.matchAll(/https?:\/\/[^\s<>"')]+/gi)).map((match) => match[0]),
    ...collectWrappedHttpUrls(rawText)
  ];
  return Array.from(new Set(urls.filter(Boolean)));
}

function extractBrowserOAuthHints(logText) {
  const text = stripAnsi(String(logText || ''));
  const urls = collectHttpUrls(text);
  const authorizationUrl = urls.find((url) => {
    try {
      const parsed = new URL(url);
      return Boolean(parsed.searchParams.get('redirect_uri') || parsed.searchParams.get('code_challenge'));
    } catch (_error) {
      return false;
    }
  }) || '';
  if (!authorizationUrl) {
    return {
      authorizationUrl: '',
      redirectUri: '',
      state: ''
    };
  }

  try {
    const parsed = new URL(authorizationUrl);
    return {
      authorizationUrl,
      redirectUri: String(parsed.searchParams.get('redirect_uri') || ''),
      state: String(parsed.searchParams.get('state') || '')
    };
  } catch (_error) {
    return {
      authorizationUrl,
      redirectUri: '',
      state: ''
    };
  }
}

function isLoopbackCallbackUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = String(parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch (_error) {
    return false;
  }
}

function buildBrowserCaptureCommand(fs, runtimeDir, platform) {
  const isWindows = String(platform || '').toLowerCase() === 'win32';
  const filePath = path.join(runtimeDir, isWindows ? BROWSER_CAPTURE_WIN : BROWSER_CAPTURE_UNIX);
  if (isWindows) {
    fs.writeFileSync(filePath, [
      '@echo off',
      'echo %*',
      ':loop',
      'timeout /t 3600 /nobreak >nul',
      'goto loop',
      ''
    ].join('\r\n'), 'utf8');
    return filePath;
  }

  fs.writeFileSync(filePath, [
    '#!/bin/sh',
    'trap "exit 0" INT TERM HUP',
    'printf "%s\\n" "$@"',
    'while :; do sleep 3600; done',
    ''
  ].join('\n'), 'utf8');
  if (typeof fs.chmodSync === 'function') {
    fs.chmodSync(filePath, 0o755);
  }
  return filePath;
}

function parseBrowserCallbackInput(rawCallbackUrl, redirectUri) {
  const raw = normalizeString(rawCallbackUrl);
  if (!raw) return null;
  try {
    const redirect = new URL(redirectUri);
    if (raw.startsWith('?')) {
      return new URL(`${redirect.origin}${redirect.pathname}${raw}`);
    }
    if (raw.startsWith('/')) {
      return new URL(raw, redirect.origin);
    }
    return new URL(raw);
  } catch (_error) {
    return null;
  }
}

function isSameCallbackEndpoint(urlValue, expectedValue) {
  try {
    const url = new URL(String(urlValue || ''));
    const expected = new URL(String(expectedValue || ''));
    return url.origin === expected.origin && url.pathname === expected.pathname;
  } catch (_error) {
    return false;
  }
}

function parseAuthorizationCodeInput(rawCallbackUrl, redirectUri) {
  const raw = normalizeString(rawCallbackUrl);
  if (!raw) return null;

  const fallbackRedirectUri = normalizeString(redirectUri) || 'https://antigravity.google/oauth-callback';
  const parseWithRedirect = () => {
    const parsed = parseBrowserCallbackInput(raw, fallbackRedirectUri);
    if (!parsed) return null;
    return {
      code: normalizeString(parsed.searchParams.get('code')),
      state: normalizeString(parsed.searchParams.get('state')),
      error: normalizeString(parsed.searchParams.get('error') || parsed.searchParams.get('error_description'))
    };
  };

  if (/^(https?:\/\/|\?|\/)/i.test(raw)) {
    return parseWithRedirect();
  }

  if (/[?&]code=/.test(raw) || /^code=/.test(raw)) {
    try {
      const params = new URLSearchParams(raw.replace(/^\?/, ''));
      return {
        code: normalizeString(params.get('code')),
        state: normalizeString(params.get('state')),
        error: normalizeString(params.get('error') || params.get('error_description'))
      };
    } catch (_error) {
      return null;
    }
  }

  if (/\s/.test(raw)) return null;
  return {
    code: raw,
    state: '',
    error: ''
  };
}

function buildCodexAuthorizationUrl(options) {
  const url = new URL(CODEX_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('state', options.state);
  url.searchParams.set('originator', 'Codex Desktop');
  return url.toString();
}

function buildClaudeAuthorizationUrl(options) {
  const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', CLAUDE_OAUTH_SCOPE);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', options.state);
  return url.toString();
}

// Shape the claude token-endpoint response into the `.credentials.json` layout
// that aih (and the Claude CLI) read: claudeAiOauth with both camelCase and
// snake_case mirrors, an absolute expiry, and the granted scopes.
function buildClaudeCredentialsFromTokenResponse(tokenPayload, nowMs) {
  const expiresInSeconds = Number(tokenPayload && tokenPayload.expires_in);
  const expiresAt = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? nowMs + expiresInSeconds * 1000
    : 0;
  const accessToken = normalizeString(tokenPayload && tokenPayload.access_token);
  const refreshToken = normalizeString(tokenPayload && tokenPayload.refresh_token);
  const scopeRaw = tokenPayload && (tokenPayload.scope || tokenPayload.scopes);
  const scopes = Array.isArray(scopeRaw)
    ? scopeRaw.map((item) => normalizeString(item)).filter(Boolean)
    : (normalizeString(scopeRaw) ? normalizeString(scopeRaw).split(/\s+/) : []);
  const account = tokenPayload && typeof tokenPayload.account === 'object' ? tokenPayload.account : null;
  const organization = tokenPayload && typeof tokenPayload.organization === 'object' ? tokenPayload.organization : null;
  const subscriptionType = normalizeString(
    (tokenPayload && (tokenPayload.subscription_type || tokenPayload.subscriptionType))
    || (account && (account.subscription_type || account.subscriptionType))
  );
  // 捕获账号邮箱/UUID 作为可区分身份，避免所有 Claude OAuth 账号都显示成 "OAuth Configured"
  // 而被去重逻辑误判为同一个账号。
  const accountEmail = normalizeString(
    account && (account.email_address || account.emailAddress || account.email)
  );
  const accountUuid = normalizeString(
    account && (account.uuid || account.account_uuid || account.accountUuid || account.id)
  );

  const claudeAiOauth = {
    accessToken,
    access_token: accessToken,
    refreshToken,
    refresh_token: refreshToken,
    scopes,
    lastRefresh: new Date(nowMs).toISOString(),
    last_refresh: new Date(nowMs).toISOString()
  };
  if (expiresAt > 0) {
    claudeAiOauth.expiresAt = expiresAt;
    claudeAiOauth.expires_at = expiresAt;
    claudeAiOauth.expiry = new Date(expiresAt).toISOString();
  }
  if (subscriptionType) claudeAiOauth.subscriptionType = subscriptionType;
  if (accountEmail || accountUuid) {
    claudeAiOauth.account = {
      ...(accountEmail ? { emailAddress: accountEmail, email_address: accountEmail } : {}),
      ...(accountUuid ? { uuid: accountUuid } : {})
    };
    if (organization && normalizeString(organization.name)) {
      claudeAiOauth.account.organizationName = normalizeString(organization.name);
    }
  }

  return { claudeAiOauth };
}

function decodeJwtPayloadUnsafe(jwt) {
  const text = normalizeString(jwt);
  const parts = text.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function resolveCodexUpstreamAccountId(idToken, accessToken) {
  const idPayload = decodeJwtPayloadUnsafe(idToken);
  const accessPayload = decodeJwtPayloadUnsafe(accessToken);
  const authClaim = (accessPayload && accessPayload['https://api.openai.com/auth'])
    || (idPayload && idPayload['https://api.openai.com/auth'])
    || {};
  return normalizeString(authClaim.chatgpt_account_id || authClaim.account_id);
}

function buildCodexAuthJsonFromTokenResponse(tokenPayload, nowMs) {
  const expiresInSeconds = Number(tokenPayload && tokenPayload.expires_in);
  const expiresAt = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? nowMs + expiresInSeconds * 1000
    : 0;
  const accessToken = normalizeString(tokenPayload && tokenPayload.access_token);
  const idToken = normalizeString(tokenPayload && tokenPayload.id_token);
  const refreshToken = normalizeCodexRefreshToken(tokenPayload && tokenPayload.refresh_token);
  const upstreamAccountId = resolveCodexUpstreamAccountId(idToken, accessToken);
  const tokens = {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken
  };
  if (upstreamAccountId) tokens.account_id = upstreamAccountId;
  const authJson = {
    tokens,
    last_refresh: new Date(nowMs).toISOString()
  };
  if (expiresAt > 0) authJson.expired = new Date(expiresAt).toISOString();
  return authJson;
}

function buildLoginArgs(provider, authMode) {
  const config = AI_CLI_CONFIGS[provider];
  const args = Array.isArray(config && config.loginArgs) ? config.loginArgs.slice() : [];
  if (authMode === 'oauth-device' && provider === 'codex' && !args.includes('--device-auth')) {
    args.push('--device-auth');
  }
  return args;
}

function isSupportedAuthMode(provider, authMode) {
  const modes = PROVIDER_AUTH_MODE_MATRIX[String(provider || '').trim().toLowerCase()] || [];
  return modes.includes(String(authMode || '').trim());
}

function getDefaultAuthMode(provider) {
  return PROVIDER_DEFAULT_AUTH_MODE[String(provider || '').trim().toLowerCase()] || 'oauth-browser';
}

function isAgyGoogleOAuthPrompt(logText) {
  const text = stripAnsi(String(logText || ''));
  return /Select login method/i.test(text)
    && /Google OAuth/i.test(text)
    && /Google Cloud project/i.test(text);
}

function maybeSelectAgyGoogleOAuth(job) {
  if (!job || job.provider !== 'agy' || job._agyGoogleOAuthSelected) return;
  if (!isAgyGoogleOAuthPrompt(job.logs)) return;
  job._agyGoogleOAuthSelected = true;
  setAuthProgressState(job, AUTH_PROGRESS_STATES.AWAITING_LOGIN_METHOD);
  const ptyProcess = job._ptyProcess;
  if (!ptyProcess || typeof ptyProcess.write !== 'function') {
    appendJobLog(job, '检测到 Antigravity 登录方式菜单，但当前 PTY 不支持自动输入。');
    return;
  }
  appendJobLog(job, '检测到 Antigravity 登录方式菜单，自动选择 1. Google OAuth。');
  ptyProcess.write('1\r');
  setAuthProgressState(job, AUTH_PROGRESS_STATES.LOGIN_METHOD_SELECTED);
}


function resolveProviderConfigDir(provider, runtimeDir) {
  const config = AI_CLI_CONFIGS[provider] || {};
  const globalDir = String(config.globalDir || `.${provider}`).trim();
  const configSubDir = String(config.configSubDir || '').trim();
  return configSubDir
    ? path.join(runtimeDir, globalDir, configSubDir)
    : path.join(runtimeDir, globalDir);
}

function ensureLoginRuntime(options) {
  const { fs, provider, aiHomeDir, jobId } = options;
  const runtimeDir = resolveLoginRuntimeDir(aiHomeDir, provider, `auth-${jobId}`);
  if (!runtimeDir) throw new Error('invalid_login_runtime');
  const configDir = resolveProviderConfigDir(provider, runtimeDir);
  fs.mkdirSync(configDir, { recursive: true });
  return { runtimeDir, configDir };
}

function configureApiKeyAccount(options) {
  const {
    fs,
    provider,
    config,
    aiHomeDir,
    accountArtifactHooks
  } = options;

  const normalized = normalizeCredentialConfig({
    cli: provider,
    api_key: config && config.apiKey,
    base_url: config && config.baseUrl,
    credential_type: provider === 'claude'
      ? (config && (config.credentialType || config.authType))
      : ''
  });
  if (!normalized.ok) {
    const error = new Error(normalized.error.message);
    error.code = normalized.error.code;
    throw error;
  }

  const apiKey = normalized.value.api_key;
  const baseUrl = normalized.value.base_url;
  const credentialType = normalized.value.credential_type || CLAUDE_CREDENTIAL_TYPES.API_KEY;
  const identity = resolveIdentitySeedFromAccount({
    provider,
    apiKeyMode: credentialType !== 'auth-token',
    credentialType,
    accessToken: apiKey,
    baseUrl
  });
  if (!identity.identitySeed || identity.degraded) throw new Error('missing_stable_identity');
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    identitySeed: identity.identitySeed
  });
  const accountRef = registration.accountRef;
  const authSnapshotBefore = accountArtifactHooks
    && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
    ? accountArtifactHooks.snapshotAccountAuthArtifacts(provider, accountRef)
    : null;

  const envPayload = {};
  const envKeys = normalized.value.cli === 'gemini'
    ? ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
    : [normalized.value.cli === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'];

  if (provider === 'claude') {
    Object.assign(envPayload, writeClaudeCredentialEnv(envPayload, {
      credentialType,
      token: apiKey,
      baseUrl
    }));
  } else {
    envPayload[envKeys[0]] = apiKey;
  }
  if (baseUrl && provider !== 'claude') {
    if (provider === 'codex') envPayload.OPENAI_BASE_URL = baseUrl;
    if (provider === 'gemini') envPayload.GEMINI_BASE_URL = baseUrl;
  }

  writeAccountCredentials(fs, aiHomeDir, accountRef, envPayload);
  if (authSnapshotBefore && typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged === 'function') {
    accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
      provider,
      accountRef,
      before: authSnapshotBefore,
      source: 'webui_api_key_account_configured',
      reason: 'api_key_credentials_updated'
    });
  }

  return {
    provider,
    accountRef,
    apiKeyMode: true,
    created: registration.created
  };
}

function createAuthJobManager(options = {}) {
  const {
    fs,
    processObj = process,
    ptyImpl = createLazyPtyAdapter(),
    resolveCliPathImpl = resolveNativeCliPath,
    buildPtyLaunchImpl = buildPtyLaunch,
    resolveWindowsBatchLaunchImpl = resolveWindowsBatchLaunch,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    startLoopbackCallbackServerImpl = startOauthLoopbackCallbackServer,
    aiHomeDir,
    onOauthJobFinished,
    onJobChanged,
    verifyOauthJobCompleted
  } = options;

  const jobs = new Map();
  const runningProviders = new Map();

  function attachJobChangeNotifier(job) {
    if (!job || typeof onJobChanged !== 'function') return job;
    Object.defineProperty(job, '_onChanged', {
      value: onJobChanged,
      writable: true,
      configurable: true,
      enumerable: false
    });
    return job;
  }

  // 需求：授权 job 结束、取消或过期时必须释放临时 callback server，避免端口 1455 被残留占用。
  function closeJobLoopbackCallback(job) {
    if (!job || !job._loopbackCallbackServer) return;
    try {
      job._loopbackCallbackServer.close();
    } catch (_error) {
      // best effort cleanup
    }
    job._loopbackCallbackServer = null;
    if (job.callbackCaptureStatus === 'starting' || job.callbackCaptureStatus === 'listening') {
      job.callbackCaptureStatus = 'closed';
    }
  }

  function notifyOauthJobFinishedOnce(job) {
    if (!job || job.status !== 'succeeded') return Promise.resolve();
    if (job._finishedNotifyPromise) return job._finishedNotifyPromise;
    if (job._finishedNotified) return Promise.resolve();
    job._finishedNotified = true;
    if (typeof onOauthJobFinished === 'function') {
      job._finishedNotifyPromise = Promise.resolve(onOauthJobFinished(job)).catch((error) => {
        appendJobLog(job, `状态同步异常：${compactLogText((error && error.message) || error || 'unknown_error')}`);
      });
      return job._finishedNotifyPromise;
    }
    return Promise.resolve();
  }

  function cleanupFinishedJobs() {
    const now = Date.now();
    Array.from(jobs.entries()).forEach(([jobId, job]) => {
      if (job.status === 'running') return;
      if ((now - job.updatedAt) > FINISHED_JOB_TTL_MS) {
        jobs.delete(jobId);
      }
    });
  }

  function getJob(jobId) {
    cleanupFinishedJobs();
    const job = jobs.get(String(jobId || '').trim()) || null;
    if (!job) return null;
    return refreshJobState(job);
  }

  function getRunningJob(provider) {
    cleanupFinishedJobs();
    const normalizedProvider = normalizeString(provider).toLowerCase();
    const jobId = runningProviders.get(normalizedProvider);
    if (!jobId) return null;
    const job = jobs.get(jobId) || null;
    if (!job) return null;
    return refreshJobState(job);
  }

  function finalizeJob(job, nextStatus, errorMessage = '', exitCode = null) {
    if (!job) return;
    if (nextStatus === 'succeeded') {
      try {
        const registration = registerProviderAuthProjection(fs, job.runtimeDir, job.provider, {
          path,
          aiHomeDir
        });
        if (!registration.registered) {
          nextStatus = 'failed';
          errorMessage = `OAuth 凭据未写入账号数据库: ${registration.reason}`;
        } else {
          job.accountRef = registration.accountRef;
        }
      } catch (error) {
        nextStatus = 'failed';
        errorMessage = `OAuth 凭据入库失败: ${error.message}`;
      }
    }
    closeJobLoopbackCallback(job);
    job.status = nextStatus;
    const finishedProgressState = resolveFinishedAuthProgressState(nextStatus);
    if (finishedProgressState) job.authProgressState = finishedProgressState;
    job.error = errorMessage ? String(errorMessage) : job.error;
    job.exitCode = Number.isInteger(exitCode) ? exitCode : job.exitCode;
    job.updatedAt = Date.now();
    if (runningProviders.get(job.provider) === job.id) {
      runningProviders.delete(job.provider);
    }
    notifyAuthJobChanged(job);
    const finishedPromise = notifyOauthJobFinishedOnce(job);
    return Promise.resolve(finishedPromise).finally(() => {
      notifyAuthJobChanged(job);
    });
  }

  function cancelJob(jobId) {
    const job = getJob(jobId);
    if (!job) return { ok: false, code: 'job_not_found' };
    if (job.status !== 'running') {
      return { ok: true, job };
    }

    job._cancelRequested = true;
    job._terminationReason = 'user_cancelled';
    finalizeJob(job, 'cancelled', '用户取消了 OAuth 授权流程', null);
    try {
      if (job._ptyProcess && typeof job._ptyProcess.kill === 'function') {
        job._ptyProcess.kill();
      }
    } catch (_error) {
      // ignore best effort kill
    }
    return { ok: true, job };
  }

  function refreshJobState(job) {
    if (!job) return null;
    if (job.status !== 'running') return job;

    const now = Date.now();
    const deadline = resolveOauthJobDeadline(job);
    if (Number.isFinite(deadline) && deadline > 0 && now >= deadline) {
      job._terminationReason = 'expired';
      try {
        if (job._ptyProcess && typeof job._ptyProcess.kill === 'function') {
          job._ptyProcess.kill();
        }
      } catch (_error) {
        // ignore best effort kill
      }
      finalizeJob(job, 'expired', job.authMode === 'oauth-device'
        ? '设备码已过期，请重新发起授权。'
        : 'OAuth 授权已超时，请重新发起授权。', null);
      return job;
    }

    if (hasOauthCompletionArtifacts(job, fs)) {
      job._terminationReason = 'completed';
      try {
        if (job._ptyProcess && typeof job._ptyProcess.kill === 'function') {
          job._ptyProcess.kill();
        }
      } catch (_error) {
        // ignore best effort kill
      }
      if (job.provider === 'agy') {
        const match = String(job.logs || '').match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
        const email = match ? match[1].trim() : '';
        if (email) {
          job.email = email;
          job.displayName = email;
        }
      }
      finalizeJob(job, 'succeeded', '', 0);
      return job;
    }

    if (job._manualCallbackOauth) {
      return job;
    }

    if (!isProcessAlive(job.pid, processObj)) {
      job._ptyProcess = null;
      finalizeJob(job, 'failed', job.error || '授权进程已结束，请重新发起授权。', job.exitCode);
      return job;
    }

    return job;
  }

  async function exchangeManualCallbackCodexCode(job, code, redirectUri) {
    if (!job || !job._manualCallbackOauth) {
      return { ok: false, code: 'callback_not_supported', job };
    }
    const authCode = normalizeString(code);
    if (!authCode) return { ok: false, code: 'invalid_callback_url', job };
    const tokenRedirectUri = normalizeString(redirectUri);
    if (!tokenRedirectUri) return { ok: false, code: 'invalid_callback_redirect', job };
    if (typeof fetchImpl !== 'function') {
      return { ok: false, code: 'callback_forward_unavailable', job };
    }
    appendJobLog(job, '开始向 OpenAI token endpoint 换取 Codex OAuth token。');

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('client_id', CODEX_OAUTH_CLIENT_ID);
    body.set('code', authCode);
    body.set('redirect_uri', tokenRedirectUri);
    body.set('code_verifier', job._codeVerifier);

    try {
      const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      });
      const rawText = await response.text().catch(() => '');
      appendJobLog(job, `OpenAI token endpoint 返回 HTTP ${response.status || 0}。`);
      if (!response.ok) {
        job.error = rawText || `token_exchange_failed_${response.status}`;
        job.updatedAt = Date.now();
        appendJobLog(job, `token exchange 失败：${compactLogText(job.error) || 'empty_response'}`);
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_failed', statusCode: response.status, job };
      }
      const payload = rawText ? JSON.parse(rawText) : {};
      const authJson = buildCodexAuthJsonFromTokenResponse(payload, Date.now());
      appendJobLog(
        job,
        `token 响应字段：access=${Boolean(authJson.tokens.access_token)} refresh=${Boolean(authJson.tokens.refresh_token)} id=${Boolean(authJson.tokens.id_token)} expiresIn=${Number(payload && payload.expires_in) || 0}`
      );
      if (!authJson.tokens.access_token || !authJson.tokens.refresh_token) {
        job.error = 'token_exchange_missing_tokens';
        job.updatedAt = Date.now();
        appendJobLog(job, 'token exchange 成功但响应缺少 access_token 或 refresh_token。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_missing_tokens', job };
      }
      fs.mkdirSync(job.configDir, { recursive: true });
      fs.writeFileSync(path.join(job.configDir, 'auth.json'), `${JSON.stringify(authJson, null, 2)}\n`, 'utf8');
      const metadata = extractCodexMetadata(authJson);
      job.email = metadata.email || '';
      job.displayName = metadata.email || '';
      job.planType = metadata.planType || '';
      appendJobLog(job, `auth.json 已写入：${path.join(job.configDir, 'auth.json')}`);
      if (job.email) appendJobLog(job, `已解析账号邮箱：${job.email}`);
      if (!hasOauthCompletionArtifacts(job, fs)) {
        job.error = 'oauth_artifact_verification_failed';
        job.updatedAt = Date.now();
        appendJobLog(job, '写入后未通过本地 OAuth artifact 校验。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'oauth_artifact_verification_failed', job };
      }
      if (typeof verifyOauthJobCompleted === 'function') {
        appendJobLog(job, '开始执行账号状态识别校验。');
        const verified = await Promise.resolve(verifyOauthJobCompleted(job, authJson));
        if (!verified || verified.ok === false) {
          const reason = String(verified && (verified.message || verified.code) || 'oauth_completion_verification_failed');
          job.error = reason;
          job.updatedAt = Date.now();
          appendJobLog(job, `账号状态识别失败：${compactLogText(reason)}`);
          finalizeJob(job, 'failed', reason, 1);
          return { ok: false, code: 'oauth_completion_verification_failed', job };
        }
        if (verified.email) job.email = String(verified.email || '').trim();
        if (verified.displayName) job.displayName = String(verified.displayName || '').trim();
        appendJobLog(job, '账号状态识别通过。');
      }
      job.browserCallbackForwardedAt = Date.now();
      job.updatedAt = Date.now();
      appendJobLog(job, 'Codex OAuth 授权完成。');
      await finalizeJob(job, 'succeeded', '', 0);
      return { ok: true, job };
    } catch (error) {
      job.error = String((error && error.message) || error || 'token_exchange_failed');
      job.updatedAt = Date.now();
      appendJobLog(job, `token exchange 异常：${compactLogText(job.error)}`);
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'token_exchange_failed', job };
    }
  }

  async function exchangeClaudeOauthCode(job, code, redirectUri) {
    if (!job || !job._manualCallbackOauth) {
      return { ok: false, code: 'callback_not_supported', job };
    }
    const authCode = normalizeString(code);
    if (!authCode) return { ok: false, code: 'invalid_callback_url', job };
    const tokenRedirectUri = normalizeString(redirectUri);
    if (!tokenRedirectUri) return { ok: false, code: 'invalid_callback_redirect', job };
    if (typeof fetchImpl !== 'function') {
      return { ok: false, code: 'callback_forward_unavailable', job };
    }
    appendJobLog(job, '开始向 Claude token endpoint 换取 OAuth token。');

    try {
      const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: tokenRedirectUri,
          client_id: CLAUDE_OAUTH_CLIENT_ID,
          code_verifier: job._codeVerifier,
          state: job.oauthState
        })
      });
      const rawText = await response.text().catch(() => '');
      appendJobLog(job, `Claude token endpoint 返回 HTTP ${response.status || 0}。`);
      if (!response.ok) {
        job.error = rawText || `token_exchange_failed_${response.status}`;
        job.updatedAt = Date.now();
        appendJobLog(job, `token exchange 失败：${compactLogText(job.error) || 'empty_response'}`);
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_failed', statusCode: response.status, job };
      }
      const payload = rawText ? JSON.parse(rawText) : {};
      const credentials = buildClaudeCredentialsFromTokenResponse(payload, Date.now());
      const oauth = credentials.claudeAiOauth;
      appendJobLog(
        job,
        `token 响应字段：access=${Boolean(oauth.accessToken)} refresh=${Boolean(oauth.refreshToken)} scopes=${oauth.scopes.length} expiresIn=${Number(payload && payload.expires_in) || 0}`
      );
      if (!oauth.accessToken || !oauth.refreshToken) {
        job.error = 'token_exchange_missing_tokens';
        job.updatedAt = Date.now();
        appendJobLog(job, 'token exchange 成功但响应缺少 access_token 或 refresh_token。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_missing_tokens', job };
      }
      fs.mkdirSync(job.configDir, { recursive: true });
      fs.writeFileSync(path.join(job.configDir, '.credentials.json'), `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
      appendJobLog(job, `.credentials.json 已写入：${path.join(job.configDir, '.credentials.json')}`);
      if (!hasOauthCompletionArtifacts(job, fs)) {
        job.error = 'oauth_artifact_verification_failed';
        job.updatedAt = Date.now();
        appendJobLog(job, '写入后未通过本地 OAuth artifact 校验。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'oauth_artifact_verification_failed', job };
      }
      if (typeof verifyOauthJobCompleted === 'function') {
        appendJobLog(job, '开始执行账号状态识别校验。');
        const verified = await Promise.resolve(verifyOauthJobCompleted(job, credentials));
        if (!verified || verified.ok === false) {
          const reason = String(verified && (verified.message || verified.code) || 'oauth_completion_verification_failed');
          job.error = reason;
          job.updatedAt = Date.now();
          appendJobLog(job, `账号状态识别失败：${compactLogText(reason)}`);
          finalizeJob(job, 'failed', reason, 1);
          return { ok: false, code: 'oauth_completion_verification_failed', job };
        }
        if (verified.email) job.email = String(verified.email || '').trim();
        if (verified.displayName) job.displayName = String(verified.displayName || '').trim();
        appendJobLog(job, '账号状态识别通过。');
      }
      job.browserCallbackForwardedAt = Date.now();
      job.updatedAt = Date.now();
      appendJobLog(job, 'Claude OAuth 授权完成。');
      await finalizeJob(job, 'succeeded', '', 0);
      return { ok: true, job };
    } catch (error) {
      job.error = String((error && error.message) || error || 'token_exchange_failed');
      job.updatedAt = Date.now();
      appendJobLog(job, `token exchange 异常：${compactLogText(job.error)}`);
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'token_exchange_failed', job };
    }
  }

  // 需求：Codex browser OAuth 默认自动监听 localhost callback；失败时只降级到手填，不中断授权任务。
  function attachManualCallbackLoopback(job) {
    if (!job || !job._manualCallbackOauth || typeof startLoopbackCallbackServerImpl !== 'function') {
      return;
    }
    job.callbackCaptureStatus = 'starting';
    job.callbackCaptureError = '';
    job.callbackListeningUrl = job.redirectUri;
    try {
      const loopback = startLoopbackCallbackServerImpl({
        redirectUri: job.redirectUri,
        onListening(info = {}) {
          if (job.status !== 'running') return;
          job.callbackCaptureStatus = 'listening';
          job.callbackListeningUrl = normalizeString(info.url) || job.redirectUri;
          job.updatedAt = Date.now();
          appendJobLog(job, `本地 OAuth callback 服务已监听：${job.callbackListeningUrl}`);
        },
        onUnavailable(error) {
          if (job.status !== 'running') return;
          job.callbackCaptureStatus = 'unavailable';
          job.callbackCaptureError = compactLogText((error && (error.code || error.message)) || error || 'callback_server_unavailable');
          job.updatedAt = Date.now();
          appendJobLog(job, `本地 OAuth callback 服务不可用，保留手动提交回调兜底：${job.callbackCaptureError || 'unknown_error'}`);
        },
        onCallback(callbackUrl) {
          return completeBrowserOauthCallback(job.id, callbackUrl);
        }
      });
      Object.defineProperty(job, '_loopbackCallbackServer', {
        value: loopback,
        writable: true,
        configurable: true,
        enumerable: false
      });
    } catch (error) {
      job.callbackCaptureStatus = 'unavailable';
      job.callbackCaptureError = compactLogText((error && (error.code || error.message)) || error || 'callback_server_unavailable');
      job.updatedAt = Date.now();
      appendJobLog(job, `本地 OAuth callback 服务启动失败，保留手动提交回调兜底：${job.callbackCaptureError || 'unknown_error'}`);
    }
  }

  // Generic "aih runs the OAuth itself" job: aih builds the authorization URL,
  // runs its own loopback server to auto-capture the callback on the same machine
  // (manual paste as a fallback for remote sessions), exchanges the code, and
  // writes the provider's credential file. Per-provider specifics come from the
  // strategy's nativeOauth descriptor; nothing here is provider-conditional.
  function startNativeOauthJob(provider, nativeOauth, jobId, runtimeDir, configDir, existingAccountRef, previousAccountState = null) {
    const pkce = createPkcePair();
    const state = createOauthState();
    const redirectUri = nativeOauth.loopbackRedirectUri;
    const authorizationUrl = nativeOauth.buildAuthorizationUrl({
      redirectUri,
      codeChallenge: pkce.codeChallenge,
      state,
      deps: strategyDeps
    });
    const label = nativeOauth.logLabel || provider;
    const job = {
      id: jobId,
      provider,
      accountRef: '',
      authMode: 'oauth-browser',
      reauth: Boolean(existingAccountRef),
      runtimeDir,
      configDir,
      status: 'running',
      authProgressState: resolveInitialAuthProgressState(provider, 'oauth-browser', authorizationUrl),
      logs: '',
      exitCode: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOutputAt: Date.now(),
      pid: null,
      expiresAt: Date.now() + MANUAL_CALLBACK_OAUTH_TTL_MS,
      pollIntervalMs: 1000,
      verificationUri: '',
      verificationUriComplete: '',
      userCode: '',
      authorizationUrl,
      redirectUri,
      oauthState: state,
      email: '',
      displayName: '',
      planType: '',
      browserCaptureCommand: '',
      browserCallbackForwardedAt: 0,
      callbackCaptureStatus: '',
      callbackCaptureError: '',
      callbackListeningUrl: '',
      _cancelRequested: false,
      _terminationReason: '',
      _finishedNotified: false,
      _finishedNotifyPromise: null,
      _ptyProcess: null,
      _preserveExistingAccount: Boolean(existingAccountRef),
      _requireFreshOauthArtifacts: Boolean(existingAccountRef),
      _previousAccountState: previousAccountState,
      _oauthArtifactSignatureAtStart: '',
      _manualCallbackOauth: true,
      _codeVerifier: pkce.codeVerifier,
      _reauthTargetRef: existingAccountRef || ''
    };
    attachJobChangeNotifier(job);
    if (job._requireFreshOauthArtifacts) {
      job._oauthArtifactSignatureAtStart = readOauthArtifactSignature(job, fs);
    }
    appendJobLog(job, `${label} OAuth 流程已创建。`);
    appendJobLog(job, `回调地址：${redirectUri}`);
    appendJobLog(job, `授权任务：provider=${provider}${existingAccountRef ? ` reauth=${existingAccountRef}` : ''}`);
    jobs.set(jobId, job);
    runningProviders.set(provider, jobId);
    attachManualCallbackLoopback(job);
    notifyAuthJobChanged(job);
    return {
      jobId,
      provider,
      accountRef: '',
      expiresAt: job.expiresAt,
      pollIntervalMs: job.pollIntervalMs,
      authorizationUrl,
      redirectUri,
      callbackCaptureStatus: job.callbackCaptureStatus,
      callbackListeningUrl: job.callbackListeningUrl,
      callbackCaptureError: job.callbackCaptureError,
      authProgressState: job.authProgressState
    };
  }

  function startOauthJob(provider, authMode, jobOptions = {}) {
    cleanupFinishedJobs();
    const normalizedProvider = normalizeString(provider).toLowerCase();
    const normalizedMode = normalizeAuthMode(authMode);
    const existingAccountRef = normalizeExistingAccountRef(jobOptions.accountRef);
    const cliConfig = AI_CLI_CONFIGS[normalizedProvider];

    if (!cliConfig) {
      const error = new Error('unsupported_provider');
      error.code = 'unsupported_provider';
      throw error;
    }
    if (!normalizedMode || normalizedMode === 'api-key') {
      const error = new Error('invalid_auth_mode');
      error.code = 'invalid_auth_mode';
      throw error;
    }
    if (!isSupportedAuthMode(normalizedProvider, normalizedMode)) {
      const error = new Error('unsupported_auth_mode');
      error.code = 'unsupported_auth_mode';
      throw error;
    }
    if (runningProviders.has(normalizedProvider)) {
      const existingJob = getRunningJob(normalizedProvider);
      if (existingJob && existingJob.status === 'running') {
        const error = new Error('oauth_job_already_running');
        error.code = 'oauth_job_already_running';
        error.jobId = runningProviders.get(normalizedProvider) || '';
        throw error;
      }
    }
    if (existingAccountRef) {
      const existingAccount = resolveAccountRef(fs, aiHomeDir, existingAccountRef, { bestEffort: true });
      if (!existingAccount || existingAccount.provider !== normalizedProvider) {
        const error = new Error('account_not_found');
        error.code = 'account_not_found';
        throw error;
      }
    }

    const cliPath = resolveCliPathImpl(normalizedProvider, {
      fs,
      env: processObj.env || process.env || {},
      platform: processObj.platform || process.platform,
      cwd: typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd()
    });
    if (!cliPath) {
      const installHint = String(cliConfig.pkg || '').trim()
        ? `请先安装 ${cliConfig.pkg}`
        : '请先安装原生 CLI';
      const error = new Error(`未找到 ${normalizedProvider} CLI，${installHint}`);
      error.code = 'cli_not_found';
      throw error;
    }

    const jobId = crypto.randomUUID();
    const { runtimeDir, configDir } = ensureLoginRuntime({
      fs,
      provider: normalizedProvider,
      aiHomeDir,
      jobId
    });

    const loginStrategy = resolveLoginStrategy(normalizedProvider);
    if (loginStrategy.nativeOauth && normalizedMode === 'oauth-browser') {
      return startNativeOauthJob(
        normalizedProvider,
        loginStrategy.nativeOauth,
        jobId,
        runtimeDir,
        configDir,
        existingAccountRef,
        jobOptions.previousAccountState || null
      );
    }

    try {
      prepareProviderRuntime(normalizedProvider, runtimeDir, processObj.env, {
        path,
        fs,
        platform: processObj.platform,
        aiHomeDir,
        isLogin: true,
        accountRef: existingAccountRef,
        requireNativeAuth: Boolean(existingAccountRef)
      });
    } catch (error) {
      const message = String((error && error.message) || error || 'provider_prepare_failed');
      const prepareError = new Error(`provider_prepare_failed: ${message}`);
      prepareError.code = 'provider_prepare_failed';
      throw prepareError;
    }

    const envOverrides = buildProviderRuntimeEnv(normalizedProvider, runtimeDir, processObj.env, {
      path,
      fs,
      platform: processObj.platform,
      aiHomeDir,
      isLogin: true,
      accountRef: existingAccountRef
    });
    const spawnCwd = typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd();
    // Per-provider pre-spawn setup (sandbox seeding, env tweaks) lives in each
    // provider's login strategy rather than as branches here.
    resolveLoginStrategy(normalizedProvider).prepareLogin({
      profileDir: runtimeDir,
      configDir,
      envOverrides,
      fs,
      spawnCwd,
      deps: strategyDeps
    });

    let browserCaptureCommand = '';
    if (normalizedMode === 'oauth-browser') {
      browserCaptureCommand = buildBrowserCaptureCommand(fs, runtimeDir, processObj.platform);
      envOverrides.BROWSER = browserCaptureCommand;
    }

    const argsToRun = buildLoginArgs(normalizedProvider, normalizedMode);
    const batchLaunch = resolveWindowsBatchLaunchImpl(
      normalizedProvider,
      cliPath,
      envOverrides,
      processObj.platform
    );
    const launch = buildPtyLaunchImpl(
      batchLaunch.launchBin || cliPath,
      argsToRun,
      { platform: processObj.platform }
    );

    const ptyProcess = ptyImpl.spawn(launch.command, launch.args, {
      name: 'xterm-color',
      cols: 120,
      rows: 32,
      cwd: spawnCwd,
      env: {
        ...envOverrides,
        ...(batchLaunch.envPatch || {})
      }
    });

    const job = {
      id: jobId,
      provider: normalizedProvider,
      accountRef: '',
      authMode: normalizedMode,
      reauth: Boolean(existingAccountRef),
      runtimeDir,
      configDir,
      status: 'running',
      authProgressState: resolveInitialAuthProgressState(normalizedProvider, normalizedMode),
      logs: '',
      exitCode: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOutputAt: Date.now(),
      pid: Number(ptyProcess && ptyProcess.pid) || null,
      expiresAt: null,
      pollIntervalMs: normalizedMode === 'oauth-device' ? RFC8628_DEFAULT_POLL_INTERVAL_MS : null,
      verificationUri: '',
      verificationUriComplete: '',
      userCode: '',
      authorizationUrl: '',
      redirectUri: '',
      oauthState: '',
      browserCaptureCommand,
      browserCallbackForwardedAt: 0,
      _cancelRequested: false,
      _terminationReason: '',
      _finishedNotified: false,
      _finishedNotifyPromise: null,
      _ptyProcess: ptyProcess,
      _preserveExistingAccount: Boolean(existingAccountRef),
      _requireFreshOauthArtifacts: Boolean(existingAccountRef),
      _previousAccountState: jobOptions.previousAccountState || null,
      _oauthArtifactSignatureAtStart: '',
      _agyGoogleOAuthSelected: false,
      _reauthTargetRef: existingAccountRef || ''
    };
    attachJobChangeNotifier(job);

    if (job._requireFreshOauthArtifacts) {
      job._oauthArtifactSignatureAtStart = readOauthArtifactSignature(job, fs);
    }

    jobs.set(jobId, job);
    runningProviders.set(normalizedProvider, jobId);
    notifyAuthJobChanged(job);

    ptyProcess.onData((chunk) => {
      appendLog(job, chunk);
      maybeSelectAgyGoogleOAuth(job);
      const hints = extractOAuthChallenge(job.logs);
      if (hints.verificationUri) job.verificationUri = hints.verificationUri;
      if (hints.verificationUriComplete) job.verificationUriComplete = hints.verificationUriComplete;
      if (hints.userCode) job.userCode = hints.userCode;
      if (job.authMode === 'oauth-browser') {
        const browserHints = extractBrowserOAuthHints(job.logs);
        if (browserHints.authorizationUrl) job.authorizationUrl = browserHints.authorizationUrl;
        if (browserHints.redirectUri) job.redirectUri = browserHints.redirectUri;
        if (browserHints.state) job.oauthState = browserHints.state;
        resolveLoginStrategy(job.provider).updateProgress({ job, hints: browserHints, deps: strategyDeps });
      }
      if (job.authMode === 'oauth-device' && !Number.isFinite(job.expiresAt)) {
        const expiresInMs = parseDeviceCodeExpiryMs(job.logs);
        if (Number.isFinite(expiresInMs) && expiresInMs > 0) {
          job.expiresAt = job.createdAt + expiresInMs;
        }
      }
      if (job.authMode === 'oauth-device') {
        const pollIntervalMs = parseDeviceCodePollIntervalMs(job.logs);
        if (Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) {
          job.pollIntervalMs = pollIntervalMs;
        }
      }
      job.updatedAt = Date.now();
      notifyAuthJobChanged(job);
    });

    ptyProcess.onExit(({ exitCode }) => {
      job._ptyProcess = null;
      job.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
      if (job.status !== 'running') {
        notifyAuthJobChanged(job);
        notifyOauthJobFinishedOnce(job);
        return;
      }
      if (job._terminationReason === 'user_cancelled' || job._cancelRequested) {
        finalizeJob(job, 'cancelled', '用户取消了 OAuth 授权流程', job.exitCode);
        return;
      }
      const completed = hasOauthCompletionArtifacts(job, fs);
      finalizeJob(
        job,
        job.exitCode === 0 && completed ? 'succeeded' : 'failed',
        job.exitCode === 0 && completed
          ? ''
          : (job.error || (job.exitCode === 0
            ? '授权进程已结束，但未检测到新的授权结果。'
            : `OAuth 登录失败，退出码 ${job.exitCode}`)),
        job.exitCode
      );
    });

    return {
      jobId,
      provider: normalizedProvider,
      accountRef: '',
      expiresAt: job.expiresAt,
      pollIntervalMs: job.pollIntervalMs,
      authProgressState: job.authProgressState
    };
  }

  // Collaborators handed to the per-provider login strategies. Bundling them here
  // (dependency injection) keeps oauth-login-strategies.js free of any dependency
  // on this module, so the strategies stay pure and independently testable.
  const strategyDeps = {
    states: AUTH_PROGRESS_STATES,
    aiHomeDir,
    path,
    fs,
    fetchImpl,
    normalizeString,
    stripAnsi,
    compactLogText,
    appendJobLog,
    setAuthProgressState,
    finalizeJob,
    refreshJobState,
    exchangeManualCallbackCodexCode,
    exchangeClaudeOauthCode,
    buildCodexAuthorizationUrl,
    buildClaudeAuthorizationUrl,
    parseAuthorizationCodeInput,
    parseBrowserCallbackInput,
    isSameCallbackEndpoint,
    isLoopbackCallbackUrl,
    resolveCodexSqliteHome
  };

  async function completeBrowserOauthCallback(jobId, rawCallbackUrl) {
    const job = getJob(jobId);
    if (!job) return { ok: false, code: 'job_not_found' };
    if (job.status !== 'running') return { ok: false, code: 'job_not_running', job };
    if (job.authMode !== 'oauth-browser') return { ok: false, code: 'callback_not_supported', job };

    // How the pasted code/URL becomes a completed login is provider-specific
    // (Codex exchanges it, Claude/Antigravity paste it into the CLI, others
    // forward to a loopback server). Each provider's login strategy owns that.
    const result = await resolveLoginStrategy(job.provider).submitCallback({
      job,
      rawInput: rawCallbackUrl,
      deps: strategyDeps
    });
    return { ...result, job: refreshJobState(result.job || job) };
  }

  return {
    getJob,
    getRunningJob,
    cancelJob,
    startOauthJob,
    completeBrowserOauthCallback
  };
}

module.exports = {
  stripAnsi,
  parseDeviceCodeExpiryMs,
  parseDeviceCodePollIntervalMs,
  isProcessAlive,
  normalizeAuthMode,
  normalizeExistingAccountRef,
  PROVIDER_AUTH_MODE_MATRIX,
  PROVIDER_DEFAULT_AUTH_MODE,
  isSupportedAuthMode,
  getDefaultAuthMode,
  extractOAuthChallenge,
  extractBrowserOAuthHints,
  configureApiKeyAccount,
  serializeAuthJob,
  createAuthJobManager
};
