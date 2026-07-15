export type ImageReferenceSource = string | {
  src: string;
  fallbackSrc?: string;
};

export type SingleImageReferenceOptions = {
  fallbackSource?: string;
  allowIndexedFallback?: boolean;
};

export type PathScopedImageFallbackTarget = {
  path: string;
  isImage: boolean;
};

export type PathScopedImageFallbackMap = Record<string, string>;

export type ImageReferenceSegment =
  | {
      type: 'text';
      value: string;
    }
  | {
      type: 'image_reference';
      raw: string;
      imageNumber: number;
      imageIndex: number;
      src: string;
      fallbackSrc: string;
    };

const IMAGE_MARKER_PATTERN = /\[Image\s*#(\d+)\]/gi;
const IMAGE_XML_OPEN_TAG_PATTERN = /<image\b[^>]*>/gi;
const IMAGE_XML_CLOSE_TAG_PATTERN = /<\/image>/gi;

export function stripImageReferenceMarkup(content: string) {
  return String(content || '')
    .replace(IMAGE_XML_OPEN_TAG_PATTERN, (tag) => {
      const ref = tag.match(/\[Image\s*#\d+\]/i);
      return ref ? ref[0] : '';
    })
    .replace(IMAGE_XML_CLOSE_TAG_PATTERN, '')
    .trim();
}

function normalizeImageReferenceSource(source: ImageReferenceSource | undefined) {
  if (!source) return { src: '', fallbackSrc: '' };
  if (typeof source === 'string') return { src: source, fallbackSrc: '' };
  return {
    src: String(source.src || '').trim(),
    fallbackSrc: String(source.fallbackSrc || '').trim()
  };
}

// 把正文里第 refOrder 个 [Image #N] 解析到图片数组下标:优先绝对编号(N-1);越界则回退到「出现顺序」
// (refOrder)。修复:用户粘贴的图片常被赋予【会话全局】编号(如 #4),而这条消息的 images 数组只含
// 本条局部的若干张(如只有 1 张),绝对编号越界 → 图片明明渲染出来了、内联引用却提示「图片未读取到」。
export function resolveImageRefIndex(imageNumber: number, refOrder: number, imageCount: number): number {
  const abs = imageNumber - 1;
  if (abs >= 0 && abs < imageCount) return abs;
  if (refOrder >= 0 && refOrder < imageCount) return refOrder;
  return -1;
}

export function splitImageReferenceText(content: string, images: ImageReferenceSource[]): ImageReferenceSegment[] {
  const text = stripImageReferenceMarkup(content);
  const normalizedImages = Array.isArray(images) ? images : [];
  const segments: ImageReferenceSegment[] = [];
  let cursor = 0;
  let refOrder = 0;
  let match: RegExpExecArray | null;

  // Codex/Claude 在正文里使用 [Image #n] 作为附件引用，这里只负责把编号映射到已归一化的图片列表。
  IMAGE_MARKER_PATTERN.lastIndex = 0;
  while ((match = IMAGE_MARKER_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, match.index) });
    }

    const imageNumber = Number(match[1]);
    const imageIndex = resolveImageRefIndex(imageNumber, refOrder, normalizedImages.length);
    refOrder += 1;
    const imageSource = normalizeImageReferenceSource(imageIndex >= 0 ? normalizedImages[imageIndex] : undefined);
    segments.push({
      type: 'image_reference',
      raw: match[0],
      imageNumber,
      imageIndex,
      src: imageSource.src,
      fallbackSrc: imageSource.fallbackSrc
    });
    cursor = IMAGE_MARKER_PATTERN.lastIndex;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', value: text }];
}

export function getImageReferenceNumbers(content: string) {
  const numbers: number[] = [];
  let match: RegExpExecArray | null;

  IMAGE_MARKER_PATTERN.lastIndex = 0;
  while ((match = IMAGE_MARKER_PATTERN.exec(stripImageReferenceMarkup(content))) !== null) {
    const imageNumber = Number(match[1]);
    if (Number.isFinite(imageNumber) && imageNumber > 0) {
      numbers.push(imageNumber);
    }
  }

  return numbers;
}

export function buildSingleImageReferenceSourceList(
  content: string,
  source: string,
  fallbackImages: string[] = [],
  fallbackOptions: string | SingleImageReferenceOptions = ''
): ImageReferenceSource[] {
  const normalizedSource = String(source || '').trim();
  const options = typeof fallbackOptions === 'string'
    ? { fallbackSource: fallbackOptions, allowIndexedFallback: true }
    : fallbackOptions || {};
  const normalizedFallbackSource = String(options.fallbackSource || '').trim();
  const allowIndexedFallback = options.allowIndexedFallback !== false;
  if (!normalizedSource) return [];

  const [firstImageNumber] = getImageReferenceNumbers(content);
  if (!firstImageNumber) {
    return [{
      src: normalizedSource,
      fallbackSrc: normalizedFallbackSource || (allowIndexedFallback ? String(fallbackImages[0] || '').trim() : '')
    }];
  }

  // 工具结果可能沿用全局 [Image #n] 编号，这里把单张图片放回对应下标，避免缩略图错位。
  return Array.from({ length: firstImageNumber }, (_item, index) => (
    index === firstImageNumber - 1
      ? {
          src: normalizedSource,
          fallbackSrc: normalizedFallbackSource || (allowIndexedFallback ? String(fallbackImages[index] || '').trim() : '')
        }
      : ''
  ));
}

export function buildPathScopedImageFallbackMap(
  targets: PathScopedImageFallbackTarget[],
  fallbackImages: string[] = []
): PathScopedImageFallbackMap {
  const map: PathScopedImageFallbackMap = {};
  const normalizedFallbacks = Array.isArray(fallbackImages) ? fallbackImages : [];
  let imageIndex = 0;

  targets.forEach((target) => {
    const path = String(target?.path || '').trim();
    if (!path || !target?.isImage) return;

    // Claude 的多个 Read 图片结果经常都写成局部 [Image #1]，fallback 必须按图片工具顺序消费。
    if (!map[path] && normalizedFallbacks[imageIndex]) {
      map[path] = normalizedFallbacks[imageIndex];
    }
    imageIndex += 1;
  });

  return map;
}

export function getReferencedImageIndexes(content: string, imageCount: number) {
  const indexes = new Set<number>();
  const total = Number.isFinite(imageCount) ? imageCount : 0;
  let refOrder = 0;
  let match: RegExpExecArray | null;

  // 与 splitImageReferenceText 用同一套解析(绝对编号→越界回退出现顺序),保证被内联引用命中的图片
  // 会从底部图库里排除、不重复出现。
  IMAGE_MARKER_PATTERN.lastIndex = 0;
  while ((match = IMAGE_MARKER_PATTERN.exec(stripImageReferenceMarkup(content))) !== null) {
    const imageIndex = resolveImageRefIndex(Number(match[1]), refOrder, total);
    refOrder += 1;
    if (imageIndex >= 0 && imageIndex < total) {
      indexes.add(imageIndex);
    }
  }

  return indexes;
}
