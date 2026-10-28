'use strict';

/**
 * 受管文本块：在用户自己的配置文件（rc / nginx 片段 …）里按标记整体替换一段内容，
 * 重复写入不会叠加，删除时按同一标记摘掉。
 *
 * 抽取原因：`aih edge`（nginx 片段）与 `aih shell`（zshrc/bashrc 片段）需要完全相同的
 * 语义——都要求「只动自己写的那一段、其余原样保留、幂等」。两份实现一旦漂移，
 * 就会出现「写进去的标记和删掉的标记对不上」这类只能靠用户手工收拾的问题。
 *
 * 标记形态刻意保持可读（`# >>> <prefix>:<name> >>>` / `# <<< <prefix>:<name> <<<`），
 * 用户 grep 得到、也能一眼看出是哪个工具写的。
 */

function buildManagedBlockMarkers(name, prefix = 'aih') {
  const label = `${String(prefix || 'aih').trim()}:${String(name || '').trim()}`;
  return {
    start: `# >>> ${label} >>>`,
    end: `# <<< ${label} <<<`
  };
}

/**
 * 用 marker 块替换同名片段（重复调用不会叠加）。
 * 已有块被摘除后追加到文件末尾；块内容统一去掉首尾空白。
 */
function replaceManagedBlock(text, name, content, options = {}) {
  const { start, end } = buildManagedBlockMarkers(name, options.prefix);
  const lines = String(text == null ? '' : text).split('\n');
  const startIndex = lines.findIndex((line) => line.trim() === start);
  let next = String(text == null ? '' : text);
  if (startIndex >= 0) {
    const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === end);
    const kept = endIndex >= 0
      ? [...lines.slice(0, startIndex), ...lines.slice(endIndex + 1)]
      : lines.slice(0, startIndex);
    next = kept.join('\n');
  }
  return `${String(next).replace(/\s*$/, '')}\n${start}\n${String(content).trim()}\n${end}\n`;
}

/** 读取受管块的内容（不含标记行）；没有该块时返回 null。 */
function readManagedBlock(text, name, options = {}) {
  const { start, end } = buildManagedBlockMarkers(name, options.prefix);
  const lines = String(text == null ? '' : text).split('\n');
  const startIndex = lines.findIndex((line) => line.trim() === start);
  if (startIndex < 0) return null;
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === end);
  if (endIndex < 0) return null;
  return lines.slice(startIndex + 1, endIndex).join('\n');
}

/** 摘掉受管块（含标记行）；没有该块时返回原文本。 */
function removeManagedBlock(text, name, options = {}) {
  const { start, end } = buildManagedBlockMarkers(name, options.prefix);
  const lines = String(text == null ? '' : text).split('\n');
  const startIndex = lines.findIndex((line) => line.trim() === start);
  if (startIndex < 0) return { text, removed: false };
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === end);
  const kept = endIndex >= 0
    ? [...lines.slice(0, startIndex), ...lines.slice(endIndex + 1)]
    : lines.slice(0, startIndex);
  return { text: kept.join('\n'), removed: true };
}

module.exports = {
  buildManagedBlockMarkers,
  readManagedBlock,
  removeManagedBlock,
  replaceManagedBlock
};
