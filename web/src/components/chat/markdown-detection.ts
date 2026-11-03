const MARKDOWN_BLOCK_PATTERNS = [
  /^#{1,6}\s+\S/m,
  /^[-*+]\s+\S/m,
  /^\d+\.\s+\S/m,
  /^>\s+\S/m,
  /^```[\s\S]*```/m,
  /^\|.+\|\s*$/m,
  /^\s*[-:|]{3,}\s*$/m
];

const MARKDOWN_INLINE_PATTERNS = [
  /\[[^\]]+\]\([^)]+\)/,
  /`[^`\n]+`/,
  /\*\*[^*\n][\s\S]*?\*\*/,
  /__[^_\n][\s\S]*?__/,
  /(^|[^*])\*[^*\n]+\*([^*]|$)/,
  /(^|[^_])_[^_\n]+_([^_]|$)/
];

export function shouldRenderMarkdown(value: string) {
  const text = String(value || '');
  if (!text.trim()) return false;
  return MARKDOWN_BLOCK_PATTERNS.some((pattern) => pattern.test(text))
    || MARKDOWN_INLINE_PATTERNS.some((pattern) => pattern.test(text));
}
