const MENU_SELECTION = 'aih-translation-selection';
const MENU_PAGE = 'aih-translation-page';

const DEFAULTS = { endpoint: 'http://127.0.0.1:9527', token: '', target: 'zh-Hans', mode: 'side-by-side' };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
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
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  try {
    const response = await fetch(`${endpoint}/v0/webui/translation/stream`, {
      method: 'POST', headers,
      body: JSON.stringify({ text: request.text, target: config.target, targetPolicy: 'saved', operation: request.operation || 'selection' })
    });
    if (!response.ok) return sendResponse({ ok: false, error: `翻译服务返回 HTTP ${response.status}` });
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
    return sendResponse({ ok: true, text: output });
  } catch (error) {
    return sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'aih-translate') return false;
  void translate(message, sendResponse);
  return true;
});
