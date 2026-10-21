// 截图/录制水印：把「AIH · provider · model」自动画到每一帧的右下角。
//
// 偏好只保存开关；provider/model 在捕获时从当前会话身份解析，不能由设置页
// 手填。capture-controller 在编码前统一叠加，GIF / APNG / WebM / 静图共用。

/** 持久化偏好：只允许控制开关，provider/model 不属于用户配置。 */
export interface CaptureWatermarkPreference {
  enabled: boolean;
}

/** 捕获时解析出的完整水印（开关 + 当前会话身份）。 */
export interface CaptureWatermarkSettings {
  enabled: boolean;
  provider: string;
  model: string;
}

export interface CaptureWatermarkIdentity {
  provider: string;
  model: string;
}

export const DEFAULT_CAPTURE_WATERMARK: CaptureWatermarkPreference = {
  enabled: false
};

export function normalizeCaptureWatermark(
  input?: Partial<CaptureWatermarkPreference> | null
): CaptureWatermarkPreference {
  return { enabled: input?.enabled === true };
}

/** 把全局开关与当前会话的 provider/model 合成为实际绘制水印。 */
export function resolveCaptureWatermark(
  preference?: Partial<CaptureWatermarkPreference> | null,
  identity?: Partial<CaptureWatermarkIdentity> | null
): CaptureWatermarkSettings {
  return {
    enabled: preference?.enabled === true,
    provider: typeof identity?.provider === 'string' ? identity.provider.trim().slice(0, 80) : '',
    model: typeof identity?.model === 'string' ? identity.model.trim().slice(0, 120) : ''
  };
}

/** 生成要绘制的文案；关闭或没有内容时返回空串（调用方据此跳过绘制）。 */
export function resolveWatermarkText(
  input?: Partial<CaptureWatermarkSettings> | null
): string {
  const enabled = input?.enabled === true;
  if (!enabled) return '';
  const provider = typeof input?.provider === 'string' ? input.provider.trim() : '';
  const model = typeof input?.model === 'string' ? input.model.trim() : '';
  const detail = [provider, model].filter(Boolean).join(' · ');
  return detail ? `AIH · ${detail}` : 'AIH';
}

type WatermarkContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function drawRoundedRect(
  context: WatermarkContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function fitWatermarkText(context: WatermarkContext, text: string, maxWidth: number): string {
  if (!text || maxWidth <= 0) return '';
  if (context.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  if (context.measureText(ellipsis).width > maxWidth) return '';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, middle).trimEnd()}${ellipsis}`;
    if (context.measureText(candidate).width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, Math.max(1, low)).trimEnd()}${ellipsis}`;
}

/**
 * 直接把水印画到画布上。字号按画面宽度等比缩放，保证 GIF/APNG 编码器
 * 把画面缩到 640/800 长边后仍然可读（源帧上的字号会一起被缩小）。
 */
export function drawCaptureWatermark(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  input?: Partial<CaptureWatermarkSettings> | null
): void {
  const text = resolveWatermarkText(input);
  if (!text) return;
  const context = canvas.getContext('2d') as WatermarkContext | null;
  if (!context) return;
  drawCaptureWatermarkOnContext(context, canvas.width, canvas.height, text);
}

export function drawCaptureWatermarkOnContext(
  context: WatermarkContext,
  width: number,
  height: number,
  text: string
): void {
  if (!text || width <= 0 || height <= 0) return;
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const scale = Math.max(0.72, Math.min(1.4, safeWidth / 1280));
  const fontSize = Math.max(16, Math.min(44, Math.round(safeWidth * 0.026)));
  const paddingX = Math.max(10, Math.round(fontSize * 0.55));
  const paddingY = Math.max(6, Math.round(fontSize * 0.34));
  const margin = Math.max(
    4,
    Math.min(
      Math.round(fontSize * 0.7),
      Math.floor(safeWidth * 0.04),
      Math.floor(safeHeight * 0.04)
    )
  );
  const radius = Math.max(5, Math.round(fontSize * 0.32));
  context.save();
  try {
    context.font = `600 ${fontSize}px "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace`;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    const maxTextWidth = Math.max(1, safeWidth - margin * 2 - paddingX * 2);
    const label = fitWatermarkText(context, text, maxTextWidth);
    if (!label) return;
    const textWidth = context.measureText(label).width;
    const boxWidth = Math.max(
      1,
      Math.min(safeWidth - margin * 2, textWidth + paddingX * 2)
    );
    const boxHeight = fontSize + paddingY * 2;
    const x = Math.max(margin, safeWidth - margin - boxWidth);
    const y = Math.max(margin, safeHeight - margin - boxHeight);
    context.fillStyle = 'rgba(5, 10, 18, 0.78)';
    context.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    context.lineWidth = Math.max(1, Math.round(scale));
    drawRoundedRect(context, x, y, boxWidth, boxHeight, radius);
    context.fill();
    context.stroke();
    context.fillStyle = '#f2fbff';
    context.fillText(label, x + paddingX, y + boxHeight / 2);
  } finally {
    context.restore();
  }
}
