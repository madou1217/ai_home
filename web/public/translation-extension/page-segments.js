/* global document, getComputedStyle */
(() => {
  const ownedNodes = new WeakSet();
  const ROOT_ATTR = 'data-aih-translation-extension';
  const excluded = 'script,style,noscript,svg,canvas,pre,textarea,input,select,button,form,iframe,object,embed,[contenteditable]:not([contenteditable="false"]),[translate="no"],[inert],[aria-hidden="true"],[hidden]';
  const semanticBlocks = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'DT', 'DD', 'TD', 'TH', 'CAPTION', 'FIGCAPTION', 'BLOCKQUOTE', 'ADDRESS']);

  function declaredLanguage(element) {
    const value = element.closest('[lang]')?.getAttribute('lang') || '';
    if (!value.trim()) return '';
    try {
      const locale = new Intl.Locale(value.trim().replace(/_/g, '-'));
      return locale.language === 'zh' ? locale.maximize().script === 'Hant' ? 'zh-Hant' : 'zh-Hans' : locale.language;
    } catch { return ''; }
  }

  function attributesOf(node) {
    return node.nodeType === 1 ? [...node.attributes].map(({ name, value }) => [name, value]) : [];
  }
  function attributesMatch(node, attributes) {
    return node.nodeType !== 1 || node.attributes.length === attributes.length
      && attributes.every(([name, value]) => node.getAttribute(name) === value);
  }
  function sourceText(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeName === 'BR') return '\n';
    return [...node.childNodes].map(sourceText).join('');
  }

  function collect(root = document.body) {
    if (!root) return [];
    const segments = [];
    const styles = new WeakMap();
    const styleOf = (element) => {
      if (!styles.has(element)) styles.set(element, getComputedStyle(element));
      return styles.get(element);
    };
    const isExcluded = (element) => element.hasAttribute(ROOT_ATTR) || element.matches(excluded)
      || (element.tagName === 'CODE' && !['inline', 'inline-block', 'contents'].includes(styleOf(element).display))
      || styleOf(element).display === 'none' || ['hidden', 'collapse'].includes(styleOf(element).visibility);
    const hasLanguageBoundary = (element) => element.hasAttribute('lang') && declaredLanguage(element) !== (element.parentElement ? declaredLanguage(element.parentElement) : '');
    const isBoundary = (element) => semanticBlocks.has(element.tagName) || hasLanguageBoundary(element)
      || !['inline', 'inline-block', 'contents'].includes(styleOf(element).display)
      || (element.tagName === 'A' && Boolean(element.closest('nav,[role="navigation"]')));

    // A run is contiguous inline content within one semantic block. Descendant
    // blocks and excluded controls split runs rather than joining unrelated text.
    function walk(container, owner, run) {
      for (const child of container.childNodes) {
        if (child.nodeType === 3) { run.nodes.push(child); continue; }
        if (child.nodeType !== 1) { flush(owner, run); continue; }
        if (isExcluded(child)) { flush(owner, run); continue; }
        if (child.tagName === 'BR') { run.nodes.push(child); continue; }
        if (isBoundary(child)) {
          flush(owner, run);
          const nested = { nodes: [] }; walk(child, child, nested); flush(child, nested);
        } else {
          // Keep an inline subtree as one unit only when it has no block/control
          // descendants; otherwise descend and split at the same boundaries.
          const descendants = [...child.querySelectorAll('*')];
          if (descendants.some((node) => isExcluded(node) || isBoundary(node))) {
            flush(owner, run); const nested = { nodes: [] }; walk(child, child, nested); flush(child, nested);
          } else run.nodes.push(child);
        }
      }
    }

    function flush(owner, run) {
      const roots = run.nodes.splice(0);
      if (!roots.length) return;
      const records = [];
      function snapshot(node) {
        records.push({ node, parent: node.parentNode, value: node.nodeType === 3 ? node.nodeValue : null, children: [...node.childNodes], attributes: attributesOf(node) });
        for (const child of node.childNodes) snapshot(child);
      }
      roots.forEach(snapshot);
      const source = roots.map(sourceText).join('').replace(/[\t\r ]+/g, ' ').trim();
      if (source.length < 2) return;
      const declaration = owner.closest('[lang]');
      segments.push({ owner, ownerParent: owner.parentNode, ownerAttributes: attributesOf(owner), ownerChildren: [...owner.childNodes].filter((node) => !ownedNodes.has(node)), roots, records, source, sourceLanguage: declaredLanguage(owner), languageSource: declaration && !['HTML', 'BODY'].includes(declaration.tagName) ? 'local-declaration' : 'document-default', index: segments.length });
    }
    if (!isExcluded(root)) { const run = { nodes: [] }; walk(root, root, run); flush(root, run); }
    return segments;
  }

  function isCurrent(segment) {
    if (!segment.owner.isConnected || segment.owner.parentNode !== segment.ownerParent) return false;
    if (segment.owner.closest(excluded) || !attributesMatch(segment.owner, segment.ownerAttributes)) return false;
    const ownerChildren = [...segment.owner.childNodes].filter((node) => !ownedNodes.has(node));
    if (ownerChildren.length !== segment.ownerChildren.length || ownerChildren.some((node, index) => node !== segment.ownerChildren[index])) return false;
    return segment.records.every(({ node, parent, value, children, attributes }) => node.isConnected && node.parentNode === parent
      && (value === null || node.nodeValue === value) && attributesMatch(node, attributes)
      && node.childNodes.length === children.length && children.every((child, index) => node.childNodes[index] === child))
      && segment.roots.every((node, index) => index === 0 || segment.roots[index - 1].nextSibling === node);
  }

  function surface(segment, kind, theme = 'plain') {
    const anchor = segment.roots[segment.roots.length - 1];
    const parent = anchor.parentNode;
    const marker = document.createElement('span');
    marker.setAttribute(ROOT_ATTR, kind); marker.style.cssText = 'display:block;min-inline-size:0;max-inline-size:100%;margin-block:0.4em 0.7em;';
    ownedNodes.add(marker);
    const { body, setTheme } = globalThis.AIHReadingThemes.mount(marker, theme);
    parent.insertBefore(marker, anchor.nextSibling);
    const attributes = attributesOf(marker);
    const current = () => marker.isConnected && marker.parentNode === parent && attributesMatch(marker, attributes) && marker.childNodes.length === 0;
    return { body, current, setTheme, remove() { if (current()) marker.remove(); } };
  }

  function stage(segment, options = {}) {
    if (!isCurrent(segment)) return null;
    const shell = surface(segment, 'pending', options.theme);
    const status = document.createElement('div'); status.className = 'status'; status.setAttribute('role', 'status');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); status.append(dot, label);
    const bars = document.createElement('div'); bars.className = 'bars'; bars.setAttribute('aria-hidden', 'true');
    let content = null;
    for (let index = 0; index < 2; index += 1) { const bar = document.createElement('div'); bar.className = 'bar'; bars.append(bar); }
    shell.body.append(status, bars);
    const update = (value = {}) => {
      if (!shell.current()) return;
      const state = value.state || 'pending';
      label.textContent = value.text || ({ pending: '等待翻译', loading: '正在生成译文…', error: '翻译失败，可重试', stopped: '翻译已停止' }[state] || '等待翻译');
      bars.hidden = !['pending', 'loading'].includes(state) || Boolean(value.content);
      if (typeof value.content === 'string') {
        if (!content) { content = document.createElement('div'); content.className = 'content translation'; content.dir = 'auto'; shell.body.append(content); }
        const previous = content.textContent;
        if (content.firstChild && value.content.startsWith(previous)) content.firstChild.appendData(value.content.slice(previous.length));
        else content.textContent = value.content;
      }
    };
    update();
    return { update, setTheme: shell.setTheme, remove: shell.remove };
  }

  function apply(segment, text, mode, options = {}) {
    if (!String(text || '').trim() || !isCurrent(segment)) return null;
    options.stage?.remove();
    const plain = segment.roots.every((node) => node.nodeType === 3);
    // The text-only protocol has no trustworthy inline alignment. Rich source
    // keeps its links, emphasis and listeners; translated text is an annotation.
    const ownerStyle = getComputedStyle(segment.owner);
    const safeReplacement = plain && !segment.owner.closest('a,button,summary,[role="button"],[role="link"],[role="textbox"]')
      && !['inline', 'contents'].includes(ownerStyle.display)
      && !['nowrap', 'pre'].includes(ownerStyle.whiteSpace)
      && !['hidden', 'clip'].includes(ownerStyle.overflowY);
    if (mode === 'replace' && safeReplacement) {
      const writes = segment.roots.map((node) => ({ node, parent: node.parentNode, original: node.nodeValue, written: '' }));
      const shell = surface(segment, 'replacement', options.theme);
      const translated = document.createElement('div'); translated.className = 'content translation'; translated.dir = 'auto'; translated.textContent = text; shell.body.append(translated);
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '查看原文';
      const original = document.createElement('div'); original.className = 'content'; original.dir = 'auto'; original.textContent = writes.map((item) => item.original).join('');
      const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = '还原这一段';
      let undone = false;
      const undo = () => {
        if (undone) return; undone = true;
        for (const item of writes) {
          if (item.node.isConnected && item.node.parentNode === item.parent && item.node.nodeValue === item.written) item.node.nodeValue = item.original;
        }
        shell.remove();
      };
      restore.onclick = undo; details.append(summary, original, restore); shell.body.append(details);
      writes.forEach(({ node, written }) => { node.nodeValue = written; });
      return { mode: 'replace', undo };
    }
    const shell = surface(segment, 'side-by-side', options.theme);
    if (mode === 'replace') {
      const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = plain ? '保留原文，译文在下方显示' : '保留原文与链接'; shell.body.append(hint);
    }
    const content = document.createElement('div'); content.className = 'content translation'; content.dir = 'auto'; content.textContent = text; shell.body.append(content);
    return { mode: 'side-by-side', undo: shell.remove };
  }

  function markSameLanguage(segment, label, options = {}) {
    if (!isCurrent(segment)) return null;
    const shell = surface(segment, 'same-language', options.theme);
    const content = document.createElement('div'); content.className = 'hint'; content.textContent = `✓ 已是${label || '目标语言'} · 保留原文`;
    shell.body.append(content);
    return { undo: shell.remove };
  }

  globalThis.AIHTranslationPageSegments = { collect, stage, apply, markSameLanguage, isCurrent };
})();
