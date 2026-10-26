/* global chrome, document, innerWidth, innerHeight, window */
/* A shadow-root surface keeps page CSS and translation controls independent. */
(() => {
  const styles = `
    :host{all:initial;color-scheme:light dark;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#25262c}
    *{box-sizing:border-box}button,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.55}
    .surface{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--surface:#fffffff5;--text:#25262c;--muted:#6c707a;--line:#171a2314;--soft:#f0f1f5;--accent:#5555d9;--warning:#a04b25;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:22px;box-shadow:0 18px 64px #15162926,0 2px 8px #15162912;backdrop-filter:blur(24px);overflow:hidden;display:flex;flex-direction:column;max-height:inherit;animation:enter .2s ease-out}
    header{flex-shrink:0;display:flex;align-items:center;gap:9px;padding:14px 15px 12px;cursor:grab;touch-action:none;user-select:none;border-bottom:1px solid var(--line)}header:active{cursor:grabbing}.mark{display:grid;place-items:center;width:30px;height:30px;border-radius:10px;background:var(--soft);color:var(--accent);font-size:17px;font-weight:650}.heading{min-width:0;flex:1}h2{font-size:13px;line-height:1.4;font-weight:650;letter-spacing:.01em;margin:0}.hint{display:block;color:var(--muted);font-size:11px;margin-top:1px}.icon{display:grid;place-items:center;width:29px;height:29px;flex-shrink:0;border:0;border-radius:9px;background:transparent;color:var(--muted);padding:6px}.icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.icon:hover,.icon[aria-pressed=true]{background:var(--soft);color:var(--accent)}
    .body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;padding:18px;overflow-wrap:anywhere;white-space:normal}.body:focus{outline:none}.body>*{max-width:100%;min-width:0;animation:reveal .18s ease-out}.body button{border:1px solid var(--line);border-radius:11px;padding:7px 12px;background:var(--soft);color:var(--text);font-size:12px;font-weight:550;transition:background .15s,transform .15s}.body button:hover:not(:disabled){background:color-mix(in srgb,var(--accent) 12%,var(--soft))}.body button:active:not(:disabled){transform:scale(.97)}button:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.body button.primary{background:var(--accent);border-color:transparent;color:#fff}.body select{width:100%;min-width:0;border:1px solid var(--line);border-radius:10px;background:var(--soft);color:var(--text);padding:8px}.body footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:18px;padding-top:13px;border-top:1px solid var(--line)}.body p{margin:8px 0}.muted{color:var(--muted);font-size:12px}.label{font-size:11px;font-weight:600;letter-spacing:.05em;color:var(--muted);margin:0 0 8px}.reading{white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;line-height:1.85;font-size:15px;letter-spacing:.015em;max-height:46vh;overflow:auto;overscroll-behavior:contain;padding-right:3px}.source{margin:0 0 17px;padding-bottom:13px;border-bottom:1px solid var(--line)}summary{cursor:pointer;color:var(--muted);font-size:12px}.source .reading{font-size:13px;line-height:1.7;color:var(--muted);max-height:120px;margin-top:8px}.status{display:flex;align-items:center;gap:8px;min-height:22px;font-size:13px}.spinner{width:13px;height:13px;flex-shrink:0;border:1.5px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}.stream:empty{display:none}.stream{margin-top:15px}.skeleton{height:8px;margin-top:13px;border-radius:4px;background:linear-gradient(90deg,var(--soft),var(--line),var(--soft));background-size:200%;animation:shimmer 1.8s ease infinite}.skeleton:last-child{width:65%}progress{width:100%;height:5px;border:0;border-radius:8px;overflow:hidden;accent-color:var(--accent);margin:14px 0 5px}progress::-webkit-progress-bar{background:var(--soft)}progress::-webkit-progress-value{background:var(--accent);transition:width .2s}.body[data-state=error] .status{color:#b44a38}
    @media(prefers-color-scheme:dark){.surface{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--surface:#202127f5;--text:#eff0f5;--muted:#a1a5b3;--line:#ffffff14;--soft:#30323b;--accent:#a2a0ff;--warning:#efb28c;box-shadow:0 18px 64px #0005,0 2px 8px #0003}.body button.primary{color:#171727}.body[data-state=error] .status{color:#ffb3a1}}
    @keyframes reveal{from{opacity:0}to{opacity:1}}@keyframes enter{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes shimmer{to{background-position:-200%}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
  `;
  const icons = {
    pin: '<path d="m9 3 6 0-1 5 3 3v2H7v-2l3-3-1-5Z"/><path d="M12 13v8"/>',
    settings: '<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>'
  };
  function create(title, rect, onClose, { compact = false } = {}) {
    const previousFocus = document.activeElement;
    const root = document.createElement('section');
    root.setAttribute('data-aih-translation-extension', 'panel');
    root.style.cssText = `all:initial;position:fixed;z-index:2147483647;width:min(410px,calc(100vw - 24px));max-height:calc(100vh - 24px);display:block;${compact ? '' : 'height:min(520px,calc(100vh - 24px));'}`;
    const shadow = root.attachShadow({ mode: 'closed' });
    const style = document.createElement('style'); style.textContent = styles;
    const surface = document.createElement('section'); surface.className = 'surface'; if (!compact) surface.style.height = '100%'; surface.setAttribute('role', 'dialog'); surface.setAttribute('aria-label', title);
    const header = document.createElement('header');
    const mark = document.createElement('span'); mark.className = 'mark'; mark.textContent = '译'; mark.setAttribute('aria-hidden', 'true');
    const heading = document.createElement('div'); heading.className = 'heading';
    const name = document.createElement('h2'); name.textContent = title;
    const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = '拖动标题移动 · Esc 关闭'; heading.append(name, hint);
    function icon(type, label) { const button = document.createElement('button'); button.className = 'icon'; button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[type]}</svg>`; return button; }
    let pinned = false; let destroyed = false; let drag = null;
    const pin = icon('pin', '固定浮层，点击页面时保持显示'); pin.setAttribute('aria-pressed', 'false');
    pin.onclick = () => { pinned = !pinned; pin.setAttribute('aria-pressed', String(pinned)); pin.title = pinned ? '取消固定浮层' : '固定浮层，点击页面时保持显示'; pin.setAttribute('aria-label', pin.title); hint.textContent = pinned ? '已固定 · 拖动标题移动' : '拖动标题移动 · Esc 关闭'; };
    const settings = icon('settings', '翻译设置'); settings.onclick = () => chrome.runtime.sendMessage({ type: 'aih-open-translation-settings' });
    const close = icon('close', '关闭翻译面板');
    header.append(mark, heading, pin, settings, close);
    const body = document.createElement('div'); body.className = 'body'; body.tabIndex = -1;
    surface.append(header, body); shadow.append(style, surface); document.documentElement.append(root);
    function place(left, top) { const bounds = root.getBoundingClientRect(); root.style.left = `${Math.max(12, Math.min(left, innerWidth - bounds.width - 12))}px`; root.style.top = `${Math.max(12, Math.min(top, innerHeight - bounds.height - 12))}px`; }
    place(rect?.left || 20, (rect?.bottom || 20) + 10);
    const resize = () => { const bounds = root.getBoundingClientRect(); place(bounds.left, bounds.top); };
    const outside = (event) => { if (!pinned && !event.composedPath().includes(root)) dismiss(); };
    function destroy() { if (destroyed) return; destroyed = true; window.removeEventListener('resize', resize); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); const restoreFocus = document.activeElement === root; root.remove(); if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); }
    function dismiss() { onClose(); destroy(); }
    close.onclick = dismiss;
    const escape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const inPanel = event.composedPath().includes(root);
      if (!inPanel && event.target.closest?.('input,textarea,select,[contenteditable],[role=menu],[role=listbox],[role=dialog]')) return;
      event.preventDefault(); dismiss();
    };
    document.addEventListener('keydown', escape);
    header.addEventListener('pointerdown', (event) => { if (event.button !== 0 || event.target.closest('button')) return; const bounds = root.getBoundingClientRect(); drag = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }; header.setPointerCapture(event.pointerId); event.preventDefault(); });
    header.addEventListener('pointermove', (event) => { if (drag) place(event.clientX - drag.x, event.clientY - drag.y); });
    header.addEventListener('pointerup', () => { drag = null; }); header.addEventListener('pointercancel', () => { drag = null; });
    window.addEventListener('resize', resize); document.addEventListener('pointerdown', outside, true);
    body.focus({ preventScroll: true });
    return { root, body, destroy };
  }
  globalThis.AIHTranslationPanel = { create };
})();
