// 预览水印：只在 PC / 手机独立预览与聊天内预览上浅色平铺「谁的回答」，
// 绝不烧进截图或录制产物。
//
// 偏好只保存开关；provider/model 在预览时从当前会话身份解析，不能由设置页
// 手填。老的「把水印画到每帧画布」路径已移除：水印属于预览层，不属于编码层，
// 这样录制产物天然干净，也避免水印与录制格式/分辨率互相耦合。

/** 持久化偏好：只允许控制开关，provider/model 不属于用户配置。 */
export interface CaptureWatermarkPreference {
  enabled: boolean;
}

/** 预览时解析出的完整水印（开关 + 当前会话身份）。 */
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

/** 把全局开关与当前会话的 provider/model 合成为水印文案输入。 */
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

/** 生成要显示的文案；关闭或没有内容时返回空串（调用方据此跳过渲染）。 */
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

/** 单个预览水印标记：位置是相对容器的百分比，渲染层直接可用。 */
export interface PreviewWatermarkMark {
  text: string;
  /** 文本中心相对容器的位置（0-100）。 */
  leftPct: number;
  topPct: number;
  /** 轻微倾斜，模拟弹幕的随机感。 */
  rotateDeg: number;
  /** 字号（px），随容器短边缩放。 */
  fontSizePx: number;
  /** 很浅的透明度，避免遮挡页面内容。 */
  opacity: number;
}

export interface PreviewWatermarkLayoutInput {
  /** 已解析好的水印文案；空串返回空数组。 */
  text: string;
  /** 预览容器（不是整个窗口）的像素尺寸。 */
  width: number;
  height: number;
  /** 稳定种子：同一尺寸下重复渲染位置不跳动。 */
  seed?: number;
}

/** 网格密度上限：再大只会让浅色水印糊成一片。 */
const MAX_WATERMARK_COLUMNS = 5;
const MAX_WATERMARK_ROWS = 6;
/** 单个文字标记的字号范围。 */
const MIN_MARK_FONT_SIZE = 11;
const MAX_MARK_FONT_SIZE = 16;

/** 32 位稳定哈希：把文案与尺寸折进种子。 */
function hashSeed(text: string, width: number, height: number, seed: number): number {
  let hash = 2166136261 ^ seed;
  const source = `${text}|${Math.round(width / 40)}|${Math.round(height / 40)}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32：纯函数式伪随机，保证同一 seed 得到同一组位置。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成「像弹幕一样随机、浅浅分布」的预览水印布局。
 *
 * 做法是抖动网格而不是完全随机撒点：完全随机会留下大片空白或互相重叠，
 * 抖动网格保证整块预览都被覆盖到，又不会排成整齐的表格。
 */
export function buildPreviewWatermarkMarks(
  input: PreviewWatermarkLayoutInput
): PreviewWatermarkMark[] {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const width = Number(input.width);
  const height = Number(input.height);
  if (!text || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return [];
  }
  const columns = Math.max(2, Math.min(MAX_WATERMARK_COLUMNS, Math.round(width / 320)));
  const rows = Math.max(2, Math.min(MAX_WATERMARK_ROWS, Math.round(height / 200)));
  const random = createRandom(hashSeed(text, width, height, input.seed ?? 0));
  const fontSizePx = Math.max(
    MIN_MARK_FONT_SIZE,
    Math.min(MAX_MARK_FONT_SIZE, Math.round(Math.min(width, height) * 0.02))
  );
  const marks: PreviewWatermarkMark[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      // 在网格单元内抖动 ±34%，保留边距，避免贴边被裁掉。
      const jitterX = (random() - 0.5) * 0.68;
      const jitterY = (random() - 0.5) * 0.68;
      marks.push({
        text,
        leftPct: ((column + 0.5 + jitterX) / columns) * 100,
        topPct: ((row + 0.5 + jitterY) / rows) * 100,
        rotateDeg: Math.round((random() * 2 - 1) * 12 * 10) / 10,
        fontSizePx,
        opacity: Math.round((0.09 + random() * 0.08) * 100) / 100
      });
    }
  }
  return marks;
}
