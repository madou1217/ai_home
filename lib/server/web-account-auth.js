'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const nodePty = require('node-pty');

const { AI_CLI_CONFIGS } = require('../cli/services/ai-cli/provider-registry');
const { normalizeCredentialConfig } = require('../profile/credential-config');
const { resolveCliPath } = require('../runtime/platform-runtime');
const { buildPtyLaunch, resolveWindowsBatchLaunch } = require('../runtime/pty-launch');
const { extractCodexMetadata } = require('../account/codex-auth-metadata');

const JOB_LOG_LIMIT = 40000;
const FINISHED_JOB_TTL_MS = 15 * 60 * 1000;
const PROVIDER_AUTH_MODE_MATRIX = Object.freeze({
  codex: Object.freeze(['oauth-browser', 'oauth-device', 'api-key']),
  claude: Object.freeze(['oauth-browser', 'api-key']),
  gemini: Object.freeze(['oauth-browser', 'api-key'])
});
const PROVIDER_DEFAULT_AUTH_MODE = Object.freeze({
  codex: 'oauth-browser',
  claude: 'oauth-browser',
  gemini: 'oauth-browser'
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
const CODEX_OAUTH_LOOPBACK_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const MANUAL_CALLBACK_OAUTH_TTL_MS = 10 * 60 * 1000;

function stripAnsi(text) {
  return String(text || '').replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
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
  return '';
}

function getNextAccountIdFromIds(ids) {
  const numbers = (Array.isArray(ids) ? ids : [])
    .map((item) => Number.parseInt(String(item || '').trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0)
    .sort((a, b) => a - b);
  if (numbers.length === 0) return '1';
  return String(numbers[numbers.length - 1] + 1);
}

function normalizeExistingAccountId(value) {
  const id = normalizeString(value);
  return /^\d+$/.test(id) ? id : '';
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

function appendJobLog(job, message) {
  const text = normalizeString(message);
  if (!job || !text) return;
  appendLog(job, `[${new Date().toISOString()}] ${text}\n`);
  job.updatedAt = Date.now();
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
    return Boolean(tokens && (tokens.access_token || tokens.id_token));
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

function getOauthArtifactPath(job) {
  if (!job || !job.configDir) return '';
  if (job.provider === 'codex') return path.join(String(job.configDir || ''), 'auth.json');
  if (job.provider === 'claude') return path.join(String(job.configDir || ''), '.credentials.json');
  if (job.provider === 'gemini') return path.join(String(job.configDir || ''), 'oauth_creds.json');
  return '';
}

function readOauthArtifactSignature(job, fs) {
  const artifactPath = getOauthArtifactPath(job);
  if (!artifactPath || !fs.existsSync(artifactPath)) return '';
  try {
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

  const urls = Array.from(text.matchAll(/https?:\/\/[^\s<>"')]+/gi)).map((match) => match[0]);
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

function extractBrowserOAuthHints(logText) {
  const text = stripAnsi(String(logText || ''));
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s<>"')]+/gi)).map((match) => match[0]);
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

function buildBrowserCaptureCommand(fs, profileDir, platform) {
  const isWindows = String(platform || '').toLowerCase() === 'win32';
  const filePath = path.join(profileDir, isWindows ? BROWSER_CAPTURE_WIN : BROWSER_CAPTURE_UNIX);
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

function resolveCodexTokenAccountId(idToken, accessToken) {
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
  const refreshToken = normalizeString(tokenPayload && tokenPayload.refresh_token);
  const accountId = resolveCodexTokenAccountId(idToken, accessToken);
  const tokens = {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken
  };
  if (accountId) tokens.account_id = accountId;
  const authJson = {
    tokens,
    last_refresh: new Date(nowMs).toISOString()
  };
  if (expiresAt > 0) authJson.expired = new Date(expiresAt).toISOString();
  return authJson;
}

function isUsableCodexRefreshToken(value) {
  return String(value || '').trim().startsWith('rt_');
}

function normalizeProxyEnv(envObj) {
  const env = { ...(envObj || {}) };
  const pairs = [
    ['http_proxy', 'HTTP_PROXY'],
    ['https_proxy', 'HTTPS_PROXY'],
    ['all_proxy', 'ALL_PROXY'],
    ['no_proxy', 'NO_PROXY']
  ];
  pairs.forEach(([lower, upper]) => {
    const lowerValue = normalizeString(env[lower]);
    const upperValue = normalizeString(env[upper]);
    if (lowerValue && !upperValue) env[upper] = lowerValue;
    if (upperValue && !lowerValue) env[lower] = upperValue;
  });
  return env;
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

function ensureAccountSandbox(options) {
  const {
    fs,
    provider,
    accountId,
    getProfileDir,
    getToolConfigDir
  } = options;

  const profileDir = getProfileDir(provider, accountId);
  const configDir = getToolConfigDir(provider, accountId);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  return { profileDir, configDir };
}

function configureApiKeyAccount(options) {
  const {
    fs,
    provider,
    accountId,
    config,
    getProfileDir,
    getToolConfigDir
  } = options;

  const normalized = normalizeCredentialConfig({
    cli: provider,
    api_key: config && config.apiKey,
    base_url: config && config.baseUrl
  });
  if (!normalized.ok) {
    const error = new Error(normalized.error.message);
    error.code = normalized.error.code;
    throw error;
  }

  const { profileDir, configDir } = ensureAccountSandbox({
    fs,
    provider,
    accountId,
    getProfileDir,
    getToolConfigDir
  });

  const envPayload = {};
  const apiKey = normalized.value.api_key;
  const baseUrl = normalized.value.base_url;
  const envKeys = normalized.value.cli === 'gemini'
    ? ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
    : [normalized.value.cli === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'];

  envPayload[envKeys[0]] = apiKey;
  if (baseUrl) {
    if (provider === 'codex') envPayload.OPENAI_BASE_URL = baseUrl;
    if (provider === 'claude') envPayload.ANTHROPIC_BASE_URL = baseUrl;
  }

  fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify(envPayload, null, 2), 'utf8');

  if (provider === 'codex') {
    fs.writeFileSync(
      path.join(configDir, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2),
      'utf8'
    );
  }

  return {
    provider,
    accountId,
    profileDir,
    configDir,
    apiKeyMode: true
  };
}

function createAuthJobManager(options = {}) {
  const {
    fs,
    processObj = process,
    ptyImpl = nodePty,
    resolveCliPathImpl = resolveCliPath,
    buildPtyLaunchImpl = buildPtyLaunch,
    resolveWindowsBatchLaunchImpl = resolveWindowsBatchLaunch,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    getToolAccountIds,
    getProfileDir,
    getToolConfigDir,
    onOauthJobFinished,
    verifyOauthJobCompleted
  } = options;

  const jobs = new Map();
  const runningProviders = new Map();

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
    job.status = nextStatus;
    job.error = errorMessage ? String(errorMessage) : job.error;
    job.exitCode = Number.isInteger(exitCode) ? exitCode : job.exitCode;
    job.updatedAt = Date.now();
    if (runningProviders.get(job.provider) === job.id) {
      runningProviders.delete(job.provider);
    }
    return notifyOauthJobFinishedOnce(job);
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
    if (Number.isFinite(job.expiresAt) && job.expiresAt > 0 && now >= job.expiresAt) {
      job._terminationReason = 'expired';
      try {
        if (job._ptyProcess && typeof job._ptyProcess.kill === 'function') {
          job._ptyProcess.kill();
        }
      } catch (_error) {
        // ignore best effort kill
      }
      job._ptyProcess = null;
      finalizeJob(job, 'expired', '设备码已过期，请重新发起授权。', null);
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
      job._ptyProcess = null;
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
      if (!isUsableCodexRefreshToken(authJson.tokens.refresh_token)) {
        job.error = 'token_exchange_unusable_refresh_token';
        job.updatedAt = Date.now();
        appendJobLog(job, 'token exchange 成功但 refresh_token 不符合 Codex server pool 可用格式。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_unusable_refresh_token', job };
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

  function startManualCallbackCodexOauthJob(accountId, profileDir, configDir, existingAccountId) {
    const jobId = crypto.randomUUID();
    const pkce = createPkcePair();
    const state = createOauthState();
    const redirectUri = CODEX_OAUTH_LOOPBACK_REDIRECT_URI;
    const authorizationUrl = buildCodexAuthorizationUrl({
      redirectUri,
      codeChallenge: pkce.codeChallenge,
      state
    });
    const job = {
      id: jobId,
      provider: 'codex',
      accountId,
      authMode: 'oauth-browser',
      reauth: Boolean(existingAccountId),
      profileDir,
      configDir,
      status: 'running',
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
      _cancelRequested: false,
      _terminationReason: '',
      _finishedNotified: false,
      _finishedNotifyPromise: null,
      _ptyProcess: null,
      _preserveExistingAccount: Boolean(existingAccountId),
      _requireFreshOauthArtifacts: Boolean(existingAccountId),
      _oauthArtifactSignatureAtStart: '',
      _manualCallbackOauth: true,
      _codeVerifier: pkce.codeVerifier
    };
    if (job._requireFreshOauthArtifacts) {
      job._oauthArtifactSignatureAtStart = readOauthArtifactSignature(job, fs);
    }
    appendJobLog(job, 'Codex OAuth 流程已创建。');
    appendJobLog(job, `回调地址：${redirectUri}`);
    appendJobLog(job, `授权任务：provider=codex account=${accountId}${existingAccountId ? ' reauth=true' : ''}`);
    jobs.set(jobId, job);
    runningProviders.set('codex', jobId);
    return {
      jobId,
      provider: 'codex',
      accountId,
      expiresAt: job.expiresAt,
      pollIntervalMs: job.pollIntervalMs,
      authorizationUrl,
      redirectUri
    };
  }

  function startOauthJob(provider, authMode, jobOptions = {}) {
    cleanupFinishedJobs();
    const normalizedProvider = normalizeString(provider).toLowerCase();
    const normalizedMode = normalizeAuthMode(authMode);
    const existingAccountId = normalizeExistingAccountId(jobOptions.accountId);
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

    const cliPath = resolveCliPathImpl(normalizedProvider);
    if (!cliPath) {
      const error = new Error(`未找到 ${normalizedProvider} CLI，请先安装 ${cliConfig.pkg}`);
      error.code = 'cli_not_found';
      throw error;
    }

    const accountId = existingAccountId || getNextAccountIdFromIds(getToolAccountIds(normalizedProvider));
    const { profileDir, configDir } = ensureAccountSandbox({
      fs,
      provider: normalizedProvider,
      accountId,
      getProfileDir,
      getToolConfigDir
    });

    if (normalizedProvider === 'codex' && normalizedMode === 'oauth-browser') {
      return startManualCallbackCodexOauthJob(
        accountId,
        profileDir,
        configDir,
        existingAccountId
      );
    }

    const envOverrides = normalizeProxyEnv({
      ...processObj.env,
      HOME: profileDir,
      USERPROFILE: profileDir,
      CLAUDE_CONFIG_DIR: path.join(profileDir, '.claude'),
      CODEX_HOME: path.join(profileDir, '.codex'),
      XDG_CONFIG_HOME: profileDir,
      XDG_DATA_HOME: path.join(profileDir, '.local', 'share'),
      XDG_STATE_HOME: path.join(profileDir, '.local', 'state'),
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(profileDir, '.gemini', 'settings.json')
    });
    let browserCaptureCommand = '';
    if (normalizedMode === 'oauth-browser') {
      browserCaptureCommand = buildBrowserCaptureCommand(fs, profileDir, processObj.platform);
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
      batchLaunch.launchBin || normalizedProvider,
      argsToRun,
      { platform: processObj.platform }
    );

    const ptyProcess = ptyImpl.spawn(launch.command, launch.args, {
      name: 'xterm-color',
      cols: 120,
      rows: 32,
      cwd: typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd(),
      env: {
        ...envOverrides,
        ...(batchLaunch.envPatch || {})
      }
    });

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      provider: normalizedProvider,
      accountId,
      authMode: normalizedMode,
      reauth: Boolean(existingAccountId),
      profileDir,
      configDir,
      status: 'running',
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
      _preserveExistingAccount: Boolean(existingAccountId),
      _requireFreshOauthArtifacts: Boolean(existingAccountId),
      _oauthArtifactSignatureAtStart: ''
    };

    if (job._requireFreshOauthArtifacts) {
      job._oauthArtifactSignatureAtStart = readOauthArtifactSignature(job, fs);
    }

    jobs.set(jobId, job);
    runningProviders.set(normalizedProvider, jobId);

    ptyProcess.onData((chunk) => {
      appendLog(job, chunk);
      const hints = extractOAuthChallenge(job.logs);
      if (hints.verificationUri) job.verificationUri = hints.verificationUri;
      if (hints.verificationUriComplete) job.verificationUriComplete = hints.verificationUriComplete;
      if (hints.userCode) job.userCode = hints.userCode;
      if (job.authMode === 'oauth-browser') {
        const browserHints = extractBrowserOAuthHints(job.logs);
        if (browserHints.authorizationUrl) job.authorizationUrl = browserHints.authorizationUrl;
        if (browserHints.redirectUri) job.redirectUri = browserHints.redirectUri;
        if (browserHints.state) job.oauthState = browserHints.state;
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
    });

    ptyProcess.onExit(({ exitCode }) => {
      job._ptyProcess = null;
      job.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
      if (job.status !== 'running') {
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
      accountId,
      expiresAt: job.expiresAt,
      pollIntervalMs: job.pollIntervalMs
    };
  }

  async function completeBrowserOauthCallback(jobId, rawCallbackUrl) {
    const job = getJob(jobId);
    if (!job) return { ok: false, code: 'job_not_found' };
    if (job.status !== 'running') return { ok: false, code: 'job_not_running', job };
    if (job.authMode !== 'oauth-browser') return { ok: false, code: 'callback_not_supported', job };
    if (job._manualCallbackOauth) {
      appendJobLog(job, '收到浏览器 OAuth 回调提交。');
      const pasted = parseBrowserCallbackInput(rawCallbackUrl, job.redirectUri);
      if (!pasted) {
        appendJobLog(job, '回调地址解析失败。');
        return { ok: false, code: 'invalid_callback_url', job };
      }
      if (!isSameCallbackEndpoint(pasted, job.redirectUri)) {
        appendJobLog(job, '回调地址 endpoint 与当前授权任务不一致。');
        return { ok: false, code: 'invalid_callback_redirect', job };
      }
      const state = String(pasted.searchParams.get('state') || '');
      if (job.oauthState && state !== job.oauthState) {
        appendJobLog(job, '回调 state 校验失败。');
        return { ok: false, code: 'invalid_callback_state', job };
      }
      appendJobLog(job, '回调 state 校验通过。');
      const errorParam = normalizeString(pasted.searchParams.get('error') || pasted.searchParams.get('error_description'));
      if (errorParam) {
        job.error = errorParam;
        appendJobLog(job, `OAuth provider 返回错误：${compactLogText(errorParam)}`);
        finalizeJob(job, 'failed', errorParam, 1);
        return { ok: false, code: 'oauth_provider_error', job };
      }
      if (!normalizeString(pasted.searchParams.get('code'))) {
        appendJobLog(job, '回调缺少 code 参数。');
      }
      return exchangeManualCallbackCodexCode(job, pasted.searchParams.get('code'), job.redirectUri);
    }
    if (!job.redirectUri || !isLoopbackCallbackUrl(job.redirectUri)) {
      return { ok: false, code: 'oauth_redirect_not_ready', job };
    }
    if (typeof fetchImpl !== 'function') {
      return { ok: false, code: 'callback_forward_unavailable', job };
    }

    const pasted = parseBrowserCallbackInput(rawCallbackUrl, job.redirectUri);
    if (!pasted) return { ok: false, code: 'invalid_callback_url', job };
    const state = String(pasted.searchParams.get('state') || '');
    if (job.oauthState && state !== job.oauthState) {
      return { ok: false, code: 'invalid_callback_state', job };
    }

    const target = new URL(job.redirectUri);
    target.search = pasted.search;
    target.hash = '';
    try {
      const response = await fetchImpl(target.toString(), { method: 'GET' });
      if (response && response.ok === false) {
        return { ok: false, code: 'callback_forward_failed', statusCode: response.status, job };
      }
      job.browserCallbackForwardedAt = Date.now();
      job.updatedAt = Date.now();
      return { ok: true, job: refreshJobState(job) };
    } catch (error) {
      job.error = String((error && error.message) || error || 'callback_forward_failed');
      job.updatedAt = Date.now();
      return { ok: false, code: 'callback_forward_failed', job };
    }
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
  normalizeExistingAccountId,
  PROVIDER_AUTH_MODE_MATRIX,
  PROVIDER_DEFAULT_AUTH_MODE,
  isSupportedAuthMode,
  getDefaultAuthMode,
  getNextAccountIdFromIds,
  extractOAuthChallenge,
  extractBrowserOAuthHints,
  configureApiKeyAccount,
  createAuthJobManager
};
