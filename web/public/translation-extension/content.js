/* global chrome, document, getSelection, requestAnimationFrame, matchMedia, Element */
(() => {
  const ROOT_ATTR = 'data-aih-translation-extension';
  let active = null;
  const pageStreams = new Map();
  let selectionProgress = null;
  let operationSerial = Date.now();
  let activeCleanup = () => {};
  let pagePresentation = null;

  function pageState(action, options = {}) {
    return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'aih-page-translation-state', action, ...options }, (result) => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false } : result || { ok: false });
    }));
  }

  function cancelTranslation(operationId) {
    chrome.runtime.sendMessage({ type: 'aih-cancel-translation', operationId }, () => { void chrome.runtime.lastError; });
  }

  function settingsButton() {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '连接设置';
    button.onclick = () => chrome.runtime.sendMessage({ type: 'aih-open-translation-settings' });
    return button;
  }

  function panel(title, rect, options = {}) {
    activeCleanup('replace');
    activeCleanup = () => {};
    selectionProgress = null;
    active?.destroy();
    active = globalThis.AIHTranslationPanel.create(title, rect, () => { activeCleanup('dismiss'); selectionProgress = null; }, options);
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
    selectionProgress = { operationToken, body, status, output, skeleton, sequence: 0 };
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
      ...(options.targetPolicy ? { targetPolicy: options.targetPolicy } : {}),
      ...(options.restoring ? { restoring: true } : {}),
      ...(options.segmentId ? { segmentId: options.segmentId } : {})
    }, (response) => { const error = chrome.runtime.lastError; resolve(response || { ok: false, fatal: true, error: error?.message || '扩展无法连接到翻译服务' }); }));
  }

  function renderConfirmation(body, confirmation, onConfirm, onKeep) {
    body.dataset.state = 'confirmation'; selectionProgress = null; body.replaceChildren();
    const form = document.createElement('form'); form.className = 'confirmation';
    const heading = document.createElement('h3'); heading.className = 'confirmation-title'; heading.textContent = '选择译文语言';
    const description = document.createElement('p'); description.className = 'confirmation-description';
    description.textContent = '确认这次翻译使用的语言，或保留当前原文。';
    const detected = String(confirmation?.detected || '').trim();
    form.append(heading, description);
    if (detected) {
      const source = document.createElement('div'); source.className = 'source-language';
      source.textContent = `原文${confirmation?.confidence === 'low' ? '可能是' : '语言'} · ${languageLabel(detected)}`;
      form.append(source);
    }
    const candidates = [confirmation?.target, ...(Array.isArray(confirmation?.suggestedTargets) ? confirmation.suggestedTargets : [])]
      .map((value) => String(value || '').trim()).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
    const field = document.createElement('label'); field.className = 'language-field';
    const label = document.createElement('span'); label.className = 'field-label'; label.textContent = '翻译为';
    const select = document.createElement('select'); select.setAttribute('aria-label', '目标语言');
    candidates.forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = languageLabel(value); select.append(option); });
    if (!candidates.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = '暂时没有可选语言'; select.append(option); select.disabled = true;
    }
    const selectWrap = document.createElement('span'); selectWrap.className = 'language-select'; selectWrap.append(select);
    field.append(label, selectWrap); form.append(field);
    const feedback = document.createElement('p'); feedback.className = 'confirmation-feedback'; feedback.setAttribute('role', 'status'); feedback.hidden = true;
    form.append(feedback);
    const actions = document.createElement('div'); actions.className = 'confirmation-actions';
    const keep = document.createElement('button'); keep.type = 'button'; keep.className = 'quiet'; keep.textContent = '保持原文';
    const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.className = 'primary'; confirm.textContent = '开始翻译'; confirm.disabled = !candidates.length;
    if (!candidates.length) {
      feedback.hidden = false; feedback.textContent = '请在翻译设置中选择目标语言后重试。';
      actions.append(settingsButton());
    }
    let submitting = false;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const target = select.value;
      if (!target || submitting || !body.isConnected) return;
      submitting = true; confirm.disabled = true; keep.disabled = true; select.disabled = true;
      form.setAttribute('aria-busy', 'true'); confirm.textContent = '正在开始…'; feedback.hidden = true;
      try { await onConfirm(target); }
      catch (error) {
        if (!form.isConnected) return;
        feedback.textContent = error instanceof Error ? error.message : String(error); feedback.hidden = false;
      } finally {
        if (form.isConnected) {
          submitting = false; form.removeAttribute('aria-busy'); confirm.disabled = false; keep.disabled = false; select.disabled = false; confirm.textContent = '开始翻译';
        }
      }
    };
    keep.onclick = () => {
      if (submitting || !body.isConnected) return;
      onKeep();
      if (body.isConnected) { body.dataset.state = 'stopped'; body.replaceChildren(statusLine('已保持原文')); }
    };
    actions.append(keep, confirm); form.append(actions); body.append(form);
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

  async function translatePage(targetOverride = '', { restoring = false } = {}) {
    const operationToken = ++operationSerial;
    pagePresentation?.undo(); pagePresentation = null;
    const body = panel('整页翻译', { left: 16, bottom: 16 }, { compact: true }); const segments = globalThis.AIHTranslationPageSegments.collect();
    if (!segments.length) { body.textContent = '当前页面没有可翻译的正文'; return; }
    const snapshots = []; const failedItems = [];
    let translationTheme = 'plain';
    const placeholders = new Map();
    let cacheHits = 0; let missingCache = 0; let skippedSameLanguage = 0; let pageFinished = false;
    const translatedByIndex = new Map();
    let processed = 0; let succeeded = 0; let failed = 0; let stopRequested = false; let confirmation = null;
    let pageAutoCopyEligible = true; let pageCopyDone = false;
    let fatalError = ''; let cancelled = false;
    let concurrency = 3;
    let requestSequence = 0;
    const progress = statusLine('准备翻译页面…', true);
    const progressBar = document.createElement('progress'); progressBar.setAttribute('aria-label', '页面翻译进度');
    const pageActions = document.createElement('footer');
    const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = '停止';
    stop.onclick = () => { cancelled = true; stopRequested = true; clearStreams(); cancelTranslation(operationToken); void pageState('clear', { operationId: operationToken }); stop.disabled = true; stop.textContent = '正在停止…'; };
    activeCleanup = () => { if (!pageFinished) { cancelled = true; stopRequested = true; cancelTranslation(operationToken); } clearPlaceholders(); };
    pagePresentation = { undo: restoreSnapshots };
    function clearStreams() {
      for (const [key, stream] of pageStreams) if (stream.operationToken === operationToken) pageStreams.delete(key);
    }
    function clearPlaceholders() {
      clearStreams();
      for (const placeholder of placeholders.values()) placeholder?.remove(); placeholders.clear();
    }

    function updateProgress(label, total) { progress.lastChild.textContent = `${label} ${processed} / ${total} 段${skippedSameLanguage ? ` · 已是目标语言 ${skippedSameLanguage} 段` : ''}`; progressBar.max = total || 1; progressBar.value = processed; pageActions.replaceChildren(stop); body.replaceChildren(progress, progressBar, pageActions); }
    function restoreSnapshots() {
      snapshots.slice().reverse().forEach((snapshot) => snapshot.undo());
      snapshots.length = 0;
      clearPlaceholders();
    }
    function applyPageResult(item, result) {
      const snapshot = globalThis.AIHTranslationPageSegments.apply(item, result.text, result.mode, { stage: placeholders.get(item), theme: translationTheme });
      if (!snapshot) return false;
      placeholders.delete(item);
      snapshots.push(snapshot);
      return true;
    }
    async function translateItems(items, label) {
      let itemCursor = 0; const total = items.length; stopRequested = false;
      // Start longer passages early without making them a serial gate. Every
      // unlabelled segment retains auto-source, including multilingual pages.
      const representative = items.reduce((best, item) => !best || item.source.length > best.source.length ? item : best, null);
      const orderedItems = representative ? [representative, ...items.filter((item) => item !== representative)] : [];
      async function worker() {
        while (!stopRequested && !cancelled && body.isConnected && operationToken === operationSerial && itemCursor < total) {
          const item = orderedItems[itemCursor++];
          const segmentId = `${operationToken}:${++requestSequence}`;
          const options = { operationId: operationToken, segmentId, source: 'auto', restoring, ...(targetOverride ? { target: targetOverride, targetPolicy: 'explicit' } : {}) };
          if (!placeholders.has(item)) placeholders.set(item, globalThis.AIHTranslationPageSegments.stage(item, { theme: translationTheme }));
          placeholders.get(item)?.update({ state: 'loading' });
          pageStreams.set(segmentId, { operationToken, stage: placeholders.get(item), sequence: 0 });
          const result = await translateOne(item.source, 'page', options);
          pageStreams.delete(segmentId); processed += 1;
          if (cancelled || !body.isConnected || operationToken !== operationSerial) return;
          if (result?.confirmation) { if (!confirmation) { confirmation = result.confirmation; stopRequested = true; cancelTranslation(operationToken); restoreSnapshots(); } continue; }
          if (stopRequested) continue;
          if (result?.fatal) { fatalError = result.error || '翻译服务不可用'; stopRequested = true; failed += 1; clearStreams(); cancelTranslation(operationToken); return; }
          if (result?.ok && result.text && applyPageResult(item, result)) {
            translatedByIndex.set(item.index, result.text);
            pageAutoCopyEligible = pageAutoCopyEligible && result.autoCopy === true;
            succeeded += 1;
            if (result.cached) cacheHits += 1;
          }
          else { if (result?.cacheMiss) missingCache += 1; placeholders.get(item)?.update({ state: 'error', text: result?.error || '原文已变化，可以重试' }); failed += 1; if (!failedItems.includes(item)) failedItems.push(item); }
          updateProgress(label, total);
        }
      }
      // Every worker owns one request and its own segment placeholder. Start
      // them together so page translation is truly concurrent; each response
      // still settles into its original segment and can stream independently.
      await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
    }
    function renderPageConfirmation() {
      renderConfirmation(body, confirmation, async (target) => { await translatePage(target); }, () => { restoreSnapshots(); body.textContent = '已保持原文'; });
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
      clearPlaceholders();
      pageFinished = true;
      body.replaceChildren(); const summary = document.createElement('span'); summary.textContent = `${fatalError ? '翻译已暂停' : cancelled ? '翻译已停止' : restoring ? '已恢复页面译文' : '页面翻译完成'} · 成功 ${succeeded} · 跳过 ${skippedSameLanguage} · 失败 ${failed}`; body.append(summary);
      if (cacheHits) { const restored = document.createElement('p'); restored.className = 'muted'; restored.textContent = `${restoring ? '已恢复' : '已复用'} ${cacheHits} 段本机缓存`; body.append(restored); }
      if (fatalError) { const reason = document.createElement('p'); reason.textContent = fatalError; body.append(reason, settingsButton()); }
      if (failed > 0 && !fatalError) { const partial = document.createElement('div'); partial.textContent = missingCache ? `${missingCache} 段暂无缓存，点击继续翻译后再请求模型。` : '部分段落翻译失败，可重新执行。'; partial.style.cssText = 'margin-top:6px;color:var(--warning)'; body.append(partial); }
      const actions = document.createElement('footer'); actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      const copiedText = segments.slice().sort((left, right) => left.index - right.index).map((item) => translatedByIndex.get(item.index) || '').filter(Boolean).join('\n');
      const copyStatus = document.createElement('span'); copyStatus.setAttribute('data-copy-status', ''); copyStatus.setAttribute('role', 'status'); copyStatus.style.cssText = 'align-self:center;color:var(--muted);font-size:12px';
      if (copiedText) {
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制已完成译文'; copy.onclick = () => { void copyPageText(copyStatus, copy, copiedText); }; actions.append(copy);
      }
      if (failed > 0 && !fatalError && !cancelled) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = missingCache ? '继续翻译未缓存段落' : '重新翻译失败段落';
        retry.onclick = async () => { restoring = false; pageFinished = false; missingCache = 0; const retryItems = failedItems.splice(0); if (!retryItems.length) return; processed = 0; failed = Math.max(0, failed - retryItems.length); updateProgress('正在重试', retryItems.length); confirmation = null; await translateItems(retryItems, '正在重试'); if (confirmation) renderPageConfirmation(); else await renderSummary(); };
        actions.append(retry);
      }
      if (snapshots.length) { const undo = document.createElement('button'); undo.type = 'button'; undo.textContent = '撤回页面译文'; undo.onclick = () => { void pageState('clear', { operationId: operationToken }); restoreSnapshots(); body.textContent = '已撤回页面译文'; }; actions.append(undo); }
      if (actions.childElementCount) body.append(actions);
      if (copyStatus.textContent || copiedText) { actions.append(copyStatus); }
      const allSucceeded = !cancelled && !fatalError && failed === 0 && translatedByIndex.size === segments.length;
      if (!restoring && allSucceeded && succeeded > 0 && pageAutoCopyEligible && !pageCopyDone && copiedText.trim()) {
        pageCopyDone = true;
        const automaticCopy = actions.querySelector('button');
        if (automaticCopy) await copyPageText(copyStatus, automaticCopy, copiedText, true);
      }
    }
    updateProgress(restoring ? '正在恢复译文' : '正在翻译', segments.length);
    const preference = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'aih-translation-preferences' }, (result) => {
      void chrome.runtime.lastError; resolve(result || {});
    }));
    if (!body.isConnected || operationToken !== operationSerial || cancelled) return;
    concurrency = Math.max(1, Math.min(8, Math.floor(Number(preference.concurrency) || 3)));
    translationTheme = String(preference?.theme || 'plain');
    const targetLanguage = targetOverride || preference?.target || '';
    const skipped = segments.filter((item) => globalThis.AIHTranslationPageLanguage?.decide(item, targetLanguage)?.skip === true);
    skippedSameLanguage = skipped.length;
    skipped.forEach((item) => {
      placeholders.get(item)?.remove(); placeholders.delete(item);
      const marker = globalThis.AIHTranslationPageSegments.markSameLanguage?.(item, languageLabel(targetLanguage), { theme: 'plain' });
      if (marker) snapshots.push(marker);
      translatedByIndex.set(item.index, item.source);
    });
    const translatableSegments = segments.filter((item) => !skipped.includes(item));
    translatableSegments.forEach((item) => placeholders.set(item, globalThis.AIHTranslationPageSegments.stage(item, { theme: translationTheme })));
    updateProgress(restoring ? '正在恢复译文' : '正在翻译', translatableSegments.length);
    if (!body.isConnected || operationToken !== operationSerial || cancelled) return;
    await pageState('set', { operationId: operationToken, ...(targetOverride ? { target: targetOverride } : {}), restoring });
    if (!body.isConnected || operationToken !== operationSerial || cancelled) return;
    await translateItems(translatableSegments, '正在翻译');
    if (confirmation) { renderPageConfirmation(); return; }
    await renderSummary();
  }

  function controlClickContent(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target || target.closest(`[${ROOT_ATTR}],a,button,input,textarea,select,[contenteditable],[translate="no"],[hidden],[aria-hidden="true"],pre,code,[role="button"],[role="menu"]`)) return null;
    const selection = selected();
    if (selection && selection.range.intersectsNode(target)) return selection;
    const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (caret?.startContainer?.nodeType === 3 && target.contains(caret.startContainer)) {
      const node = caret.startContainer; const offset = caret.startOffset;
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
      const word = [...segmenter.segment(node.nodeValue)].find((item) => item.isWordLike && offset >= item.index && offset <= item.index + item.segment.length);
      if (word) {
        const range = document.createRange(); range.setStart(node, word.index); range.setEnd(node, word.index + word.segment.length);
        return { text: word.segment, range, rect: range.getBoundingClientRect() };
      }
    }
    const owner = target.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote') || target;
    const segment = globalThis.AIHTranslationPageSegments.collect(owner)[0];
    return segment ? { text: segment.source, range: null, rect: owner.getBoundingClientRect() } : null;
  }
  let controlGesture = null;
  let consumedControlClick = null;
  document.addEventListener('pointerdown', (event) => {
    controlGesture = null; consumedControlClick = null;
    if (!event.ctrlKey || event.button !== 0 || event.metaKey || event.altKey) return;
    const item = controlClickContent(event); if (!item) return;
    controlGesture = { item, x: event.clientX, y: event.clientY, at: Date.now() };
    consumedControlClick = controlGesture;
    // Control-click is a native context-menu gesture on macOS. Consume only
    // the explicit translation chord over readable content.
    event.preventDefault();
  }, true);
  document.addEventListener('contextmenu', (event) => {
    const gesture = consumedControlClick;
    if (event.ctrlKey && gesture && Date.now() - gesture.at < 1200 && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6) { event.preventDefault(); consumedControlClick = null; }
  }, true);
  document.addEventListener('pointercancel', () => { controlGesture = null; consumedControlClick = null; }, true);
  document.addEventListener('pointerup', (event) => {
    const gesture = controlGesture; controlGesture = null;
    if (!gesture || !event.ctrlKey || event.button !== 0 || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) return;
    event.preventDefault();
    void translateSelection(gesture.item.text, gesture.item.rect, gesture.item.range);
  }, true);

  const initialOperation = operationSerial;
  void pageState('get').then(async (result) => {
    if (result?.state && operationSerial === initialOperation && !active) { void translatePage(result.state.target || '', { restoring: true }); return; }
    // Not restoring a previous translation: translate on load if the user marked this
    // site "always translate". Only top frames, so iframes don't each open a panel.
    if (window.top !== window || operationSerial !== initialOperation || active) return;
    const site = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'aih-auto-site', action: 'get' }, (response) => resolve(chrome.runtime.lastError ? null : response)));
    if (site?.enabled && operationSerial === initialOperation && !active) void translatePage();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'aih-translation-progress' && message.segmentId && message.operationId === operationSerial && active?.body?.isConnected) {
      const stream = pageStreams.get(message.segmentId);
      if (stream && Number.isSafeInteger(message.sequence) && message.sequence > stream.sequence) {
        stream.sequence = message.sequence;
        stream.stage?.update({ state: 'loading', content: String(message.text || '') });
      }
    }
    if (message?.type === 'aih-translation-progress' && selectionProgress?.operationToken === message.operationId && !message.segmentId && message.operationId === operationSerial && selectionProgress.body.isConnected) {
      if (!Number.isSafeInteger(message.sequence) || message.sequence <= selectionProgress.sequence) return;
      selectionProgress.sequence = message.sequence;
      const { status, output, skeleton } = selectionProgress;
      status.lastChild.textContent = message.text ? '正在生成译文…' : '模型已连接，正在翻译…';
      if (message.text) {
        skeleton.remove();
        updateReadingText(output, message.text);
      }
    }
    if (message?.type === 'aih-translate-selection') { const item = selected(); if (item) void translateSelection(message.text || item.text, item.rect, item.range); }
    if (message?.type === 'aih-translate-page') void translatePage(message.target || '');
    if (message?.type === 'aih-undo-page') { pagePresentation?.undo(); pagePresentation = null; void pageState('clear', { operationId: operationSerial }); }
    if (message?.type === 'aih-toggle-page') {
      if (pagePresentation) { pagePresentation.undo(); pagePresentation = null; void pageState('clear', { operationId: operationSerial }); }
      else void translatePage();
    }
  });
  // The toolbar popup asks the page for its state so it can offer "translate" or "undo".
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'aih-page-status') return false;
    sendResponse({ ok: true, translated: Boolean(pagePresentation), active: Boolean(active) });
    return false;
  });
})();
