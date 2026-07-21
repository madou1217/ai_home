export type HtmlPreviewDevice = 'desktop' | 'mobile';

export interface HtmlPreviewWindowOptions {
  device: HtmlPreviewDevice;
  title?: string;
}

const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
const PREVIEW_URL_REVOKE_DELAY_MS = 60_000;

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildHtmlPreviewWindowDocument(
  documentContent: string,
  options: HtmlPreviewWindowOptions
) {
  const initialDevice = options.device === 'mobile' ? 'mobile' : 'desktop';
  const rawTitle = options.title || 'HTML 预览';
  const title = escapeHtml(rawTitle);
  const titleAttribute = escapeHtmlAttribute(rawTitle);
  const srcDoc = escapeHtmlAttribute(documentContent);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; font-family: "Avenir Next", "PingFang SC", sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { display: flex; flex-direction: column; background: #17191f; color: #f6f7f9; }
    .toolbar { min-height: 56px; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #30343d; background: #111318; }
    .identity { min-width: 0; display: flex; align-items: center; gap: 10px; }
    .signal { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: #65d49a; box-shadow: 0 0 0 4px rgba(101, 212, 154, .14); }
    .title { overflow: hidden; color: #f6f7f9; font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
    .subtitle { color: #8f96a3; font-family: "SFMono-Regular", Consolas, monospace; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
    .controls, .devices { display: flex; align-items: center; gap: 6px; }
    .device { min-height: 32px; padding: 5px 12px; border: 1px solid #363b46; border-radius: 7px; background: #1d2027; color: #aeb4bf; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
    .device:hover { border-color: #626b7b; color: #fff; }
    .device[aria-pressed="true"] { border-color: #f0b35b; background: #f0b35b; color: #17191f; }
    .fullscreen { min-height: 32px; padding: 5px 12px; border: 1px solid #626b7b; border-radius: 7px; background: transparent; color: #f6f7f9; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
    .fullscreen:hover { border-color: #f6f7f9; background: #252a34; }
    .fullscreen[hidden] { display: none; }
    .stage { flex: 1; min-height: 0; padding: 16px; display: flex; align-items: center; justify-content: center; overflow: auto; background: radial-gradient(circle at 50% 0%, #252a34 0%, #17191f 54%); }
    .preview { display: block; border: 1px solid #3a404b; background: #fff; box-shadow: 0 24px 70px rgba(0, 0, 0, .42); transition: width .18s ease, height .18s ease, border-radius .18s ease; }
    .preview:fullscreen { width: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none; }
    .stage[data-device="desktop"] .preview { width: 100%; height: 100%; border-radius: 10px; }
    .stage[data-device="mobile"] .preview { width: min(390px, calc(100vw - 24px)); height: min(844px, calc(100vh - 96px)); border-width: 8px; border-color: #090a0d; border-radius: 30px; }
    @media (max-width: 560px) {
      .toolbar { align-items: flex-start; flex-direction: column; gap: 8px; }
      .controls, .devices { width: 100%; }
      .controls { align-items: stretch; }
      .device { flex: 1; }
      .fullscreen { flex: 0 0 auto; }
      .stage { padding: 8px; }
      .stage[data-device="mobile"] .preview { height: calc(100vh - 122px); }
    }
  </style>
</head>
<body>
  <header class="toolbar">
    <div class="identity">
      <span class="signal" aria-hidden="true"></span>
      <div>
        <div class="title">${title}</div>
        <div class="subtitle">Isolated HTML preview</div>
      </div>
    </div>
    <div class="controls">
      <div class="devices" role="group" aria-label="预览设备">
        <button class="device" type="button" data-device-option="desktop" aria-pressed="${initialDevice === 'desktop'}">PC 预览</button>
        <button class="device" type="button" data-device-option="mobile" aria-pressed="${initialDevice === 'mobile'}">手机预览</button>
      </div>
      <button class="fullscreen" type="button" data-fullscreen${initialDevice === 'mobile' ? ' hidden' : ''}>全屏</button>
    </div>
  </header>
  <main class="stage" data-preview-stage data-device="${initialDevice}">
    <iframe class="preview" title="${titleAttribute}" sandbox="${HTML_PREVIEW_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${srcDoc}"></iframe>
  </main>
  <script>
    const stage = document.querySelector('[data-preview-stage]');
    const preview = document.querySelector('.preview');
    const fullscreen = document.querySelector('[data-fullscreen]');
    document.querySelectorAll('[data-device-option]').forEach((button) => {
      button.addEventListener('click', () => {
        stage.dataset.device = button.dataset.deviceOption;
        fullscreen.hidden = button.dataset.deviceOption !== 'desktop';
        document.querySelectorAll('[data-device-option]').forEach((option) => {
          option.setAttribute('aria-pressed', String(option === button));
        });
      });
    });
    fullscreen.addEventListener('click', async () => {
      if (typeof preview.requestFullscreen !== 'function') return;
      try {
        await preview.requestFullscreen();
      } catch (_error) {
        // 浏览器拒绝全屏时保留普通 PC 预览，不影响页面交互。
      }
    });
  </script>
</body>
</html>`;
}

export function openHtmlPreviewWindow(
  documentContent: string,
  options: HtmlPreviewWindowOptions
) {
  if (typeof window === 'undefined' || typeof Blob === 'undefined') return false;

  const previewDocument = buildHtmlPreviewWindowDocument(documentContent, options);
  const previewUrl = window.URL.createObjectURL(new Blob([previewDocument], { type: 'text/html' }));
  const link = window.document.createElement('a');
  link.href = previewUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.click();
  window.setTimeout(() => window.URL.revokeObjectURL(previewUrl), PREVIEW_URL_REVOKE_DELAY_MS);
  return true;
}
