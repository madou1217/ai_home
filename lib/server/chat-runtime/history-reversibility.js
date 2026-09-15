'use strict';

// Pi/DeepSeek 的分支与压缩都要求 cut 落在可重建的历史边界上。
// 这个模块只做判定，不负责转换或执行，避免把“能显示”误当成“能无损恢复”。

const REVERSIBLE = Object.freeze({ reversible: true, reason: '' });
const SKIPPABLE_NOTICE_CODES = new Set([
  'contextCompaction', 'context_compacted', 'codex_warning'
]);

function assessHistoryItem(item, nativeItem) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return unsupported('', 'item_invalid');
  }
  const kind = String(item.kind || '').trim();
  if (kind === 'message') return assessMessage(item);
  // Native checkpoints and provider warnings are safe to retain in the public
  // prefix for display, but they are not injectable Responses items; the
  // branch builder skips them when creating the child seed.
  if (kind === 'notice' && isSkippableNotice(item)) return REVERSIBLE;
  if (kind === 'reasoning' && item.status === 'completed'
    && nativeItem?.type === 'reasoning' && nativeItem.id === item.id) return REVERSIBLE;
  // Public display data alone cannot reconstruct native history. Reasoning
  // requires the private raw record above; other shapes remain unsupported.
  if (['reasoning', 'notice', 'error'].includes(kind)) {
    return unsupported(kind, 'native_item_shape_not_persisted');
  }
  if (kind === 'tool') return assessTool(item);
  return unsupported(kind, 'kind_not_supported');
}

function isSkippableNotice(item) {
  const code = String(item && item.detail && item.detail.code || '').trim();
  return SKIPPABLE_NOTICE_CODES.has(code);
}

function assessHistoryPrefix(items, readNativeItem = () => null) {
  const source = Array.isArray(items) ? items : [];
  for (const item of source) {
    const result = assessHistoryItem(item, readNativeItem(item.id));
    if (!result.reversible) return { ...result, itemId: String(item && item.id || '') };
  }
  return REVERSIBLE;
}

function assessMessage(item) {
  const role = String(item.detail && item.detail.role || '').trim();
  if (role !== 'user' && role !== 'assistant') return unsupported('message', 'role_not_supported');
  if (item.status !== 'completed') return unsupported('message', 'message_not_completed');
  if (item.detail && Array.isArray(item.detail.inputs)) {
    for (const input of item.detail.inputs) {
      const kind = String(input && input.kind || '').trim();
      if (kind && !['image', 'skill', 'mention'].includes(kind)) {
        return unsupported('message', 'input_not_supported');
      }
    }
  }
  return REVERSIBLE;
}

function assessTool(item) {
  const detail = item.detail && typeof item.detail === 'object' ? item.detail : {};
  const callId = String(detail.callId || '').trim();
  const name = String(detail.name || '').trim();
  if (!callId || !name) return unsupported('tool', 'call_identity_missing');
  if (item.status !== 'completed') return unsupported('tool', 'tool_result_unknown');
  if (detail.result === undefined || detail.result === null) {
    return unsupported('tool', 'tool_result_missing');
  }
  if (typeof detail.result !== 'string') return unsupported('tool', 'tool_result_not_text');
  // The canonical projection does not retain enough information to recreate
  // namespace/type/media fields of a Responses call. Keep this explicit when
  // the private raw-item evidence is unavailable.
  return unsupported('tool', 'raw_call_shape_not_persisted');
}

function unsupported(kind, reason) {
  return { reversible: false, kind, reason };
}

module.exports = { assessHistoryItem, assessHistoryPrefix, isSkippableNotice };
