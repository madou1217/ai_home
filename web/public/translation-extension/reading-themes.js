/* global document */
(() => {
  const border = (style) => `padding:10px 12px;border:1px ${style} color-mix(in srgb,currentColor 24%,transparent);border-radius:10px;`;
  const underline = (style) => `text-decoration:underline ${style} color-mix(in srgb,currentColor 48%,transparent);text-decoration-thickness:1px;text-underline-offset:.23em;text-decoration-skip-ink:auto;`;
  const descriptors = [
    { id: 'plain', label: '自然阅读', description: '沿用页面字体与颜色，译文自然融入正文。', frame: '', text: '' },
    { id: 'solid', label: '细实线', description: '完整细边框，清楚区分原文与译文。', frame: border('solid') },
    { id: 'dashed', label: '虚线', description: '轻量虚线边框，适合对照阅读。', frame: border('dashed') },
    { id: 'dotted', label: '点线', description: '细点边框，保持轻盈的段落边界。', frame: border('dotted') },
    ...[['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线'], ['wavy', '波浪']].map(([style, label]) => ({ id: `underline-${style}`, label: `${label}下划线`, description: '仅标记译文文字，随每行文字换行。', frame: '', text: underline(style) })),
    { id: 'soft', label: '柔和底色', description: '低对比底色，让长段落更容易辨认。', frame: 'padding:10px 12px;border-radius:10px;background:color-mix(in srgb,currentColor 6%,transparent);' },
    { id: 'hud', label: 'HUD', description: '冷色细线与轻透明底板，保留正文的可读性。', frame: 'padding:11px 13px;border:1px solid color-mix(in srgb,#38bdf8 45%,currentColor 20%);border-radius:10px;background:color-mix(in srgb,#38bdf8 6%,transparent);box-shadow:0 3px 12px #0891b210;' },
    { id: 'cyberpunk', label: 'Cyberpunk', description: '克制的青紫渐变和霓虹边缘，无闪烁或持续发光动画。', frame: 'padding:11px 13px;border:1px solid color-mix(in srgb,#c026d3 48%,currentColor 20%);border-radius:10px;background:linear-gradient(120deg,#22d3ee0c,#d946ef0c);box-shadow:0 2px 12px #c026d312;' }
  ].map(Object.freeze);
  const byId = new Map(descriptors.map((theme) => [theme.id, theme]));
  const normalize = (value) => byId.has(value) ? value : 'plain';
  const css = `
    :host{font:inherit;color:inherit}*{box-sizing:border-box}[hidden]{display:none!important}
    .frame,.body,.content{min-inline-size:0;max-inline-size:100%}.frame{font:inherit;color:inherit;text-align:start;transition:background-color .16s,border-color .16s,box-shadow .16s}
    .content{font:inherit;color:inherit;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;line-height:1.8;text-align:start;unicode-bidi:plaintext}
    .status,summary,button,.hint{font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.status,.hint{opacity:.7}.status{display:flex;align-items:center;gap:7px}.dot{inline-size:6px;block-size:6px;border-radius:50%;background:currentColor;opacity:.5;flex:none}
    .bars{max-inline-size:560px;margin-block:9px}.bar{block-size:7px;border-radius:9px;background:currentColor;opacity:.09;margin-block:8px;animation:breathe 1.6s ease-in-out infinite}.bar:last-child{inline-size:64%;animation-delay:.2s}
    details{margin-block-start:10px}summary{cursor:pointer;opacity:.75;inline-size:fit-content}details .content{margin-block:8px;max-block-size:200px;overflow:auto;overscroll-behavior:contain;font-size:.94em;text-decoration:none}
    button{cursor:pointer;padding:3px 9px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:7px;background:transparent;color:inherit}button:hover{background:color-mix(in srgb,currentColor 6%,transparent)}button:focus-visible,summary:focus-visible{outline:2px solid currentColor;outline-offset:3px}.hint{margin-block-end:4px}
    ${descriptors.map((theme) => `.theme-${theme.id}{${theme.frame}}.theme-${theme.id} .translation{${theme.text || ''}}`).join('\n')}
    @keyframes breathe{50%{opacity:.18}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}@media(forced-colors:active){.frame{background:Canvas;box-shadow:none;border-color:CanvasText}.content{color:CanvasText;text-decoration-color:CanvasText}}
  `;
  function mount(host, theme = 'plain') {
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style'); style.textContent = css;
    const frame = document.createElement('div');
    const body = document.createElement('div'); body.className = 'body'; frame.append(body); shadow.append(style, frame);
    const setTheme = (value) => { frame.className = `frame theme-${normalize(value)}`; };
    setTheme(theme);
    return { body, setTheme };
  }
  globalThis.AIHReadingThemes = Object.freeze({ list: Object.freeze(descriptors), normalize, mount });
})();
