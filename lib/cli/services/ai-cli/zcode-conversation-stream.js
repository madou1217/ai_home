'use strict';

// 把 `v4/conversation/frame` 里的 **assistantText** 行还原成连续的文本增量。
//
// 桌面端的流式文本不走会话库（DB 只在 turn 结束时一次性落盘），而是走 v4 会话帧：
//   * `row.appended` / `row.upserted`：整行快照，`kind: "assistantText"`，带 `text`/`state`；
//   * `row.delta`：`{op, rowId, path: "text", append}`，只追加新 token；
//   * 初始快照的 rows 形状是 `{window: [...], totalCount, firstRowId}`。
//
// 这个模块只做「帧 → 文本」的纯逻辑，不碰 stdio/RPC，便于单测。调用方通过
// `onText` 拿到增量；`getText()` 是所有已输出增量的拼接。多段 assistantText
// （工具调用前后各一段）之间补一个换行，与 `readZcodeSessionMessages` 的拼接口径一致。

function normalizeText(value) {
  return typeof value === 'string' ? value : '';
}

function createZcodeConversationStream(options = {}) {
  const onText = typeof options.onText === 'function' ? options.onText : null;
  const rows = new Map();
  const order = [];
  let text = '';
  let emittedAny = false;

  const emit = (chunk) => {
    const value = normalizeText(chunk);
    if (!value) return;
    text += value;
    emittedAny = true;
    if (onText) onText(value);
  };

  const ensureRow = (rowId) => {
    const id = String(rowId);
    let entry = rows.get(id);
    if (entry) return entry;
    entry = { id, text: '', state: '' };
    rows.set(id, entry);
    if (order.length > 0) {
      const previous = rows.get(order[order.length - 1]);
      if (previous && previous.text && !text.endsWith('\n')) emit('\n');
    }
    order.push(id);
    return entry;
  };

  /** 整行快照：只输出相对于「本行已输出内容」的新增后缀。 */
  const applyRow = (row) => {
    if (!row || typeof row !== 'object' || row.kind !== 'assistantText') return;
    const entry = ensureRow(row.rowId);
    const full = normalizeText(row.text);
    const previous = entry.text;
    if (typeof row.state === 'string' && row.state) entry.state = row.state;
    if (full === previous) return;
    if (full.startsWith(previous)) {
      entry.text = full;
      emit(full.slice(previous.length));
      return;
    }
    // 服务端重写了这一行（例如最终快照少了流式阶段的字符）：以快照为准，
    // 但已经输出的内容无法收回，只能补发整段。正常路径不会走到这里。
    if (previous.startsWith(full)) return;
    entry.text = full;
    emit(full);
  };

  /** `row.delta`：只追加，不覆盖。 */
  const applyRowDelta = (rowId, append) => {
    const chunk = normalizeText(append);
    if (!chunk) return;
    const entry = ensureRow(rowId);
    entry.text += chunk;
    emit(chunk);
  };

  const applyRows = (list) => {
    if (!Array.isArray(list)) return;
    const sorted = list.slice().sort((a, b) => Number(a && a.rowId) - Number(b && b.rowId));
    for (const row of sorted) applyRow(row);
  };

  const acceptFrame = (frame) => {
    const payload = frame && typeof frame === 'object' ? frame.payload : null;
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind === 'snapshot') {
      const rowsField = payload.snapshot && payload.snapshot.rows;
      applyRows(Array.isArray(rowsField) ? rowsField : (rowsField && rowsField.window));
      return;
    }
    if (payload.kind !== 'deltas' || !Array.isArray(payload.deltas)) return;
    for (const delta of payload.deltas) {
      if (!delta || typeof delta !== 'object') continue;
      if (delta.op === 'row.appended' || delta.op === 'row.upserted') {
        applyRow(delta.row);
      } else if (delta.op === 'row.delta' && delta.path === 'text') {
        applyRowDelta(delta.rowId, delta.append);
      }
    }
  };

  return {
    acceptFrame,
    hasText: () => emittedAny,
    getText: () => text,
    /** 最后一条 assistantText 行已 complete 且非空 —— 可以作为最终答案返回。 */
    isComplete() {
      const last = order.length > 0 ? rows.get(order[order.length - 1]) : null;
      return Boolean(last && last.state === 'complete' && last.text);
    },
    getLastState() {
      const last = order.length > 0 ? rows.get(order[order.length - 1]) : null;
      return last ? last.state : '';
    }
  };
}

module.exports = { createZcodeConversationStream };
