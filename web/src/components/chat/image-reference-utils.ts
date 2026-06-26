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

export function splitImageReferenceText(content: string, images: ImageReferenceSource[]): ImageReferenceSegment[] {
  const text = stripImageReferenceMarkup(content);
  const normalizedImages = Array.isArray(images) ? images : [];
  const segments: ImageReferenceSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  // Codex/Claude 在正文里使用 [Image #n] 作为附件引用，这里只负责把编号映射到已归一化的图片列表。
  IMAGE_MARKER_PATTERN.lastIndex = 0;
  while ((match = IMAGE_MARKER_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, match.index) });
    }

    const imageNumber = Number(match[1]);
    const imageIndex = imageNumber - 1;
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
  let match: RegExpExecArray | null;

  // 只收集真实可预览的图片索引，未解析到的编号交给正文里的弱提示展示。
  IMAGE_MARKER_PATTERN.lastIndex = 0;
  while ((match = IMAGE_MARKER_PATTERN.exec(stripImageReferenceMarkup(content))) !== null) {
    const imageIndex = Number(match[1]) - 1;
    if (imageIndex >= 0 && imageIndex < total) {
      indexes.add(imageIndex);
    }
  }

  return indexes;
}
