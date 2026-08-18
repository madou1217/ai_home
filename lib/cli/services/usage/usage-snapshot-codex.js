'use strict';

const {
  DEFAULT_CODEX_CLIENT_ID,
  decodeJwtPayloadUnsafe,
  normalizeCodexRefreshToken,
  buildCodexSnapshotAccount,
  buildCodexMetadataFallbackSnapshot,
} = require('../../../account/codex-auth-metadata');

const {
  withAuthRefreshLock,
} = require('../../../account/auth-refresh-lock');

const {
  resolveCodexSqliteHome,
} = require('../../../runtime/codex-home');

const {
  buildPtyLaunch,
} = require('../../../runtime/pty-launch');

const {
  buildProviderRuntimeEnv,
  prepareProviderRuntime,
  resolveProviderRuntimeScope,
} = require('../ai-cli/provider-runtime-env');

const {
  readAccountNativeAuth,
  writeAccountNativeAuth,
} = require('../../../server/account-credential-store');

const {
  isAccountRef,
} = require('../../../server/account-ref-store');

const DEFAULT_OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

module.exports = function createCodexUsageSnapshotDomain(deps, helpers) {

  const {
    fs,
    path,
    spawn,
    spawnSync,
    processObj,
    aiHomeDir,
    resolveCliPath,
    usageSnapshotSchemaVersion,
    usageSourceCodex,
    getProfileDir,
    writeUsageCache,
    accountArtifactHooks,
  } = deps;

  const {
    readAccountEnv,
    setProbeError,
    clearRuntimeStateForVerifiedSnapshot,
    spawnProcess,
    fetchWithImpl,
    fetchWithTimeoutImpl,
  } = helpers;

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
    const planType = String(rateLimits.planType || rateLimits.plan_type || '').trim();
    return {
      schemaVersion: usageSnapshotSchemaVersion,
      kind: 'codex_oauth_status',
      capturedAt: capturedAt || Date.now(),
      source: source || usageSourceCodex,
      account: planType ? { planType } : null,
      entries
    };
  }

  function parseCodexAccountFallback(account, capturedAt, source, authJson) {
    return buildCodexMetadataFallbackSnapshot({
      schemaVersion: usageSnapshotSchemaVersion,
      capturedAt: capturedAt || Date.now(),
      source: source || usageSourceCodex,
      fallbackSource: 'account_read',
      account,
      authJson
    });
  }

  function mergeCodexSnapshotAccount(snapshot, account, authJson) {
    if (!snapshot) return null;
    const preferredAccount = buildCodexSnapshotAccount(account, authJson);
    if (!preferredAccount) return snapshot;
    snapshot.account = {
      ...(snapshot.account || {}),
      ...preferredAccount,
      planType: preferredAccount.planType || (snapshot.account && snapshot.account.planType) || ''
    };
    return snapshot;
  }

  function readCodexAuthJsonForSandbox(cliName, id) {
    if (cliName !== 'codex') return null;
    return readAccountNativeAuth(fs, aiHomeDir, id).auth || null;
  }

  function resolveUsageRuntime(cliName, id) {
    const accountEnv = readAccountEnv(id);
    const projectionDir = getProfileDir(cliName, id);
    const runtime = resolveProviderRuntimeScope(cliName, projectionDir, processObj.env, {
      path,
      platform: processObj.platform,
      accountEnv
    });
    return { ...runtime, accountEnv };
  }

  function refreshCodexUsageSnapshotFromAppServer(cliName, id) {
    if (cliName !== 'codex') return null;
    const runtime = resolveUsageRuntime(cliName, id);
    const sandboxDir = runtime.runtimeDir;
    try {
      prepareProviderRuntime('codex', sandboxDir, processObj.env, {
        path,
        fs,
        aiHomeDir,
        accountRef: id,
        accountEnv: runtime.accountEnv,
        materializeAuth: runtime.projectionRequired
      });
    } catch (_error) {
      return null;
    }

    const codexBin = resolveCliPath('codex');
    if (!codexBin) return null;

    const probeScript = `
const { spawn } = require('child_process');

const codexBin = process.env.AIH_CODEX_BIN;
const codexHome = process.env.AIH_CODEX_HOME;

const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  CODEX_SQLITE_HOME: process.env.AIH_CODEX_SQLITE_HOME || ''
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

    const codexSqliteHome = resolveCodexSqliteHome({ path, aiHomeDir });
    const envOverrides = buildProviderRuntimeEnv('codex', sandboxDir, processObj.env, {
      path,
      platform: processObj.platform,
      aiHomeDir,
      accountRef: id,
      accountEnv: runtime.accountEnv,
      codexSqliteHome,
      extraEnv: {
        AIH_CODEX_BIN: codexBin,
        AIH_CODEX_HOME: path.join(sandboxDir, '.codex'),
        AIH_CODEX_SQLITE_HOME: codexSqliteHome
      }
    });

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
        parsed = mergeCodexSnapshotAccount(
          parsed,
          parsedOutput.account,
          readCodexAuthJsonForSandbox(cliName, id)
        );
      }
      if (!parsed && parsedOutput.account) {
        parsed = parseCodexAccountFallback(
          parsedOutput.account,
          Date.now(),
          usageSourceCodex,
          readCodexAuthJsonForSandbox(cliName, id)
        );
      }
      if (!parsed) {
        setProbeError(cliName, id, 'empty_parsed_snapshot');
        return null;
      }

      writeUsageCache(cliName, id, parsed);
      setProbeError(cliName, id, '');
      clearRuntimeStateForVerifiedSnapshot(cliName, id, parsed);
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

  async function fetchWithOptionalCustomFetch(url, init, timeoutMs) {
    const globalFetch = typeof fetch === 'function' ? fetch : null;
    const hasCustomFetch = typeof fetchWithImpl === 'function' && fetchWithImpl !== globalFetch;
    if (hasCustomFetch) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchWithImpl(url, {
          ...init,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
    }
    return fetchWithTimeoutImpl(url, init, timeoutMs);
  }

  function readCodexAuthForSandbox(cliName, id) {
    if (cliName !== 'codex') return null;
    const authJson = readCodexAuthJsonForSandbox(cliName, id);
    const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
    if (!tokens) return null;
    const accessToken = sanitizeAccessToken(tokens.access_token || '');
    if (!accessToken) return null;
    return {
      accessToken,
      upstreamAccountId: String(tokens.account_id || '').trim(),
      authJson
    };
  }

  async function refreshCodexTokenForSandbox(cliName, id) {
    if (cliName !== 'codex') return false;
    if (typeof fetchWithImpl !== 'function' && typeof fetchWithTimeoutImpl !== 'function') return false;
    const accountRef = String(id || '').trim();
    if (!isAccountRef(accountRef)) return false;
    const authPath = path.join(aiHomeDir, 'run', 'codex', `${accountRef}.auth`);

    const readAuth = () => {
      const authJson = readAccountNativeAuth(fs, aiHomeDir, accountRef).auth || null;
      const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
      return { authJson, tokens };
    };
    const initial = readAuth();
    const initialAccessToken = sanitizeAccessToken(initial.tokens && initial.tokens.access_token || '');
    if (!initial.tokens) return false;

    const timeoutRaw = Number(processObj.env.AIH_CODEX_TOKEN_REFRESH_TIMEOUT_MS || '7000');
    const timeoutMs = Number.isFinite(timeoutRaw)
      ? Math.max(2000, Math.min(30000, Math.floor(timeoutRaw)))
      : 7000;

    const refreshWithCurrentAuth = async () => {
      const current = readAuth();
      const authJson = current.authJson;
      const tokens = current.tokens;
      if (!tokens) return false;
      const accessToken = sanitizeAccessToken(tokens.access_token || '');
      if (initialAccessToken && accessToken && accessToken !== initialAccessToken) {
        return true;
      }
      const refreshToken = normalizeCodexRefreshToken(tokens.refresh_token);
      if (!refreshToken) return false;
      const payload = decodeJwtPayloadUnsafe(accessToken);
      const clientId = String(payload && payload.client_id || '').trim() || DEFAULT_CODEX_CLIENT_ID;

      try {
        const response = await fetchWithOptionalCustomFetch(String(processObj.env.AIH_CODEX_TOKEN_URL || DEFAULT_OPENAI_OAUTH_TOKEN_URL), {
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
          })
        }, timeoutMs);
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
        const nextRefresh = normalizeCodexRefreshToken(next && (next.refresh_token || next.refreshToken) || '');

        const nextTokens = { ...tokens, access_token: nextAccess };
        if (nextId) nextTokens.id_token = nextId;
        if (nextRefresh) nextTokens.refresh_token = nextRefresh;
        const merged = {
          ...authJson,
          tokens: nextTokens,
          last_refresh: new Date().toISOString()
        };
        const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
        writeAccountNativeAuth(fs, aiHomeDir, accountRef, { ...nativeAuth, auth: merged });
        if (accountArtifactHooks && typeof accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
          accountArtifactHooks.notifyDefaultAccountAuthUpdated({
            provider: cliName,
            accountRef,
            artifactPath: 'app-state.db',
            source: 'usage_snapshot_token_refresh',
            reason: 'codex_oauth_token_refreshed'
          });
        }
        return true;
      } catch (_error) {
        return false;
      }
    };

    const locked = await withAuthRefreshLock(fs, path, authPath, refreshWithCurrentAuth, {
      timeoutMs: Math.max(timeoutMs, 30_000)
    });
    return locked.acquired ? !!locked.value : false;
  }

  function readCodexDirectMode() {
    return String(processObj.env.AIH_CODEX_USAGE_DIRECT || '1') !== '0';
  }

  function resolveCodexDirectBaseUrl(rateLimitPath = '') {
    const byUsage = String(processObj.env.AIH_CODEX_USAGE_BASE_URL || '').trim();
    if (byUsage) return byUsage.replace(/\/+$/, '');
    const byServer = String(processObj.env.AIH_SERVER_CODEX_BASE_URL || '').trim();
    if (byServer) return byServer.replace(/\/+$/, '');
    if (String(rateLimitPath || '').startsWith('/wham/')) return 'https://chatgpt.com/backend-api';
    return 'https://chatgpt.com/backend-api/codex';
  }

  function resolveCodexDirectRateLimitPath() {
    const byUsage = String(processObj.env.AIH_CODEX_USAGE_PATH || '').trim();
    if (byUsage) {
      if (byUsage.startsWith('/')) return byUsage;
      return `/${byUsage}`;
    }
    return '/wham/usage';
  }

  async function fetchCodexDirectUsage(url, init, timeoutMs) {
    return fetchWithOptionalCustomFetch(url, init, timeoutMs);
  }

  function normalizeCodexWhamUsageWindow(window) {
    if (!window || typeof window !== 'object') return null;
    const windowSeconds = Number(window.limit_window_seconds ?? window.limitWindowSeconds);
    const usedPct = Number(window.used_percent ?? window.usedPercent);
    const resetAt = window.reset_at ?? window.resetAt;
    const resetAfterSeconds = Number(window.reset_after_seconds ?? window.resetAfterSeconds);
    const normalized = {};

    if (Number.isFinite(windowSeconds) && windowSeconds > 0) {
      normalized.window_minutes = windowSeconds / 60;
    }
    if (Number.isFinite(usedPct)) {
      normalized.used_percent = usedPct;
    }
    if (resetAt != null && String(resetAt).trim() !== '') {
      normalized.resets_at = resetAt;
    } else if (Number.isFinite(resetAfterSeconds) && resetAfterSeconds >= 0) {
      normalized.resets_at = Math.floor(Date.now() / 1000) + resetAfterSeconds;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  function extractRateLimitsFromWhamUsagePayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const usage = payload.rate_limit || payload.rateLimit;
    if (!usage || typeof usage !== 'object') return null;

    const primary = normalizeCodexWhamUsageWindow(usage.primary_window || usage.primaryWindow);
    const secondary = normalizeCodexWhamUsageWindow(usage.secondary_window || usage.secondaryWindow);
    const rateLimits = {};
    if (primary) rateLimits.primary = primary;
    if (secondary) rateLimits.secondary = secondary;
    return Object.keys(rateLimits).length > 0 ? rateLimits : null;
  }

  function extractRateLimitsFromDirectPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.rateLimits && typeof payload.rateLimits === 'object') return payload.rateLimits;
    if (payload.rate_limits && typeof payload.rate_limits === 'object') return payload.rate_limits;
    if (payload.result && payload.result.rateLimits && typeof payload.result.rateLimits === 'object') return payload.result.rateLimits;
    if (payload.result && payload.result.rate_limits && typeof payload.result.rate_limits === 'object') return payload.result.rate_limits;
    const whamRateLimits = extractRateLimitsFromWhamUsagePayload(payload);
    if (whamRateLimits) return whamRateLimits;
    return null;
  }

  function extractCodexAccountFromDirectPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const source = payload.account && typeof payload.account === 'object'
      ? payload.account
      : payload;
    const account = {
      planType: source.planType || source.plan_type,
      email: source.email,
      upstreamAccountId: source.upstreamAccountId || source.account_id,
      organizationId: source.organizationId || source.organization_id
    };
    return Object.values(account).some((value) => String(value || '').trim()) ? account : null;
  }

  async function refreshCodexUsageSnapshotFromDirectApiAsync(cliName, id, timeoutOverrideMs = null) {
    if (cliName !== 'codex') return null;
    if (!readCodexDirectMode()) return null;
    if (typeof fetchWithImpl !== 'function') return null;
    const auth = readCodexAuthForSandbox(cliName, id);
    if (!auth || !auth.accessToken) return null;

    const timeoutMsRaw = Number(timeoutOverrideMs) || Number(processObj.env.AIH_CODEX_USAGE_HTTP_TIMEOUT_MS || '60000');
    const timeoutMs = Number.isFinite(timeoutMsRaw)
      ? Math.max(1000, Math.min(60000, Math.floor(timeoutMsRaw)))
      : 60000;
    const rateLimitPath = resolveCodexDirectRateLimitPath();
    const url = `${resolveCodexDirectBaseUrl(rateLimitPath)}${rateLimitPath}`;

    try {
      const response = await fetchCodexDirectUsage(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          accept: 'application/json',
          version: '0.101.0',
          originator: 'codex_cli_rs',
          'user-agent': 'codex_cli_rs/0.101.0',
          ...(auth.upstreamAccountId ? { 'chatgpt-account-id': auth.upstreamAccountId } : {})
        }
      }, timeoutMs);
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
      return buildCodexSnapshotFromProbePayload(cliName, id, {
        ok: true,
        rateLimits,
        account: extractCodexAccountFromDirectPayload(payload)
      });
    } catch (error) {
      const code = String(error && (error.code || error.name || '') || '').trim();
      const message = String(error && error.message || '').trim();
      const detail = [code, message].filter(Boolean).join(': ').slice(0, 160);
      setProbeError(cliName, id, detail ? `direct_request_failed:${detail}` : 'direct_request_failed');
      return null;
    }
  }

  function buildCodexSnapshotFromProbePayload(cliName, id, payload) {
    if (!payload || payload.ok !== true) return null;
    const authJson = readCodexAuthJsonForSandbox(cliName, id);
    let parsed = null;
    if (payload.rateLimits) {
      parsed = parseCodexRateLimits(payload.rateLimits, Date.now(), usageSourceCodex);
      parsed = mergeCodexSnapshotAccount(parsed, payload.account, authJson);
    }
    if (!parsed && payload.account) {
      parsed = parseCodexAccountFallback(payload.account, Date.now(), usageSourceCodex, authJson);
    }
    if (!parsed) return null;
    writeUsageCache(cliName, id, parsed);
    setProbeError(cliName, id, '');
    clearRuntimeStateForVerifiedSnapshot(cliName, id, parsed);
    return parsed;
  }

  function createCodexProbeTimeoutMs(timeoutOverrideMs) {
    if (Number.isFinite(Number(timeoutOverrideMs)) && Number(timeoutOverrideMs) > 0) {
      return Math.max(1000, Math.min(60000, Math.floor(Number(timeoutOverrideMs))));
    }
    const value = Number(processObj.env.AIH_CODEX_USAGE_TIMEOUT_MS || '60000');
    if (!Number.isFinite(value)) return 60000;
    return Math.max(1000, Math.min(60000, Math.floor(value)));
  }

  function refreshCodexUsageSnapshotFromAppServerAsync(cliName, id, timeoutOverrideMs = null) {
    if (cliName !== 'codex') return Promise.resolve(null);
    const runtime = resolveUsageRuntime(cliName, id);
    const sandboxDir = runtime.runtimeDir;
    try {
      prepareProviderRuntime('codex', sandboxDir, processObj.env, {
        path,
        fs,
        aiHomeDir,
        accountRef: id,
        accountEnv: runtime.accountEnv,
        materializeAuth: runtime.projectionRequired
      });
    } catch (_error) {
      return Promise.resolve(null);
    }

    const codexBin = resolveCliPath('codex');
    if (!codexBin) return Promise.resolve(null);
    const codexSqliteHome = resolveCodexSqliteHome({ path, aiHomeDir });
    const codexEnv = buildProviderRuntimeEnv('codex', sandboxDir, processObj.env, {
      path,
      platform: processObj.platform,
      codexSqliteHome,
      aiHomeDir,
      accountRef: id,
      accountEnv: runtime.accountEnv
    });

    return new Promise((resolve) => {
      const timeoutMs = createCodexProbeTimeoutMs(timeoutOverrideMs);
      const launch = buildPtyLaunch(codexBin, ['app-server', '--listen', 'stdio://'], {
        platform: processObj.platform || process.platform
      });

      let child;
      try {
        child = spawnProcess(launch.command, launch.args, {
          cwd: processObj.cwd(),
          env: codexEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true  // Windows: 隐藏窗口
        });
      } catch (spawnError) {
        // 立即捕获 spawn 错误 (EINVAL 等)
        setProbeError(cliName, id, `spawn_error: ${String(spawnError.code || spawnError.message || spawnError)}`);
        resolve(null);
        return;
      }

      if (!child || !child.pid) {
        setProbeError(cliName, id, 'spawn_failed_no_pid');
        resolve(null);
        return;
      }

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

      child.on('error', (err) => {
        const errMsg = err && (err.code || err.message) ? `${err.code || 'UNKNOWN'}: ${err.message || ''}` : 'spawn_failed';
        finalize({ ok: false, error: errMsg });
      });
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

  return {
    refreshCodexUsageSnapshot,
    refreshCodexTokenForSandbox,
    refreshCodexUsageSnapshotFromDirectApiAsync,
    refreshCodexUsageSnapshotFromAppServerAsync,
    readCodexAuthJsonForSandbox,
    sanitizeAccessToken,
  };

};
