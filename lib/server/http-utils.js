'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

let ProxyAgentClass;
let proxyAgentResolved = false;
let undiciInstallAttempted = false;
let undiciRequireFn = require;
let undiciInstallerFn = null;

const proxyDispatcherCache = new Map();
const DEFAULT_GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_GEMINI_CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
const GEMINI_CODE_ASSIST_AUTH_TYPE = 'oauth-personal';

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
  const agent = new ProxyAgentClass(key);
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

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
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
  }
}

function isGeminiCodeAssistBaseUrl(baseUrl) {
  const text = String(baseUrl || '').trim().toLowerCase();
  return text.includes('cloudcode-pa.googleapis.com');
}

function shouldUseGeminiCodeAssist(options, account) {
  const authType = String(account && account.authType || '').trim().toLowerCase();
  if (authType === GEMINI_CODE_ASSIST_AUTH_TYPE) return true;
  const configured = String(options && options.geminiBaseUrl || '').trim();
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

function resolveProviderBaseUrl(options, account) {
  const provider = String(account && account.provider || 'codex').trim().toLowerCase();
  if (provider === 'gemini') {
    return normalizeGeminiBaseUrl(options, account);
  }
  if (provider === 'claude') {
    const fromAccount = String(account && account.baseUrl || '').trim();
    return (fromAccount || String(options && options.claudeBaseUrl || '').trim()).replace(/\/+$/, '');
  }
  return String(options && options.codexBaseUrl || '').trim().replace(/\/+$/, '');
}

function buildGeminiCodeAssistMethodUrl(baseUrl, method) {
  let normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalized) normalized = DEFAULT_GEMINI_CODE_ASSIST_BASE_URL;
  if (!/\/v[0-9][^/:]*$/i.test(normalized)) normalized = `${normalized}/v1internal`;
  return `${normalized}:${method}`;
}

function createGeminiCodeAssistHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json'
  };
}

async function fetchGeminiCodeAssistProject(options, account, timeoutMs = 8000) {
  if (account && account.codeAssistProject) return String(account.codeAssistProject).trim();
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = buildGeminiCodeAssistMethodUrl(baseUrl, 'loadCodeAssist');
  const payload = {
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI'
    }
  };
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: createGeminiCodeAssistHeaders(account.accessToken),
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
  const project = String(json && json.cloudaicompanionProject || '').trim();
  if (project && account) account.codeAssistProject = project;
  return project;
}

async function fetchGeminiCodeAssistModels(options, account, timeoutMs = 8000) {
  const fromSnapshot = Array.isArray(account && account.availableModels)
    ? account.availableModels
      .map((id) => String(id || '').trim())
      .filter(Boolean)
    : [];
  if (fromSnapshot.length > 0) {
    return Array.from(new Set(fromSnapshot)).sort();
  }

  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = buildGeminiCodeAssistMethodUrl(baseUrl, 'retrieveUserQuota');
  let project = '';
  try {
    project = await fetchGeminiCodeAssistProject(options, account, timeoutMs);
  } catch (_error) {}

  async function doFetch(bodyPayload) {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: createGeminiCodeAssistHeaders(account.accessToken),
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
    const buckets = Array.isArray(json && json.buckets) ? json.buckets : [];
    const ids = buckets
      .map((item) => String(item && item.modelId || '').trim().replace(/_vertex$/i, ''))
      .filter(Boolean);
    return Array.from(new Set(ids)).sort();
  }

  if (project) {
    try {
      return await doFetch({ project });
    } catch (_error) {}
  }
  return doFetch({});
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

function normalizeOpenAIMessagesForGemini(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const contents = [];
  const systemParts = [];
  list.forEach((msg) => {
    const role = String(msg && msg.role || '').trim().toLowerCase();
    const text = toGeminiTextPart(msg && msg.content);
    if (!text) return;
    if (role === 'system') {
      systemParts.push(text);
      return;
    }
    const geminiRole = role === 'assistant' ? 'model' : 'user';
    contents.push({
      role: geminiRole,
      parts: [{ text }]
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
    .map((part) => String(part && part.text || '').trim())
    .filter(Boolean)
    .join('\n');
  return text;
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
  parts.forEach((part, idx) => {
    if (!part || typeof part !== 'object' || !part.functionCall) return;
    const fn = part.functionCall || {};
    const name = String(fn.name || '').trim();
    if (!name) return;
    out.push({
      id: `call_${idx + 1}`,
      type: 'function',
      function: {
        name,
        arguments: stringifyGeminiFunctionArgs(fn.args)
      }
    });
  });
  return out;
}

function normalizeOpenAIToolsForGemini(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const declarations = [];
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
      parameters
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

async function buildGeminiCodeAssistGenerateContext(options, account, requestJson, timeoutMs) {
  const project = await fetchGeminiCodeAssistProject(options, account, timeoutMs);
  if (!project) {
    throw new Error('gemini_code_assist_project_unavailable');
  }
  const model = String(
    requestJson && requestJson.model
    || (Array.isArray(account && account.availableModels) ? account.availableModels[0] : '')
    || 'gemini-2.5-flash'
  ).trim();
  const normalized = normalizeOpenAIMessagesForGemini(requestJson && requestJson.messages);
  const generationConfig = {};
  const maxTokens = Number(requestJson && requestJson.max_tokens);
  const temperature = Number(requestJson && requestJson.temperature);
  const topP = Number(requestJson && requestJson.top_p);
  if (Number.isFinite(maxTokens) && maxTokens > 0) generationConfig.maxOutputTokens = Math.round(maxTokens);
  if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
  if (Number.isFinite(topP)) generationConfig.topP = topP;
  if (Array.isArray(requestJson && requestJson.stop) && requestJson.stop.length > 0) {
    generationConfig.stopSequences = requestJson.stop.map((x) => String(x || '').trim()).filter(Boolean);
  } else if (typeof (requestJson && requestJson.stop) === 'string') {
    generationConfig.stopSequences = [String(requestJson.stop).trim()].filter(Boolean);
  }
  const functionDeclarations = normalizeOpenAIToolsForGemini(requestJson && requestJson.tools);
  const toolConfig = functionDeclarations.length > 0
    ? normalizeOpenAIToolChoiceForGemini(requestJson && requestJson.tool_choice)
    : undefined;
  return {
    model,
    payload: {
      model,
      project,
      user_prompt_id: `aih-${Date.now()}`,
      request: {
        contents: normalized.contents,
        systemInstruction: normalized.systemInstruction,
        generationConfig,
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
        toolConfig,
        session_id: ''
      }
    }
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
  const { model, payload } = await buildGeminiCodeAssistGenerateContext(options, account, requestJson, timeoutMs);
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = buildGeminiCodeAssistMethodUrl(baseUrl, 'generateContent');
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: createGeminiCodeAssistHeaders(account.accessToken),
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
  const text = extractGeminiCandidateText(first);
  const toolCalls = extractGeminiCandidateToolCalls(first);
  const usageMetadata = extractGeminiUsageMetadata(json);
  const finishReason = toolCalls.length > 0 ? 'tool_calls' : mapGeminiFinishReason(first && first.finishReason);
  return {
    id: `chatcmpl-${String(json && json.traceId || Date.now())}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: extractGeminiModelVersion(json, model),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls.length > 0 ? null : text,
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

async function fetchGeminiCodeAssistChatCompletionStream(options, account, requestJson, timeoutMs = 8000) {
  if (!shouldUseGeminiCodeAssist(options, account)) {
    const err = new Error('gemini_code_assist_not_applicable');
    err.code = 'GEMINI_CODE_ASSIST_NOT_APPLICABLE';
    throw err;
  }
  const { model, payload } = await buildGeminiCodeAssistGenerateContext(options, account, requestJson, timeoutMs);
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = `${buildGeminiCodeAssistMethodUrl(baseUrl, 'streamGenerateContent')}?alt=sse`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: createGeminiCodeAssistHeaders(account.accessToken),
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
      yield {
        model: extractGeminiModelVersion(envelope, model),
        candidates,
        toolCallsByCandidate: candidates.map((candidate) => extractGeminiCandidateToolCalls(candidate)),
        usageMetadata: extractGeminiUsageMetadata(envelope)
      };
    }
  })();
}

async function fetchModelsForAccount(options, account, timeoutMs = 8000) {
  const provider = String(account && account.provider || 'codex').trim().toLowerCase();
  if (provider === 'gemini' && shouldUseGeminiCodeAssist(options, account)) {
    return fetchGeminiCodeAssistModels(options, account, timeoutMs);
  }
  const baseUrl = resolveProviderBaseUrl(options, account);
  const path = (provider === 'gemini' || provider === 'claude') ? '/models' : '/v1/models';
  const url = `${baseUrl}${path}`;
  const headers = {
    authorization: `Bearer ${account.accessToken}`
  };
  const res = await fetchWithTimeout(url, { method: 'GET', headers }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
  }
  const json = await res.json();
  const arr = Array.isArray(json && json.data) ? json.data : [];
  return arr
    .map((x) => String((x && x.id) || '').trim())
    .filter(Boolean);
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

function writeSseChatCompletion(res, model, text) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const resolvedModel = String(model || '').trim() || 'unknown';
  const chunks = [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: resolvedModel,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: resolvedModel,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
    },
    {
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

module.exports = {
  parseAuthorizationBearer,
  readRequestBody,
  writeJson,
  withTimeout,
  fetchWithTimeout,
  fetchModelsForAccount,
  fetchGeminiCodeAssistChatCompletion,
  fetchGeminiCodeAssistChatCompletionStream,
  buildChatCompletionPayload,
  writeSseChatCompletion,
  __private: {
    resolveProxyConfig,
    shouldBypassProxy,
    shouldUseGeminiCodeAssist,
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
