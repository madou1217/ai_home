#!/usr/bin/env node
'use strict';

// 用量账本对比：Node 的 model_usage_records 与 Go 的 usage_ledger 是否可比。
//
// 为什么需要它：WebUI 的用量/额度页目前读 Node 的记录表，而 Go 已经有自己的账本。
// 切流前必须证明两边在同一时间窗内量级一致——只要有一边系统性缺失，切过去就是
// 「页面数字突然变小」，而这种错误不会报任何错。
//
// 用法：
//   node scripts/compare-usage-ledgers.js [--days 1] [--tolerance 0.2] [--json]
//     [--node-db ~/.ai_home/app-state.db] [--go-db ~/.ai_home/aih.db]
//
// 退出码：0 = 可比（或只有一边有数据）；2 = 存在显著差异，先查清来源再谈切流。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_DAYS = 1;
const DEFAULT_TOLERANCE = 0.2;
// 低于这个占比视为「链路未接全」，不算口径分歧。
const PARTIAL_RATIO = 0.05;

function parseArgs(argv) {
  const home = process.env.HOME || os.homedir();
  const options = {
    days: DEFAULT_DAYS,
    tolerance: DEFAULT_TOLERANCE,
    nodeDb: path.join(home, '.ai_home', 'app-state.db'),
    goDb: path.join(home, '.ai_home', 'aih.db'),
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error('缺少参数值: ' + flag);
      return argv[index];
    };
    switch (flag) {
      case '--days': options.days = Number(next()) || DEFAULT_DAYS; break;
      case '--tolerance': options.tolerance = Number(next()); break;
      case '--node-db': options.nodeDb = next(); break;
      case '--go-db': options.goDb = next(); break;
      case '--json': options.json = true; break;
      case '--help': options.help = true; break;
      default: throw new Error('未知参数: ' + flag);
    }
  }
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0) {
    options.tolerance = DEFAULT_TOLERANCE;
  }
  return options;
}

function usage() {
  return [
    '用法: node scripts/compare-usage-ledgers.js [选项]',
    '',
    '  --days <n>        统计最近 n 天（默认 1）',
    '  --tolerance <p>   允许的相对差异（默认 0.2）',
    '  --node-db <path>  Node 记录库（默认 ~/.ai_home/app-state.db）',
    '  --go-db <path>    Go 账本库（默认 ~/.ai_home/aih.db）',
    '  --json            输出机器可读结果'
  ].join('\n');
}

// 打开只读连接：这两个库属于运行中的服务，脚本绝不能写。
function openReadOnly(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (!fs.existsSync(file)) throw new Error('数据库不存在: ' + file);
  return new DatabaseSync(file, { readOnly: true });
}

function readNodeTokens(file, sinceMs) {
  const db = openReadOnly(file);
  try {
    const rows = db.prepare(
      'SELECT provider AS provider, SUM(total_tokens) AS tokens, COUNT(*) AS requests' +
      ' FROM model_usage_records WHERE timestamp_ms >= ? GROUP BY provider'
    ).all(sinceMs);
    return rows.map((row) => ({
      provider: String(row.provider || ''),
      tokens: Number(row.tokens) || 0,
      requests: Number(row.requests) || 0
    }));
  } finally {
    db.close();
  }
}

function readGoTokens(file, sinceMs) {
  const db = openReadOnly(file);
  try {
    const rows = db.prepare(
      'SELECT provider_id AS provider, SUM(total_tokens) AS tokens, COUNT(*) AS requests' +
      ' FROM usage_ledger WHERE occurred_at_ms >= ? GROUP BY provider_id'
    ).all(sinceMs);
    return rows.map((row) => ({
      provider: String(row.provider || ''),
      tokens: Number(row.tokens) || 0,
      requests: Number(row.requests) || 0
    }));
  } finally {
    db.close();
  }
}

// compareRows 是纯函数：把两侧按 provider 对齐，算相对差异与结论。
//
// 只有两边都有数据时才判「是否可比」；一边为 0 说明这条链路还没接上，
// 那是「未迁移」而不是「数值不一致」，不该混为一谈。
function compareRows(nodeRows, goRows, tolerance) {
  const providers = new Set();
  for (const row of nodeRows) providers.add(row.provider);
  for (const row of goRows) providers.add(row.provider);
  const nodeIndex = new Map(nodeRows.map((row) => [row.provider, row]));
  const goIndex = new Map(goRows.map((row) => [row.provider, row]));
  const rows = [];
  for (const provider of [...providers].sort()) {
    const node = nodeIndex.get(provider) || { tokens: 0, requests: 0 };
    const go = goIndex.get(provider) || { tokens: 0, requests: 0 };
    const bothPresent = node.tokens > 0 && go.tokens > 0;
    const baseline = Math.max(node.tokens, go.tokens);
    const delta = bothPresent ? Math.abs(node.tokens - go.tokens) / baseline : 0;
    // 一边只有另一边的零头，说明这条链路还没接全（迁移中），不是「数值算错了」。
    // 把它报成 diverged 会让「未完成迁移」和「口径不同」混成一件事。
    const partial = bothPresent && Math.min(node.tokens, go.tokens) / baseline < PARTIAL_RATIO;
    let verdict = 'comparable';
    if (node.tokens > 0 && go.tokens === 0) verdict = 'node_only';
    else if (go.tokens > 0 && node.tokens === 0) verdict = 'go_only';
    else if (partial) verdict = 'partial';
    else if (bothPresent && delta > tolerance) verdict = 'diverged';
    rows.push({
      provider,
      nodeTokens: node.tokens,
      goTokens: go.tokens,
      nodeRequests: node.requests,
      goRequests: go.requests,
      delta: Number(delta.toFixed(4)),
      verdict
    });
  }
  const diverged = rows.filter((row) => row.verdict === 'diverged');
  return { rows, diverged, verdict: diverged.length === 0 ? 'ledgers_comparable' : 'ledgers_diverged' };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(String(error.message) + '\n\n' + usage() + '\n');
    return 1;
  }
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  const sinceMs = Date.now() - Math.max(1, Math.trunc(options.days)) * 24 * 60 * 60 * 1000;
  let nodeRows;
  let goRows;
  try {
    nodeRows = readNodeTokens(options.nodeDb, sinceMs);
    goRows = readGoTokens(options.goDb, sinceMs);
  } catch (error) {
    process.stderr.write('读取数据库失败: ' + String(error.message) + '\n');
    return 1;
  }
  const result = compareRows(nodeRows, goRows, options.tolerance);
  result.days = options.days;
  result.tolerance = options.tolerance;
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write('最近 ' + options.days + ' 天，容差 ' + (options.tolerance * 100) + '%\n');
    for (const row of result.rows) {
      process.stdout.write(
        row.provider.padEnd(14) +
        'node=' + String(row.nodeTokens).padStart(12) +
        '  go=' + String(row.goTokens).padStart(12) +
        '  delta=' + String((row.delta * 100).toFixed(1)).padStart(6) + '%' +
        '  ' + row.verdict + '\n'
      );
    }
    process.stdout.write('结论: ' + result.verdict + '\n');
  }
  return result.diverged.length === 0 ? 0 : 2;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { compareRows, parseArgs };

