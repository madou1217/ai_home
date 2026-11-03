#!/usr/bin/env node
'use strict';

// 用量统计按保留期裁剪（默认只演练，不删）。
//
//   node scripts/prune-usage.js                 # 演练：只报告会删多少
//   node scripts/prune-usage.js --days 180      # 换保留期
//   node scripts/prune-usage.js --apply         # 真删
//   node scripts/prune-usage.js --apply --vacuum # 真删并回收磁盘（需要先停 server）
//
// 只动用量表：model_usage_records / model_usage_prompt_events / model_usage_sessions。
// 不碰 model_usage_file_state（扫描游标，删了会全量重扫）和 model_usage_pricing。
// 聊天会话、事件流、账号数据都不在这个脚本的范围内。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function parseArgs(argv) {
  const options = { days: 90, apply: false, vacuum: false, db: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--vacuum') options.vacuum = true;
    else if (arg === '--days') options.days = Number(argv[++i]);
    else if (arg.startsWith('--days=')) options.days = Number(arg.slice(7));
    else if (arg === '--db') options.db = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/prune-usage.js [--days N] [--apply] [--vacuum] [--db PATH]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(options.days) || options.days <= 0) throw new Error('--days 必须是正数');
  return options;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const options = parseArgs(process.argv.slice(2));
const home = process.env.AIH_HOME || path.join(os.homedir(), '.ai_home');
const dbPath = options.db || path.join(home, 'app-state.db');

if (!fs.existsSync(dbPath)) {
  console.error('找不到数据库: ' + dbPath);
  process.exit(1);
}

const cutoff = Date.now() - options.days * DAY_MS;
const cutoffIso = new Date(cutoff).toISOString();
const sizeBefore = fs.statSync(dbPath).size;
const db = new DatabaseSync(dbPath);

const targets = [
  { table: 'model_usage_records', column: 'timestamp_ms' },
  { table: 'model_usage_prompt_events', column: 'timestamp_ms' },
  { table: 'model_usage_sessions', column: 'updated_at_ms' }
];

const plan = targets.map((t) => ({
  ...t,
  rows: db.prepare('select count(*) c from "' + t.table + '" where "' + t.column + '" < ?').get(cutoff).c,
  total: db.prepare('select count(*) c from "' + t.table + '"').get().c
}));

console.log('数据库   ' + dbPath + ' (' + (sizeBefore / 1048576).toFixed(0) + 'MB)');
console.log('保留期   ' + options.days + ' 天（' + cutoffIso + ' 之前的行）');
console.log('模式     ' + (options.apply ? '真删' : '演练（加 --apply 才动手）'));
console.log('');
for (const p of plan) {
  const pct = p.total > 0 ? ((p.rows / p.total) * 100).toFixed(1) : '0.0';
  console.log('  ' + p.table.padEnd(28) + String(p.rows).padStart(9) + ' / ' + String(p.total).padStart(9) + '  (' + pct + '%)');
}

const totalRows = plan.reduce((sum, p) => sum + p.rows, 0);
if (totalRows === 0) {
  console.log('\n没有需要删除的行。');
  db.close();
  process.exit(0);
}
if (!options.apply) {
  console.log('\n演练结束，未改动任何数据。');
  db.close();
  process.exit(0);
}

db.exec('BEGIN IMMEDIATE');
try {
  for (const t of targets) {
    db.prepare('delete from "' + t.table + '" where "' + t.column + ' < ?').run(cutoff);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  console.error('回滚: ' + error.message);
  process.exit(1);
}
console.log('\n已删除 ' + totalRows + ' 行。');

if (options.vacuum) {
  console.log('VACUUM 中（大库需要一点时间）…');
  const started = Date.now();
  db.exec('VACUUM');
  console.log('VACUUM 完成，用时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
}
db.close();

const sizeAfter = fs.statSync(dbPath).size;
console.log('数据库 ' + (sizeBefore / 1048576).toFixed(0) + 'MB → ' + (sizeAfter / 1048576).toFixed(0) + 'MB');
if (!options.vacuum && sizeAfter >= sizeBefore * 0.95) {
  console.log('文件没缩小是正常的：SQLite 只把页标为空闲。要回收磁盘请先停 server，再加 --vacuum。');
}
