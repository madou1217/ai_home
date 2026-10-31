/* global chrome, document, URL, AbortController, setTimeout, clearTimeout, fetch */
const defaults = { endpoint: 'http://127.0.0.1:9527', token: '', target: 'zh-Hans', mode: 'side-by-side', autoCopy: false, model: '', provider: '', concurrency: 3, theme: 'plain' };
const field = (id) => document.getElementById(id);
const readingThemes = globalThis.AIHReadingThemes;
for (const theme of readingThemes.list) {
  const option = document.createElement('option'); option.value = theme.id; option.textContent = theme.label; field('theme').append(option);
}
const preview = readingThemes.mount(field('theme-preview'));
const sample = document.createElement('div'); sample.className = 'content translation'; sample.dir = 'auto';
sample.textContent = '让译文自然融入阅读。长段落会随页面宽度换行，保留清晰的行距与原文结构。\nRead comfortably, one paragraph at a time.';
preview.body.append(sample);
function updateThemePreview() {
  const theme = readingThemes.normalize(field('theme').value); preview.setTheme(theme);
  field('theme-description').textContent = readingThemes.list.find((item) => item.id === theme).description;
}
field('theme').onchange = updateThemePreview;
updateThemePreview();
let modelCatalog = [];
let catalogRequest = 0;
let catalogController = null;
let selectedModel = { model: '', provider: '' };

async function updateCacheStatus(action = 'status') {
  const button = field('clear-cache');
  button.disabled = true;
  if (action === 'clear') { button.textContent = '清除中…'; field('cache-status').textContent = '正在清除本机缓存…'; }
  try {
    const result = await chrome.runtime.sendMessage({ type: 'aih-translation-cache', action });
    if (!result?.ok) throw new Error('暂时无法读取缓存，请重试');
    const size = result.bytes < 1024 * 1024 ? `${Math.ceil(result.bytes / 1024)} KB` : `${(result.bytes / 1024 / 1024).toFixed(1)} MB`;
    field('cache-status').textContent = action === 'clear' ? '缓存与页面恢复记录已清除' : `${result.entries} 段译文 · ${size} · ${result.pages} 个可恢复页面`;
  } catch (error) { field('cache-status').textContent = error.message || '缓存操作失败，请重试'; }
  finally { button.disabled = false; button.textContent = '清除缓存'; }
}
field('clear-cache').onclick = () => void updateCacheStatus('clear');
void updateCacheStatus();

function showManual() { field('manual-fields').hidden = field('model').value !== 'manual'; }
function selection() {
  if (field('model').value === 'manual') return { model: field('manual-model').value.trim(), provider: field('manual-provider').value.trim() };
  const item = modelCatalog[Number(field('model').value)];
  return field('model').value && item ? { model: item.id, provider: item.provider || '' } : { model: '', provider: '' };
}
function validEndpoint() {
  const url = new URL(field('endpoint').value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入 http 或 https 服务地址，不要在地址中包含密钥');
  return url.href.replace(/\/$/, '');
}
function fillModels(data) {
  modelCatalog = Array.isArray(data.models) ? data.models : [];
  const select = field('model'); select.replaceChildren();
  const automatic = document.createElement('option'); automatic.value = ''; automatic.textContent = data.defaultModel ? `Server 默认 · ${data.defaultModel}` : '使用 Server 默认模型'; select.append(automatic);
  modelCatalog.forEach((model, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = `${model.id}${model.providerLabel || model.provider ? ` · ${model.providerLabel || model.provider}` : ''}`; select.append(option); });
  const manual = document.createElement('option'); manual.value = 'manual'; manual.textContent = '手动指定模型…'; select.append(manual);
  const matched = modelCatalog.findIndex((model) => model.id === selectedModel.model && (model.provider || '') === selectedModel.provider);
  select.value = selectedModel.model ? matched >= 0 ? String(matched) : 'manual' : '';
  field('manual-model').value = selectedModel.model; field('manual-provider').value = selectedModel.provider; showManual();
}
async function refreshModels() {
  selectedModel = selection();
  const requestId = ++catalogRequest; catalogController?.abort(); catalogController = new AbortController();
  const controller = catalogController;
  const timer = setTimeout(() => controller.abort(), 10000);
  field('refresh-models').disabled = true; field('refresh-models').textContent = '连接中…';
  field('connection-state').textContent = '正在连接'; field('model-status').textContent = '正在读取可选模型…';
  try {
    const endpoint = validEndpoint(); const token = field('token').value.trim();
    const response = await fetch(`${endpoint}/v0/webui/translation/models`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '连接未授权，请检查管理密钥' : `服务返回 HTTP ${response.status}`);
    const data = await response.json(); if (requestId !== catalogRequest) return;
    selectedModel = selection(); fillModels(data); field('connection-state').textContent = '已连接';
    field('model-status').textContent = `${modelCatalog.length} 个可选模型 · 默认跟随 Server，也可手动指定`;
  } catch (error) {
    if (requestId !== catalogRequest) return;
    field('connection-state').textContent = '未连接'; field('model-status').textContent = `${error.name === 'AbortError' ? '连接超时，请检查服务地址' : error.message}。仍可保存设置或手动指定模型。`;
  } finally {
    clearTimeout(timer);
    if (requestId === catalogRequest) { field('refresh-models').disabled = false; field('refresh-models').textContent = '刷新模型'; }
  }
}
field('model').onchange = () => { showManual(); selectedModel = selection(); field('status').textContent = '有未保存的更改'; };
field('refresh-models').onclick = () => void refreshModels();
field('toggle-token').onclick = () => { const visible = field('token').type === 'password'; field('token').type = visible ? 'text' : 'password'; field('toggle-token').textContent = visible ? '隐藏' : '显示'; field('toggle-token').setAttribute('aria-pressed', String(visible)); field('toggle-token').setAttribute('aria-label', visible ? '隐藏管理密钥' : '显示管理密钥'); };
field('settings-form').addEventListener('input', (event) => {
  field('status').textContent = '有未保存的更改'; field('save').textContent = '保存设置';
  if (['endpoint', 'token'].includes(event.target.id)) {
    ++catalogRequest; catalogController?.abort(); selectedModel = selection(); fillModels({});
    field('connection-state').textContent = '连接已更改'; field('model-status').textContent = '点击刷新模型，读取新连接的可选模型。';
    field('refresh-models').disabled = false; field('refresh-models').textContent = '刷新模型';
  }
});
field('settings-form').onsubmit = async (event) => {
  event.preventDefault(); field('save').disabled = true; field('save').textContent = '保存中…';
  try {
    const endpoint = validEndpoint(); const model = selection();
    if (field('model').value === 'manual' && !model.model) throw new Error('请填写模型 ID，或选择 Server 默认模型');
    await Promise.all([chrome.storage.sync.set({ endpoint, target: field('target').value, mode: field('mode').value, concurrency: Number(field('concurrency').value) || 3, theme: readingThemes.normalize(field('theme').value), autoCopy: field('autoCopy').checked, ...model }), chrome.storage.local.set({ token: field('token').value.trim() })]);
    field('status').textContent = '已保存 · 下次翻译立即生效'; field('save').textContent = '已保存';
  } catch (error) { field('status').textContent = error.message || '保存失败，请重试'; field('save').textContent = '重新保存'; }
  finally { field('save').disabled = false; }
};
Promise.all([chrome.storage.sync.get({ endpoint: defaults.endpoint, target: defaults.target, mode: defaults.mode, concurrency: defaults.concurrency, theme: defaults.theme, autoCopy: defaults.autoCopy, model: defaults.model, provider: defaults.provider }), chrome.storage.local.get({ token: defaults.token })]).then(([shared, privateState]) => {
  const settings = { ...defaults, ...shared, ...privateState };
  for (const name of ['endpoint', 'token', 'target', 'mode']) field(name).value = settings[name];
  field('concurrency').value = String(Math.max(1, Math.min(8, Number(settings.concurrency) || 3))); field('theme').value = readingThemes.normalize(settings.theme); updateThemePreview(); field('autoCopy').checked = settings.autoCopy === true; selectedModel = { model: settings.model, provider: settings.provider };
  fillModels({}); void refreshModels();
}).catch(() => { field('status').textContent = '无法读取设置，请重新打开扩展'; });


// Page actions: when opened from the toolbar on a normal web page, translate or restore
// that page directly (the options page itself, chrome:// pages and the store are skipped).
(async function setupPageActions() {
  let tab = null;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (_error) { return; }
  if (!tab || !tab.id || !/^https?:/.test(String(tab.url || ''))) return;
  const section = field('page-actions'); const translate = field('translate-page'); const undo = field('undo-page'); const state = field('page-state');
  section.hidden = false;
  try { state.textContent = new URL(tab.url).hostname; } catch (_error) { state.textContent = ''; }
  const send = (message) => chrome.tabs.sendMessage(tab.id, message);
  async function refresh() {
    try {
      const status = await send({ type: 'aih-page-status' });
      undo.hidden = !status?.translated;
      translate.textContent = status?.translated ? '重新翻译' : '翻译此页';
      field('subtitles-row').hidden = !(status?.videos > 0);
      field('subtitles').checked = Boolean(status?.subtitles);
    } catch (_error) {
      // Content script not injected yet (page opened before install): translating still
      // works via the background, which injects on demand.
      undo.hidden = true;
    }
  }
  translate.onclick = async () => {
    translate.disabled = true; translate.textContent = '已开始翻译…';
    try { await send({ type: 'aih-translate-page', target: field('target').value }); window.close(); }
    catch (_error) { translate.disabled = false; translate.textContent = '翻译此页'; state.textContent = '此页面暂不可翻译，请刷新后重试'; }
  };
  undo.onclick = async () => { try { await send({ type: 'aih-undo-page' }); } catch (_error) { /* page closed */ } await refresh(); };
  field('subtitles').onchange = async () => {
    const result = await send({ type: 'aih-subtitles', action: field('subtitles').checked ? 'enable' : 'disable' }).catch(() => null);
    field('subtitles').checked = Boolean(result?.enabled);
    if (result?.enabled && !result.tracks) state.textContent = '此视频没有可读取的字幕轨';
  };
  const autoSite = field('auto-site'); let host = '';
  try { host = new URL(tab.url).hostname; } catch (_error) { host = ''; }
  const siteState = await chrome.runtime.sendMessage({ type: 'aih-auto-site', action: 'get', host }).catch(() => null);
  autoSite.checked = Boolean(siteState?.enabled);
  autoSite.onchange = async () => {
    const result = await chrome.runtime.sendMessage({ type: 'aih-auto-site', action: 'set', host, enabled: autoSite.checked }).catch(() => null);
    autoSite.checked = Boolean(result?.enabled);
  };
  await refresh();
})();
