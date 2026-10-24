const MENU_SELECTION = 'aih-translation-selection';
const MENU_PAGE = 'aih-translation-page';

const DEFAULTS = { endpoint: 'http://127.0.0.1:9527', token: '', target: 'zh-Hans', mode: 'side-by-side' };

async function settings() {
  const [shared, privateState] = await Promise.all([
    chrome.storage.sync.get({ endpoint: DEFAULTS.endpoint, target: DEFAULTS.target, mode: DEFAULTS.mode }),
    chrome.storage.local.get({ token: DEFAULTS.token })
  ]);
  return { ...DEFAULTS, ...shared, ...privateState };
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

async function translate(request, sendResponse) {
  const config = await settings();
  const endpoint = String(config.endpoint || '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(endpoint)) return sendResponse({ ok: false, error: '请先在扩展设置中填写 AIH Server 地址' });
  const target = String(request.target || config.target || '').trim();
  const targetPolicy = String(request.targetPolicy || 'saved').trim() || 'saved';
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  try {
    const response = await fetch(`${endpoint}/v0/webui/translation/stream`, {
      method: 'POST', headers,
      body: JSON.stringify({ text: request.text, target, targetPolicy, operation: request.operation || 'selection' })
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
      return sendResponse({ ok: false, error: data.detail || `翻译服务返回 HTTP ${response.status}` });
    }
    const reader = response.body?.getReader();
    if (!reader) return sendResponse({ ok: false, error: '翻译服务没有返回流' });
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (data && data !== '[DONE]') {
          try {
            const event = JSON.parse(data);
            if (event.type === 'delta') output += String(event.content || '');
            if (event.type === 'error') return sendResponse({ ok: false, error: event.message || '翻译失败' });
          } catch (_error) { /* ignore incomplete/diagnostic SSE frames */ }
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    return sendResponse({ ok: true, text: output, mode: config.mode === 'replace' ? 'replace' : 'side-by-side' });
  } catch (error) {
    return sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'aih-translate') return false;
  void translate(message, sendResponse);
  return true;
});
