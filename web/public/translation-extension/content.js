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
    if (!text || !selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    return { text, rect: range.getBoundingClientRect(), range: range.cloneRange() };
  }

  function renderResult(body, source, text, undo) {
    body.replaceChildren();
    const output = document.createElement('div'); output.style.cssText = 'white-space:pre-wrap;line-height:1.6'; output.textContent = text; body.append(output);
    const footer = document.createElement('footer'); footer.style.cssText = 'display:flex;gap:8px;margin-top:10px';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制'; copy.onclick = () => { void navigator.clipboard?.writeText(text); }; footer.append(copy);
    if (undo) { const undoButton = document.createElement('button'); undoButton.type = 'button'; undoButton.textContent = '撤回替换'; undoButton.onclick = () => { undo(); undoButton.remove(); }; footer.append(undoButton); }
    body.append(footer);
    void source;
  }

  function translateOne(text, operation = 'selection', options = {}) {
    return new Promise((resolve) => chrome.runtime.sendMessage({
      type: 'aih-translate', text, operation,
      ...(options.target ? { target: options.target } : {}),
      ...(options.targetPolicy ? { targetPolicy: options.targetPolicy } : {})
    }, (response) => resolve(response || { ok: false, error: '扩展无法连接到翻译服务' })));
  }

  function renderConfirmation(body, confirmation, onConfirm, onKeep, label = '') {
    body.replaceChildren();
    if (label) { const status = document.createElement('div'); status.textContent = label; status.style.cssText = 'margin-bottom:6px;font-weight:600;color:#f5c77a'; body.append(status); }
    const message = document.createElement('div'); message.textContent = confirmation?.message || '请确认目标语言后再翻译'; message.style.cssText = 'line-height:1.5'; body.append(message);
    const detected = String(confirmation?.detected || '').trim();
    if (detected) { const hint = document.createElement('div'); hint.textContent = `检测到：${detected}${confirmation?.confidence ? `（${confirmation.confidence}）` : ''}`; hint.style.cssText = 'margin-top:5px;color:#9db8cc;font-size:12px'; body.append(hint); }
    const candidates = [confirmation?.target, ...(Array.isArray(confirmation?.suggestedTargets) ? confirmation.suggestedTargets : [])]
      .map((value) => String(value || '').trim()).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
    const selectorRow = document.createElement('label'); selectorRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px';
    const selectorLabel = document.createElement('span'); selectorLabel.textContent = '目标语言';
    const select = document.createElement('select'); select.setAttribute('aria-label', '目标语言'); select.style.flex = '1';
    candidates.forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = value; select.append(option); });
    if (!candidates.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '暂无可选目标语言'; option.selected = true; select.append(option); select.disabled = true; }
    selectorRow.append(selectorLabel, select); body.append(selectorRow);
    const actions = document.createElement('footer'); actions.style.cssText = 'display:flex;gap:8px;margin-top:10px';
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = '翻译'; confirm.disabled = !candidates.length;
    const keep = document.createElement('button'); keep.type = 'button'; keep.textContent = '保持原文';
    confirm.onclick = async () => {
      const target = select.value; if (!target) return;
      confirm.disabled = true; keep.disabled = true; select.disabled = true; body.textContent = '正在按确认的目标语言翻译…';
      try { await onConfirm(target); } catch (error) { body.textContent = error instanceof Error ? error.message : String(error); }
    };
    keep.onclick = () => { confirm.disabled = true; keep.disabled = true; select.disabled = true; onKeep(); };
    actions.append(confirm, keep); body.append(actions);
  }

  function applySelectionResult(body, source, result, rangeSnapshot) {
    if (result?.confirmation) {
      renderConfirmation(body, result.confirmation, async (target) => {
        const retry = await translateOne(source, 'selection', { target, targetPolicy: 'explicit' });
        applySelectionResult(body, source, retry, rangeSnapshot);
      }, () => { body.textContent = '已保持原文'; });
      return;
    }
    if (!result?.ok || !result.text) { body.textContent = result?.error || '翻译失败'; return; }
    let undo = null;
    if (result.mode === 'replace' && rangeSnapshot && (rangeSnapshot.startContainer?.isConnected || rangeSnapshot.startContainer === document)) {
      try {
        const range = rangeSnapshot.cloneRange();
        if (!range.collapsed) {
          const original = range.cloneContents();
          const replacement = document.createElement('span'); replacement.setAttribute(ROOT_ATTR, 'replacement'); replacement.textContent = result.text; replacement.style.cssText = 'opacity:0;transition:opacity 180ms ease';
          range.deleteContents(); range.insertNode(replacement); requestAnimationFrame(() => { replacement.style.opacity = '1'; });
          undo = () => { if (!replacement.isConnected) return; const restore = document.createRange(); restore.selectNode(replacement); restore.deleteContents(); restore.insertNode(original); };
        }
      } catch (_error) { /* The source DOM may have changed while the request was in flight. */ }
    }
    renderResult(body, source, result.text, undo);
  }

  async function translateSelection(text, rect, rangeSnapshot) {
    const body = panel('AIH 翻译选区', rect); body.textContent = '正在识别并翻译…';
    const result = await translateOne(text);
    applySelectionResult(body, text, result, rangeSnapshot);
  }

  async function translatePage(targetOverride = '') {
    const body = panel('AIH 整页翻译', { left: 16, bottom: 16 }); const segments = textNodes();
    if (!segments.length) { body.textContent = '当前页面没有可翻译的正文'; return; }
    const snapshots = []; const failedItems = [];
    let processed = 0; let succeeded = 0; let failed = 0; let stopRequested = false; let confirmation = null;
    const concurrency = 3;

    function updateProgress(label, total) { body.textContent = `${label} ${processed} / ${total} 段 · 成功 ${succeeded} · 失败 ${failed}`; }
    function restoreSnapshots() {
      snapshots.slice().reverse().forEach((item) => { if (item.node?.isConnected) item.node.nodeValue = item.original; item.marker?.remove(); });
      snapshots.length = 0;
    }
    function applyPageResult(item, result) {
      if (!item.node.isConnected || !item.node.parentNode) return false;
      snapshots.push({ ...item, original: item.node.nodeValue });
      if (result.mode === 'replace') item.node.nodeValue = result.text;
      else {
        const marker = document.createElement('span'); marker.setAttribute(ROOT_ATTR, 'side-by-side'); marker.textContent = result.text; marker.style.cssText = 'display:block;opacity:0;transition:opacity 160ms ease;color:inherit';
        item.node.parentNode.insertBefore(marker, item.node.nextSibling); requestAnimationFrame(() => { marker.style.opacity = '1'; }); snapshots[snapshots.length - 1].marker = marker;
      }
      return true;
    }
    async function translateItems(items, label) {
      let itemCursor = 0; const total = items.length; stopRequested = false;
      async function worker() {
        while (!stopRequested && itemCursor < total) {
          const item = items[itemCursor++]; const options = targetOverride ? { target: targetOverride, targetPolicy: 'explicit' } : {};
          const result = await translateOne(item.source, 'page', options); processed += 1;
          if (result?.confirmation) { if (!confirmation) { confirmation = result.confirmation; stopRequested = true; restoreSnapshots(); } continue; }
          if (stopRequested) continue;
          if (result?.ok && result.text && applyPageResult(item, result)) succeeded += 1;
          else { failed += 1; if (!failedItems.includes(item)) failedItems.push(item); }
          updateProgress(label, total);
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));
    }
    function renderPageConfirmation() {
      renderConfirmation(body, confirmation, async (target) => { await translatePage(target); }, () => { restoreSnapshots(); body.textContent = '已保持原文'; }, '待确认目标语言');
    }
    function renderSummary() {
      body.replaceChildren(); const summary = document.createElement('span'); summary.textContent = `页面翻译完成 · 成功 ${succeeded} · 失败 ${failed}`; body.append(summary);
      if (failed > 0) { const partial = document.createElement('div'); partial.textContent = '部分段落翻译失败，可重新执行。'; partial.style.cssText = 'margin-top:6px;color:#f5c77a'; body.append(partial); }
      const actions = document.createElement('footer'); actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      if (failed > 0) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新翻译失败段落';
        retry.onclick = async () => { const retryItems = failedItems.splice(0); if (!retryItems.length) return; processed = 0; failed = Math.max(0, failed - retryItems.length); updateProgress('正在重试', retryItems.length); confirmation = null; await translateItems(retryItems, '正在重试'); if (confirmation) renderPageConfirmation(); else renderSummary(); };
        actions.append(retry);
      }
      if (snapshots.length) { const undo = document.createElement('button'); undo.type = 'button'; undo.textContent = '撤回页面译文'; undo.onclick = () => { restoreSnapshots(); body.textContent = '已撤回页面译文'; }; actions.append(undo); }
      if (actions.childElementCount) body.append(actions);
    }
    updateProgress('正在翻译', segments.length); await translateItems(segments, '正在翻译');
    if (confirmation) { renderPageConfirmation(); return; }
    renderSummary();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'aih-translate-selection') { const item = selected(); if (item) void translateSelection(message.text || item.text, item.rect, item.range); }
    if (message?.type === 'aih-translate-page') void translatePage();
  });
})();
