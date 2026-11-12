'use strict';

// 日志保留策略（2026-11-01）：按天归档 + 默认保留 10 天。
// 约定：当前日志文件名不变（server.log / go-core.log），跨天后改名为 <file>.<YYYY-MM-DD>，
// 这样 launchd / 外部工具引用的路径不会失效。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_KEEP_DAYS,
  DEFAULT_MAX_AGE_MS,
  localDateStamp,
  pruneDatedLogs,
  resolveKeepDays,
  resolveMaxAgeMs,
  rotateLogByDay,
  sweepAihLogs
} = require('../lib/server/log-rotation');
const { appendBoundedLine } = require('../lib/server/bounded-log-writer');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-log-rotation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('默认保留 10 天，可用 AIH_LOG_KEEP_DAYS 覆盖', () => {
  assert.equal(DEFAULT_KEEP_DAYS, 10);
  assert.equal(resolveKeepDays({}), 10);
  assert.equal(resolveKeepDays({ AIH_LOG_KEEP_DAYS: '3' }), 3);
  assert.equal(resolveKeepDays({ AIH_LOG_KEEP_DAYS: 'abc' }), 10);
});

test('跨天把当前日志改名成 <file>.<昨天日期>，当天不滚动', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'server.log');
  fs.writeFileSync(file, 'yesterday line\n');
  const now = new Date(2026, 10, 1, 10, 0, 0).getTime();
  const yesterday = now - 24 * 60 * 60 * 1000;
  fs.utimesSync(file, new Date(yesterday), new Date(yesterday));

  assert.equal(rotateLogByDay({ fs, path, file, now }), true);
  assert.equal(fs.existsSync(file), false);
  const archived = fs.readFileSync(file + '.' + localDateStamp(yesterday), 'utf8');
  assert.equal(archived, 'yesterday line\n');
  // 没有文件可滚时安静返回 false
  assert.equal(rotateLogByDay({ fs, path, file, now }), false);
  // 当天文件不滚动（mtime 必须钉到 now，否则写文件时的真实时间跨天会让判定失真）
  fs.writeFileSync(file, 'today line\n');
  fs.utimesSync(file, new Date(now), new Date(now));
  assert.equal(rotateLogByDay({ fs, path, file, now }), false);
});

test('同一天二次滚动时把增量并进已有归档', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'go-core.log');
  const now = new Date(2026, 10, 1, 9, 0, 0).getTime();
  const day = localDateStamp(now - 24 * 60 * 60 * 1000);
  fs.writeFileSync(file + '.' + day, 'first batch\n');
  fs.writeFileSync(file, 'second batch\n');
  fs.utimesSync(file, new Date(now - 24 * 60 * 60 * 1000), new Date(now - 24 * 60 * 60 * 1000));

  assert.equal(rotateLogByDay({ fs, path, file, now }), true);
  assert.equal(fs.readFileSync(file + '.' + day, 'utf8'), 'first batch\nsecond batch\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('只保留最近 10 天的归档', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'server.log');
  const now = new Date(2026, 10, 1, 9, 0, 0).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = [0, 5, 9, 10, 11, 30];
  for (const offset of days) fs.writeFileSync(file + '.' + localDateStamp(now - offset * dayMs), 'x');

  const removed = pruneDatedLogs({ fs, path, file, now, keepDays: 10 });
  assert.equal(removed, 2);
  assert.equal(fs.existsSync(file + '.' + localDateStamp(now - 11 * dayMs)), false);
  assert.equal(fs.existsSync(file + '.' + localDateStamp(now - 30 * dayMs)), false);
  assert.equal(fs.existsSync(file + '.' + localDateStamp(now - 9 * dayMs)), true);
});

test('appendBoundedLine 写入时自动跨天归档', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'server.log');
  fs.writeFileSync(file, 'old\n');
  const yesterday = Date.now() - 24 * 60 * 60 * 1000;
  fs.utimesSync(file, new Date(yesterday), new Date(yesterday));

  assert.equal(appendBoundedLine(fs, file, 'new'), true);
  const archived = file + '.' + localDateStamp(yesterday);
  assert.equal(fs.existsSync(archived), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
});

test('默认最大年龄跟随保留天数（10 天），AIH_LOG_MAX_AGE_DAYS 仍可覆盖', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  assert.equal(DEFAULT_MAX_AGE_MS, 10 * dayMs);
  assert.equal(resolveMaxAgeMs({}), 10 * dayMs);
  // 保留天数调小，清扫年龄跟着走，不能钉死在 10 天
  assert.equal(resolveMaxAgeMs({}, 3), 3 * dayMs);
  assert.equal(resolveMaxAgeMs({ AIH_LOG_MAX_AGE_DAYS: '2' }, 3), 2 * dayMs);
});

test('每小时清扫按文件名日期删过期归档（不需要先发生滚动）', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'server.log');
  const now = new Date(2026, 10, 1, 9, 0, 0).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const staleArchive = file + '.' + localDateStamp(now - 11 * dayMs);
  const freshArchive = file + '.' + localDateStamp(now - 9 * dayMs);
  const stalePlain = path.join(dir, 'codex', 'app-server', 'chat-gateway.log');
  fs.mkdirSync(path.dirname(stalePlain), { recursive: true });
  fs.writeFileSync(staleArchive, 'x');
  fs.writeFileSync(freshArchive, 'x');
  fs.writeFileSync(stalePlain, 'x');
  const old = new Date(now - 15 * dayMs);
  fs.utimesSync(stalePlain, old, old);
  // 归档文件的 mtime 故意留新：判定必须只看文件名里的日期
  fs.utimesSync(staleArchive, new Date(now), new Date(now));

  const changed = sweepAihLogs(fs, path, dir, { keepDays: 10, now });
  assert.equal(fs.existsSync(staleArchive), false);
  assert.equal(fs.existsSync(freshArchive), true);
  assert.equal(fs.existsSync(stalePlain), false);
  assert.equal(changed, 2);
});
