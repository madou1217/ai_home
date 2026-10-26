const MENU_SELECTION = 'aih-translation-selection';
const MENU_PAGE = 'aih-translation-page';

const DEFAULTS = { endpoint: 'http://127.0.0.1:9527', token: '', target: 'zh-Hans', mode: 'side-by-side', autoCopy: false };
let clipboardQueue = Promise.resolve();
const translationRequests = new Map();

function taskKey(sender, operationId) {
  return `${sender.tab?.id}:${sender.frameId || 0}:${operationId}`;
}

function cancelTask(key) {
  for (const controller of translationRequests.get(key) || []) controller.abort();
  translationRequests.delete(key);
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
    chrome.storage.sync.get({ endpoint: DEFAULTS.endpoint, target: DEFAULTS.target, mode: DEFAULTS.mode, autoCopy: DEFAULTS.autoCopy }),
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
});

async function translate(request, sendResponse, sender) {
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
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    const response = await fetch(`${endpoint}/v0/webui/translation/stream`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ text: request.text, source: request.source || 'auto', target, targetPolicy, operation: request.operation || 'selection' })
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
    let sawStart = false;
    let sawDone = false;
    let streamError = null;
    const handleEvent = (event) => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'start') {
        sawStart = true;
        streamMeta = {
          from: String(event.from || ''),
          to: String(event.to || ''),
          detected: String(event.detected || ''),
          fromLabel: String(event.fromLabel || ''),
          toLabel: String(event.toLabel || ''),
          detectionConfidence: String(event.detectionConfidence || '')
        };
      } else if (event.type === 'delta') {
        output += String(event.content || '');
      } else if (event.type === 'done') {
        sawDone = true;
        if (event.text !== undefined && event.text !== null) output = String(event.text);
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
    if (!sawStart || !sawDone) return sendResponse({ ok: false, error: '翻译流未完成，请重试' });
    if (!output.trim()) return sendResponse({ ok: false, error: '翻译服务返回空结果' });
    const canAutoCopy = config.autoCopy === true
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
