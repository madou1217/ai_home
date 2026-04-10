'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const nodePty = require('node-pty');

const { AI_CLI_CONFIGS } = require('../cli/services/ai-cli/provider-registry');
const { normalizeCredentialConfig } = require('../profile/credential-config');
const { resolveCliPath } = require('../runtime/platform-runtime');
const { buildPtyLaunch, resolveWindowsBatchLaunch } = require('../runtime/pty-launch');

const JOB_LOG_LIMIT = 40000;
const FINISHED_JOB_TTL_MS = 15 * 60 * 1000;
const PROVIDER_AUTH_MODE_MATRIX = Object.freeze({
  codex: Object.freeze(['oauth-browser', 'oauth-device', 'api-key']),
  claude: Object.freeze(['oauth-browser', 'api-key']),
  gemini: Object.freeze(['oauth-browser', 'api-key'])
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

function stripAnsi(text) {
  return String(text || '').replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
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

function appendLog(job, chunk) {
  const text = stripAnsi(String(chunk || ''));
  if (!text) return;
  job.logs = `${job.logs}${text}`;
  if (job.logs.length > JOB_LOG_LIMIT) {
    job.logs = job.logs.slice(-JOB_LOG_LIMIT);
  }
  job.lastOutputAt = Date.now();
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

function hasOauthCompletionArtifacts(job, fs) {
  if (!job || !job.configDir) return false;
  if (job.provider === 'codex') return hasCodexOauthTokens(job.configDir, fs);
  if (job.provider === 'claude') return hasClaudeOauthTokens(job.configDir, fs);
  if (job.provider === 'gemini') return hasGeminiOauthTokens(job.configDir, fs);
  return false;
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
    getToolAccountIds,
    getProfileDir,
    getToolConfigDir,
    onOauthJobFinished
  } = options;

  const jobs = new Map();
  const runningProviders = new Map();

  function notifyOauthJobFinishedOnce(job) {
    if (!job || job.status !== 'succeeded' || job._finishedNotified) return;
    job._finishedNotified = true;
    if (typeof onOauthJobFinished === 'function') {
      Promise.resolve(onOauthJobFinished(job)).catch(() => {});
    }
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
    notifyOauthJobFinishedOnce(job);
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

    if (!isProcessAlive(job.pid, processObj)) {
      job._ptyProcess = null;
      finalizeJob(job, 'failed', job.error || '授权进程已结束，请重新发起授权。', job.exitCode);
      return job;
    }

    return job;
  }

  function startOauthJob(provider, authMode) {
    cleanupFinishedJobs();
    const normalizedProvider = normalizeString(provider).toLowerCase();
    const normalizedMode = normalizeAuthMode(authMode);
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

    const accountId = getNextAccountIdFromIds(getToolAccountIds(normalizedProvider));
    const { profileDir, configDir } = ensureAccountSandbox({
      fs,
      provider: normalizedProvider,
      accountId,
      getProfileDir,
      getToolConfigDir
    });

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
      _cancelRequested: false,
      _terminationReason: '',
      _finishedNotified: false,
      _ptyProcess: ptyProcess
    };

    jobs.set(jobId, job);
    runningProviders.set(normalizedProvider, jobId);

    ptyProcess.onData((chunk) => {
      appendLog(job, chunk);
      const hints = extractOAuthChallenge(job.logs);
      if (hints.verificationUri) job.verificationUri = hints.verificationUri;
      if (hints.verificationUriComplete) job.verificationUriComplete = hints.verificationUriComplete;
      if (hints.userCode) job.userCode = hints.userCode;
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
      finalizeJob(
        job,
        job.exitCode === 0 ? 'succeeded' : 'failed',
        job.exitCode === 0 ? '' : (job.error || `OAuth 登录失败，退出码 ${job.exitCode}`),
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

  return {
    getJob,
    getRunningJob,
    cancelJob,
    startOauthJob
  };
}

module.exports = {
  stripAnsi,
  parseDeviceCodeExpiryMs,
  parseDeviceCodePollIntervalMs,
  isProcessAlive,
  normalizeAuthMode,
  PROVIDER_AUTH_MODE_MATRIX,
  isSupportedAuthMode,
  getNextAccountIdFromIds,
  extractOAuthChallenge,
  configureApiKeyAccount,
  createAuthJobManager
};
