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
    :root { color-scheme: dark; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { display: flex; flex-direction: column; background: #0f0f11; color: #e4e4e7; }
    .toolbar { min-height: 56px; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #2b2b31; background: #17171a; }
    .identity { min-width: 0; display: flex; align-items: center; gap: 10px; }
    .signal { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: #5cc389; }
    .title { overflow: hidden; color: #fafafa; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .subtitle { color: #a1a1aa; font-family: "JetBrains Mono", "SF Mono", ui-monospace, Consolas, monospace; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
    .controls, .devices { display: flex; align-items: center; gap: 6px; }
    .device { min-height: 32px; padding: 5px 12px; border: 1px solid #2b2b31; border-radius: 6px; background: #17171a; color: #a1a1aa; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background-color 120ms, border-color 120ms, color 120ms; }
    .device:hover { border-color: #3b3b42; color: #fafafa; }
    .device[aria-pressed="true"] { border-color: #f4f4f5; background: #f4f4f5; color: #18181b; }
    .fullscreen { min-height: 32px; padding: 5px 12px; border: 1px solid #3b3b42; border-radius: 6px; background: transparent; color: #e4e4e7; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background-color 120ms, border-color 120ms; }
    .fullscreen:hover { border-color: #52525b; background: rgba(255, 255, 255, .07); }
    .fullscreen[hidden] { display: none; }
    .stage { flex: 1; min-height: 0; padding: 16px; display: flex; align-items: center; justify-content: center; overflow: auto; background: #0f0f11; }
    .preview { display: block; border: 1px solid #2b2b31; background: #fff; transition: width 160ms cubic-bezier(0.2, 0, 0, 1), height 160ms cubic-bezier(0.2, 0, 0, 1), border-radius 160ms cubic-bezier(0.2, 0, 0, 1); }
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
