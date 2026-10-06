'use strict';

// 时间线条目只存一份的规则（新建条目与历史回填共用，保证两边形状完全一致）：
// - shell：输出只在 content 里存一份；detail.output 与 content 相同时不再重复存
//   （前端显示 detail.output || content）。
// - file_change：每个文件的 diff 只在 detail.changes[].diff 里存一份——它带着
//   路径对应关系；合并后的 detail.diff 与 content 是从 changes 推导出的副本，
//   不再存（前端从 changes 渲染）。只在 content 确实等于推导结果时才丢弃，
//   来源不明的 content 原样保留。
// 输入不被修改，返回压缩后的新对象；没有可压缩的内容时返回原对象。

function joinedChangeDiff(changes) {
  return changes.map((change) => (change && typeof change.diff === 'string' ? change.diff : ''))
    .filter(Boolean).join('\n');
}

function compactShell(item) {
  const detail = item.detail || {};
  if (typeof item.content !== 'string' || detail.output !== item.content) return item;
  const { output: _duplicate, ...rest } = detail;
  return { ...item, detail: rest };
}

function compactFileChange(item) {
  const detail = item.detail || {};
  const changes = Array.isArray(detail.changes) ? detail.changes : null;
  if (!changes) return item;
  const derived = joinedChangeDiff(changes);
  const dropDiff = Object.prototype.hasOwnProperty.call(detail, 'diff') && detail.diff === derived;
  const dropContent = typeof item.content === 'string' && item.content === derived;
  if (!dropDiff && !dropContent) return item;
  const { diff: _derivedDiff, ...restDetail } = detail;
  const { content: _derivedContent, ...restItem } = item;
  return {
    ...(dropContent ? restItem : item),
    detail: dropDiff ? restDetail : detail
  };
}

function compactTimelineItem(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.kind === 'shell') return compactShell(item);
  if (item.kind === 'file_change') return compactFileChange(item);
  return item;
}

module.exports = { compactTimelineItem };
