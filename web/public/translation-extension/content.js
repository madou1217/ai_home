(() => {
  const ROOT_ATTR = 'data-aih-translation-extension';
  let active = null;

  const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'PRE', 'CODE', 'TEXTAREA', 'INPUT']);
  function textNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const result = []; let current;
    while ((current = walker.nextNode())) {
      const node = current; const parent = node.parentElement;
      const source = node.nodeValue?.replace(/\s+/g, ' ').trim() || '';
      if (!parent || ignored.has(parent.tagName) || parent.closest(`[${ROOT_ATTR}]`) || source.length < 2) continue;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      result.push({ node, source, index: result.length });
    }
    return result;
  }

  function panel(title, rect) {
    active?.remove();
    const root = document.createElement('section'); root.setAttribute(ROOT_ATTR, 'panel');
    root.style.cssText = `position:fixed;z-index:2147483647;left:${Math.max(8, rect?.left || 16)}px;top:${Math.max(8, (rect?.bottom || 16) + 8)}px;width:360px;max-height:70vh;overflow:auto;padding:12px;background:#0c1524;color:#e2f1f8;border:1px solid #23405f;box-shadow:0 8px 30px #0008;font:13px system-ui,sans-serif`;
    root.innerHTML = `<header style="display:flex;justify-content:space-between;gap:8px;align-items:center"><strong>${title}</strong><button data-close type="button">×</button></header><div data-body style="margin-top:8px"></div>`;
    root.querySelector('[data-close]').onclick = () => root.remove();
    document.body.append(root); active = root; return root.querySelector('[data-body]');
  }

  function selected() {
    const selection = getSelection(); const text = selection?.toString().trim();
    if (!text) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return { text, rect };
  }

  function renderResult(body, source, text, undo) {
    body.innerHTML = `<div style="white-space:pre-wrap;line-height:1.6">${escapeHtml(text)}</div><footer style="display:flex;gap:8px;margin-top:10px"><button data-copy type="button">复制</button>${undo ? '<button data-undo type="button">撤回替换</button>' : ''}</footer>`;
    body.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(text);
    if (undo) body.querySelector('[data-undo]').onclick = () => { undo(); body.querySelector('[data-undo]').remove(); };
    void source;
  }

  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
  function translateOne(text, operation = 'selection') { return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'aih-translate', text, operation }, resolve)); }

  async function translateSelection(text, rect) {
    const body = panel('AIH 翻译选区', rect); body.textContent = '正在识别并翻译…';
    const result = await translateOne(text); if (!result?.ok) { body.textContent = result?.error || '翻译失败'; return; }
    renderResult(body, text, result.text, null);
  }

  async function translatePage() {
    const body = panel('AIH 整页翻译', { left: 16, bottom: 16 }); const segments = textNodes();
    if (!segments.length) { body.textContent = '当前页面没有可翻译的正文'; return; }
    body.textContent = `正在翻译 0 / ${segments.length} 段…`;
    const snapshots = []; let cursor = 0; let completed = 0; const concurrency = 3;
    async function worker() {
      while (cursor < segments.length) {
        const item = segments[cursor++]; const result = await translateOne(item.source, 'page'); completed += 1;
        if (result?.ok && result.text) { snapshots.push({ ...item, original: item.node.nodeValue }); const marker = document.createElement('span'); marker.setAttribute(ROOT_ATTR, 'side-by-side'); marker.textContent = result.text; marker.style.cssText = 'display:block;opacity:0;transition:opacity 160ms ease;color:inherit'; item.node.parentNode.insertBefore(marker, item.node.nextSibling); requestAnimationFrame(() => { marker.style.opacity = '1'; }); snapshots[snapshots.length - 1].marker = marker; }
        body.textContent = `正在翻译 ${completed} / ${segments.length} 段…`;
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    body.innerHTML = `<span>页面翻译完成 · ${completed} 段</span> <button data-undo type="button">撤回页面译文</button>`;
    body.querySelector('[data-undo]').onclick = () => { snapshots.forEach((item) => { item.node.nodeValue = item.original; item.marker?.remove(); }); body.textContent = '已撤回页面译文'; };
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'aih-translate-selection') { const item = selected(); if (item) void translateSelection(message.text || item.text, item.rect); }
    if (message?.type === 'aih-translate-page') void translatePage();
  });
})();
