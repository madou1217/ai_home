'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseResetAtTimestampMatch, parseResetAtTimestampMs } = require('../lib/server/retry-hints');

// 2026-10-31 14:57:00 UTC+8 = 06:57:00Z
const EN_RESET_MS = Date.UTC(2026, 9, 31, 6, 57, 0);
// 2026-11-04 13:34:21 UTC+8 = 05:34:21Z
const ZH_RESET_MS = Date.UTC(2026, 10, 4, 5, 34, 21);

test('英文语序：your usage will reset at <时刻>', () => {
  assert.equal(
    parseResetAtTimestampMs('API Error: 429, your usage will reset at 2026-10-31 14:57:00 UTC+8'),
    EN_RESET_MS
  );
});

test('中文语序：将在 <时刻> 重置（codebuddycn 真机文案）', () => {
  assert.equal(
    parseResetAtTimestampMs('您的使用量已超出频率限制，将在 2026-11-04 13:34:21 UTC+8 重置，您也可以切换其他模型继续使用。'),
    ZH_RESET_MS
  );
  assert.equal(
    parseResetAtTimestampMs('服务将在 2026-11-04 13:34:21 UTC+8 恢复'),
    ZH_RESET_MS
  );
});

test('中文语序缺省时区按 UTC，显式偏移按偏移换算', () => {
  assert.equal(parseResetAtTimestampMs('将在 2026-11-04 05:34:21 重置'), ZH_RESET_MS);
  assert.equal(parseResetAtTimestampMs('将在 2026-11-04 00:34:21 UTC-5 重置'), ZH_RESET_MS);
});

test('没有「重置 / 恢复」动词的日期不算恢复时刻', () => {
  assert.equal(parseResetAtTimestampMs('会议在 2026-11-04 13:34:21 UTC+8 开始'), 0);
  assert.equal(parseResetAtTimestampMs('2026-11-04 13:34:21'), 0);
  assert.equal(parseResetAtTimestampMs(''), 0);
});

test('allowBareTimestamp 只在调用方已确认限流时启用（中文折行会拆散动词）', () => {
  const wrapped = '您的使用量已超出频率限制，将在 2026-11-04 13:34:21 UTC+8 重 置';
  assert.equal(parseResetAtTimestampMs(wrapped), 0);
  assert.equal(
    parseResetAtTimestampMs(wrapped, { allowBareTimestamp: true }),
    ZH_RESET_MS
  );
  // 裸日期没有时区时仍然不认：避免把普通日志里的时间当成恢复时刻。
  assert.equal(
    parseResetAtTimestampMs('日志 2026-11-04 13:34:21 开始', { allowBareTimestamp: true }),
    0
  );
  // 裸 `UTC` 可能只是还没到齐的 `UTC+8` 前缀：不能按 0 偏移提前解析。
  assert.equal(
    parseResetAtTimestampMs('将在 2026-11-04 13:34:21 UTC 重 置', { allowBareTimestamp: true }),
    0
  );
  assert.equal(
    parseResetAtTimestampMs('将在 2026-11-04 13:34:21 UTC+8 重 置', { allowBareTimestamp: true }),
    ZH_RESET_MS
  );
});

test('半截时间戳标记 complete=false：秒留在下一帧时先别定案', () => {
  const half = parseResetAtTimestampMatch(
    'your usage will reset at 2026-10-31 14:57',
    { allowBareTimestamp: true }
  );
  assert.ok(half);
  assert.equal(half.complete, false);
  // 下一帧补齐后同一段文字就完整了（14:57:21 ≠ 14:57:00）。
  const full = parseResetAtTimestampMatch(
    'your usage will reset at 2026-10-31 14:57:21 UTC+8',
    { allowBareTimestamp: true }
  );
  assert.ok(full);
  assert.equal(full.complete, true);
  assert.equal(full.ms, Date.UTC(2026, 9, 31, 6, 57, 21));
});

test('折行把 UTC 与 +8 分开时取最长匹配，不按 0 偏移提前定案', () => {
  const best = parseResetAtTimestampMatch(
    'your usage will reset at 2026-10-31 14:57:21 UTC +8',
    { allowBareTimestamp: true }
  );
  assert.ok(best);
  assert.equal(best.ms, Date.UTC(2026, 9, 31, 6, 57, 21));
  assert.match(best.text, /UTC \+8$/);
});
