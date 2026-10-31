/* global chrome, AbortController, setTimeout, clearTimeout, fetch, TextDecoder, URL */
import { createTranslationCache, translationHash } from './cache.js';
const MENU_SELECTION = 'aih-translation-selection';
const MENU_PAGE = 'aih-translation-page';

const DEFAULTS = { endpoint: 'http://127.0.0.1:9527', token: '', target: 'zh-Hans', mode: 'side-by-side', autoCopy: false, model: '', provider: '', concurrency: 3, theme: 'plain' };
let clipboardQueue = Promise.resolve();
const translationRequests = new Map();
const resultCache = createTranslationCache(chrome.storage.local);
const operationProfiles = new Map();
const pendingPages = new Map();
const cancelledOperations = new Map();
const pageRevisions = new Map();
const pageOperations = new Map();
let cacheGeneration = 0;
let nextPageRevision = 0;

function advancePageRevision(url) {
  const revision = ++nextPageRevision;
  pageRevisions.delete(url); pageRevisions.set(url, revision);
  while (pageRevisions.size > 256) pageRevisions.delete(pageRevisions.keys().next().value);
  return revision;
}

function pageURL(sender) {
  try { const url = new URL(sender.url || ''); if (!/^https?:$/.test(url.protocol)) return ''; url.hash = ''; return url.href; } catch { return ''; }
}

async function resolveCacheProfile(config, sender, operationId, operation = 'selection') {
  const endpoint = String(config.endpoint || '').replace(/\/$/, '');
  const base = await translationHash(JSON.stringify(['translation-v1', endpoint, config.token || '', config.model || '', config.provider || '', config.target, config.mode]));
  if (config.model) return { profile: base, model: config.model, provider: config.provider || '' };
  const operationKey = operationId ? `${taskKey(sender, operationId)}:${operation}:${base}` : '';
  if (operationKey && operationProfiles.has(operationKey)) return operationProfiles.get(operationKey);
  const lookup = (async () => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
      const responses = await Promise.all(['models', 'settings'].map((resource) => fetch(`${endpoint}/v0/webui/translation/${resource}`, { headers, signal: controller.signal })));
      if (responses.some((response) => !response.ok)) return null;
      const [catalog, preferences] = await Promise.all(responses.map((response) => response.json()));
      const routes = preferences.settings?.routes || [];
      const operationRoutes = routes.filter((route) => route && route.enabled !== false
        && (Array.isArray(route.operations) ? route.operations : ['selection']).includes(operation))
        .sort((left, right) => (Number(left.priority) || 0) - (Number(right.priority) || 0));
      const selected = operationRoutes.find((route) => String(route.model || '').trim());
      // A nonempty route chain with no matching operation is not the catalog
      // default. Leave legacy/unknown migration semantics uncached safely.
      if (routes.length && !selected) return null;
      const model = String(selected?.model || catalog.defaultModel || '').trim();
      const provider = String(selected ? selected.modelProvider || '' : catalog.defaultProvider || '').trim();
      const routeProvider = String(selected?.provider || '').trim();
      if (!model) return null;
      const profile = await translationHash(JSON.stringify([base, model, provider, operationRoutes]));
      return { profile, model, provider, routeProvider };
    } catch { return null; }
    finally { clearTimeout(timer); }
  })();
  if (operationKey) {
    operationProfiles.set(operationKey, lookup);
    while (operationProfiles.size > 128) operationProfiles.delete(operationProfiles.keys().next().value);
  }
  return lookup;
}

async function rememberPage(sender, operationId, profile, target) {
  const pending = pendingPages.get(taskKey(sender, operationId));
  if (!pending || pending.profile !== profile || pending.target !== target || pending.generation !== cacheGeneration) return;
  const isCurrent = () => pageRevisions.get(pending.url) === pending.revision && pendingPages.get(taskKey(sender, operationId)) === pending && pending.generation === cacheGeneration;
  if (isCurrent()) await resultCache.setPage(await translationHash(pending.url), pending, isCurrent).catch(() => {});
}

async function pageState(message, sender) {
  const url = pageURL(sender);
  if (!url) return { ok: false, state: null };
  if (message.action === 'clear') {
    const currentOperation = pageOperations.get(url);
    if (message.operationId && currentOperation && currentOperation !== taskKey(sender, message.operationId)) return { ok: true, state: null };
    advancePageRevision(url);
    pageOperations.delete(url);
    for (const [key, pending] of pendingPages) if (pending.url === url) pendingPages.delete(key);
    await resultCache.clearPage(await translationHash(url));
    return { ok: true, state: null };
  }
  const operationKey = message.operationId ? taskKey(sender, message.operationId) : '';
  if (message.action === 'set' && operationKey && cancelledOperations.has(operationKey)) return { ok: false, state: null };
  const cancelEpoch = operationKey ? (cancelledOperations.get(operationKey) || 0) : 0;
  const revision = message.action === 'set' ? advancePageRevision(url) : pageRevisions.get(url) || 0;
  const generation = cacheGeneration;
  const preparing = message.action === 'set' && operationKey ? { url, revision, generation } : null;
  if (preparing) {
    pendingPages.set(operationKey, preparing); pageOperations.set(url, operationKey);
    while (pendingPages.size > 128) pendingPages.delete(pendingPages.keys().next().value);
    while (pageOperations.size > 256) pageOperations.delete(pageOperations.keys().next().value);
  }
  if (message.action === 'get' && !await resultCache.getPage(await translationHash(url))) return { ok: true, state: null };
  const config = await settings();
  const context = await resolveCacheProfile(config, sender, message.operationId, 'page');
  if (operationKey && cancelEpoch !== (cancelledOperations.get(operationKey) || 0)) return { ok: false, state: null };
  if (preparing && pendingPages.get(operationKey) !== preparing) return { ok: false, state: null };
  if (!context || generation !== cacheGeneration || (pageRevisions.get(url) || 0) !== revision) {
    if (preparing && pendingPages.get(operationKey) === preparing) pendingPages.delete(operationKey);
    return { ok: true, state: null };
  }
  if (message.action === 'get') {
    const state = await resultCache.getPage(await translationHash(url), context.profile);
    return { ok: true, state: generation === cacheGeneration && (pageRevisions.get(url) || 0) === revision ? state : null };
  }
  if (message.action !== 'set' || !message.operationId) return { ok: false, state: null };
  const target = String(message.target || config.target || '').trim();
  if (!target || target.length > 100) return { ok: false, state: null };
  const mode = (message.mode || config.mode) === 'replace' ? 'replace' : 'side-by-side';
  pendingPages.set(operationKey, { url, revision, generation, target, mode, profile: context.profile });
  while (pendingPages.size > 128) pendingPages.delete(pendingPages.keys().next().value);
  return { ok: true, profile: context.profile };
}

function taskKey(sender, operationId) {
  return `${sender.tab?.id}:${sender.frameId || 0}:${operationId}`;
}

function cancelTask(key) {
  for (const controller of translationRequests.get(key) || []) controller.abort();
  translationRequests.delete(key);
  pendingPages.delete(key);
  cancelledOperations.set(key, (cancelledOperations.get(key) || 0) + 1);
  while (cancelledOperations.size > 256) cancelledOperations.delete(cancelledOperations.keys().next().value);
}

function translationFailure(status, message, errorCode = '') {
  const code = Number(status) || 0;
  return {
    ok: false,
    status: code,
    code: errorCode,
    fatal: code === 0 || code === 400 || code === 401 || code === 403 || code === 404 || code === 429 || code >= 500,
    error: message || `翻译服务返回 HTTP ${code}`
  };
}

async function settings() {
  const [shared, privateState] = await Promise.all([
    chrome.storage.sync.get({ endpoint: DEFAULTS.endpoint, target: DEFAULTS.target, mode: DEFAULTS.mode, autoCopy: DEFAULTS.autoCopy, model: DEFAULTS.model, provider: DEFAULTS.provider, concurrency: DEFAULTS.concurrency, theme: DEFAULTS.theme }),
    chrome.storage.local.get({ token: DEFAULTS.token })
  ]);
  return { ...DEFAULTS, ...shared, ...privateState };
}

async function ensureClipboardDocument() {
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
    throw new Error('当前浏览器不支持扩展剪贴板文档');
  }
  const documentUrl = chrome.runtime.getURL('offscreen.html');
  const contexts = typeof chrome.runtime.getContexts === 'function'
    ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [documentUrl] })
    : [];
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: '为扩展的手动和自动翻译复制提供稳定的扩展上下文'
  });
}

function writeClipboard(text) {
  const value = String(text || '');
  if (!value.trim()) return Promise.resolve({ ok: false, error: '没有可复制的译文' });
  const operation = clipboardQueue.then(async () => {
    await ensureClipboardDocument();
    const result = await chrome.runtime.sendMessage({ type: 'aih-offscreen-clipboard-write', text: value });
    if (!result?.ok) throw new Error(result?.error || '剪贴板写入失败');
    return { ok: true };
  });
  clipboardQueue = operation.catch(() => {});
  return operation.catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}

function ensureMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SELECTION, title: 'AIH 翻译选中内容', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: 'AIH 翻译当前页面', contexts: ['page'] });
  });
}

chrome.runtime.onInstalled.addListener(ensureMenus);
chrome.runtime.onStartup.addListener(ensureMenus);
ensureMenus();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: info.menuItemId === MENU_PAGE ? 'aih-translate-page' : 'aih-translate-selection', text: info.selectionText || '' });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'translate-selection' && tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'aih-translate-selection' });
  // One key flips the page between translated and original (the 沉浸式翻译 Alt+A habit).
  if (command === 'toggle-page' && tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'aih-toggle-page' }).catch(() => {});
});

// Sites the user chose to always translate. Hostnames only, stored in sync storage
// so the choice follows the browser profile; no page content is stored here.
const AUTO_SITES_KEY = 'autoTranslateSites';
async function readAutoSites() {
  const stored = await chrome.storage.sync.get(AUTO_SITES_KEY);
  return Array.isArray(stored[AUTO_SITES_KEY]) ? stored[AUTO_SITES_KEY].filter((host) => typeof host === 'string') : [];
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'aih-auto-site') return false;
  (async () => {
    let host = String(message.host || '').trim().toLowerCase();
    if (!host && sender.tab?.url) { try { host = new URL(sender.tab.url).hostname; } catch (_error) { host = ''; } }
    const sites = await readAutoSites();
    if (!host || !/^[a-z0-9.-]{1,253}$/.test(host)) return sendResponse({ ok: false, enabled: false, sites });
    if (message.action === 'set') {
      const next = message.enabled ? [...new Set([...sites, host])].slice(-200) : sites.filter((item) => item !== host);
      await chrome.storage.sync.set({ [AUTO_SITES_KEY]: next });
      return sendResponse({ ok: true, enabled: next.includes(host) });
    }
    return sendResponse({ ok: true, enabled: sites.includes(host) });
  })().catch(() => sendResponse({ ok: false, enabled: false }));
  return true;
});

async function translate(request, sendResponse, sender) {
  const generation = cacheGeneration;
  const key = taskKey(sender, request.operationId);
  const controller = new AbortController();
  const pending = translationRequests.get(key) || new Set();
  pending.add(controller);
  translationRequests.set(key, pending);
  const timeout = setTimeout(() => controller.abort(new Error('翻译请求超时，请检查服务后重试')), 60000);
  try {
    const config = await settings();
    if (controller.signal.aborted) throw controller.signal.reason;
    const endpoint = String(config.endpoint || '').replace(/\/$/, '');
    if (!/^https?:\/\//.test(endpoint)) return sendResponse({ ok: false, fatal: true, error: '请先在扩展设置中填写 AIH Server 地址' });
    const target = String(request.target || config.target || '').trim();
    const targetPolicy = String(request.targetPolicy || 'saved').trim() || 'saved';
    const cacheContext = await resolveCacheProfile(config, sender, request.operationId, request.operation || 'selection');
    const cacheEligible = targetPolicy !== 'confirm';
    const cacheKey = cacheEligible && cacheContext ? await translationHash(JSON.stringify([cacheContext.profile, request.source || 'auto', target, request.operation || 'selection', await translationHash(String(request.text || ''))])) : '';
    if (controller.signal.aborted) throw controller.signal.reason;
    if (cacheKey && generation === cacheGeneration) {
      const cached = await resultCache.read(cacheKey).catch(() => null);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (cached && generation === cacheGeneration) {
        if (request.operation === 'page') await rememberPage(sender, request.operationId, cacheContext.profile, target);
        if (controller.signal.aborted) throw controller.signal.reason;
        return sendResponse({ ok: true, ...cached, cached: true, mode: config.mode === 'replace' ? 'replace' : 'side-by-side', autoCopy: request.restoring !== true && config.autoCopy === true && Boolean(cached.meta?.from && cached.meta?.to && cached.meta.from !== cached.meta.to) });
      }
    }
    if (request.restoring === true) {
      return sendResponse({ ok: false, cacheMiss: true, error: '此段暂无本机缓存，请点击继续翻译' });
    }
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    const response = await fetch(`${endpoint}/v0/webui/translation/stream`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ text: request.text, source: request.source || 'auto', target, targetPolicy, operation: request.operation || 'selection', ...(config.model ? { model: config.model, provider: config.provider || '' } : {}) })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 && data?.error === 'translation_target_confirmation_required') {
        return sendResponse({
          ok: false,
          confirmation: {
            code: data.error,
            message: data.detail || '请确认目标语言',
            detected: String(data.detected || ''),
            confidence: String(data.confidence || 'low'),
            suggestedTargets: Array.isArray(data.suggestedTargets) ? data.suggestedTargets : [],
            target
          }
        });
      }
      const authRequired = response.status === 401 || response.status === 403;
      return sendResponse(translationFailure(response.status, authRequired ? '连接未授权，请在扩展设置中填写此 AIH Server 的管理密钥' : data.detail, data.error));
    }
    const reader = response.body?.getReader();
    if (!reader) return sendResponse({ ok: false, error: '翻译服务没有返回流' });
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';
    let streamMeta = null;
    let completedModel = '';
    let completedProvider = '';
    let completedRouteProvider = '';
    let sawStart = false;
    let sawDone = false;
    let streamError = null;
    let lastProgressAt = 0;
    let progressSequence = 0;
    let publishedText = '';
    const publishProgress = (force = false) => {
      if (!['selection', 'page'].includes(request.operation) || !sender.tab?.id || controller.signal.aborted) return;
      if (!force && Date.now() - lastProgressAt < 70) return;
      lastProgressAt = Date.now();
      publishedText = output;
      void chrome.tabs.sendMessage(sender.tab.id, {
        type: 'aih-translation-progress', operationId: request.operationId,
        ...(request.segmentId ? { segmentId: request.segmentId } : {}),
        sequence: ++progressSequence, text: output, meta: streamMeta
      }, { frameId: sender.frameId || 0 }).catch(() => {});
    };
    const handleEvent = (event) => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'start') {
        sawStart = true;
        completedModel = String(event.model || '');
        completedProvider = String(event.provider || '');
        streamMeta = {
          from: String(event.from || ''),
          to: String(event.to || ''),
          detected: String(event.detected || ''),
          fromLabel: String(event.fromLabel || ''),
          toLabel: String(event.toLabel || ''),
          detectionConfidence: String(event.detectionConfidence || '')
        };
        publishProgress(true);
      } else if (event.type === 'attempt_start') {
        completedModel = String(event.model || completedModel);
        completedProvider = String(event.modelProvider || '');
        completedRouteProvider = String(event.provider || '');
      } else if (event.type === 'delta') {
        output += String(event.content || '');
        publishProgress(!publishedText);
      } else if (event.type === 'done') {
        sawDone = true;
        if (event.text !== undefined && event.text !== null) output = String(event.text);
        publishProgress(true);
      } else if (event.type === 'error') {
        streamError = translationFailure(event.status, event.message || '翻译失败', event.code);
      }
    };
    const processBlock = (block) => {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') return;
      try {
        handleEvent(JSON.parse(data));
      } catch { /* 忽略注释或不完整的诊断帧；最终仍要求 start + done。 */ }
    };
    const processBuffer = (flush = false) => {
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        processBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
      if (flush && buffer.trim()) {
        processBlock(buffer);
        buffer = '';
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      processBuffer(done);
      if (streamError) { await reader.cancel().catch(() => {}); break; }
      if (done) break;
    }
    if (streamError) return sendResponse(streamError);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!sawStart || !sawDone) return sendResponse({ ok: false, error: '翻译流未完成，请重试' });
    if (!output.trim()) return sendResponse({ ok: false, error: '翻译服务返回空结果' });
    // A fallback that actually used another model must not masquerade as the
    // configured default on the next operation's cache lookup.
    const matchesModel = cacheContext && completedModel === cacheContext.model
      && (!cacheContext.provider || completedProvider === cacheContext.provider)
      && (!cacheContext.routeProvider || completedRouteProvider === cacheContext.routeProvider);
    let cacheStored = false;
    if (cacheKey && matchesModel && generation === cacheGeneration) {
      cacheStored = await resultCache.write(cacheKey, { text: output, meta: streamMeta }, () => !controller.signal.aborted && generation === cacheGeneration).catch(() => false);
    }
    if (request.operation === 'page' && cacheStored && cacheContext && !controller.signal.aborted && generation === cacheGeneration) await rememberPage(sender, request.operationId, cacheContext.profile, target);
    if (controller.signal.aborted) throw controller.signal.reason;
    const canAutoCopy = request.restoring !== true && config.autoCopy === true
      && Boolean(streamMeta?.from && streamMeta?.to && streamMeta.from !== streamMeta.to);
    return sendResponse({
      ok: true,
      text: output,
      mode: config.mode === 'replace' ? 'replace' : 'side-by-side',
      autoCopy: canAutoCopy,
      meta: streamMeta
    });
  } catch (error) {
    return sendResponse({ ok: false, fatal: true, error: controller.signal.aborted ? controller.signal.reason?.message || '翻译已停止' : `无法连接翻译服务：${error instanceof Error ? error.message : String(error)}` });
  } finally {
    clearTimeout(timeout);
    pending.delete(controller);
    if (!pending.size && translationRequests.get(key) === pending) translationRequests.delete(key);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'aih-translation-preferences') {
    void settings().then((config) => sendResponse({ ok: true, concurrency: Math.max(1, Math.min(8, Math.floor(Number(config.concurrency) || 3))), target: config.target, theme: config.theme }));
    return true;
  }
  if (message?.type === 'aih-page-translation-state') {
    void pageState(message, sender).then(sendResponse).catch(() => sendResponse({ ok: false, state: null }));
    return true;
  }
  if (message?.type === 'aih-translation-cache') {
    // Cache administration belongs to extension pages, never website scripts.
    if (!String(sender.url || '').startsWith(chrome.runtime.getURL(''))) { sendResponse({ ok: false }); return false; }
    if (message.action === 'clear') {
      cacheGeneration += 1; pendingPages.clear(); operationProfiles.clear();
      void resultCache.clear().then(() => resultCache.status()).then((status) => sendResponse({ ok: true, ...status })).catch(() => sendResponse({ ok: false }));
    } else void resultCache.status().then((status) => sendResponse({ ok: true, ...status })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'aih-cancel-translation') {
    cancelTask(taskKey(sender, message.operationId));
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'aih-open-translation-settings') {
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'aih-copy-text') {
    void writeClipboard(message.text).then(sendResponse);
    return true;
  }
  if (message?.type !== 'aih-translate') return false;
  void translate(message, sendResponse, sender);
  return true;
});
