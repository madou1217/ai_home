function isRenderablePendingBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'thinking') return false;
  if (block.type === 'tool_use') return true;
  if (block.type === 'tool_group') return Array.isArray(block.items) && block.items.length > 0;
  if (block.type === 'text') return Boolean(String(block.value || '').trim());
  return false;
}

export function getRenderablePendingBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).filter(isRenderablePendingBlock);
}

export function hasRenderablePendingBlocks(blocks) {
  return getRenderablePendingBlocks(blocks).length > 0;
}

export function shouldRenderPendingBlockAsPlainText(block) {
  return Boolean(block && block.type === 'text');
}

export function normalizePendingTextBlock(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
