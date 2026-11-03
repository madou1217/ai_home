// 统一文件引用标题生成，避免消息气泡和文件抽屉各自实现路径截取。
export function basenameLike(filePath: string) {
  const text = String(filePath || '').trim();
  if (!text) return '';
  const normalized = text.replace(/[?#].*$/, '').split('\n')[0].trim();
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

// 文件预览 Tab 需要把受控来源纳入 key，避免同名路径跨来源时互相覆盖。
export function getFileTabKey(filePath: string, source?: string) {
  return source ? `${source}:${filePath}` : filePath;
}
