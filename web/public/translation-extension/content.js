/* global chrome, document, NodeFilter, getComputedStyle, getSelection, requestAnimationFrame, matchMedia */
(() => {
  const ROOT_ATTR = 'data-aih-translation-extension';
  let active = null;
  let selectionProgress = null;
  let operationSerial = Date.now();
  let activeCleanup = () => {};

  function cancelTranslation(operationId) {
    chrome.runtime.sendMessage({ type: 'aih-cancel-translation', operationId }, () => { void chrome.runtime.lastError; });
  }

  function settingsButton() {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '连接设置';
    button.onclick = () => chrome.runtime.sendMessage({ type: 'aih-open-translation-settings' });
    return button;
  }

  const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'PRE', 'CODE', 'TEXTAREA', 'INPUT']);
  function declaredLanguage(element) {
    const value = element.closest('[lang]')?.getAttribute('lang') || '';
    if (!value.trim()) return '';
    try {
      const locale = new Intl.Locale(value.trim().replace(/_/g, '-'));
      if (locale.language === 'zh') return locale.maximize().script === 'Hant' ? 'zh-Hant' : 'zh-Hans';
      return locale.language;
    } catch { return ''; }
  }

  function textNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const result = []; let current;
    while ((current = walker.nextNode())) {
      const node = current; const parent = node.parentElement;
      const source = node.nodeValue?.replace(/\s+/g, ' ').trim() || '';
      if (!parent || ignored.has(parent.tagName) || parent.closest(`[${ROOT_ATTR}]`) || source.length < 2) continue;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      result.push({ node, source, sourceLanguage: declaredLanguage(parent), index: result.length });
    }
    return result;
  }

  function panel(title, rect, options = {}) {
    activeCleanup();
    activeCleanup = () => {};
    selectionProgress = null;
    active?.destroy();
    active = globalThis.AIHTranslationPanel.create(title, rect, () => { activeCleanup(); selectionProgress = null; }, options);
    return active.body;
  }

  function statusLine(text, busy = false) {
    const row = document.createElement('div'); row.className = 'status'; row.setAttribute('role', 'status');
    if (busy) { const spinner = document.createElement('span'); spinner.className = 'spinner'; spinner.setAttribute('aria-hidden', 'true'); row.append(spinner); }
    const label = document.createElement('span'); label.textContent = text; row.append(label); return row;
  }

  function reading(text, className = '') {
    const output = document.createElement('div'); output.className = `reading ${className}`; output.textContent = text; return output;
  }

  function updateReadingText(output, text) {
    const previous = output.textContent;
    if (previous === text) return;
    if (output.firstChild && text.startsWith(previous)) output.firstChild.appendData(text.slice(previous.length));
    else output.textContent = text;
  }

  function selectionLoading(body, operationToken, retry) {
    body.dataset.state = 'loading';
    const status = statusLine('正在等待模型响应…', true);
    const output = reading('', 'stream');
    const skeleton = document.createElement('div'); skeleton.setAttribute('aria-hidden', 'true');
    skeleton.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    const footer = document.createElement('footer');
    const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = '停止翻译';
    stop.onclick = () => {
      cancelTranslation(operationToken); ++operationSerial; selectionProgress = null;
      body.dataset.state = 'stopped'; body.replaceChildren(statusLine('已停止翻译'));
      if (output.textContent) body.append(output);
      const again = document.createElement('button'); again.textContent = '重新翻译'; again.onclick = retry;
      const actions = document.createElement('footer'); actions.append(again); body.append(actions);
    };
    footer.append(stop); body.replaceChildren(status, skeleton, output, footer);
    selectionProgress = { operationToken, body, status, output, skeleton };
  }

  const languageNames = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
  function languageLabel(value) { try { return languageNames.of(value) || value; } catch { return value; } }

  function selected() {
    const selection = getSelection(); const text = selection?.toString().trim();
    if (!text || !selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    return { text, rect: range.getBoundingClientRect(), range: range.cloneRange() };
  }

  function copyText(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'aih-copy-text', text }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message || '剪贴板写入失败' });
          return;
        }
        resolve(response || { ok: false, error: '扩展无法连接到剪贴板服务' });
      });
    });
  }

  function renderResult(body, source, text, undo, options = {}) {
    const output = selectionProgress?.body === body ? selectionProgress.output : reading(text);
    const scrollTop = output.scrollTop;
    // Keep the streamed text node connected so selection and reading position survive completion.
    for (const child of [...body.children]) if (child !== output) child.remove();
    updateReadingText(output, text);
    output.classList.remove('stream');
    if (!output.isConnected) body.append(output);
    body.dataset.state = 'done'; selectionProgress = null;
    const original = document.createElement('details'); original.className = 'source';
    const disclosure = document.createElement('summary'); disclosure.textContent = '查看原文'; original.append(disclosure, reading(source));
    const label = document.createElement('div'); label.className = 'label'; label.textContent = '译文';
    body.insertBefore(original, output); body.insertBefore(label, output); output.scrollTop = scrollTop;
    const footer = document.createElement('footer'); footer.style.cssText = 'display:flex;gap:8px;margin-top:10px';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制译文';
    const copyStatus = document.createElement('span'); copyStatus.setAttribute('data-copy-status', ''); copyStatus.setAttribute('role', 'status'); copyStatus.style.cssText = 'align-self:center;color:var(--muted);font-size:12px';
    const copyWithFeedback = async (automatic = false) => {
      if (!body.isConnected) return;
      copy.disabled = true; copy.textContent = automatic ? '自动复制中…' : '复制中…'; copyStatus.textContent = automatic ? '自动复制中…' : '复制中…';
      const result = await copyText(text);
      if (!body.isConnected) return;
      if (result?.ok) {
        copy.disabled = false; copy.textContent = '复制译文'; copyStatus.textContent = automatic ? '已自动复制' : '已复制'; copyStatus.style.color = 'var(--muted)';
      } else {
        copy.disabled = false; copy.textContent = '重试复制'; copyStatus.textContent = result?.error || '复制失败，请重试'; copyStatus.style.color = 'var(--warning)';
      }
    };
    copy.onclick = () => { void copyWithFeedback(false); }; footer.append(copy, copyStatus);
    if (undo) { const undoButton = document.createElement('button'); undoButton.type = 'button'; undoButton.textContent = '撤回替换'; undoButton.onclick = () => { undo(); undoButton.remove(); }; footer.append(undoButton); }
    body.append(footer);
    if (options.autoCopy === true && options.operationToken === operationSerial && body.isConnected) void copyWithFeedback(true);
  }

  function translateOne(text, operation = 'selection', options = {}) {
    return new Promise((resolve) => chrome.runtime.sendMessage({
      type: 'aih-translate', text, operation,
      operationId: options.operationId,
      ...(options.source ? { source: options.source } : {}),
      ...(options.target ? { target: options.target } : {}),
      ...(options.targetPolicy ? { targetPolicy: options.targetPolicy } : {})
    }, (response) => { const error = chrome.runtime.lastError; resolve(response || { ok: false, fatal: true, error: error?.message || '扩展无法连接到翻译服务' }); }));
  }

  function renderConfirmation(body, confirmation, onConfirm, onKeep, label = '') {
    body.dataset.state = 'confirmation'; selectionProgress = null; body.replaceChildren();
    if (label) { const status = document.createElement('div'); status.textContent = label; status.style.cssText = 'margin-bottom:6px;font-weight:600;color:var(--warning)'; body.append(status); }
    const message = document.createElement('div'); message.textContent = confirmation?.message || '请确认目标语言后再翻译'; message.style.cssText = 'line-height:1.5'; body.append(message);
    const detected = String(confirmation?.detected || '').trim();
    if (detected) { const hint = document.createElement('div'); hint.textContent = `原文：${languageLabel(detected)}${confirmation?.confidence === 'low' ? '（请确认）' : ''}`; hint.style.cssText = 'margin-top:5px;color:var(--muted);font-size:12px'; body.append(hint); }
    const candidates = [confirmation?.target, ...(Array.isArray(confirmation?.suggestedTargets) ? confirmation.suggestedTargets : [])]
      .map((value) => String(value || '').trim()).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
    const selectorRow = document.createElement('label'); selectorRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px';
    const selectorLabel = document.createElement('span'); selectorLabel.textContent = '目标语言';
    const select = document.createElement('select'); select.setAttribute('aria-label', '目标语言'); select.style.flex = '1';
    candidates.forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = languageLabel(value); select.append(option); });
    if (!candidates.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '暂无可选目标语言'; option.selected = true; select.append(option); select.disabled = true; }
    selectorRow.append(selectorLabel, select); body.append(selectorRow);
    const actions = document.createElement('footer'); actions.style.cssText = 'display:flex;gap:8px;margin-top:10px';
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'primary'; confirm.textContent = '翻译'; confirm.disabled = !candidates.length;
    const keep = document.createElement('button'); keep.type = 'button'; keep.textContent = '保持原文';
    confirm.onclick = async () => {
      const target = select.value; if (!target) return;
      confirm.disabled = true; keep.disabled = true; select.disabled = true; body.replaceChildren(statusLine('正在翻译…', true));
      try { await onConfirm(target); } catch (error) { body.textContent = error instanceof Error ? error.message : String(error); }
    };
    keep.onclick = () => { confirm.disabled = true; keep.disabled = true; select.disabled = true; onKeep(); };
    actions.append(confirm, keep); body.append(actions);
  }

  function applySelectionResult(body, source, result, rangeSnapshot, operationToken) {
    if (!body.isConnected || operationToken !== operationSerial) return;
    if (result?.confirmation) {
      renderConfirmation(body, result.confirmation, async (target) => {
        selectionLoading(body, operationToken, () => void translateSelection(source, null, rangeSnapshot));
        const retry = await translateOne(source, 'selection', { target, targetPolicy: 'explicit', operationId: operationToken });
        applySelectionResult(body, source, retry, rangeSnapshot, operationToken);
      }, () => { body.textContent = '已保持原文'; });
      return;
    }
    if (!result?.ok || !result.text) {
      selectionProgress = null; body.dataset.state = 'error'; body.replaceChildren(statusLine(result?.error || '翻译失败'));
      const actions = document.createElement('footer'); const retry = document.createElement('button'); retry.textContent = '重新翻译';
      retry.onclick = () => void translateSelection(source, null, rangeSnapshot); actions.append(retry, settingsButton()); body.append(actions); return;
    }
    let undo = null;
    if (result.mode === 'replace' && rangeSnapshot && (rangeSnapshot.startContainer?.isConnected || rangeSnapshot.startContainer === document)) {
      try {
        const range = rangeSnapshot.cloneRange();
        if (!range.collapsed) {
          const original = range.cloneContents();
          const replacement = document.createElement('span'); replacement.setAttribute(ROOT_ATTR, 'replacement'); replacement.textContent = result.text; replacement.style.cssText = matchMedia('(prefers-reduced-motion: reduce)').matches ? '' : 'opacity:0;transition:opacity 180ms ease';
          range.deleteContents(); range.insertNode(replacement); requestAnimationFrame(() => { replacement.style.opacity = '1'; });
          undo = () => { if (!replacement.isConnected) return; const restore = document.createRange(); restore.selectNode(replacement); restore.deleteContents(); restore.insertNode(original); };
        }
      } catch { /* The source DOM may have changed while the request was in flight. */ }
    }
    renderResult(body, source, result.text, undo, { autoCopy: result.autoCopy === true, operationToken });
  }

  async function translateSelection(text, rect, rangeSnapshot) {
    const operationToken = ++operationSerial;
    const body = panel('选区翻译', rect);
    selectionLoading(body, operationToken, () => void translateSelection(text, rect, rangeSnapshot));
    activeCleanup = () => cancelTranslation(operationToken);
    const result = await translateOne(text, 'selection', { operationId: operationToken });
    applySelectionResult(body, text, result, rangeSnapshot, operationToken);
  }

  async function translatePage(targetOverride = '') {
    const operationToken = ++operationSerial;
    const body = panel('整页翻译', { left: 16, bottom: 16 }, { compact: true }); const segments = textNodes();
    if (!segments.length) { body.textContent = '当前页面没有可翻译的正文'; return; }
    const snapshots = []; const failedItems = [];
    const translatedByIndex = new Map();
    let processed = 0; let succeeded = 0; let failed = 0; let stopRequested = false; let confirmation = null;
    let pageAutoCopyEligible = true; let pageCopyDone = false;
    let fatalError = ''; let cancelled = false;
    let pageLanguage = '';
    const concurrency = 3;
    const progress = statusLine('准备翻译页面…', true);
    const progressBar = document.createElement('progress'); progressBar.setAttribute('aria-label', '页面翻译进度');
    const pageActions = document.createElement('footer');
    const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = '停止';
    stop.onclick = () => { cancelled = true; stopRequested = true; cancelTranslation(operationToken); stop.disabled = true; stop.textContent = '正在停止…'; };
    activeCleanup = () => { cancelled = true; stopRequested = true; cancelTranslation(operationToken); restoreSnapshots(); };

    function updateProgress(label, total) { progress.lastChild.textContent = `${label} ${processed} / ${total} 段`; progressBar.max = total; progressBar.value = processed; pageActions.replaceChildren(stop); body.replaceChildren(progress, progressBar, pageActions); }
    function restoreSnapshots() {
      snapshots.slice().reverse().forEach((item) => { if (item.node?.isConnected) item.node.nodeValue = item.original; item.marker?.remove(); });
      snapshots.length = 0;
    }
    function applyPageResult(item, result) {
      if (!item.node.isConnected || !item.node.parentNode) return false;
      snapshots.push({ ...item, original: item.node.nodeValue });
      if (result.mode === 'replace') item.node.nodeValue = result.text;
      else {
        const marker = document.createElement('span'); marker.setAttribute(ROOT_ATTR, 'side-by-side'); marker.textContent = result.text; marker.style.cssText = 'display:block;opacity:0;transition:opacity 160ms ease;color:inherit;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.75;margin-block:0.4em 0.7em';
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) { marker.style.transition = 'none'; marker.style.opacity = '1'; }
        item.node.parentNode.insertBefore(marker, item.node.nextSibling); requestAnimationFrame(() => { marker.style.opacity = '1'; }); snapshots[snapshots.length - 1].marker = marker;
      }
      return true;
    }
    async function translateItems(items, label) {
      let itemCursor = 0; const total = items.length; stopRequested = false;
      // A navigation word cannot establish a page's language. Translate a
      // representative passage first, then reuse its resolved source for
      // unlabelled fragments; explicit per-element lang always takes priority.
      const representative = items.reduce((best, item) => !best || item.source.length > best.source.length ? item : best, null);
      const orderedItems = representative ? [representative, ...items.filter((item) => item !== representative)] : [];
      async function worker(limit = total) {
        while (!stopRequested && !cancelled && body.isConnected && operationToken === operationSerial && itemCursor < limit) {
          const item = orderedItems[itemCursor++]; const options = { operationId: operationToken, source: item.sourceLanguage || pageLanguage, ...(targetOverride ? { target: targetOverride, targetPolicy: 'explicit' } : {}) };
          const result = await translateOne(item.source, 'page', options); processed += 1;
          if (cancelled || !body.isConnected || operationToken !== operationSerial) return;
          if (result?.confirmation) { if (!confirmation) { confirmation = result.confirmation; stopRequested = true; restoreSnapshots(); } continue; }
          if (stopRequested) continue;
          if (result?.fatal) { fatalError = result.error || '翻译服务不可用'; stopRequested = true; failed += 1; cancelTranslation(operationToken); return; }
          if (result?.ok && result.text && applyPageResult(item, result)) {
            if (!pageLanguage && result.meta?.from) pageLanguage = result.meta.from;
            translatedByIndex.set(item.index, result.text);
            pageAutoCopyEligible = pageAutoCopyEligible && result.autoCopy === true;
            succeeded += 1;
          }
          else { failed += 1; if (!failedItems.includes(item)) failedItems.push(item); }
          updateProgress(label, total);
        }
      }
      await worker(Math.min(1, total));
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(0, total - 1)) }, () => worker()));
    }
    function renderPageConfirmation() {
      renderConfirmation(body, confirmation, async (target) => { await translatePage(target); }, () => { restoreSnapshots(); body.textContent = '已保持原文'; }, '待确认目标语言');
    }
    async function copyPageText(status, button, text, automatic = false) {
      if (!body.isConnected || operationToken !== operationSerial) return;
      button.disabled = true; button.textContent = automatic ? '自动复制中…' : '复制中…'; status.textContent = automatic ? '自动复制中…' : '复制中…';
      const result = await copyText(text);
      if (!body.isConnected || operationToken !== operationSerial) return;
      if (result?.ok) {
        button.disabled = false; button.textContent = '复制已完成译文'; status.textContent = automatic ? '已自动复制' : '已复制'; status.style.color = 'var(--muted)';
      } else {
        button.disabled = false; button.textContent = '重试复制'; status.textContent = result?.error || '复制失败，请重试'; status.style.color = 'var(--warning)';
      }
    }
    async function renderSummary() {
      if (!body.isConnected || operationToken !== operationSerial) return;
      body.replaceChildren(); const summary = document.createElement('span'); summary.textContent = `${fatalError ? '翻译已暂停' : cancelled ? '翻译已停止' : '页面翻译完成'} · 成功 ${succeeded} · 失败 ${failed}`; body.append(summary);
      if (fatalError) { const reason = document.createElement('p'); reason.textContent = fatalError; body.append(reason, settingsButton()); }
      if (failed > 0 && !fatalError) { const partial = document.createElement('div'); partial.textContent = '部分段落翻译失败，可重新执行。'; partial.style.cssText = 'margin-top:6px;color:var(--warning)'; body.append(partial); }
      const actions = document.createElement('footer'); actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      const copiedText = segments.slice().sort((left, right) => left.index - right.index).map((item) => translatedByIndex.get(item.index) || '').filter(Boolean).join('\n');
      const copyStatus = document.createElement('span'); copyStatus.setAttribute('data-copy-status', ''); copyStatus.setAttribute('role', 'status'); copyStatus.style.cssText = 'align-self:center;color:var(--muted);font-size:12px';
      if (copiedText) {
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制已完成译文'; copy.onclick = () => { void copyPageText(copyStatus, copy, copiedText); }; actions.append(copy);
      }
      if (failed > 0 && !fatalError && !cancelled) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新翻译失败段落';
        retry.onclick = async () => { const retryItems = failedItems.splice(0); if (!retryItems.length) return; processed = 0; failed = Math.max(0, failed - retryItems.length); updateProgress('正在重试', retryItems.length); confirmation = null; await translateItems(retryItems, '正在重试'); if (confirmation) renderPageConfirmation(); else await renderSummary(); };
        actions.append(retry);
      }
      if (snapshots.length) { const undo = document.createElement('button'); undo.type = 'button'; undo.textContent = '撤回页面译文'; undo.onclick = () => { restoreSnapshots(); body.textContent = '已撤回页面译文'; }; actions.append(undo); }
      if (actions.childElementCount) body.append(actions);
      if (copyStatus.textContent || copiedText) { actions.append(copyStatus); }
      const allSucceeded = !cancelled && !fatalError && failed === 0 && translatedByIndex.size === segments.length;
      if (allSucceeded && pageAutoCopyEligible && !pageCopyDone && copiedText.trim()) {
        pageCopyDone = true;
        const automaticCopy = actions.querySelector('button');
        if (automaticCopy) await copyPageText(copyStatus, automaticCopy, copiedText, true);
      }
    }
    updateProgress('正在翻译', segments.length); await translateItems(segments, '正在翻译');
    if (confirmation) { renderPageConfirmation(); return; }
    await renderSummary();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'aih-translation-progress' && selectionProgress?.operationToken === message.operationId && message.operationId === operationSerial && selectionProgress.body.isConnected) {
      const { status, output, skeleton } = selectionProgress;
      status.lastChild.textContent = message.text ? '正在生成译文…' : '模型已连接，正在翻译…';
      if (message.text) {
        skeleton.remove();
        updateReadingText(output, message.text);
      }
    }
    if (message?.type === 'aih-translate-selection') { const item = selected(); if (item) void translateSelection(message.text || item.text, item.rect, item.range); }
    if (message?.type === 'aih-translate-page') void translatePage();
  });
})();
