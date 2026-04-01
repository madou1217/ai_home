'use strict';

const { spawn: spawnChild } = require('node:child_process');
const DEFAULT_OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_CODEX_CLI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function createUsageSnapshotService(options = {}) {
  const {
    fs,
    path,
    spawn,
    spawnSync,
    fetchImpl,
    processObj,
    resolveCliPath,
    usageSnapshotSchemaVersion,
    usageRefreshStaleMs,
    usageSourceGemini,
    usageSourceCodex,
    usageSourceClaudeOauth,
    usageSourceClaudeAuthToken,
    getProfileDir,
    getToolConfigDir,
    writeUsageCache,
    readUsageCache
  } = options;
  const spawnProcess = typeof spawn === 'function' ? spawn : spawnChild;
  const fetchWithImpl = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  const probeErrorByAccountKey = new Map();

  function makeProbeErrorKey(cliName, id) {
    return `${String(cliName || '').trim()}#${String(id || '').trim()}`;
  }

  function setProbeError(cliName, id, message) {
    const key = makeProbeErrorKey(cliName, id);
    if (!key) return;
    const text = String(message || '').trim();
    if (!text) {
      probeErrorByAccountKey.delete(key);
      return;
    }
    probeErrorByAccountKey.set(key, text.slice(0, 500));
  }

  function getLastUsageProbeError(cliName, id) {
    return probeErrorByAccountKey.get(makeProbeErrorKey(cliName, id)) || '';
  }

  function normalizeGeminiModelId(modelId) {
    if (!modelId) return '';
    return String(modelId).replace(/_vertex$/i, '');
  }

  function formatResetInFromIso(resetTime) {
    const target = new Date(resetTime).getTime();
    if (!Number.isFinite(target)) return 'unknown';
    const diffMs = Math.max(0, target - Date.now());
    const totalMinutes = Math.ceil(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return 'soon';
  }

  function parseResetAtMsFromIso(resetTime) {
    const target = new Date(resetTime).getTime();
    if (!Number.isFinite(target) || target <= 0) return null;
    return target;
  }

  function formatResetInFromUnixSeconds(resetAtSeconds) {
    const resetSec = Number(resetAtSeconds);
    if (!Number.isFinite(resetSec) || resetSec <= 0) return 'unknown';
    const target = resetSec * 1000;
    const diffMs = Math.max(0, target - Date.now());
    const totalMinutes = Math.ceil(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return 'soon';
  }

  function parseResetAtMsFromUnixSeconds(resetAtSeconds) {
    const resetSec = Number(resetAtSeconds);
    if (!Number.isFinite(resetSec) || resetSec <= 0) return null;
    return resetSec * 1000;
  }

  function parseDurationMsFromResetIn(resetInText) {
    const text = String(resetInText || '').trim().toLowerCase();
    if (!text || text === 'unknown' || text === 'soon') return null;
    const re = /(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)/g;
    let totalMs = 0;
    let matched = false;
    let m = null;
    while ((m = re.exec(text)) !== null) {
      matched = true;
      const value = Number(m[1]);
      const unit = String(m[2] || '');
      if (!Number.isFinite(value) || value < 0) continue;
      if (unit.startsWith('d')) totalMs += value * 24 * 60 * 60 * 1000;
      else if (unit.startsWith('h')) totalMs += value * 60 * 60 * 1000;
      else if (unit.startsWith('m')) totalMs += value * 60 * 1000;
      else if (unit.startsWith('s')) totalMs += value * 1000;
    }
    if (!matched || totalMs <= 0) return null;
    return totalMs;
  }

  function deriveResetAtMsFromEntry(entry, capturedAt) {
    const direct = Number(entry && entry.resetAtMs);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const base = Number(capturedAt);
    if (!Number.isFinite(base) || base <= 0) return null;
    const fromText = parseDurationMsFromResetIn(entry && entry.resetIn);
    if (!Number.isFinite(fromText) || fromText <= 0) return null;
    return base + fromText;
  }

  function parseGeminiQuotaBuckets(buckets) {
    if (!Array.isArray(buckets)) return null;
    const modelMap = new Map();
    buckets.forEach((bucket) => {
      if (!bucket || typeof bucket.modelId !== 'string') return;
      if (!Number.isFinite(bucket.remainingFraction)) return;
      if (!bucket.resetTime) return;

      const model = normalizeGeminiModelId(bucket.modelId);
      if (!model.startsWith('gemini-')) return;

      const remainingPct = Math.max(0, Math.min(100, bucket.remainingFraction * 100));
      const next = {
        model,
        remainingPct,
        resetIn: formatResetInFromIso(bucket.resetTime),
        resetTime: bucket.resetTime
      };

      const prev = modelMap.get(model);
      if (!prev) {
        modelMap.set(model, next);
        return;
      }

      if (next.remainingPct < prev.remainingPct) {
        modelMap.set(model, next);
        return;
      }

      if (next.remainingPct === prev.remainingPct && String(next.resetTime) < String(prev.resetTime)) {
        modelMap.set(model, next);
      }
    });

    const models = Array.from(modelMap.values())
      .sort((a, b) => a.model.localeCompare(b.model))
      .map(({ model, remainingPct, resetIn, resetTime }) => ({
        model,
        remainingPct,
        resetIn,
        resetAtMs: parseResetAtMsFromIso(resetTime)
      }));

    if (models.length === 0) return null;
    return {
      schemaVersion: usageSnapshotSchemaVersion,
      kind: 'gemini_oauth_stats',
      source: usageSourceGemini,
      capturedAt: Date.now(),
      models
    };
  }

  function refreshGeminiUsageSnapshot(cliName, id) {
    if (cliName !== 'gemini') return null;
    const sandboxDir = getProfileDir(cliName, id);
    if (!fs.existsSync(sandboxDir)) return null;

    const geminiBin = resolveCliPath('gemini');
    if (!geminiBin) return null;

    const probeScript = `
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
(async () => {
  try {
    const bin = process.env.AIH_GEMINI_BIN;
    const distIndex = fs.realpathSync(bin);
    const srcRoot = path.join(path.dirname(distIndex), 'src');
    const { loadSettings } = await import(path.join(srcRoot, 'config/settings.js'));
    const { parseArguments, loadCliConfig } = await import(path.join(srcRoot, 'config/config.js'));
    process.argv = ['node', 'gemini'];
    const settings = loadSettings();
    const argv = await parseArguments(settings.merged);
    const config = await loadCliConfig(settings.merged, crypto.randomUUID(), argv, {
      projectHooks: settings.workspace?.settings?.hooks,
    });
    await config.initialize();
    const authType = settings.merged?.security?.auth?.selectedType;
    if (authType) await config.refreshAuth(authType);
    const quota = await config.refreshUserQuota();
    console.log('AIH_QUOTA_JSON_START');
    console.log(JSON.stringify({
      ok: true,
      buckets: quota?.buckets || [],
    }));
    console.log('AIH_QUOTA_JSON_END');
  } catch (err) {
    console.log('AIH_QUOTA_JSON_START');
    console.log(JSON.stringify({
      ok: false,
      error: String((err && err.message) || err),
    }));
    console.log('AIH_QUOTA_JSON_END');
  }
})();
`;

    const envOverrides = {
      ...processObj.env,
      HOME: sandboxDir,
      USERPROFILE: sandboxDir,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(sandboxDir, '.gemini', 'settings.json'),
      AIH_GEMINI_BIN: geminiBin
    };

    try {
      const run = spawnSync(processObj.execPath, ['-e', probeScript], {
        cwd: processObj.cwd(),
        env: envOverrides,
        encoding: 'utf8',
        timeout: 45000,
        maxBuffer: 8 * 1024 * 1024
      });

      const joined = `${run.stdout || ''}\n${run.stderr || ''}`;
      const m = joined.match(/AIH_QUOTA_JSON_START\s*([\s\S]*?)\s*AIH_QUOTA_JSON_END/);
      if (!m) return null;

      const parsedOutput = JSON.parse(m[1]);
      if (!parsedOutput || parsedOutput.ok !== true) return null;

      const parsed = parseGeminiQuotaBuckets(parsedOutput.buckets || []);
      if (!parsed) return null;

      writeUsageCache(cliName, id, parsed);
      return parsed;
    } catch (_error) {
      return null;
    }
  }

  function formatCodexWindow(windowMinutes) {
    const minutes = Number(windowMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return String(windowMinutes);
    if (minutes % 1440 === 0) return `${Math.round(minutes / 1440)}days`;
    if (minutes % 60 === 0) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes)}m`;
  }

  function normalizeCodexRateLimitWindow(bucket) {
    if (!bucket || typeof bucket !== 'object') return null;
    const windowMinutesRaw = bucket.window_minutes ?? bucket.windowDurationMins;
    const usedPctRaw = bucket.used_percent ?? bucket.usedPercent;
    const resetsAtRaw = bucket.resets_at ?? bucket.resetsAt;

    const windowMinutes = Number(windowMinutesRaw);
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;

    const usedPctNumber = Number(usedPctRaw);
    const usedPct = Number.isFinite(usedPctNumber)
      ? Math.max(0, Math.min(100, usedPctNumber))
      : null;

    return {
      windowMinutes,
      usedPct,
      resetsAt: resetsAtRaw
    };
  }

  function parseCodexRateLimits(rateLimits, capturedAt, source) {
    if (!rateLimits || typeof rateLimits !== 'object') return null;
    const entries = [];
    ['primary', 'secondary'].forEach((bucketName) => {
      const normalizedBucket = normalizeCodexRateLimitWindow(rateLimits[bucketName]);
      if (!normalizedBucket) return;
      const { windowMinutes, usedPct, resetsAt } = normalizedBucket;
      const remainingPct = typeof usedPct === 'number'
        ? Math.max(0, Math.min(100, 100 - usedPct))
        : null;

      entries.push({
        bucket: bucketName,
        windowMinutes,
        window: formatCodexWindow(windowMinutes),
        remainingPct,
        resetIn: formatResetInFromUnixSeconds(resetsAt),
        resetAtMs: parseResetAtMsFromUnixSeconds(resetsAt)
      });
    });

    if (entries.length === 0) return null;
    return {
      schemaVersion: usageSnapshotSchemaVersion,
      kind: 'codex_oauth_status',
      capturedAt: capturedAt || Date.now(),
      source: source || usageSourceCodex,
      entries
    };
  }

  function parseCodexAccountFallback(account, capturedAt, source) {
    if (!account || typeof account !== 'object') return null;
    const planType = String(account.planType || '').trim();
    const email = String(account.email || '').trim();
    const labelParts = [];
    if (planType) labelParts.push(`plan:${planType}`);
    if (email) labelParts.push(email);
    const fallbackLabel = labelParts.join(' ').trim() || 'account';
    return {
      schemaVersion: usageSnapshotSchemaVersion,
      kind: 'codex_oauth_status',
      capturedAt: capturedAt || Date.now(),
      source: source || usageSourceCodex,
      entries: [{
        bucket: 'account',
        windowMinutes: 0,
        window: fallbackLabel,
        remainingPct: null,
        resetIn: 'unknown'
      }]
    };
  }

  function refreshCodexUsageSnapshotFromAppServer(cliName, id) {
    if (cliName !== 'codex') return null;
    const sandboxDir = getProfileDir(cliName, id);
    if (!fs.existsSync(sandboxDir)) return null;

    const codexBin = resolveCliPath('codex');
    if (!codexBin) return null;

    const probeScript = `
const { spawn } = require('child_process');

const codexBin = process.env.AIH_CODEX_BIN;
const codexHome = process.env.AIH_CODEX_HOME;
const sandboxDir = process.env.AIH_CODEX_SANDBOX;

const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  HOME: sandboxDir,
  USERPROFILE: sandboxDir
};

function print(payload) {
  console.log('AIH_CODEX_RATE_LIMIT_JSON_START');
  console.log(JSON.stringify(payload));
  console.log('AIH_CODEX_RATE_LIMIT_JSON_END');
}

let done = false;
function finish(payload) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  try {
    child.kill('SIGTERM');
  } catch (e) {}
  print(payload);
}

function quoteForCmd(arg) {
  const text = String(arg || '');
  if (!text) return '""';
  if (/^[A-Za-z0-9._:/\\\\-]+$/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function startCodexAppServer() {
  if (process.platform === 'win32') {
    const line = [quoteForCmd(codexBin), 'app-server', '--listen', 'stdio://'].join(' ');
    return spawn('cmd.exe', ['/d', '/s', '/c', line], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    });
  }
  return spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });
}

const child = startCodexAppServer();

let stdoutBuf = '';
let stderrBuf = '';
let accountReadRequested = false;
const timer = setTimeout(() => {
  finish({ ok: false, error: 'timeout' });
}, 9000);

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');

child.stderr.on('data', (chunk) => {
  stderrBuf += String(chunk || '');
});

child.stdout.on('data', (chunk) => {
  stdoutBuf += String(chunk || '');
  let idx = -1;
  while ((idx = stdoutBuf.indexOf('\\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (msg && msg.id === 'aih_init') {
      child.stdin.write(JSON.stringify({ method: 'account/rateLimits/read', id: 'aih_rate' }) + '\\n');
      continue;
    }
    if (msg && msg.id === 'aih_rate') {
      if (msg.result && msg.result.rateLimits) {
        finish({ ok: true, rateLimits: msg.result.rateLimits });
      } else {
        if (!accountReadRequested) {
          accountReadRequested = true;
          child.stdin.write(JSON.stringify({ method: 'account/read', id: 'aih_account', params: {} }) + '\\n');
        } else if (msg.error) {
          finish({ ok: false, error: String(msg.error.message || msg.error.code || 'rate_limit_read_failed') });
        } else {
          finish({ ok: false, error: 'empty_rate_limit_response' });
        }
      }
      return;
    }
    if (msg && msg.id === 'aih_account') {
      if (msg.result && msg.result.account) {
        finish({ ok: true, account: msg.result.account, fallback: 'account_read' });
      } else if (msg.error) {
        finish({ ok: false, error: String(msg.error.message || msg.error.code || 'account_read_failed') });
      } else {
        finish({ ok: false, error: 'empty_account_response' });
      }
      return;
    }
  }
});

child.on('error', (err) => {
  finish({ ok: false, error: String((err && err.message) || err) });
});

child.on('exit', (code) => {
  if (done) return;
  const detail = stderrBuf || stdoutBuf || '';
  finish({ ok: false, error: code === 0 ? 'no_rate_limit_response' : ('app_server_exit_' + String(code)), detail });
});

child.stdin.write(JSON.stringify({
  method: 'initialize',
  id: 'aih_init',
  params: {
    clientInfo: { name: 'aih-probe', version: '1.0.0' },
    capabilities: null
  }
}) + '\\n');
`;

    const envOverrides = {
      ...processObj.env,
      AIH_CODEX_BIN: codexBin,
      AIH_CODEX_HOME: path.join(sandboxDir, '.codex'),
      AIH_CODEX_SANDBOX: sandboxDir
    };

    try {
      const run = spawnSync(processObj.execPath, ['-e', probeScript], {
        cwd: processObj.cwd(),
        env: envOverrides,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024
      });

      const joined = `${run.stdout || ''}\n${run.stderr || ''}`;
      const m = joined.match(/AIH_CODEX_RATE_LIMIT_JSON_START\s*([\s\S]*?)\s*AIH_CODEX_RATE_LIMIT_JSON_END/);
      if (!m) {
        setProbeError(cliName, id, joined || 'missing_probe_output');
        return null;
      }

      const parsedOutput = JSON.parse(m[1]);
      if (!parsedOutput || parsedOutput.ok !== true) {
        setProbeError(cliName, id, parsedOutput && (parsedOutput.error || parsedOutput.detail) ? `${parsedOutput.error || ''} ${parsedOutput.detail || ''}` : 'probe_not_ok');
        return null;
      }

      let parsed = null;
      if (parsedOutput.rateLimits) {
        parsed = parseCodexRateLimits(parsedOutput.rateLimits, Date.now(), usageSourceCodex);
      }
      if (!parsed && parsedOutput.account) {
        parsed = parseCodexAccountFallback(parsedOutput.account, Date.now(), usageSourceCodex);
      }
      if (!parsed) {
        setProbeError(cliName, id, 'empty_parsed_snapshot');
        return null;
      }

      writeUsageCache(cliName, id, parsed);
      setProbeError(cliName, id, '');
      return parsed;
    } catch (_error) {
      setProbeError(cliName, id, 'probe_exception');
      return null;
    }
  }

  function refreshCodexUsageSnapshot(cliName, id) {
    if (cliName !== 'codex') return null;
    return refreshCodexUsageSnapshotFromAppServer(cliName, id);
  }

  function sanitizeAccessToken(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token) return '';
    if (/[\r\n\0]/.test(token)) return '';
    return token;
  }

  function decodeJwtPayloadUnsafe(jwt) {
    const text = String(jwt || '').trim();
    const parts = text.split('.');
    if (parts.length < 2) return null;
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    } catch (_error) {
      return null;
    }
  }

  function readCodexAuthForSandbox(cliName, id) {
    if (cliName !== 'codex') return null;
    const authPath = path.join(getToolConfigDir(cliName, id), 'auth.json');
    if (!fs.existsSync(authPath)) return null;
    try {
      const authJson = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
      if (!tokens) return null;
      const accessToken = sanitizeAccessToken(tokens.access_token || '');
      if (!accessToken) return null;
      return {
        accessToken,
        accountId: String(tokens.account_id || '').trim()
      };
    } catch (_error) {
      return null;
    }
  }

  async function refreshCodexTokenForSandbox(cliName, id) {
    if (cliName !== 'codex') return false;
    if (typeof fetchWithImpl !== 'function') return false;
    const authPath = path.join(getToolConfigDir(cliName, id), 'auth.json');
    if (!fs.existsSync(authPath)) return false;

    let authJson = null;
    try {
      authJson = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    } catch (_error) {
      return false;
    }
    const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
    if (!tokens) return false;

    const refreshToken = String(tokens.refresh_token || '').trim();
    if (!refreshToken.startsWith('rt_')) return false;
    const accessToken = sanitizeAccessToken(tokens.access_token || '');
    const payload = decodeJwtPayloadUnsafe(accessToken);
    const clientId = String(payload && payload.client_id || '').trim() || DEFAULT_CODEX_CLI_CLIENT_ID;

    const timeoutRaw = Number(processObj.env.AIH_CODEX_TOKEN_REFRESH_TIMEOUT_MS || '7000');
    const timeoutMs = Number.isFinite(timeoutRaw)
      ? Math.max(2000, Math.min(30000, Math.floor(timeoutRaw)))
      : 7000;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchWithImpl(String(processObj.env.AIH_CODEX_TOKEN_URL || DEFAULT_OPENAI_OAUTH_TOKEN_URL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: 'openid profile email offline_access'
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response || !response.ok) return false;
      const text = await response.text();
      let next = null;
      try {
        next = JSON.parse(text);
      } catch (_error) {
        return false;
      }
      const nextAccess = sanitizeAccessToken(next && (next.access_token || next.accessToken) || '');
      if (!nextAccess) return false;
      const nextId = sanitizeAccessToken(next && (next.id_token || next.idToken) || '');
      const nextRefresh = sanitizeAccessToken(next && (next.refresh_token || next.refreshToken) || '');

      const nextTokens = { ...tokens, access_token: nextAccess };
      if (nextId) nextTokens.id_token = nextId;
      if (nextRefresh.startsWith('rt_')) nextTokens.refresh_token = nextRefresh;
      const merged = {
        ...authJson,
        tokens: nextTokens,
        last_refresh: new Date().toISOString()
      };
      fs.writeFileSync(authPath, `${JSON.stringify(merged, null, 2)}\n`);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function readCodexDirectMode() {
    return String(processObj.env.AIH_CODEX_USAGE_DIRECT || '1') !== '0';
  }

  function resolveCodexDirectBaseUrl() {
    const byUsage = String(processObj.env.AIH_CODEX_USAGE_BASE_URL || '').trim();
    if (byUsage) return byUsage.replace(/\/+$/, '');
    const byServer = String(processObj.env.AIH_SERVER_CODEX_BASE_URL || '').trim();
    if (byServer) return byServer.replace(/\/+$/, '');
    return 'https://chatgpt.com/backend-api/codex';
  }

  function resolveCodexDirectRateLimitPath() {
    const byUsage = String(processObj.env.AIH_CODEX_USAGE_PATH || '').trim();
    if (byUsage) {
      if (byUsage.startsWith('/')) return byUsage;
      return `/${byUsage}`;
    }
    return '/account/rate_limits';
  }

  function extractRateLimitsFromDirectPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.rateLimits && typeof payload.rateLimits === 'object') return payload.rateLimits;
    if (payload.rate_limits && typeof payload.rate_limits === 'object') return payload.rate_limits;
    if (payload.result && payload.result.rateLimits && typeof payload.result.rateLimits === 'object') return payload.result.rateLimits;
    if (payload.result && payload.result.rate_limits && typeof payload.result.rate_limits === 'object') return payload.result.rate_limits;
    return null;
  }

  async function refreshCodexUsageSnapshotFromDirectApiAsync(cliName, id) {
    if (cliName !== 'codex') return null;
    if (!readCodexDirectMode()) return null;
    if (typeof fetchWithImpl !== 'function') return null;
    const auth = readCodexAuthForSandbox(cliName, id);
    if (!auth || !auth.accessToken) return null;

    const timeoutMsRaw = Number(processObj.env.AIH_CODEX_USAGE_HTTP_TIMEOUT_MS || '2500');
    const timeoutMs = Number.isFinite(timeoutMsRaw)
      ? Math.max(1000, Math.min(30000, Math.floor(timeoutMsRaw)))
      : 2500;
    const url = `${resolveCodexDirectBaseUrl()}${resolveCodexDirectRateLimitPath()}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchWithImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          accept: 'application/json',
          version: '0.101.0',
          originator: 'codex_cli_rs',
          'user-agent': 'codex_cli_rs/0.101.0',
          ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {})
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response || !response.ok) {
        setProbeError(cliName, id, `direct_http_status_${response ? response.status : 'unknown'}`);
        return null;
      }
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        setProbeError(cliName, id, 'direct_json_parse_failed');
        return null;
      }
      const rateLimits = extractRateLimitsFromDirectPayload(payload);
      if (!rateLimits) {
        setProbeError(cliName, id, 'direct_missing_rate_limits');
        return null;
      }
      return buildCodexSnapshotFromProbePayload(cliName, id, { ok: true, rateLimits });
    } catch (_error) {
      setProbeError(cliName, id, 'direct_request_failed');
      return null;
    }
  }

  function buildCodexSnapshotFromProbePayload(cliName, id, payload) {
    if (!payload || payload.ok !== true) return null;
    let parsed = null;
    if (payload.rateLimits) {
      parsed = parseCodexRateLimits(payload.rateLimits, Date.now(), usageSourceCodex);
    }
    if (!parsed && payload.account) {
      parsed = parseCodexAccountFallback(payload.account, Date.now(), usageSourceCodex);
    }
    if (!parsed) return null;
    writeUsageCache(cliName, id, parsed);
    setProbeError(cliName, id, '');
    return parsed;
  }

  function createCodexProbeTimeoutMs(timeoutOverrideMs) {
    if (Number.isFinite(Number(timeoutOverrideMs)) && Number(timeoutOverrideMs) > 0) {
      return Math.max(1000, Math.min(30000, Math.floor(Number(timeoutOverrideMs))));
    }
    const value = Number(processObj.env.AIH_CODEX_USAGE_TIMEOUT_MS || '2500');
    if (!Number.isFinite(value)) return 2500;
    return Math.max(1000, Math.min(30000, Math.floor(value)));
  }

  function refreshCodexUsageSnapshotFromAppServerAsync(cliName, id, timeoutOverrideMs = null) {
    if (cliName !== 'codex') return Promise.resolve(null);
    const sandboxDir = getProfileDir(cliName, id);
    if (!fs.existsSync(sandboxDir)) return Promise.resolve(null);

    const codexBin = resolveCliPath('codex');
    if (!codexBin) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timeoutMs = createCodexProbeTimeoutMs(timeoutOverrideMs);
      const child = spawnProcess(codexBin, ['app-server', '--listen', 'stdio://'], {
        cwd: processObj.cwd(),
        env: {
          ...processObj.env,
          CODEX_HOME: path.join(sandboxDir, '.codex'),
          HOME: sandboxDir,
          USERPROFILE: sandboxDir
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let done = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let accountReadRequested = false;
      const finalize = (payload) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          child.stdin.end();
        } catch (_e) {}
        try {
          child.kill('SIGTERM');
        } catch (_e) {}
        const snapshot = buildCodexSnapshotFromProbePayload(cliName, id, payload);
        if (!snapshot) {
          setProbeError(cliName, id, payload && (payload.error || payload.detail) ? `${payload.error || ''} ${payload.detail || ''}` : 'probe_failed');
        } else {
          setProbeError(cliName, id, '');
        }
        resolve(snapshot || null);
      };

      const timer = setTimeout(() => {
        finalize({ ok: false, error: 'timeout' });
      }, timeoutMs);

      const writeRpc = (payload) => {
        if (done) return;
        try {
          if (!child.stdin || typeof child.stdin.write !== 'function' || child.stdin.destroyed || child.stdin.writableEnded) {
            finalize({ ok: false, error: 'stdin_write_failed' });
            return;
          }
          child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
            if (error) finalize({ ok: false, error: 'stdin_write_failed' });
          });
        } catch (_e) {
          finalize({ ok: false, error: 'stdin_write_failed' });
        }
      };

      const processLine = (lineText) => {
        if (!lineText || done) return;
        let msg = null;
        try {
          msg = JSON.parse(lineText);
        } catch (_e) {
          return;
        }
        if (msg && msg.id === 'aih_init') {
          writeRpc({ method: 'account/rateLimits/read', id: 'aih_rate' });
          return;
        }
        if (msg && msg.id === 'aih_rate') {
          if (msg.result && msg.result.rateLimits) {
            finalize({ ok: true, rateLimits: msg.result.rateLimits });
            return;
          }
          if (!accountReadRequested) {
            accountReadRequested = true;
            writeRpc({ method: 'account/read', id: 'aih_account', params: {} });
            return;
          }
          const err = msg && msg.error ? String(msg.error.message || msg.error.code || 'rate_limit_read_failed') : 'empty_rate_limit_response';
          finalize({ ok: false, error: err });
          return;
        }
        if (msg && msg.id === 'aih_account') {
          if (msg.result && msg.result.account) {
            finalize({ ok: true, account: msg.result.account, fallback: 'account_read' });
            return;
          }
          const err = msg && msg.error ? String(msg.error.message || msg.error.code || 'account_read_failed') : 'empty_account_response';
          finalize({ ok: false, error: err });
        }
      };

      if (child.stdout && typeof child.stdout.setEncoding === 'function') {
        child.stdout.setEncoding('utf8');
      }
      if (child.stderr && typeof child.stderr.setEncoding === 'function') {
        child.stderr.setEncoding('utf8');
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          stderrBuf += String(chunk || '');
        });
      }
      if (child.stdin && typeof child.stdin.on === 'function') {
        child.stdin.on('error', () => {
          finalize({ ok: false, error: 'stdin_write_failed' });
        });
      }
      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          stdoutBuf += String(chunk || '');
          let idx = -1;
          while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
            const line = stdoutBuf.slice(0, idx).trim();
            stdoutBuf = stdoutBuf.slice(idx + 1);
            processLine(line);
          }
        });
      }

      child.on('error', () => finalize({ ok: false, error: 'spawn_failed' }));
      child.on('exit', (code) => {
        if (done) return;
        const detail = stderrBuf || stdoutBuf || '';
        finalize({
          ok: false,
          error: code === 0 ? 'no_rate_limit_response' : `app_server_exit_${String(code)}`,
          detail
        });
      });

      writeRpc({
        method: 'initialize',
        id: 'aih_init',
        params: {
          clientInfo: { name: 'aih-probe', version: '1.0.0' },
          capabilities: null
        }
      });
    });
  }

  function toPercentNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (num <= 1) return Math.max(0, Math.min(100, num * 100));
    return Math.max(0, Math.min(100, num));
  }

  function readJsonFileSafe(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  function parseClaudeUsagePayload(payload, capturedAt, source) {
    if (!payload || typeof payload !== 'object') return null;
    const fiveHourRaw = payload.five_hour || payload.fiveHour || null;
    const sevenDayRaw = payload.seven_day || payload.sevenDay || null;
    const entries = [];

    const fiveHourUtil = fiveHourRaw ? toPercentNumber(fiveHourRaw.utilization) : null;
    if (typeof fiveHourUtil === 'number') {
      entries.push({
        bucket: 'five_hour',
        windowMinutes: 300,
        window: '5h',
        remainingPct: Math.max(0, Math.min(100, 100 - fiveHourUtil)),
        resetIn: formatResetInFromIso(fiveHourRaw.resets_at || fiveHourRaw.resetsAt || null),
        resetAtMs: parseResetAtMsFromIso(fiveHourRaw.resets_at || fiveHourRaw.resetsAt || null)
      });
    }

    const sevenDayUtil = sevenDayRaw ? toPercentNumber(sevenDayRaw.utilization) : null;
    if (typeof sevenDayUtil === 'number') {
      entries.push({
        bucket: 'seven_day',
        windowMinutes: 10080,
        window: '7days',
        remainingPct: Math.max(0, Math.min(100, 100 - sevenDayUtil)),
        resetIn: formatResetInFromIso(sevenDayRaw.resets_at || sevenDayRaw.resetsAt || null),
        resetAtMs: parseResetAtMsFromIso(sevenDayRaw.resets_at || sevenDayRaw.resetsAt || null)
      });
    }

    if (entries.length === 0) return null;
    return {
      schemaVersion: usageSnapshotSchemaVersion,
      kind: 'claude_oauth_usage',
      capturedAt: capturedAt || Date.now(),
      source: source || usageSourceClaudeOauth,
      entries
    };
  }

  function normalizeBaseUrl(baseUrlRaw, fallback) {
    if (typeof baseUrlRaw !== 'string') return fallback;
    const trimmed = baseUrlRaw.trim();
    return trimmed || fallback;
  }

  function isLocalHostBaseUrl(baseUrl) {
    return /^https?:\/\/(localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(baseUrl || ''));
  }

  function getClaudeUsageAuthForSandbox(cliName, id) {
    if (cliName !== 'claude') return null;
    const claudeConfigDir = getToolConfigDir(cliName, id);
    const credentialsPath = path.join(claudeConfigDir, '.credentials.json');
    if (fs.existsSync(credentialsPath)) {
      const payload = readJsonFileSafe(credentialsPath);
      const oauth = payload && (payload.claudeAiOauth || payload.claude_ai_oauth);
      const token = oauth && (oauth.accessToken || oauth.access_token);
      if (token && typeof token === 'string' && token.trim()) {
        return {
          token: token.trim(),
          baseUrl: 'https://api.anthropic.com',
          source: usageSourceClaudeOauth,
          mode: 'oauth_credentials'
        };
      }
    }

    const settingsPath = path.join(claudeConfigDir, 'settings.json');
    const settings = readJsonFileSafe(settingsPath);
    const env = settings && settings.env && typeof settings.env === 'object' ? settings.env : null;
    const settingsToken = env && typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN.trim() : '';
    if (settingsToken) {
      const baseUrl = normalizeBaseUrl(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
      return {
        token: settingsToken,
        baseUrl,
        source: usageSourceClaudeAuthToken,
        mode: 'settings_env_token',
        isLocalProxy: isLocalHostBaseUrl(baseUrl)
      };
    }

    return null;
  }

  function refreshClaudeUsageSnapshot(cliName, id) {
    if (cliName !== 'claude') return null;
    const sandboxDir = getProfileDir(cliName, id);
    if (!fs.existsSync(sandboxDir)) return null;
    const auth = getClaudeUsageAuthForSandbox(cliName, id);
    if (!auth || !auth.token) return null;

    const probeScript = `
const token = process.env.AIH_CLAUDE_OAUTH_TOKEN;
const baseUrlRaw = process.env.AIH_CLAUDE_API_BASE_URL || 'https://api.anthropic.com';
const baseUrl = String(baseUrlRaw).replace(/\\/+$/, '');
const url = baseUrl + '/api/oauth/usage';
const timeoutMs = Number(process.env.AIH_CLAUDE_USAGE_TIMEOUT_MS || '8000');

function print(payload) {
  console.log('AIH_CLAUDE_USAGE_JSON_START');
  console.log(JSON.stringify(payload));
  console.log('AIH_CLAUDE_USAGE_JSON_END');
}

(async () => {
  if (!token) {
    print({ ok: false, error: 'missing_token' });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'aih/1.0'
      },
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    if (!res.ok) {
      print({ ok: false, status: res.status, body: json || text });
      return;
    }
    print({ ok: true, payload: json });
  } catch (e) {
    print({ ok: false, error: String((e && e.message) || e) });
  } finally {
    clearTimeout(timer);
  }
})();
`;

    try {
      const run = spawnSync(processObj.execPath, ['-e', probeScript], {
        cwd: processObj.cwd(),
        env: {
          ...processObj.env,
          HOME: sandboxDir,
          USERPROFILE: sandboxDir,
          CLAUDE_CONFIG_DIR: getToolConfigDir(cliName, id),
          AIH_CLAUDE_OAUTH_TOKEN: auth.token,
          AIH_CLAUDE_API_BASE_URL: auth.baseUrl || 'https://api.anthropic.com',
          AIH_CLAUDE_USAGE_TIMEOUT_MS: '8000'
        },
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024
      });
      const joined = `${run.stdout || ''}\n${run.stderr || ''}`;
      const m = joined.match(/AIH_CLAUDE_USAGE_JSON_START\\s*([\\s\\S]*?)\\s*AIH_CLAUDE_USAGE_JSON_END/);
      if (!m) return null;
      const parsed = JSON.parse(m[1]);
      if (!parsed || parsed.ok !== true || !parsed.payload) return null;

      const snapshot = parseClaudeUsagePayload(parsed.payload, Date.now(), auth.source || usageSourceClaudeOauth);
      if (!snapshot) return null;
      writeUsageCache(cliName, id, snapshot);
      return snapshot;
    } catch (_error) {
      return null;
    }
  }

  function ensureUsageSnapshot(cliName, id, cache, refreshOptions = {}) {
    const forceRefresh = !!(refreshOptions && refreshOptions.forceRefresh);
    if (cliName !== 'gemini' && cliName !== 'codex' && cliName !== 'claude') return cache || null;
    if (cliName === 'claude') {
      const isMissing = !cache;
      const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
      if (!forceRefresh && shouldSkipRefreshUntilReset(cache)) return cache;
      if (!forceRefresh && !isMissing && !isStale) return cache;
      const refreshed = refreshClaudeUsageSnapshot(cliName, id);
      return refreshed || cache || null;
    }
    if (cliName === 'codex') {
      const isMissing = !cache;
      const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
      if (!forceRefresh && shouldSkipRefreshUntilReset(cache)) return cache;
      if (!forceRefresh && !isMissing && !isStale) return cache;
      const refreshed = refreshCodexUsageSnapshot(cliName, id);
      return refreshed || cache || null;
    }
    const isMissing = !cache;
    const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
    if (!forceRefresh && shouldSkipRefreshUntilReset(cache)) return cache;
    if (!forceRefresh && !isMissing && !isStale) return cache;
    const refreshed = refreshGeminiUsageSnapshot(cliName, id);
    return refreshed || cache || null;
  }

  async function ensureUsageSnapshotAsync(cliName, id, cache, refreshOptions = {}) {
    const forceRefresh = !!(refreshOptions && refreshOptions.forceRefresh);
    if (cliName === 'codex') {
      const isMissing = !cache;
      const isStale = !cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageRefreshStaleMs);
      if (!forceRefresh && shouldSkipRefreshUntilReset(cache)) return cache;
      if (!forceRefresh && !isMissing && !isStale) return cache;
      const direct = await refreshCodexUsageSnapshotFromDirectApiAsync(cliName, id);
      if (direct) return direct;
      const refreshed = await refreshCodexUsageSnapshotFromAppServerAsync(cliName, id);
      if (refreshed) return refreshed;

      const tokenRefreshed = await refreshCodexTokenForSandbox(cliName, id);
      if (tokenRefreshed) {
        const directRetry = await refreshCodexUsageSnapshotFromDirectApiAsync(cliName, id);
        if (directRetry) return directRetry;
        const appServerRetry = await refreshCodexUsageSnapshotFromAppServerAsync(cliName, id);
        if (appServerRetry) return appServerRetry;
      }
      if (!cache || forceRefresh) {
        const slowRetry = await refreshCodexUsageSnapshotFromAppServerAsync(cliName, id, Number(processObj.env.AIH_CODEX_USAGE_SLOW_RETRY_TIMEOUT_MS || '9000'));
        if (slowRetry) return slowRetry;
      }
      return cache || null;
    }
    return ensureUsageSnapshot(cliName, id, cache, refreshOptions);
  }

  function shouldSkipRefreshUntilReset(cache) {
    if (!cache || typeof cache !== 'object') return false;
    let entries = [];
    if (cache.kind === 'gemini_oauth_stats' && Array.isArray(cache.models)) {
      entries = cache.models.map((item) => ({
        remainingPct: Number(item && item.remainingPct),
        resetAtMs: deriveResetAtMsFromEntry(item, cache.capturedAt)
      }));
    } else if ((cache.kind === 'codex_oauth_status' || cache.kind === 'claude_oauth_usage') && Array.isArray(cache.entries)) {
      entries = cache.entries.map((item) => ({
        remainingPct: Number(item && item.remainingPct),
        resetAtMs: deriveResetAtMsFromEntry(item, cache.capturedAt)
      }));
    } else {
      return false;
    }

    const remainingValues = entries
      .map((entry) => entry.remainingPct)
      .filter((value) => Number.isFinite(value));
    if (remainingValues.length === 0) return false;
    if (Math.min(...remainingValues) > 0) return false;

    const now = Date.now();
    const futureResets = entries
      .map((entry) => entry.resetAtMs)
      .filter((value) => Number.isFinite(value) && value > now);
    if (futureResets.length === 0) return false;
    return true;
  }

  return {
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    getClaudeUsageAuthForSandbox,
    getLastUsageProbeError
  };
}

module.exports = {
  createUsageSnapshotService
};
