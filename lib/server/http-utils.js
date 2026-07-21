'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { sanitizeSchemaForGemini } = require('./gemini-schema');
const { resolveOpenAIChatFinishReason } = require('./protocol-finish-reason');
const {
  CODE_ASSIST_SKIP_THOUGHT_SIGNATURE,
  applyCodeAssistGenerationConfigStrategy,
  listCodeAssistGenerationConfigCapabilityRules,
  listCodeAssistUnsupportedGenerationConfigKeys,
  reserveAnswerBudgetForCodeAssistThinking,
  resolveCodeAssistAdaptiveThinkingConfig,
  resolveCodeAssistProviderStrategy
} = require('./code-assist-provider-strategy');
const {
  extractCodeAssistModelDescriptors,
  resolveCodeAssistModelDescriptor,
  resolveCodeAssistWireModelId
} = require('./code-assist-model-registry');
const {
  isImageGenerationModel,
  applyImageGenerationGenerationConfig,
  extractInlineImageMarkdown
} = require('./code-assist-image-generation');
const {
  detectAntigravityClientVersion
} = require('./antigravity-version');
const { fetchOpenCodeModels } = require('./opencode-server-client');
const { isClaudeAuthTokenAccount } = require('../account/claude-credential');
const { isApiCredentialAccount } = require('../account/runtime-auth-mode');
const { fetchCodexModelsForAccount } = require('./codex-model-client');
const {
  readResponseJson,
  readResponseText,
  sanitizeResponseText
} = require('./response-body');

let ProxyAgentClass;
let proxyAgentResolved = false;
let undiciInstallAttempted = false;
let undiciRequireFn = require;
let undiciInstallerFn = null;

const proxyDispatcherCache = new Map();
const DEFAULT_GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_GEMINI_CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
const DEFAULT_AGY_CODE_ASSIST_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const GEMINI_CODE_ASSIST_AUTH_TYPE = 'oauth-personal';
const GEMINI_CODE_ASSIST_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_GEMINI_SESSION_ID_MAP_TTL_MS = 30 * 60 * 1000;
const DEFAULT_GEMINI_SESSION_ID_MAP_MAX = 10_000;
const GEMINI_CODE_ASSIST_G1_CREDIT_TYPE = 'GOOGLE_ONE_AI';
const GEMINI_CODE_ASSIST_MIN_CREDIT_BALANCE = 50;
const DEFAULT_GEMINI_CODE_ASSIST_CLIENT_VERSION = '0.42.0';
const DEFAULT_AGY_CODE_ASSIST_CLIENT_VERSION = '4.2.1';
const DEFAULT_AGY_CODE_ASSIST_CHROME_VERSION = '132.0.6834.160';
const DEFAULT_AGY_CODE_ASSIST_ELECTRON_VERSION = '39.2.3';
const CODE_ASSIST_CLIENT_SESSION_ID = crypto.randomUUID();
const GEMINI_CODE_ASSIST_QUOTA_PROJECT_PLACEHOLDER = '{{projectId}}';

function pickFirstNonEmpty(values) {
  for (const value of values) {
    const text = String(value == null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}

function parseNoProxyList(rawValue) {
  return String(rawValue == null ? '' : rawValue)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.localhost');
}

function matchesNoProxyRule(target, rule) {
  const token = String(rule || '').trim().toLowerCase();
  if (!token) return false;
  if (token === '*') return true;

  const targetHost = String((target && target.hostname) || '').trim().toLowerCase();
  const targetPort = String((target && target.port) || '').trim();
  if (!targetHost) return false;

  let hostRule = token;
  let portRule = '';
  const tokenHasPort = token.includes(':') && !token.startsWith('[');
  if (tokenHasPort) {
    const idx = token.lastIndexOf(':');
    hostRule = token.slice(0, idx).trim();
    portRule = token.slice(idx + 1).trim();
    if (!hostRule || !portRule) return false;
    if (targetPort && targetPort !== portRule) return false;
    if (!targetPort && !['80', '443'].includes(portRule)) return false;
  }

  if (hostRule.startsWith('*.')) {
    hostRule = hostRule.slice(1);
  }
  if (hostRule.startsWith('.')) {
    return targetHost === hostRule.slice(1) || targetHost.endsWith(hostRule);
  }
  return targetHost === hostRule;
}

function shouldBypassProxy(targetUrl, noProxy) {
  let parsedTarget;
  try {
    parsedTarget = new URL(String(targetUrl || ''));
  } catch (_error) {
    return false;
  }

  if (!['http:', 'https:'].includes(parsedTarget.protocol)) return true;
  if (isLoopbackHost(parsedTarget.hostname)) return true;

  const rules = parseNoProxyList(noProxy);
  return rules.some((rule) => matchesNoProxyRule(parsedTarget, rule));
}

function resolveProxyConfig(targetUrl, proxyOptions = {}) {
  const options = proxyOptions || {};
  const explicitProxy = pickFirstNonEmpty([
    options.proxyUrl,
    process.env.AIH_SERVER_PROXY_URL
  ]);
  const envProxy = pickFirstNonEmpty([
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy
  ]);
  const proxyUrl = explicitProxy || envProxy;
  if (!proxyUrl) return { url: '', source: '' };

  const noProxy = pickFirstNonEmpty([
    options.noProxy,
    process.env.AIH_SERVER_NO_PROXY,
    process.env.NO_PROXY,
    process.env.no_proxy
  ]);
  if (shouldBypassProxy(targetUrl, noProxy)) return { url: '', source: '' };

  try {
    const parsed = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return { url: '', source: '' };
  } catch (_error) {
    return { url: '', source: '' };
  }
  return {
    url: proxyUrl,
    source: explicitProxy ? 'explicit' : 'env_proxy'
  };
}

function tryRequireProxyAgent() {
  try {
    const loaded = undiciRequireFn('undici');
    return loaded && loaded.ProxyAgent ? loaded.ProxyAgent : null;
  } catch (_error) {
    return null;
  }
}

function defaultInstallUndiciPackage() {
  const rootDir = path.resolve(__dirname, '..', '..');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const run = spawnSync(
      npmCmd,
      ['install', 'undici', '--no-save', '--silent', '--no-audit', '--no-fund'],
      {
        cwd: rootDir,
        stdio: 'ignore',
        timeout: 60_000
      }
    );
    return Number(run && run.status) === 0;
  } catch (_error) {
    return false;
  }
}

function tryInstallUndiciPackage() {
  if (undiciInstallAttempted) return false;
  undiciInstallAttempted = true;
  const installer = typeof undiciInstallerFn === 'function' ? undiciInstallerFn : defaultInstallUndiciPackage;
  try {
    return !!installer();
  } catch (_error) {
    return false;
  }
}

function getProxyDispatcher(proxyUrl) {
  const key = String(proxyUrl || '').trim();
  if (!key) return null;
  if (!proxyAgentResolved) {
    proxyAgentResolved = true;
    ProxyAgentClass = tryRequireProxyAgent();
    if (!ProxyAgentClass && tryInstallUndiciPackage()) {
      ProxyAgentClass = tryRequireProxyAgent();
    }
  }
  if (!ProxyAgentClass) return null;
  if (proxyDispatcherCache.has(key)) return proxyDispatcherCache.get(key);
  // 流式生成（尤其 AGY 缓冲 function call 写大文件）期间上游可能 30s-数分钟无任何字节，
  // undici 默认 bodyTimeout=300s/headersTimeout=300s 若被某些代理/版本收紧会误判超时把流掐断。
  // 显式放大到 30 分钟，避免我们这侧因 idle 把合法的长生成流判死。
  let agent;
  try {
    agent = new ProxyAgentClass({ uri: key, bodyTimeout: 1_800_000, headersTimeout: 1_800_000 });
  } catch (_optsError) {
    // 兼容旧版 ProxyAgent 只接受字符串构造参数的情况。
    agent = new ProxyAgentClass(key);
  }
  proxyDispatcherCache.set(key, agent);
  return agent;
}

function getErrorCode(error) {
  return String(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).trim().toUpperCase();
}

function shouldRetryWithoutProxy(proxyConfig, error) {
  if (!proxyConfig || proxyConfig.source !== 'env_proxy') return false;
  const code = getErrorCode(error);
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) {
    return true;
  }
  const message = String((error && error.message) || '').toLowerCase();
  return message.includes('proxy')
    || message.includes('fetch failed');
}

function parseAuthorizationBearer(headerValue) {
  const value = String(headerValue || '').trim();
  if (!value) return '';
  const m = value.match(/^Bearer\s+(.+)$/i);
  return m ? String(m[1] || '').trim() : '';
}

function readRequestBody(req, options = {}) {
  const maxBytes = Number(options.maxBytes);
  const enforceLimit = Number.isFinite(maxBytes) && maxBytes > 0;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      chunks.push(chunk);
      total += chunk.length;
      if (enforceLimit && total > maxBytes) {
        aborted = true;
        const err = new Error('request_body_too_large');
        err.code = 'request_body_too_large';
        reject(err);
      }
    });
    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

const JSON_COMPRESS_MIN_BYTES = 4096;

function writeJson(res, statusCode, payload) {
  if (!res || res.headersSent || res.writableEnded || res.destroyed) return false;
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // 大 JSON 响应按客户端 Accept-Encoding 压缩(brotli 优先,gzip 次之):/webui/projects 等
  // 可达 ~1.15MB,brotli 约压到 ~130KB(≈9x)、gzip ~200KB。Node 22 的 res.req 直接拿请求头,
  // 无需改 writeJson 签名,全端点通用。已设过 content-encoding 的(如 SSE/流式)不重复压。
  const rawLen = Buffer.byteLength(body);
  const acceptEncoding = String((res.req && res.req.headers && res.req.headers['accept-encoding']) || '');
  if (rawLen >= JSON_COMPRESS_MIN_BYTES && !res.getHeader('content-encoding') && !res.headersSent) {
    try {
      if (/\bbr\b/.test(acceptEncoding)) {
        // quality 5:速度/压缩比平衡,同步压 ~1MB 约 10-20ms(远小于省下的传输)。
        const compressed = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
        res.setHeader('content-encoding', 'br');
        res.setHeader('vary', 'accept-encoding');
        res.setHeader('content-length', compressed.length);
        res.end(compressed);
        return true;
      }
      if (/\bgzip\b/.test(acceptEncoding)) {
        const compressed = zlib.gzipSync(body, { level: 6 });
        res.setHeader('content-encoding', 'gzip');
        res.setHeader('vary', 'accept-encoding');
        res.setHeader('content-length', compressed.length);
        res.end(compressed);
        return true;
      }
    } catch (_err) {
      // 压缩失败兜底为明文
    }
  }
  res.setHeader('content-length', rawLen);
  res.end(body);
  return true;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const proxyOptions = arguments[3] || {};
  const controller = new AbortController();
  const callerSignal = init && init.signal;
  const abortFromCaller = () => {
    try { controller.abort(callerSignal && callerSignal.reason); } catch (_error) { controller.abort(); }
  };
  if (callerSignal) {
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestInit = { ...(init || {}), signal: controller.signal };
    const proxyConfig = resolveProxyConfig(url, proxyOptions);
    if (!requestInit.dispatcher) {
      const dispatcher = getProxyDispatcher(proxyConfig.url);
      if (dispatcher) requestInit.dispatcher = dispatcher;
    }
    try {
      return await fetch(url, requestInit);
    } catch (error) {
      if (!requestInit.dispatcher || !shouldRetryWithoutProxy(proxyConfig, error)) throw error;
      const fallbackInit = { ...(requestInit || {}) };
      delete fallbackInit.dispatcher;
      return await fetch(url, fallbackInit);
    }
  } finally {
    clearTimeout(timer);
    if (callerSignal && typeof callerSignal.removeEventListener === 'function') {
      callerSignal.removeEventListener('abort', abortFromCaller);
    }
  }
}

function isGeminiCodeAssistBaseUrl(baseUrl) {
  const text = String(baseUrl || '').trim().toLowerCase();
  return text.includes('cloudcode-pa.googleapis.com');
}

function isCodeAssistProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return value === 'gemini' || value === 'agy';
}

function getCodeAssistBaseUrlOption(options, provider) {
  const p = String(provider || '').trim().toLowerCase();
  return p === 'agy'
    ? String(options && options.agyBaseUrl || '').trim()
    : String(options && options.geminiBaseUrl || '').trim();
}

function getDefaultCodeAssistBaseUrl(provider) {
  return String(provider || '').trim().toLowerCase() === 'agy'
    ? DEFAULT_AGY_CODE_ASSIST_BASE_URL
    : DEFAULT_GEMINI_CODE_ASSIST_BASE_URL;
}

function shouldUseGeminiCodeAssist(options, account) {
  const provider = String((account && account.provider) || (options && options.provider) || '').trim().toLowerCase();
  if (!isCodeAssistProvider(provider)) return false;
  const authType = String(account && account.authType || '').trim().toLowerCase();
  if (authType === GEMINI_CODE_ASSIST_AUTH_TYPE) return true;
  const configured = getCodeAssistBaseUrlOption(options, provider);
  return isGeminiCodeAssistBaseUrl(configured);
}

function normalizeGeminiBaseUrl(options, account) {
  const configured = String(options && options.geminiBaseUrl || '').trim().replace(/\/+$/, '');
  if (shouldUseGeminiCodeAssist(options, account)) {
    if (!configured || configured === DEFAULT_GEMINI_OPENAI_BASE_URL) {
      return DEFAULT_GEMINI_CODE_ASSIST_BASE_URL;
    }
    return configured;
  }
  return (configured || DEFAULT_GEMINI_OPENAI_BASE_URL).replace(/\/+$/, '');
}

function normalizeCodeAssistProviderBaseUrl(options, account) {
  const provider = String(account && account.provider || '').trim().toLowerCase();
  const fromAccount = String(account && account.baseUrl || '').trim().replace(/\/+$/, '');
  if (fromAccount) return fromAccount;
  const configured = getCodeAssistBaseUrlOption(options, provider).replace(/\/+$/, '');
  return configured || getDefaultCodeAssistBaseUrl(provider);
}

function resolveProviderBaseUrl(options, account) {
  const provider = String((account && account.provider) || (options && options.provider) || 'codex').trim().toLowerCase();
  let url = '';
  if (provider === 'gemini') {
    url = normalizeGeminiBaseUrl(options, account);
  } else if (provider === 'agy') {
    url = normalizeCodeAssistProviderBaseUrl(options, account);
  } else if (provider === 'claude') {
    const fromAccount = String(account && account.baseUrl || '').trim();
    url = (fromAccount || String(options && options.claudeBaseUrl || '').trim()).replace(/\/+$/, '');
  } else {
    const fromAccount = (
      account
      && (account.apiKeyMode || account.authType === 'api-key')
      && String(account.openaiBaseUrl || '').trim()
    ) || '';
    url = (fromAccount || String(options && options.codexBaseUrl || '').trim()).replace(/\/+$/, '');
  }

  if (options && options.port && isLoopbackUrl(url, options.port)) {
    throw new Error('infinite_loop_detected');
  }

  return url;
}

function buildGeminiCodeAssistMethodUrl(baseUrl, method) {
  let normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalized) normalized = DEFAULT_GEMINI_CODE_ASSIST_BASE_URL;
  if (!/\/v[0-9][^/:]*$/i.test(normalized)) normalized = `${normalized}/v1internal`;
  return `${normalized}:${method}`;
}

function buildGeminiCodeAssistUserAgent(model) {
  const override = String(process.env.AIH_GEMINI_CODE_ASSIST_USER_AGENT || '').trim();
  if (override) return override;
  const version = String(process.env.AIH_GEMINI_CLI_VERSION || DEFAULT_GEMINI_CODE_ASSIST_CLIENT_VERSION).trim()
    || DEFAULT_GEMINI_CODE_ASSIST_CLIENT_VERSION;
  const clientName = String(process.env.AIH_GEMINI_CLI_CLIENT_NAME || 'cli-command').trim();
  const surface = String(process.env.AIH_GEMINI_CLI_SURFACE || 'terminal').trim() || 'terminal';
  const prefix = clientName ? `GeminiCLI-${clientName}` : 'GeminiCLI';
  const modelId = String(model || 'unknown').trim() || 'unknown';
  return `${prefix}/${version}/${modelId} (${process.platform}; ${process.arch}; ${surface})`;
}

function buildAgyCodeAssistClientVersion() {
  return String(
    process.env.AIH_AGY_CODE_ASSIST_CLIENT_VERSION
    || process.env.AIH_ANTIGRAVITY_VERSION
    || detectAntigravityClientVersion()
    || DEFAULT_AGY_CODE_ASSIST_CLIENT_VERSION
  ).trim() || DEFAULT_AGY_CODE_ASSIST_CLIENT_VERSION;
}

function buildAgyCodeAssistPlatformInfo() {
  if (process.platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7';
  if (process.platform === 'win32') return 'Windows NT 10.0; Win64; x64';
  return 'X11; Linux x86_64';
}

function buildAgyCodeAssistUserAgent() {
  const override = String(process.env.AIH_AGY_CODE_ASSIST_USER_AGENT || '').trim();
  if (override) return override;
  const version = buildAgyCodeAssistClientVersion();
  const chrome = String(process.env.AIH_AGY_CODE_ASSIST_CHROME_VERSION || DEFAULT_AGY_CODE_ASSIST_CHROME_VERSION).trim()
    || DEFAULT_AGY_CODE_ASSIST_CHROME_VERSION;
  const electron = String(process.env.AIH_AGY_CODE_ASSIST_ELECTRON_VERSION || DEFAULT_AGY_CODE_ASSIST_ELECTRON_VERSION).trim()
    || DEFAULT_AGY_CODE_ASSIST_ELECTRON_VERSION;
  return `Antigravity/${version} (${buildAgyCodeAssistPlatformInfo()}) Chrome/${chrome} Electron/${electron}`;
}

function isSafeHeaderValue(value) {
  return !/[\u0000-\u0008\u000A-\u001F\u007F]/.test(String(value || ''));
}

function setHeaderIfSafe(headers, name, value) {
  const key = String(name || '').trim();
  const text = String(value == null ? '' : value).trim();
  if (!key || !text || !isSafeHeaderValue(text)) return;
  headers[key] = text;
}

function resolveCodeAssistProviderKey(options, account) {
  return String(account && account.provider || options && options.provider || 'gemini').trim().toLowerCase();
}

function isAntigravityProviderKey(provider) {
  const key = String(provider || '').trim().toLowerCase();
  return key === 'agy' || key === 'antigravity';
}

function shouldNormalizeAntigravityGenerateContentEnvelope(options, account, diagnostic) {
  const provider = String(diagnostic && diagnostic.provider || '').trim().toLowerCase()
    || resolveCodeAssistProviderKey(options, account);
  return isAntigravityProviderKey(provider);
}

function buildCodeAssistHeaderOptions(options, account, extra = {}) {
  const providerStrategy = resolveCodeAssistProviderStrategy(resolveCodeAssistProviderKey(options, account));
  return {
    clientProfile: providerStrategy.clientProfile,
    injectProjectHeader: providerStrategy.injectProjectHeader,
    anthropicBetaHeader: providerStrategy.anthropicBetaHeader,
    ...extra
  };
}

function buildCodeAssistProjectMetadata(providerStrategy, knownProject) {
  const configured = providerStrategy
    && providerStrategy.projectMetadata
    && typeof providerStrategy.projectMetadata === 'object'
    ? providerStrategy.projectMetadata
    : {};
  return {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
    ...configured,
    ...(knownProject ? { duetProject: knownProject } : {})
  };
}

function shouldUseAgyCodeAssistClientProfile(options = {}) {
  const profile = options && options.clientProfile && typeof options.clientProfile === 'object'
    ? options.clientProfile
    : {};
  return String(profile.userAgent || '').trim().toLowerCase() === 'antigravity'
    || String(profile.name || '').trim().toLowerCase() === 'antigravity';
}

function createGeminiCodeAssistHeaders(accessToken, model, options = {}) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': buildGeminiCodeAssistUserAgent(model)
  };
  if (!shouldUseAgyCodeAssistClientProfile(options)) return headers;

  headers['user-agent'] = buildAgyCodeAssistUserAgent();
  setHeaderIfSafe(headers, 'x-client-name', 'antigravity');
  setHeaderIfSafe(headers, 'x-client-version', buildAgyCodeAssistClientVersion());
  setHeaderIfSafe(headers, 'x-vscode-sessionid', CODE_ASSIST_CLIENT_SESSION_ID);
  setHeaderIfSafe(headers, 'x-machine-id', process.env.AIH_AGY_CODE_ASSIST_MACHINE_ID);
  if (options.injectProjectHeader) {
    setHeaderIfSafe(headers, 'x-goog-user-project', options.project);
  }
  setHeaderIfSafe(headers, 'anthropic-beta', options.anthropicBetaHeader);
  return headers;
}

function applyGeminiCodeAssistProjectResponse(account, json, fallbackProject) {
  const project = String(json && json.cloudaicompanionProject || fallbackProject || '').trim();
  if (account) {
    account.codeAssistLoadResponse = json && typeof json === 'object' ? json : {};
    account.codeAssistPaidTier = json && json.paidTier && typeof json.paidTier === 'object' ? json.paidTier : null;
    account.codeAssistCurrentTier = json && json.currentTier && typeof json.currentTier === 'object' ? json.currentTier : null;
    if (project) account.codeAssistProject = project;
  }
  return project;
}

function clearGeminiCodeAssistProjectCache(account) {
  if (!account) return;
  delete account.codeAssistProject;
  delete account.codeAssistLoadResponse;
  delete account.codeAssistPaidTier;
  delete account.codeAssistCurrentTier;
}

function shouldRetryGeminiCodeAssistProjectWithoutCache(error) {
  const code = String(error && error.code || '').trim().toUpperCase();
  return code === 'HTTP_400'
    || code === 'HTTP_403'
    || code === 'HTTP_404';
}

async function loadGeminiCodeAssistProject(options, account, providerStrategy, project, timeoutMs) {
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = buildGeminiCodeAssistMethodUrl(baseUrl, 'loadCodeAssist');
  const knownProject = String(project || '').trim();
  const payload = {
    ...(knownProject ? { cloudaicompanionProject: knownProject } : {}),
    metadata: buildCodeAssistProjectMetadata(providerStrategy, knownProject),
    ...(knownProject ? { mode: 'HEALTH_CHECK' } : {})
  };
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: createGeminiCodeAssistHeaders(
      account.accessToken,
      undefined,
      buildCodeAssistHeaderOptions(options, account, { project: knownProject })
    ),
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await readResponseText(res).catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }
  const json = await readResponseJson(res).catch(() => ({}));
  return applyGeminiCodeAssistProjectResponse(account, json, knownProject);
}

async function fetchGeminiCodeAssistProject(options, account, timeoutMs = 8000) {
  const knownProject = String(account && account.codeAssistProject || '').trim();
  if (account && knownProject && account.codeAssistLoadResponse) return knownProject;
  const providerStrategy = resolveCodeAssistProviderStrategy(resolveCodeAssistProviderKey(options, account));
  if (!knownProject) {
    return loadGeminiCodeAssistProject(options, account, providerStrategy, '', timeoutMs);
  }

  try {
    return await loadGeminiCodeAssistProject(options, account, providerStrategy, knownProject, timeoutMs);
  } catch (error) {
    if (!shouldRetryGeminiCodeAssistProjectWithoutCache(error)) throw error;
    clearGeminiCodeAssistProjectCache(account);
    try {
      return await loadGeminiCodeAssistProject(options, account, providerStrategy, '', timeoutMs);
    } catch (retryError) {
      retryError.cachedCodeAssistProject = knownProject;
      retryError.cachedCodeAssistProjectError = error;
      throw retryError;
    }
  }
}

function getCachedCodeAssistModelDescriptors(account) {
  return Array.isArray(account && account.codeAssistModelDescriptors)
    ? account.codeAssistModelDescriptors
    : [];
}

function listCodeAssistDescriptorIds(descriptors) {
  return Array.from(new Set((Array.isArray(descriptors) ? descriptors : [])
    .map((descriptor) => String(descriptor && (descriptor.id || descriptor.modelId) || '').trim())
    .filter(Boolean))).sort();
}

function createCodeAssistModelRequiredError(provider) {
  const normalizedProvider = String(provider || 'code_assist').trim().toLowerCase() || 'code_assist';
  const err = new Error(`${normalizedProvider}_model_required`);
  err.code = 'MODEL_REQUIRED';
  return err;
}

function isCodeAssistPermissionError(error) {
  const code = String(error && error.code || '').trim().toUpperCase();
  if (code === 'HTTP_403') return true;
  const message = String((error && error.message) || error || '');
  return /HTTP\s+403\b/i.test(message)
    || message.includes('PERMISSION_DENIED')
    || message.toLowerCase().includes('permission');
}

function shouldUseQuotaCatalogFallback(provider, error) {
  return String(provider || '').trim().toLowerCase() === 'gemini' && isCodeAssistPermissionError(error);
}

function cacheCodeAssistModelDescriptors(account, provider, descriptors) {
  if (!account) return [];
  const normalized = extractCodeAssistModelDescriptors(provider, {
    models: Array.isArray(descriptors) ? descriptors : []
  });
  if (normalized.length < 1) return [];
  account.codeAssistModelDescriptors = normalized;
  account.availableModels = listCodeAssistDescriptorIds(normalized);
  return normalized;
}

function createCodeAssistModelRequestId() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_error) {}
  return crypto.randomBytes(16).toString('hex');
}

function createCodeAssistAgentRequestId() {
  return `agent/${Date.now()}/${crypto.randomBytes(4).toString('hex')}`;
}

function resolveCodeAssistCreditFields(providerStrategy, creditDecision) {
  const field = String(providerStrategy && providerStrategy.creditTypesField || 'enabled_credit_types').trim()
    || 'enabled_credit_types';
  const shouldInclude = Boolean(
    creditDecision && creditDecision.enabled
    || providerStrategy && providerStrategy.alwaysSendAgentCreditTypes
  );
  return {
    field,
    values: shouldInclude ? [GEMINI_CODE_ASSIST_G1_CREDIT_TYPE] : [],
    forced: Boolean(
      providerStrategy
      && providerStrategy.alwaysSendAgentCreditTypes
      && !(creditDecision && creditDecision.enabled)
    )
  };
}

function buildCodeAssistGeneratePayload(providerStrategy, model, project, request, sessionState, creditFields) {
  const envelope = String(providerStrategy && providerStrategy.requestEnvelope || 'gemini_cli').trim()
    || 'gemini_cli';
  if (envelope === 'antigravity_agent') {
    return {
      project,
      requestId: createCodeAssistAgentRequestId(),
      request,
      model,
      userAgent: 'antigravity',
      requestType: 'agent',
      ...(creditFields.values.length > 0 ? { [creditFields.field]: creditFields.values } : {})
    };
  }
  return {
    model,
    project,
    user_prompt_id: sessionState.userPromptId,
    ...(creditFields.values.length > 0 ? { [creditFields.field]: creditFields.values } : {}),
    request
  };
}

async function fetchGeminiCodeAssistAvailableModelDescriptors(options, account, timeoutMs = 8000) {
  const provider = resolveCodeAssistProviderKey(options, account);
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = buildGeminiCodeAssistMethodUrl(baseUrl, 'fetchAvailableModels');
  let project = '';
  try {
    project = await fetchGeminiCodeAssistProject(options, account, timeoutMs);
  } catch (_error) {}
  const payload = {
    ...(project ? { project } : {}),
    requestId: createCodeAssistModelRequestId()
  };
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: createGeminiCodeAssistHeaders(
      account.accessToken,
      undefined,
      buildCodeAssistHeaderOptions(options, account, { project })
    ),
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
  }
  const json = await res.json().catch(() => ({}));
  if (process.env.AIH_DEBUG_CODE_ASSIST_MODELS === '1') {
    // 诊断上游模型档位:打印原始响应里的模型键与 tieredModelIds 原文。
    try {
      const models = json && typeof json.models === 'object' && json.models ? json.models : {};
      const tieredById = {};
      Object.entries(models).forEach(([modelId, detail]) => {
        const tiered = detail && typeof detail === 'object'
          ? (detail.tieredModelIds || detail.tiered_model_ids)
          : undefined;
        if (tiered !== undefined) tieredById[modelId] = tiered;
      });
      console.log(`[aih][debug] ${provider} fetchAvailableModels keys: ${JSON.stringify(Object.keys(models))}`);
      console.log(`[aih][debug] ${provider} tieredModelIds: ${JSON.stringify(tieredById).slice(0, 2000)}`);
      Object.entries(models).forEach(([modelId, detail]) => {
        console.log(`[aih][debug] ${provider} model ${modelId}: ${JSON.stringify(detail).slice(0, 600)}`);
      });
      if (json && json.deprecatedModelIds !== undefined) {
        console.log(`[aih][debug] ${provider} deprecatedModelIds: ${JSON.stringify(json.deprecatedModelIds).slice(0, 2000)}`);
      }
      const dumpFile = String(process.env.AIH_DEBUG_CODE_ASSIST_MODELS_DUMP || '').trim();
      if (dumpFile) {
        require('node:fs').writeFileSync(dumpFile, JSON.stringify(json, null, 2));
      }
    } catch (_debugError) {}
  }
  const descriptors = extractCodeAssistModelDescriptors(provider, json);
  return cacheCodeAssistModelDescriptors(account, provider, descriptors);
}

async function fetchGeminiCodeAssistQuotaModelDescriptors(options, account, timeoutMs = 8000) {
  const provider = resolveCodeAssistProviderKey(options, account);
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = buildGeminiCodeAssistMethodUrl(baseUrl, 'retrieveUserQuota');
  let project = '';
  try {
    project = await fetchGeminiCodeAssistProject(options, account, timeoutMs);
  } catch (_error) {}
  const quotaProject = project || (provider === 'gemini' ? GEMINI_CODE_ASSIST_QUOTA_PROJECT_PLACEHOLDER : '');

  async function doFetch(bodyPayload) {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: createGeminiCodeAssistHeaders(
        account.accessToken,
        undefined,
        buildCodeAssistHeaderOptions(options, account, { project })
      ),
      body: JSON.stringify(bodyPayload)
    }, timeoutMs, {
      proxyUrl: options && options.proxyUrl,
      noProxy: options && options.noProxy
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    }
    const json = await res.json().catch(() => ({}));
    return extractCodeAssistModelDescriptors(provider, {
      buckets: Array.isArray(json && json.buckets) ? json.buckets : []
    });
  }

  if (project) {
    try {
      return await doFetch({ project });
    } catch (_error) {}
  }
  return doFetch(quotaProject ? { project: quotaProject } : {});
}

async function fetchGeminiCodeAssistModelDescriptors(options, account, timeoutMs = 8000) {
  const provider = resolveCodeAssistProviderKey(options, account);
  const useSnapshot = !(options && options.ignoreAvailableModelsSnapshot);
  const cached = useSnapshot ? getCachedCodeAssistModelDescriptors(account) : [];
  if (cached.length > 0) return cached;

  try {
    const available = await fetchGeminiCodeAssistAvailableModelDescriptors(options, account, timeoutMs);
    if (available.length > 0) return available;
  } catch (error) {
    if (shouldUseQuotaCatalogFallback(provider, error)) {
      try {
        const quotaDescriptors = await fetchGeminiCodeAssistQuotaModelDescriptors(options, account, timeoutMs);
        const cachedQuotaDescriptors = cacheCodeAssistModelDescriptors(account, provider, quotaDescriptors);
        if (cachedQuotaDescriptors.length > 0) return cachedQuotaDescriptors;
      } catch (_quotaError) {}
    }
    throw error;
  }

  return [];
}

async function fetchGeminiCodeAssistModels(options, account, timeoutMs = 8000) {
  const useSnapshot = !(options && options.ignoreAvailableModelsSnapshot);
  const fromDescriptorSnapshot = useSnapshot
    ? listCodeAssistDescriptorIds(getCachedCodeAssistModelDescriptors(account))
    : [];
  if (fromDescriptorSnapshot.length > 0) return fromDescriptorSnapshot;

  const descriptors = await fetchGeminiCodeAssistModelDescriptors(options, account, timeoutMs);
  return listCodeAssistDescriptorIds(descriptors);
}

async function resolveCodeAssistDefaultModel(options, account, timeoutMs = 8000) {
  const provider = resolveCodeAssistProviderKey(options, account);
  let descriptors = getCachedCodeAssistModelDescriptors(account);
  if (descriptors.length < 1) {
    descriptors = await fetchGeminiCodeAssistAvailableModelDescriptors(options, account, timeoutMs);
  }
  const [model] = listCodeAssistDescriptorIds(descriptors);
  if (!model) throw createCodeAssistModelRequiredError(provider);
  return model;
}

async function resolveCodeAssistRequestModel(options, account, model, timeoutMs = 8000) {
  const provider = String(account && account.provider || options && options.provider || '').trim().toLowerCase();
  let descriptors = getCachedCodeAssistModelDescriptors(account);
  if (descriptors.length < 1) {
    try {
      descriptors = await fetchGeminiCodeAssistAvailableModelDescriptors(options, account, timeoutMs);
    } catch (_error) {
      descriptors = [];
    }
  }
  const source = { account, descriptors };
  const descriptor = resolveCodeAssistModelDescriptor(provider, model, source);
  return {
    publicModel: descriptor ? descriptor.id : String(model || '').trim(),
    wireModel: resolveCodeAssistWireModelId(provider, model, source),
    descriptor
  };
}

function toGeminiTextPart(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        if (typeof item.text === 'string') return item.text;
        if (typeof item.input_text === 'string') return item.input_text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.input_text === 'string') return content.input_text;
  }
  return '';
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function parseOpenAIToolArguments(toolCall) {
  const fn = toolCall && toolCall.function && typeof toolCall.function === 'object'
    ? toolCall.function
    : {};
  return parseJsonObject(fn.arguments) || {};
}

function resolveCodeAssistToolStrategy(options = {}) {
  if (options.providerStrategy && typeof options.providerStrategy === 'object') return options.providerStrategy;
  if (options.includeAntigravityCompatibility) return resolveCodeAssistProviderStrategy('agy');
  return resolveCodeAssistProviderStrategy(options.provider);
}

function normalizeOpenAIToolCallsForGeminiParts(toolCalls, toolNamesById, options = {}) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  const providerStrategy = resolveCodeAssistToolStrategy(options);
  return list
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== 'object') return null;
      if (String(toolCall.type || 'function').trim() !== 'function') return null;
      const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
      const name = String(fn.name || '').trim();
      if (!name) return null;
      const id = String(toolCall.id || '').trim();
      if (id && toolNamesById instanceof Map) toolNamesById.set(id, name);
      const part = {
        functionCall: {
          name,
          args: parseOpenAIToolArguments(toolCall)
        }
      };
      if (providerStrategy.addToolCallThoughtSignature) {
        part.thoughtSignature = CODE_ASSIST_SKIP_THOUGHT_SIGNATURE;
      }
      if (providerStrategy.preserveToolCallId) {
        if (id) part.functionCall.id = id;
      }
      return part;
    })
    .filter(Boolean);
}

function normalizeCodeAssistFunctionResponseContent(content) {
  const text = toGeminiTextPart(content);
  const parsed = parseJsonObject(text);
  if (parsed) return parsed;
  return text;
}

function normalizeOpenAIToolResultForGeminiPart(message, toolNamesById, options = {}) {
  if (!message || typeof message !== 'object') return null;
  const providerStrategy = resolveCodeAssistToolStrategy(options);
  const callId = String(message.tool_call_id || message.toolCallId || message.id || '').trim();
  const name = String(
    message.name
    || message.tool_name
    || (toolNamesById instanceof Map ? toolNamesById.get(callId) : '')
    || ''
  ).trim();
  if (!name) return null;
  const text = toGeminiTextPart(message.content);
  const response = providerStrategy.toolResultResponseKey === 'result'
    ? { result: normalizeCodeAssistFunctionResponseContent(message.content) }
    : (parseJsonObject(text) || { output: text });
  return {
    functionResponse: {
      name,
      ...(providerStrategy.preserveToolCallId && callId ? { id: callId } : {}),
      response
    }
  };
}

function summarizeToolDeclarations(functionDeclarations, options = {}) {
  const schemaKey = String(options.toolDeclarationSchemaKey || '').trim();
  return (Array.isArray(functionDeclarations) ? functionDeclarations : [])
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return null;
      const inferredSchemaKey = schemaKey
        || (tool.parametersJsonSchema ? 'parametersJsonSchema' : 'parameters');
      const schema = inferredSchemaKey && tool[inferredSchemaKey] && typeof tool[inferredSchemaKey] === 'object'
        ? tool[inferredSchemaKey]
        : {};
      const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
        ? schema.properties
        : {};
      return {
        name: String(tool.name || '').trim(),
        schemaKey: inferredSchemaKey,
        required: Array.isArray(schema.required)
          ? schema.required.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20)
          : [],
        propertyKeys: Object.keys(properties).slice(0, 30)
      };
    })
    .filter((item) => item && item.name);
}

function summarizeGeminiOpenAIMessageNormalization(messages, normalized, functionDeclarations, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const roleCounts = {};
  let assistantToolCallCount = 0;
  let toolResultCount = 0;
  let toolResultWithResolvedNameCount = 0;
  let textMessageCount = 0;
  const toolNames = new Set();
  const toolNamesById = new Map();
  list.forEach((msg) => {
    const role = String(msg && msg.role || '').trim().toLowerCase() || 'unknown';
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    if (toGeminiTextPart(msg && msg.content)) textMessageCount += 1;
    const calls = Array.isArray(msg && msg.tool_calls) ? msg.tool_calls : [];
    assistantToolCallCount += calls.length;
    calls.forEach((toolCall) => {
      const fn = toolCall && toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
      const name = String(fn.name || '').trim();
      const id = String(toolCall && toolCall.id || '').trim();
      if (name) toolNames.add(name);
      if (id && name) toolNamesById.set(id, name);
    });
    if (role === 'tool') {
      toolResultCount += 1;
      const callId = String(msg && (msg.tool_call_id || msg.toolCallId || msg.id) || '').trim();
      if (String(msg && (msg.name || msg.tool_name) || '').trim() || toolNamesById.has(callId)) {
        toolResultWithResolvedNameCount += 1;
      }
    }
  });
  const summary = {
    messageCount: list.length,
    roleCounts,
    textMessageCount,
    assistantToolCallCount,
    toolResultCount,
    toolResultWithResolvedNameCount,
    contentCount: Array.isArray(normalized && normalized.contents) ? normalized.contents.length : 0,
    systemInstruction: Boolean(normalized && normalized.systemInstruction),
    toolDeclarationCount: Array.isArray(functionDeclarations) ? functionDeclarations.length : 0,
    toolNames: Array.from(toolNames).slice(0, 20)
  };
  const schemaKey = String(options.toolDeclarationSchemaKey || '').trim();
  if (schemaKey) summary.toolDeclarationSchemaKey = schemaKey;
  if (Array.isArray(options.generationConfigKeys)) {
    summary.generationConfigKeys = options.generationConfigKeys.slice().sort();
  }
  if (Array.isArray(options.omittedGenerationConfigKeys) && options.omittedGenerationConfigKeys.length > 0) {
    summary.omittedGenerationConfigKeys = options.omittedGenerationConfigKeys.slice().sort();
  }
  const declarationSummary = summarizeToolDeclarations(functionDeclarations, { toolDeclarationSchemaKey: schemaKey });
  if (declarationSummary.length > 0) summary.toolDeclarations = declarationSummary;
  return summary;
}

function summarizeGeminiToolCalls(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall) => {
    const fn = toolCall && toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
    const name = String(fn.name || '').trim();
    const argsText = String(fn.arguments || '');
    const args = parseJsonObject(argsText) || {};
    const argKeys = Object.keys(args);
    return {
      name,
      argumentLength: argsText.length,
      argKeys,
      emptyArgs: argKeys.length === 0
    };
  }).filter((item) => item.name);
}

function summarizeGeminiToolCallsByCandidate(toolCallsByCandidate) {
  return (Array.isArray(toolCallsByCandidate) ? toolCallsByCandidate : [])
    .flatMap((toolCalls, candidateIndex) =>
      summarizeGeminiToolCalls(toolCalls).map((summary) => ({ candidateIndex, ...summary }))
    );
}

function normalizeOpenAIMessagesForGemini(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const contents = [];
  const systemParts = [];
  const toolNamesById = new Map();
  list.forEach((msg) => {
    const role = String(msg && msg.role || '').trim().toLowerCase();
    const text = toGeminiTextPart(msg && msg.content);
    if (role === 'system') {
      if (text) systemParts.push(text);
      return;
    }
    if (role === 'tool') {
      const part = normalizeOpenAIToolResultForGeminiPart(msg, toolNamesById, options);
      if (!part) return;
      contents.push({
        role: 'user',
        parts: [part]
      });
      return;
    }
    const toolCallParts = normalizeOpenAIToolCallsForGeminiParts(
      msg && msg.tool_calls,
      toolNamesById,
      options
    );
    const parts = [];
    if (text) parts.push({ text });
    parts.push(...toolCallParts);
    if (parts.length === 0) return;
    const geminiRole = role === 'assistant' ? 'model' : 'user';
    contents.push({
      role: geminiRole,
      parts
    });
  });
  if (contents.length === 0 && systemParts.length > 0) {
    contents.push({
      role: 'user',
      parts: [{ text: systemParts.join('\n') }]
    });
    systemParts.length = 0;
  }
  return {
    contents,
    systemInstruction: systemParts.length > 0
      ? { role: 'user', parts: [{ text: systemParts.join('\n') }] }
      : undefined
  };
}

function mapGeminiFinishReason(reason) {
  const value = String(reason || '').trim().toUpperCase();
  if (value === 'MAX_TOKENS') return 'length';
  if (value === 'STOP') return 'stop';
  if (value === 'UNEXPECTED_TOOL_CALL') return 'tool_calls';
  return 'stop';
}

function extractGeminiCandidateText(candidate) {
  const parts = Array.isArray(
    candidate && candidate.content && candidate.content.parts
  ) ? candidate.content.parts : [];
  const text = parts
    .filter((part) => !(part && part.thought === true))
    .map((part) => String(part && part.text || '').trim())
    .filter(Boolean)
    .join('\n');
  return text;
}

function extractGeminiCandidateThoughtText(candidate) {
  const parts = Array.isArray(
    candidate && candidate.content && candidate.content.parts
  ) ? candidate.content.parts : [];
  return parts
    .filter((part) => part && part.thought === true)
    .map((part) => String(part && part.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

function stringifyGeminiFunctionArgs(args) {
  if (typeof args === 'string') return args;
  if (args == null) return '{}';
  try {
    return JSON.stringify(args);
  } catch (_error) {
    return '{}';
  }
}

function extractGeminiCandidateToolCalls(candidate) {
  const parts = Array.isArray(
    candidate && candidate.content && candidate.content.parts
  ) ? candidate.content.parts : [];
  const out = [];
  parts.forEach((part) => {
    if (!part || typeof part !== 'object' || !part.functionCall) return;
    const fn = part.functionCall || {};
    const name = String(fn.name || '').trim();
    if (!name) return;
    const id = String(fn.id || '').trim() || `call_${out.length + 1}`;
    out.push({
      id,
      type: 'function',
      function: {
        name,
        arguments: stringifyGeminiFunctionArgs(fn.args)
      }
    });
  });
  return out;
}

function normalizeOpenAIToolsForGemini(tools, options = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const declarations = [];
  const schemaKey = String(options.schemaKey || 'parameters').trim() || 'parameters';
  list.forEach((tool) => {
    if (!tool || typeof tool !== 'object') return;
    if (String(tool.type || '').trim() !== 'function') return;
    const fn = tool.function && typeof tool.function === 'object' ? tool.function : {};
    const name = String(fn.name || '').trim();
    if (!name) return;
    const description = String(fn.description || '').trim();
    const parameters = fn.parameters && typeof fn.parameters === 'object'
      ? fn.parameters
      : { type: 'object', properties: {} };
    declarations.push({
      name,
      description,
      [schemaKey]: sanitizeSchemaForGemini(parameters)
    });
  });
  return declarations;
}

function normalizeOpenAIToolChoiceForGemini(toolChoice) {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === 'string') {
    const value = toolChoice.trim().toLowerCase();
    if (!value || value === 'auto') {
      return { functionCallingConfig: { mode: 'AUTO' } };
    }
    if (value === 'none') {
      return { functionCallingConfig: { mode: 'NONE' } };
    }
    if (value === 'required') {
      return { functionCallingConfig: { mode: 'ANY' } };
    }
    return undefined;
  }
  if (toolChoice && typeof toolChoice === 'object' && String(toolChoice.type || '').trim() === 'function') {
    const fn = toolChoice.function && typeof toolChoice.function === 'object' ? toolChoice.function : {};
    const name = String(fn.name || '').trim();
    if (!name) return { functionCallingConfig: { mode: 'ANY' } };
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [name]
      }
    };
  }
  return undefined;
}

function extractGeminiCandidates(envelope) {
  const direct = Array.isArray(envelope && envelope.candidates)
    ? envelope.candidates
    : [];
  if (direct.length > 0) return direct;
  return Array.isArray(envelope && envelope.response && envelope.response.candidates)
    ? envelope.response.candidates
    : [];
}

function extractGeminiUsageMetadata(envelope) {
  if (envelope && envelope.usageMetadata && typeof envelope.usageMetadata === 'object') {
    return envelope.usageMetadata;
  }
  if (envelope && envelope.response && envelope.response.usageMetadata && typeof envelope.response.usageMetadata === 'object') {
    return envelope.response.usageMetadata;
  }
  return {};
}

function extractGeminiModelVersion(envelope, fallbackModel) {
  const resolved = String(
    envelope && envelope.modelVersion
    || envelope && envelope.response && envelope.response.modelVersion
    || fallbackModel
    || ''
  ).trim();
  return resolved || String(fallbackModel || '').trim() || 'unknown';
}

function normalizeGeminiGenerateContentEnvelope(envelope, fallbackModel) {
  const source = envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? envelope : {};
  const wrapped = source.response && typeof source.response === 'object' && !Array.isArray(source.response)
    ? source.response
    : null;
  const normalized = wrapped ? { ...wrapped } : { ...source };
  delete normalized.response;

  const candidates = extractGeminiCandidates(source);
  if (candidates.length > 0 || wrapped) normalized.candidates = candidates;

  const usageMetadata = extractGeminiUsageMetadata(source);
  if (Object.keys(usageMetadata).length > 0 || wrapped) normalized.usageMetadata = usageMetadata;

  const modelVersion = extractGeminiModelVersion(source, fallbackModel);
  if (modelVersion) normalized.modelVersion = modelVersion;

  ['responseId', 'traceId'].forEach((key) => {
    if (source[key] && !normalized[key]) normalized[key] = source[key];
  });

  return normalized;
}

function buildDefaultGeminiCodeAssistGenerationConfig(model, providerStrategy, options = {}) {
  if (!String(model || '').trim()) return {};
  return {
    temperature: 1,
    topP: 0.95,
    topK: 64,
    thinkingConfig: resolveCodeAssistAdaptiveThinkingConfig(providerStrategy, options)
  };
}

function normalizeGeminiExternalSessionKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '[undefined]') return '';
  return text;
}

function isGeminiCodeAssistSessionId(value) {
  return GEMINI_CODE_ASSIST_SESSION_ID_RE.test(String(value || '').trim());
}

function createGeminiCodeAssistSessionId() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_error) {}
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

function buildGeminiCodeAssistMessageSessionKey(requestJson) {
  const messages = Array.isArray(requestJson && requestJson.messages)
    ? requestJson.messages
    : [];
  const firstUser = messages.find((message) => {
    const role = String(message && message.role || '').trim().toLowerCase();
    return role === 'user' && normalizeGeminiExternalSessionKey(toGeminiTextPart(message && message.content));
  });
  const firstUserText = normalizeGeminiExternalSessionKey(toGeminiTextPart(firstUser && firstUser.content));
  if (!firstUserText) return '';
  const model = normalizeGeminiExternalSessionKey(requestJson && requestJson.model) || 'unknown-model';
  const digest = crypto
    .createHash('sha256')
    .update(`${model}\n${firstUserText.replace(/\s+/g, ' ').slice(0, 1000)}`)
    .digest('hex');
  return `messages:${digest}`;
}

function buildGeminiCodeAssistExternalSessionKey(requestJson, sessionKey) {
  const metadata = requestJson && requestJson.metadata && typeof requestJson.metadata === 'object'
    ? requestJson.metadata
    : {};
  const session = requestJson && requestJson.session && typeof requestJson.session === 'object'
    ? requestJson.session
    : {};
  const conversation = requestJson && requestJson.conversation && typeof requestJson.conversation === 'object'
    ? requestJson.conversation
    : {};
  const thread = requestJson && requestJson.thread && typeof requestJson.thread === 'object'
    ? requestJson.thread
    : {};
  const fromRequest = pickFirstNonEmpty([
    requestJson && requestJson.session_id,
    requestJson && requestJson.sessionId,
    session.id,
    requestJson && requestJson.conversation_id,
    conversation.id,
    requestJson && requestJson.thread_id,
    thread.id,
    metadata.session_id,
    metadata.conversation_id,
    metadata.thread_id,
    sessionKey
  ].map((value) => normalizeGeminiExternalSessionKey(value)));
  if (fromRequest) return fromRequest;
  return buildGeminiCodeAssistMessageSessionKey(requestJson);
}

function normalizeGeminiSessionMapEntry(entry) {
  if (typeof entry === 'string') {
    return isGeminiCodeAssistSessionId(entry)
      ? { sessionId: entry.toLowerCase(), expiresAt: 0, lastUsedAt: 0, promptCount: 0 }
      : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const sessionId = String(entry.sessionId || '').trim();
  if (!isGeminiCodeAssistSessionId(sessionId)) return null;
  const promptCount = Math.max(0, Math.floor(Number(entry.promptCount) || 0));
  return {
    sessionId: sessionId.toLowerCase(),
    expiresAt: Math.max(0, Number(entry.expiresAt) || 0),
    lastUsedAt: Math.max(0, Number(entry.lastUsedAt) || 0),
    promptCount
  };
}

function pruneGeminiSessionIdMap(map, nowMs, maxEntries) {
  if (!(map instanceof Map)) return;
  for (const [key, entry] of map.entries()) {
    const normalized = normalizeGeminiSessionMapEntry(entry);
    if (!normalized || (normalized.expiresAt > 0 && normalized.expiresAt <= nowMs)) {
      map.delete(key);
    }
  }
  const max = Math.max(100, Number(maxEntries) || DEFAULT_GEMINI_SESSION_ID_MAP_MAX);
  while (map.size >= max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function buildGeminiGlobalSessionMapKey(externalKey) {
  return `session:${String(externalKey || '').trim()}`;
}

function readGeminiSessionMapEntry(map, key) {
  if (!(map instanceof Map) || !key) return null;
  return normalizeGeminiSessionMapEntry(map.get(key));
}

function writeGeminiSessionMapEntry(map, key, entry, nowMs, ttlMs) {
  if (!(map instanceof Map) || !key || !entry) return;
  map.set(key, {
    sessionId: entry.sessionId,
    expiresAt: nowMs + ttlMs,
    lastUsedAt: nowMs,
    promptCount: Math.max(0, Math.floor(Number(entry.promptCount) || 0))
  });
}

function findGeminiSessionMapEntry(map, keys) {
  for (const key of keys) {
    const entry = readGeminiSessionMapEntry(map, key);
    if (entry) return entry;
  }
  return null;
}

function hashGeminiDiagnosticValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function createGeminiCodeAssistSessionState(sessionId, externalKey, source, reused, promptCount) {
  const normalizedSessionId = String(sessionId || '').trim().toLowerCase();
  const nextPromptCount = Math.max(0, Math.floor(Number(promptCount) || 0));
  return {
    sessionId: normalizedSessionId,
    externalKey,
    externalKeyHash: hashGeminiDiagnosticValue(externalKey),
    source,
    reused: !!reused,
    promptCount: nextPromptCount,
    userPromptId: `${normalizedSessionId}########${nextPromptCount}`
  };
}

function buildGeminiCodeAssistSessionState(options, account, requestJson) {
  const externalKey = buildGeminiCodeAssistExternalSessionKey(requestJson || {}, options && options.sessionKey);
  const map = options && options.geminiSessionIdMap instanceof Map
    ? options.geminiSessionIdMap
    : null;

  const nowMs = Date.now();
  const ttlMs = Math.max(
    30_000,
    Number(options && options.geminiSessionIdMapTtlMs) || DEFAULT_GEMINI_SESSION_ID_MAP_TTL_MS
  );
  if (map) pruneGeminiSessionIdMap(map, nowMs, options && options.geminiSessionIdMapMaxEntries);

  if (isGeminiCodeAssistSessionId(externalKey)) {
    const sessionId = externalKey.toLowerCase();
    if (!map) return createGeminiCodeAssistSessionState(sessionId, externalKey, 'request_uuid', false, 0);
    const mapKey = buildGeminiGlobalSessionMapKey(externalKey);
    const found = findGeminiSessionMapEntry(map, [mapKey]);
    const promptCount = found ? found.promptCount : 0;
    writeGeminiSessionMapEntry(map, mapKey, {
      sessionId,
      promptCount: promptCount + 1
    }, nowMs, ttlMs);
    return createGeminiCodeAssistSessionState(sessionId, externalKey, 'request_uuid', !!found, promptCount);
  }

  if (!map || !externalKey) {
    const sessionId = createGeminiCodeAssistSessionId();
    return createGeminiCodeAssistSessionState(
      sessionId,
      externalKey,
      externalKey ? 'generated' : 'generated_no_external_key',
      false,
      0
    );
  }

  const mapKey = buildGeminiGlobalSessionMapKey(externalKey);
  const found = findGeminiSessionMapEntry(map, [mapKey]);
  if (found) {
    const promptCount = found.promptCount;
    writeGeminiSessionMapEntry(map, mapKey, {
      sessionId: found.sessionId,
      promptCount: promptCount + 1
    }, nowMs, ttlMs);
    return createGeminiCodeAssistSessionState(found.sessionId, externalKey, 'mapped', true, promptCount);
  }

  const sessionId = createGeminiCodeAssistSessionId();
  writeGeminiSessionMapEntry(map, mapKey, {
    sessionId,
    promptCount: 1
  }, nowMs, ttlMs);
  return createGeminiCodeAssistSessionState(sessionId, externalKey, 'mapped', false, 0);
}

function getGeminiCodeAssistG1CreditBalance(paidTier) {
  const credits = Array.isArray(paidTier && paidTier.availableCredits)
    ? paidTier.availableCredits
    : [];
  let total = 0;
  let found = false;
  credits.forEach((credit) => {
    const type = String(credit && credit.creditType || '').trim();
    if (type !== GEMINI_CODE_ASSIST_G1_CREDIT_TYPE) return;
    found = true;
    const amount = parseInt(String(credit && credit.creditAmount || '0'), 10);
    if (Number.isFinite(amount)) total += amount;
  });
  return found ? total : null;
}

function normalizeGeminiCodeAssistOverageStrategy(value) {
  const strategy = String(value || '').trim().toLowerCase();
  if (strategy === 'always' || strategy === 'ask' || strategy === 'never') return strategy;
  return '';
}

function parseConfiguredModelList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readCodeAssistCreditEligibleModels(account, options) {
  return [
    ...parseConfiguredModelList(options && options.geminiCodeAssistOverageEligibleModels),
    ...parseConfiguredModelList(options && options.codeAssistOverageEligibleModels),
    ...parseConfiguredModelList(account && account.geminiCodeAssistOverageEligibleModels),
    ...parseConfiguredModelList(account && account.codeAssistOverageEligibleModels)
  ];
}

function readBooleanField(source, fieldNames) {
  if (!source || typeof source !== 'object') return null;
  for (const fieldName of fieldNames) {
    if (!Object.prototype.hasOwnProperty.call(source, fieldName)) continue;
    const value = source[fieldName];
    if (typeof value === 'boolean') return value;
    const text = String(value || '').trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return null;
}

function isCodeAssistCreditEligibleModel(model, account, options) {
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) return false;
  const configured = readCodeAssistCreditEligibleModels(account, options);
  if (configured.length > 0) {
    return configured.some((item) => String(item || '').trim() === normalizedModel);
  }
  const descriptor = resolveCodeAssistModelDescriptor(
    String(account && account.provider || options && options.provider || '').trim().toLowerCase(),
    normalizedModel,
    { account }
  );
  const eligible = readBooleanField(descriptor, [
    'creditEligible',
    'creditsEligible',
    'overageEligible',
    'supportsOverage'
  ]);
  return eligible === true;
}

function shouldEnableGeminiCodeAssistCredits(model, account, options) {
  if (!isCodeAssistCreditEligibleModel(model, account, options)) {
    return {
      enabled: false,
      balance: null,
      reason: 'model_not_eligible'
    };
  }

  const paidTier = (account && account.codeAssistPaidTier) || null;
  const balance = getGeminiCodeAssistG1CreditBalance(paidTier);
  if (balance == null) {
    return {
      enabled: false,
      balance,
      reason: 'credit_balance_unknown'
    };
  }
  if (balance < GEMINI_CODE_ASSIST_MIN_CREDIT_BALANCE) {
    return {
      enabled: false,
      balance,
      reason: 'credit_balance_low'
    };
  }

  const strategy = normalizeGeminiCodeAssistOverageStrategy(
    options && options.geminiCodeAssistOverageStrategy
    || account && account.geminiCodeAssistOverageStrategy
    || account && account.codeAssistOverageStrategy
  );
  if (strategy === 'never') {
    return {
      enabled: false,
      balance,
      reason: 'overage_strategy_never'
    };
  }
  return {
    enabled: true,
    balance,
    reason: strategy ? `overage_strategy_${strategy}` : 'available_credit'
  };
}

function appendGeminiCodeAssistDiagnostic(options, diagnostic) {
  if (!options || typeof options.appendGeminiCodeAssistDiagnostic !== 'function') return;
  try {
    options.appendGeminiCodeAssistDiagnostic(diagnostic);
  } catch (_error) {}
}

function resolveCodeAssistRequestSessionIdField(providerStrategy) {
  const field = String(providerStrategy && providerStrategy.requestSessionIdField || '').trim();
  return field || 'session_id';
}

async function buildGeminiCodeAssistGenerateContext(options, account, requestJson, timeoutMs) {
  const project = await fetchGeminiCodeAssistProject(options, account, timeoutMs);
  if (!project) {
    throw new Error('gemini_code_assist_project_unavailable');
  }
  const originalModel = String(requestJson && requestJson.model || '').trim()
    || await resolveCodeAssistDefaultModel(options || {}, account, timeoutMs);
  let model = originalModel;
  let modelResolution = { publicModel: originalModel, wireModel: originalModel, descriptor: null };
  const provider = String(account && account.provider || '').trim().toLowerCase();
  const providerStrategy = resolveCodeAssistProviderStrategy(provider);
  if (isCodeAssistProvider(provider)) {
    modelResolution = await resolveCodeAssistRequestModel(options || {}, account, originalModel, timeoutMs);
    model = modelResolution.wireModel || originalModel;
  }
  const normalized = normalizeOpenAIMessagesForGemini(requestJson && requestJson.messages, {
    providerStrategy
  });
  let generationConfig = buildDefaultGeminiCodeAssistGenerationConfig(model, providerStrategy);
  const sessionState = buildGeminiCodeAssistSessionState(options || {}, account, requestJson || {});
  const creditDecision = shouldEnableGeminiCodeAssistCredits(model, account, options || {});
  const maxTokens = Number(requestJson && requestJson.max_tokens);
  const temperature = Number(requestJson && requestJson.temperature);
  const topP = Number(requestJson && requestJson.top_p);
  const topK = Number(requestJson && requestJson.top_k);
  if (Number.isFinite(maxTokens) && maxTokens > 0) generationConfig.maxOutputTokens = Math.round(maxTokens);
  if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
  if (Number.isFinite(topP)) generationConfig.topP = topP;
  if (Number.isFinite(topK)) generationConfig.topK = topK;
  if (Array.isArray(requestJson && requestJson.stop) && requestJson.stop.length > 0) {
    generationConfig.stopSequences = requestJson.stop.map((x) => String(x || '').trim()).filter(Boolean);
  } else if (typeof (requestJson && requestJson.stop) === 'string') {
    generationConfig.stopSequences = [String(requestJson.stop).trim()].filter(Boolean);
  }
  generationConfig = applyCodeAssistGenerationConfigStrategy(
    generationConfig,
    providerStrategy,
    { model, originalModel }
  );
  // 注入思考后给答案预留预算,避免思考吃光 maxOutputTokens → 只有思考没有回答。
  reserveAnswerBudgetForCodeAssistThinking(generationConfig);
  // 图像生成模型(如 gemini-3.1-flash-image)必须显式开启 IMAGE 响应模态,否则只叙述不画图。
  applyImageGenerationGenerationConfig(generationConfig, originalModel);
  const omittedGenerationConfigKeys = listCodeAssistUnsupportedGenerationConfigKeys(
    providerStrategy,
    { model, originalModel }
  );
  const generationConfigCapabilityRules = listCodeAssistGenerationConfigCapabilityRules(
    providerStrategy,
    { model, originalModel }
  );
  const toolDeclarationSchemaKey = providerStrategy.toolDeclarationSchemaKey;
  const functionDeclarations = normalizeOpenAIToolsForGemini(requestJson && requestJson.tools, {
    schemaKey: toolDeclarationSchemaKey
  });
  const toolConfig = functionDeclarations.length > 0
    ? normalizeOpenAIToolChoiceForGemini(requestJson && requestJson.tool_choice)
    : undefined;
  const sessionIdField = resolveCodeAssistRequestSessionIdField(providerStrategy);
  const requestSummary = summarizeGeminiOpenAIMessageNormalization(
    requestJson && requestJson.messages,
    normalized,
    functionDeclarations,
    {
      toolDeclarationSchemaKey,
      generationConfigKeys: Object.keys(generationConfig).sort(),
      omittedGenerationConfigKeys
    }
  );
  const request = {
    contents: normalized.contents,
    systemInstruction: normalized.systemInstruction,
    generationConfig,
    tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
    toolConfig,
    [sessionIdField]: sessionState.sessionId
  };
  const creditFields = resolveCodeAssistCreditFields(providerStrategy, creditDecision);
  const payload = buildCodeAssistGeneratePayload(providerStrategy, model, project, request, sessionState, creditFields);
  const diagnostic = {
    model,
    project,
    requestId: payload.requestId || '',
    requestType: payload.requestType || '',
    requestEnvelope: providerStrategy.requestEnvelope || 'gemini_cli',
    sessionId: sessionState.sessionId,
    userPromptId: sessionState.userPromptId,
    sessionSource: sessionState.source,
    sessionReused: sessionState.reused,
    promptCount: sessionState.promptCount,
    externalSessionKeyHash: sessionState.externalKeyHash,
    creditsEnabled: creditDecision.enabled,
    creditBalance: creditDecision.balance,
    creditDecisionReason: creditDecision.reason,
    creditTypesIncluded: creditFields.values.length > 0,
    creditTypesField: creditFields.field,
    creditTypesForced: creditFields.forced,
    provider,
    publicModel: modelResolution.publicModel,
    wireModel: model,
    requestProtocol: 'openai_chat_normalized',
    upstreamProtocol: 'gemini_code_assist_generate_content',
    ...(omittedGenerationConfigKeys.length > 0 ? { omittedGenerationConfigKeys } : {}),
    ...(generationConfigCapabilityRules.length > 0 ? { generationConfigCapabilityRules } : {}),
    requestSummary
  };
  return {
    model,
    originalModel,
    project,
    payload,
    diagnostic
  };
}

function createNativeGeminiRequestSummary(requestJson, generationConfig, options = {}) {
  const contents = Array.isArray(requestJson && requestJson.contents) ? requestJson.contents : [];
  const tools = Array.isArray(requestJson && requestJson.tools) ? requestJson.tools : [];
  const repairSummary = requestJson && requestJson.__nativeRepairSummary && typeof requestJson.__nativeRepairSummary === 'object'
    ? requestJson.__nativeRepairSummary
    : {};
  return {
    contentCount: contents.length,
    toolCount: tools.length,
    hasSystemInstruction: Boolean(requestJson && requestJson.systemInstruction),
    maxOutputTokens: Number(generationConfig && generationConfig.maxOutputTokens) || undefined,
    generationConfigKeys: generationConfig && typeof generationConfig === 'object'
      ? Object.keys(generationConfig).sort()
      : [],
    ...(Array.isArray(options.omittedGenerationConfigKeys) && options.omittedGenerationConfigKeys.length > 0
      ? { omittedGenerationConfigKeys: options.omittedGenerationConfigKeys.slice().sort() }
      : {}),
    backfilledFunctionResponseNameCount: Number(repairSummary.backfilledFunctionResponseNameCount || 0),
    addedToolCallThoughtSignatureCount: Number(repairSummary.addedToolCallThoughtSignatureCount || 0),
    droppedTrailingUnansweredFunctionCallTurn: Number(repairSummary.droppedTrailingUnansweredFunctionCallTurn || 0),
    wrappedAgyFunctionResponseCount: Number(repairSummary.wrappedAgyFunctionResponseCount || 0)
  };
}

function readNativeGeminiFunctionCall(part) {
  if (!part || typeof part !== 'object') return null;
  const functionCall = part.functionCall || part.function_call;
  return functionCall && typeof functionCall === 'object' ? functionCall : null;
}

function readNativeGeminiFunctionResponse(part) {
  if (!part || typeof part !== 'object') return null;
  const functionResponse = part.functionResponse || part.function_response;
  return functionResponse && typeof functionResponse === 'object' ? functionResponse : null;
}

function readNativeFunctionCallRef(functionCall) {
  if (!functionCall || typeof functionCall !== 'object') return null;
  const name = String(functionCall.name || '').trim();
  if (!name) return null;
  return {
    id: String(functionCall.id || functionCall.call_id || functionCall.callId || '').trim(),
    name
  };
}

function readNativeFunctionResponseId(functionResponse) {
  if (!functionResponse || typeof functionResponse !== 'object') return '';
  return String(functionResponse.id || functionResponse.call_id || functionResponse.callId || '').trim();
}

function cloneNativeGeminiFunctionPart(part, key, value) {
  return {
    ...part,
    [key]: {
      ...(part && part[key] && typeof part[key] === 'object' ? part[key] : {}),
      ...value
    }
  };
}

function addNativeGeminiFunctionResponseName(part, name) {
  if (part && part.functionResponse && typeof part.functionResponse === 'object') {
    return cloneNativeGeminiFunctionPart(part, 'functionResponse', { name });
  }
  if (part && part.function_response && typeof part.function_response === 'object') {
    return cloneNativeGeminiFunctionPart(part, 'function_response', { name });
  }
  return part;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function shouldWrapAgyFunctionResponse(providerStrategy, functionResponse) {
  return providerStrategy
    && providerStrategy.provider === 'agy'
    && functionResponse
    && !isPlainObject(functionResponse.response);
}

function wrapAgyFunctionResponsePart(part, response) {
  const nextResponse = { result: response === undefined ? '' : response };
  if (part && part.functionResponse && typeof part.functionResponse === 'object') {
    return cloneNativeGeminiFunctionPart(part, 'functionResponse', { response: nextResponse });
  }
  if (part && part.function_response && typeof part.function_response === 'object') {
    return cloneNativeGeminiFunctionPart(part, 'function_response', { response: nextResponse });
  }
  return part;
}

function addNativeGeminiToolCallThoughtSignature(part) {
  if (!readNativeGeminiFunctionCall(part)) return { part, added: false };
  if (String(part && (part.thoughtSignature || part.thought_signature) || '').trim()) {
    return { part, added: false };
  }
  return {
    part: {
      ...part,
      thoughtSignature: CODE_ASSIST_SKIP_THOUGHT_SIGNATURE
    },
    added: true
  };
}

function resolveNativeFunctionResponseName(functionResponse, pendingCalls, responseIndex) {
  const existingName = String(functionResponse && functionResponse.name || '').trim();
  if (existingName) return '';
  const responseId = readNativeFunctionResponseId(functionResponse);
  if (responseId) {
    const match = pendingCalls.find((call) => call && call.id === responseId && call.name);
    if (match) return match.name;
  }
  const ordered = pendingCalls[responseIndex];
  return ordered && ordered.name ? ordered.name : '';
}

function repairNativeGeminiCodeAssistContents(contents, providerStrategy) {
  const list = Array.isArray(contents) ? contents : [];
  let pendingCalls = [];
  let backfilledFunctionResponseNameCount = 0;
  let addedToolCallThoughtSignatureCount = 0;
  let droppedTrailingUnansweredFunctionCallTurn = 0;
  let wrappedAgyFunctionResponseCount = 0;

  const repaired = list.map((content) => {
    if (!content || typeof content !== 'object') return content;
    const role = String(content.role || '').trim();
    const parts = Array.isArray(content.parts) ? content.parts : [];

    if (role === 'model') {
      pendingCalls = parts.map(readNativeGeminiFunctionCall).map(readNativeFunctionCallRef).filter(Boolean);
      return { ...content, parts: parts.slice() };
    }

    let responseIndex = 0;
    const nextParts = parts.map((part) => {
      const functionResponse = readNativeGeminiFunctionResponse(part);
      if (!functionResponse) return part;
      let nextPart = part;
      if (shouldWrapAgyFunctionResponse(providerStrategy, functionResponse)) {
        nextPart = wrapAgyFunctionResponsePart(nextPart, functionResponse.response);
        wrappedAgyFunctionResponseCount += 1;
      }
      const name = resolveNativeFunctionResponseName(functionResponse, pendingCalls, responseIndex);
      responseIndex += 1;
      if (!name) return nextPart;
      backfilledFunctionResponseNameCount += 1;
      return addNativeGeminiFunctionResponseName(nextPart, name);
    });
    if (responseIndex > 0) pendingCalls = [];
    if (responseIndex === 0 && pendingCalls.length > 0) pendingCalls = [];
    return { ...content, parts: nextParts };
  });

  const last = repaired[repaired.length - 1];
  if (last && last.role === 'model' && Array.isArray(last.parts) && last.parts.some(readNativeGeminiFunctionCall)) {
    const parts = last.parts.filter((part) => !readNativeGeminiFunctionCall(part));
    droppedTrailingUnansweredFunctionCallTurn = 1;
    if (parts.length > 0) {
      repaired[repaired.length - 1] = { ...last, parts };
    } else {
      repaired.pop();
    }
  }

  const signedContents = repaired.map((content) => {
    if (!(providerStrategy && providerStrategy.addToolCallThoughtSignature)) return content;
    if (!content || content.role !== 'model' || !Array.isArray(content.parts)) return content;
    const parts = content.parts.map((part) => {
      const patched = addNativeGeminiToolCallThoughtSignature(part);
      if (patched.added) addedToolCallThoughtSignatureCount += 1;
      return patched.part;
    });
    return { ...content, parts };
  });

  return {
    contents: signedContents,
    summary: {
      backfilledFunctionResponseNameCount,
      addedToolCallThoughtSignatureCount,
      droppedTrailingUnansweredFunctionCallTurn,
      wrappedAgyFunctionResponseCount
    }
  };
}

function buildNativeGeminiCodeAssistRequest(model, sessionState, source, providerStrategy, options = {}) {
  const normalizedContents = repairNativeGeminiCodeAssistContents(
    source && source.contents,
    providerStrategy
  );
  const generationConfig = applyCodeAssistGenerationConfigStrategy({
    ...buildDefaultGeminiCodeAssistGenerationConfig(model, providerStrategy),
    ...(
      source
      && source.generationConfig
      && typeof source.generationConfig === 'object'
        ? source.generationConfig
        : {}
    )
  }, providerStrategy, {
    model,
    originalModel: options.originalModel
  });
  const sessionIdField = resolveCodeAssistRequestSessionIdField(providerStrategy);
  return {
    contents: normalizedContents.contents,
    systemInstruction: source && source.systemInstruction && typeof source.systemInstruction === 'object'
      ? source.systemInstruction
      : undefined,
    generationConfig,
    tools: Array.isArray(source && source.tools) && source.tools.length > 0 ? source.tools : undefined,
    toolConfig: source && source.toolConfig && typeof source.toolConfig === 'object'
      ? source.toolConfig
      : undefined,
    [sessionIdField]: sessionState.sessionId,
    __nativeRepairSummary: normalizedContents.summary
  };
}

async function buildGeminiCodeAssistNativeGenerateContext(options, account, requestJson, timeoutMs) {
  const project = await fetchGeminiCodeAssistProject(options, account, timeoutMs);
  if (!project) {
    throw new Error('gemini_code_assist_project_unavailable');
  }
  const source = requestJson && typeof requestJson === 'object' ? requestJson : {};
  const originalModel = String(source.model || '').trim()
    || await resolveCodeAssistDefaultModel(options || {}, account, timeoutMs);
  const provider = String(account && account.provider || '').trim().toLowerCase();
  const modelResolution = isCodeAssistProvider(provider)
    ? await resolveCodeAssistRequestModel(options || {}, account, originalModel, timeoutMs)
    : { publicModel: originalModel, wireModel: originalModel, descriptor: null };
  const model = modelResolution.wireModel || originalModel;
  const providerStrategy = resolveCodeAssistProviderStrategy(provider);
  const sessionState = buildGeminiCodeAssistSessionState(options || {}, account, source);
  const creditDecision = shouldEnableGeminiCodeAssistCredits(model, account, options || {});
  const omittedGenerationConfigKeys = listCodeAssistUnsupportedGenerationConfigKeys(
    providerStrategy,
    { model, originalModel }
  );
  const generationConfigCapabilityRules = listCodeAssistGenerationConfigCapabilityRules(
    providerStrategy,
    { model, originalModel }
  );
  const request = buildNativeGeminiCodeAssistRequest(model, sessionState, source, providerStrategy, { originalModel });
  const requestSummarySource = {
    ...source,
    contents: request.contents,
    __nativeRepairSummary: request.__nativeRepairSummary
  };
  delete request.__nativeRepairSummary;
  const creditFields = resolveCodeAssistCreditFields(providerStrategy, creditDecision);
  const payload = buildCodeAssistGeneratePayload(providerStrategy, model, project, request, sessionState, creditFields);
  const diagnostic = {
    model,
    project,
    requestId: payload.requestId || '',
    requestType: payload.requestType || '',
    requestEnvelope: providerStrategy.requestEnvelope || 'gemini_cli',
    sessionId: sessionState.sessionId,
    userPromptId: sessionState.userPromptId,
    sessionSource: sessionState.source,
    sessionReused: sessionState.reused,
    promptCount: sessionState.promptCount,
    externalSessionKeyHash: sessionState.externalKeyHash,
    creditsEnabled: creditDecision.enabled,
    creditBalance: creditDecision.balance,
    creditDecisionReason: creditDecision.reason,
    creditTypesIncluded: creditFields.values.length > 0,
    creditTypesField: creditFields.field,
    creditTypesForced: creditFields.forced,
    provider,
    publicModel: modelResolution.publicModel,
    wireModel: model,
    requestProtocol: String(options && options.clientProtocol || 'gemini_generate_content').trim() || 'gemini_generate_content',
    upstreamProtocol: 'gemini_code_assist_generate_content',
    ...(omittedGenerationConfigKeys.length > 0 ? { omittedGenerationConfigKeys } : {}),
    ...(generationConfigCapabilityRules.length > 0 ? { generationConfigCapabilityRules } : {}),
    requestSummary: createNativeGeminiRequestSummary(requestSummarySource, request.generationConfig, {
      omittedGenerationConfigKeys
    })
  };
  return {
    model,
    originalModel,
    project,
    payload,
    diagnostic
  };
}

function iterateStreamChunks(body) {
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    return body;
  }
  if (body && typeof body.getReader === 'function') {
    return {
      async *[Symbol.asyncIterator]() {
        const reader = body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } finally {
          if (typeof reader.releaseLock === 'function') reader.releaseLock();
        }
      }
    };
  }
  return {
    async *[Symbol.asyncIterator]() {}
  };
}

async function* parseSseJsonStream(body) {
  const decoder = new TextDecoder('utf-8');
  let buffered = '';
  let eventDataLines = [];

  function flushEvent() {
    if (eventDataLines.length === 0) return null;
    const payloadText = eventDataLines.join('\n').trim();
    eventDataLines = [];
    if (!payloadText || payloadText === '[DONE]') return null;
    try {
      return JSON.parse(payloadText);
    } catch (_error) {
      return null;
    }
  }

  function processLine(line) {
    if (!line) {
      return flushEvent();
    }
    if (line.startsWith('data:')) {
      eventDataLines.push(line.slice(5).trimStart());
    }
    return null;
  }

  const streamBody = iterateStreamChunks(body);
  for await (const chunk of streamBody) {
    const text = typeof chunk === 'string'
      ? chunk
      : decoder.decode(chunk, { stream: true });
    buffered += text;

    while (true) {
      const newlineIdx = buffered.indexOf('\n');
      if (newlineIdx < 0) break;
      const rawLine = buffered.slice(0, newlineIdx);
      buffered = buffered.slice(newlineIdx + 1);
      const normalizedLine = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const parsed = processLine(normalizedLine);
      if (parsed) yield parsed;
    }
  }

  buffered += decoder.decode();
  if (buffered) {
    const parsed = processLine(buffered.endsWith('\r') ? buffered.slice(0, -1) : buffered);
    if (parsed) yield parsed;
  }
  const tail = flushEvent();
  if (tail) yield tail;
}

async function fetchGeminiCodeAssistChatCompletion(options, account, requestJson, timeoutMs = 8000) {
  if (!shouldUseGeminiCodeAssist(options, account)) {
    const err = new Error('gemini_code_assist_not_applicable');
    err.code = 'GEMINI_CODE_ASSIST_NOT_APPLICABLE';
    throw err;
  }
  const { model, originalModel, project, payload, diagnostic } = await buildGeminiCodeAssistGenerateContext(options, account, requestJson, timeoutMs);
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = buildGeminiCodeAssistMethodUrl(baseUrl, 'generateContent');
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistHeaderOptions(options, account, { project })
  );
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method: 'generateContent'
  });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  const candidates = extractGeminiCandidates(json);
  const first = candidates[0] || {};
  const firstParts = Array.isArray(first && first.content && first.content.parts)
    ? first.content.parts
    : [];
  const text = extractGeminiCandidateText(first);
  const imageMarkdown = isImageGenerationModel(originalModel)
    ? extractInlineImageMarkdown(firstParts)
    : '';
  const combinedContent = [text, imageMarkdown].filter(Boolean).join('\n\n');
  const thoughtText = extractGeminiCandidateThoughtText(first);
  const toolCalls = extractGeminiCandidateToolCalls(first);
  const responseToolCalls = summarizeGeminiToolCalls(toolCalls);
  if (responseToolCalls.length > 0) {
    appendGeminiCodeAssistDiagnostic(options || {}, {
      responseToolCalls,
      responseFinishReasons: [String(first && first.finishReason || '').trim()].filter(Boolean)
    });
  }
  const usageMetadata = extractGeminiUsageMetadata(json);
  const finishReason = resolveOpenAIChatFinishReason(
    mapGeminiFinishReason(first && first.finishReason),
    { hasToolCalls: toolCalls.length > 0 }
  );
  return {
    id: `chatcmpl-${String(json && json.traceId || Date.now())}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModel || extractGeminiModelVersion(json, model),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls.length > 0 ? null : combinedContent,
          ...(thoughtText ? { reasoning_content: thoughtText } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        },
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: Number(usageMetadata.promptTokenCount || 0),
      completion_tokens: Number(usageMetadata.candidatesTokenCount || 0),
      total_tokens: Number(usageMetadata.totalTokenCount || 0)
    }
  };
}

async function fetchGeminiCodeAssistGenerateContent(options, account, requestJson, timeoutMs = 8000) {
  if (!shouldUseGeminiCodeAssist(options, account)) {
    const err = new Error('gemini_code_assist_not_applicable');
    err.code = 'GEMINI_CODE_ASSIST_NOT_APPLICABLE';
    throw err;
  }
  const { model, originalModel, project, payload, diagnostic } = await buildGeminiCodeAssistNativeGenerateContext(
    options,
    account,
    requestJson,
    timeoutMs
  );
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = buildGeminiCodeAssistMethodUrl(baseUrl, 'generateContent');
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistHeaderOptions(options, account, { project })
  );
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method: 'generateContent'
  });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (json && typeof json === 'object' && !json.modelVersion && originalModel) {
    json.modelVersion = originalModel;
  }
  const candidates = extractGeminiCandidates(json);
  const toolCalls = candidates.flatMap((candidate) => extractGeminiCandidateToolCalls(candidate));
  if (toolCalls.length > 0) {
    appendGeminiCodeAssistDiagnostic(options || {}, {
      responseToolCalls: summarizeGeminiToolCalls(toolCalls),
      responseFinishReasons: candidates
        .map((candidate) => String(candidate && candidate.finishReason || '').trim())
        .filter(Boolean)
    });
  }
  return json;
}

async function fetchGeminiCodeAssistChatCompletionStream(options, account, requestJson, timeoutMs = 8000) {
  if (!shouldUseGeminiCodeAssist(options, account)) {
    const err = new Error('gemini_code_assist_not_applicable');
    err.code = 'GEMINI_CODE_ASSIST_NOT_APPLICABLE';
    throw err;
  }
  const { model, originalModel, project, payload, diagnostic } = await buildGeminiCodeAssistGenerateContext(options, account, requestJson, timeoutMs);
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = `${buildGeminiCodeAssistMethodUrl(baseUrl, 'streamGenerateContent')}?alt=sse`;
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistHeaderOptions(options, account, { project })
  );
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method: 'streamGenerateContent'
  });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }

  return (async function* streamGeminiChunks() {
    const rawStream = parseSseJsonStream(res.body);
    for await (const envelope of rawStream) {
      const candidates = extractGeminiCandidates(envelope);
      if (!Array.isArray(candidates) || candidates.length === 0) continue;
      const toolCallsByCandidate = candidates.map((candidate) => extractGeminiCandidateToolCalls(candidate));
      const responseToolCalls = summarizeGeminiToolCallsByCandidate(toolCallsByCandidate);
      if (responseToolCalls.length > 0) {
        appendGeminiCodeAssistDiagnostic(options || {}, {
          responseToolCalls,
          responseFinishReasons: candidates
            .map((candidate) => String(candidate && candidate.finishReason || '').trim())
            .filter(Boolean)
        });
      }
      yield {
        model: originalModel || extractGeminiModelVersion(envelope, model),
        candidates,
        toolCallsByCandidate,
        usageMetadata: extractGeminiUsageMetadata(envelope)
      };
    }
  })();
}

async function fetchGeminiCodeAssistGenerateContentStream(options, account, requestJson, timeoutMs = 8000) {
  if (!shouldUseGeminiCodeAssist(options, account)) {
    const err = new Error('gemini_code_assist_not_applicable');
    err.code = 'GEMINI_CODE_ASSIST_NOT_APPLICABLE';
    throw err;
  }
  const { model, originalModel, project, payload, diagnostic } = await buildGeminiCodeAssistNativeGenerateContext(
    options,
    account,
    requestJson,
    timeoutMs
  );
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = `${buildGeminiCodeAssistMethodUrl(baseUrl, 'streamGenerateContent')}?alt=sse`;
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistHeaderOptions(options, account, { project })
  );
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method: 'streamGenerateContent'
  });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }

  const normalizeAntigravityEnvelope = shouldNormalizeAntigravityGenerateContentEnvelope(options, account, diagnostic);
  return (async function* streamGeminiGenerateContent() {
    for await (const envelope of parseSseJsonStream(res.body)) {
      const piece = normalizeAntigravityEnvelope
        ? normalizeGeminiGenerateContentEnvelope(envelope, originalModel)
        : envelope;
      if (piece && typeof piece === 'object' && !piece.modelVersion && originalModel) {
        piece.modelVersion = originalModel;
      }
      const candidates = extractGeminiCandidates(piece);
      const toolCallsByCandidate = candidates.map((candidate) => extractGeminiCandidateToolCalls(candidate));
      const responseToolCalls = summarizeGeminiToolCallsByCandidate(toolCallsByCandidate);
      if (responseToolCalls.length > 0) {
        appendGeminiCodeAssistDiagnostic(options || {}, {
          responseToolCalls,
          responseFinishReasons: candidates
            .map((candidate) => String(candidate && candidate.finishReason || '').trim())
            .filter(Boolean)
        });
      }
      yield piece;
    }
  })();
}

async function fetchModelsForAccount(options, account, timeoutMs = 8000) {
  const provider = String(account && account.provider || 'codex').trim().toLowerCase();
  if (provider === 'opencode') {
    return fetchOpenCodeModels(options, account, timeoutMs, { fetchWithTimeout });
  }
  // claude auth-token 账号是第三方 Anthropic 协议代理(GLM/DeepSeek/JD…)。支持 /v1/models 的代理
  // (如 GLM)可直接探测拿真实模型;不支持的(如 DeepSeek/anthropic 返 404)会抛错被上层捕获、退回
  // 手动注册。此前一律 return [] 导致这些账号在会话里「无可用模型」——现放开走下方通用探测。
  const claudeAuthTokenProxy = provider === 'claude' && isClaudeAuthTokenAccount(account);
  if (
    provider === 'codex'
    && !(account && account.apiKeyMode === true)
    && String(account && account.authType || '').trim().toLowerCase() !== 'api-key'
  ) {
    return fetchCodexModelsForAccount({
      options,
      account,
      fetchWithTimeout,
      timeoutMs
    });
  }
  if (isCodeAssistProvider(provider) && shouldUseGeminiCodeAssist(options, account)) {
    return fetchGeminiCodeAssistModels(options, account, timeoutMs);
  }
  const baseUrl = resolveProviderBaseUrl(options, account);
  const baseUrlHasVersion = /\/v[0-9][^/]*$/i.test(baseUrl);
  // 不同第三方代理的模型列表路径不一致:GLM(base=.../anthropic 不带 /vN)在 <base>/v1/models,
  // DeepSeek(base=https://api.deepseek.com)在 <base>/models。单一硬编码 path 会让其中一家 404
  // →「无可用模型」。策略:先按下方主 path 探,失败(404 等)再回退另一个 path。
  const primaryPath = (claudeAuthTokenProxy && !baseUrlHasVersion)
    ? '/v1/models'
    : ((provider === 'gemini' || provider === 'agy' || provider === 'claude' || baseUrlHasVersion) ? '/models' : '/v1/models');
  const altPath = primaryPath === '/models' ? '/v1/models' : '/models';
  // Anthropic authenticates API keys via x-api-key and OAuth tokens via
  // Authorization: Bearer — never the reverse. The probe must mirror the real
  // request path (upstream-endpoints.js / webui-chat-routes.js both send
  // x-api-key for claude API-key accounts), otherwise a working account fails
  // the probe with a spurious 401 authentication_error.
  const claudeApiKey = provider === 'claude' && isApiCredentialAccount(account);
  const headers = {};
  if (claudeApiKey) {
    headers['x-api-key'] = account.accessToken;
  } else {
    headers.authorization = `Bearer ${account.accessToken}`;
  }
  // Anthropic's API rejects requests without anthropic-version; OAuth tokens
  // additionally need the oauth beta header. (OpenAI-compatible providers
  // ignore these extra headers, so it's safe to always send them for claude.)
  if (provider === 'claude') {
    headers['anthropic-version'] = '2023-06-01';
    // oauth-beta 仅真 OAuth 账号需要;auth-token(第三方代理)不是 OAuth,发了可能被代理拒。
    if (!isApiCredentialAccount(account) && !claudeAuthTokenProxy) {
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    }
  }
  const tryFetchModels = async (url) => {
    const res = await fetchWithTimeout(url, { method: 'GET', headers }, timeoutMs, {
      proxyUrl: options && options.proxyUrl,
      noProxy: options && options.noProxy
    });
    if (!res.ok) {
      const text = await readResponseText(res).catch(() => '');
      const err = new Error(`HTTP ${res.status} ${sanitizeResponseText(text, 160)}`.trim());
      err.status = res.status;
      throw err;
    }
    const json = await readResponseJson(res);
    // 有些第三方代理(如 bigmodel)对【错误路径】返回 HTTP 200 + 错误体
    // {code,msg:"404 NOT_FOUND",success:false}——res.ok 为真但没有 data 数组。必须视为失败
    // 以触发下方另一路径回退,否则会静默返回空列表 → 账号「无可用模型」。
    if (json && json.success === false) {
      throw new Error(String(`${json.code ? json.code + ' ' : ''}${json.msg || 'models_error'}`).trim());
    }
    if (!Array.isArray(json && json.data)) {
      throw new Error('models_response_missing_data');
    }
    return json.data
      .map((x) => String((x && x.id) || '').trim())
      .filter(Boolean);
  };

  // 候选 URL,按序试、返回第一个拿到 data 数组的:
  //  1) base 相对(GLM:模型在 <base=.../anthropic>/v1/models);
  //  2) host 根(DeepSeek:base=.../anthropic 但模型在 host 根 api.deepseek.com/models,不在 /anthropic 下)。
  // 覆盖"路径不在 base 之下"和"200+错误体"两种坑,不再因单一路径 404/空而「无可用模型」。
  const rel = String(baseUrl || '').replace(/\/+$/, '');
  let origin = '';
  try { origin = new URL(baseUrl).origin; } catch (_error) { origin = ''; }
  const candidates = [];
  const addUrl = (u) => { if (u && !candidates.includes(u)) candidates.push(u); };
  addUrl(`${rel}${primaryPath}`);
  addUrl(`${rel}${altPath}`);
  if (origin && origin !== rel) {
    addUrl(`${origin}/v1/models`);
    addUrl(`${origin}/models`);
  }

  let firstError = null;
  for (const url of candidates) {
    try {
      return await tryFetchModels(url);
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }
  throw firstError || new Error('models_response_missing_data');
}

function buildChatCompletionPayload(model, text) {
  const resolvedModel = String(model || '').trim() || 'unknown';
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resolvedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

function writeSseChatCompletion(res, model, text, meta = {}) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const resolvedModel = String(model || '').trim() || 'unknown';
  const sessionId = String(meta && (meta.session_id || meta.sessionId) || '').trim();
  const base = sessionId ? { session_id: sessionId, sessionId } : {};
  const chunks = [
    {
      ...base,
      id,
      object: 'chat.completion.chunk',
      created,
      model: resolvedModel,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    },
    {
      ...base,
      id,
      object: 'chat.completion.chunk',
      created,
      model: resolvedModel,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
    },
    {
      ...base,
      id,
      object: 'chat.completion.chunk',
      created,
      model: resolvedModel,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    }
  ];
  chunks.forEach((c) => {
    res.write(`data: ${JSON.stringify(c)}\n\n`);
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

function isLoopbackUrl(url, serverPort) {
  try {
    const p = new URL(url);
    const host = String(p.hostname || '').trim().toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
    const targetPort = p.port || (p.protocol === 'https:' ? '443' : '80');
    return isLocal && targetPort === String(serverPort);
  } catch (e) {
    return false;
  }
}

module.exports = {
  parseAuthorizationBearer,
  readRequestBody,
  writeJson,
  withTimeout,
  fetchWithTimeout,
  fetchModelsForAccount,
  fetchGeminiCodeAssistChatCompletion,
  fetchGeminiCodeAssistChatCompletionStream,
  fetchGeminiCodeAssistGenerateContent,
  fetchGeminiCodeAssistGenerateContentStream,
  buildChatCompletionPayload,
  writeSseChatCompletion,
  isLoopbackUrl,
  __private: {
    DEFAULT_AGY_CODE_ASSIST_BASE_URL,
    resolveProxyConfig,
    shouldBypassProxy,
    isCodeAssistProvider,
    shouldUseGeminiCodeAssist,
    fetchGeminiCodeAssistAvailableModelDescriptors,
    fetchGeminiCodeAssistModelDescriptors,
    fetchGeminiCodeAssistQuotaModelDescriptors,
    resolveCodeAssistDefaultModel,
    resolveCodeAssistRequestModel,
    resolveProviderBaseUrl,
    buildGeminiCodeAssistMethodUrl,
    buildAgyCodeAssistClientVersion,
    buildAgyCodeAssistUserAgent,
    createGeminiCodeAssistHeaders,
    buildCodeAssistHeaderOptions,
    resolveCodeAssistProviderKey,
    fetchGeminiCodeAssistProject,
    buildGeminiCodeAssistSessionState,
    buildDefaultGeminiCodeAssistGenerationConfig,
    buildGeminiCodeAssistNativeGenerateContext,
    repairNativeGeminiCodeAssistContents,
    getGeminiCodeAssistG1CreditBalance,
    shouldEnableGeminiCodeAssistCredits,
    appendGeminiCodeAssistDiagnostic,
    parseJsonObject,
    parseSseJsonStream,
    extractGeminiCandidates,
    extractGeminiUsageMetadata,
    extractGeminiModelVersion,
    getProxyDispatcher,
    setUndiciHooksForTest: (hooks = {}) => {
      undiciRequireFn = typeof hooks.requireFn === 'function' ? hooks.requireFn : require;
      undiciInstallerFn = typeof hooks.installFn === 'function' ? hooks.installFn : null;
      ProxyAgentClass = null;
      proxyAgentResolved = false;
      undiciInstallAttempted = false;
      proxyDispatcherCache.clear();
    }
  }
};
