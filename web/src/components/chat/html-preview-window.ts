import { ensurePreviewWindowCaptureHost } from '../../features/capture';

export type HtmlPreviewDevice = 'desktop' | 'mobile';

export interface HtmlPreviewWindowOptions {
  device: HtmlPreviewDevice;
  title?: string;
}

const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
const PREVIEW_URL_REVOKE_DELAY_MS = 60_000;

/** 与宿主 preview-window-host.ts 约定的消息契约（弹窗侧不能 import，保持常量同步）。 */
const CAPTURE_REQUEST_TYPE = 'aih:html-preview-capture-request';
const CAPTURE_RESULT_TYPE = 'aih:html-preview-capture-result';

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
    /* 独立 blob 页面拿不到应用的 CSS 变量：这里内联深色 Cyber HUD 取值（design-tokens.css [data-theme='dark']）。 */
    :root { color-scheme: dark; font-family: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, "PingFang SC", monospace; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { display: flex; flex-direction: column; background: #05080e; color: #e2f1f8; }
    .toolbar { min-height: 56px; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(0, 240, 255, .35); background: #0a101a; box-shadow: 0 0 18px rgba(0, 240, 255, .12); }
    .identity { min-width: 0; display: flex; align-items: center; gap: 10px; }
    .signal { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: #00ff66; box-shadow: 0 0 6px #00ff66; }
    .title { overflow: hidden; color: #f2fbff; font-size: 13px; font-weight: 700; letter-spacing: .02em; text-overflow: ellipsis; white-space: nowrap; }
    .subtitle { color: #5c7890; font-size: 10px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
    .controls, .devices { display: flex; align-items: center; gap: 6px; }
    .device { min-height: 32px; padding: 5px 12px; border: 1px solid #15263d; border-radius: 0; background: #03060b; color: #7f9bb3; font: inherit; font-size: 12px; font-weight: 600; letter-spacing: .04em; cursor: pointer; transition: background-color 120ms, border-color 120ms, color 120ms, box-shadow 120ms; }
    .capture { min-height: 32px; padding: 5px 12px; border: 1px solid #23405f; border-radius: 0; background: #0c1524; color: #e2f1f8; font: inherit; font-size: 12px; font-weight: 600; letter-spacing: .04em; cursor: pointer; transition: background-color 120ms, border-color 120ms, color 120ms; }
    .capture:hover { border-color: #00f0ff; color: #00f0ff; background: rgba(0, 240, 255, .08); }
    .capture:disabled { opacity: .65; cursor: default; }
    .capture-status { color: #5c7890; font-size: 11px; font-weight: 600; letter-spacing: .04em; white-space: nowrap; }
    .capture-status[hidden] { display: none; }
    .device:hover { border-color: rgba(0, 240, 255, .55); color: #00f0ff; }
    .device[aria-pressed="true"] { border-color: #00f0ff; background: rgba(0, 240, 255, .14); color: #00f0ff; box-shadow: 0 0 18px rgba(0, 240, 255, .25); text-shadow: 0 0 10px rgba(0, 240, 255, .55); }
    .fullscreen { min-height: 32px; padding: 5px 12px; border: 1px solid #23405f; border-radius: 0; background: #0c1524; color: #e2f1f8; font: inherit; font-size: 12px; font-weight: 600; letter-spacing: .04em; cursor: pointer; transition: background-color 120ms, border-color 120ms, color 120ms; }
    .fullscreen:hover { border-color: #00f0ff; color: #00f0ff; background: rgba(0, 240, 255, .08); }
    .fullscreen[hidden] { display: none; }
    .stage { flex: 1; min-height: 0; padding: 16px; display: flex; align-items: center; justify-content: center; overflow: auto; background-color: #05080e; background-image: linear-gradient(rgba(0, 240, 255, .035) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 240, 255, .035) 1px, transparent 1px); background-size: 32px 32px; }
    .preview { display: block; border: 1px solid rgba(0, 240, 255, .35); background: #fff; transition: width 160ms cubic-bezier(0.2, 0, 0, 1), height 160ms cubic-bezier(0.2, 0, 0, 1), border-radius 160ms cubic-bezier(0.2, 0, 0, 1); }
    .preview:fullscreen { width: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none; }
    .stage[data-device="desktop"] .preview { width: 100%; height: 100%; border-radius: 0; box-shadow: 0 0 18px rgba(0, 240, 255, .12); }
    /* 手机视口保留设备外框圆角（模拟真机屏幕边界），外框用 HUD 发丝线 + 辉光 */
    .stage[data-device="mobile"] .preview { width: min(390px, calc(100vw - 24px)); height: min(844px, calc(100vh - 96px)); border-width: 8px; border-color: #0c1524; border-radius: 30px; box-shadow: 0 0 0 1px rgba(0, 240, 255, .35), 0 0 30px rgba(0, 240, 255, .12); }
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
      <button class="capture" type="button" data-capture="screenshot">截图</button>
      <button class="capture" type="button" data-capture="record">录制</button>
      <span class="capture-status" data-capture-status hidden></span>
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

    // 捕获桥（弹窗侧）：按钮 → 请求宿主编码 → 进度展示 → 回传 URL 触发下载。
    // 弹窗文档没有主 bundle，栅格化与格式编码全部由宿主完成，这里只做编排。
    const status = document.querySelector('[data-capture-status]');
    const CAPTURE_TIMEOUT_MS = 90000;
    let captureSeq = 0;
    let pendingRequest = '';
    let pendingTimer = 0;
    const captureButtons = Array.prototype.slice.call(document.querySelectorAll('[data-capture]'));
    function setCaptureBusy(busy, label) {
      captureButtons.forEach((button) => { button.disabled = busy; });
      if (busy) {
        status.textContent = label || '正在捕获…';
        status.hidden = false;
      } else {
        status.hidden = true;
      }
    }
    function requestCapture(kind) {
      if (!window.opener) {
        setCaptureBusy(false);
        status.textContent = '宿主页面已关闭，无法捕获';
        status.hidden = false;
        return;
      }
      const requestId = 'cap-' + Date.now().toString(36) + '-' + (++captureSeq);
      pendingRequest = requestId;
      clearTimeout(pendingTimer);
      pendingTimer = window.setTimeout(() => {
        if (pendingRequest !== requestId) return;
        pendingRequest = '';
        setCaptureBusy(false);
        status.textContent = '捕获超时，请重试';
        status.hidden = false;
      }, CAPTURE_TIMEOUT_MS);
      const srcdoc = preview.getAttribute('srcdoc') || '';
      window.opener.postMessage({
        type: '${CAPTURE_REQUEST_TYPE}',
        requestId: requestId,
        kind: kind,
        html: srcdoc,
        width: Math.round(preview.getBoundingClientRect().width) || 0
      }, window.location.origin);
    }
    function settleCapture(requestId) {
      if (pendingRequest && pendingRequest !== requestId) return;
      pendingRequest = '';
      clearTimeout(pendingTimer);
    }
    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.type !== '${CAPTURE_RESULT_TYPE}') return;
      if (data.kind === 'progress') {
        status.textContent = data.label || '正在捕获…';
        status.hidden = false;
        return;
      }
      settleCapture(data.requestId);
      if (data.kind !== 'artifact' || !data.ok) {
        setCaptureBusy(false);
        status.textContent = '捕获失败：' + ((data && data.message) || '未知错误');
        status.hidden = false;
        return;
      }
      const link = document.createElement('a');
      link.href = data.url;
      link.download = data.fileName || 'html-preview';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setCaptureBusy(false);
    });
    captureButtons.forEach((button) => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        const kind = button.dataset.capture === 'record' ? 'record' : 'still';
        setCaptureBusy(true, kind === 'record' ? '正在录制…' : '正在生成截图…');
        requestCapture(kind);
      });
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
  // 捕获桥要求弹窗持有 window.opener：这里不能加 noopener/noreferrer。
  // 弹窗首屏脚本全部是本模块生成的编排代码，用户 HTML 隔离在 sandbox iframe 内，风险可控。
  ensurePreviewWindowCaptureHost();
  const link = window.document.createElement('a');
  link.href = previewUrl;
  link.target = '_blank';
  link.click();
  window.setTimeout(() => window.URL.revokeObjectURL(previewUrl), PREVIEW_URL_REVOKE_DELAY_MS);
  return true;
}
