#!/usr/bin/env node
'use strict';

// 别名双库对账：Node（owner）的 app-state.db.model_aliases 与 Go 的 aih.db.model_alias。
//
// 与运行时影子对账的分工：
//   - lib/server/model-alias-shadow.js 比的是「接口返回的投影」，只能反映被页面读到的那一刻；
//   - 这个脚本直接比两张表，适合切片 B 的「跑一晚零漂移」——不依赖任何 UI 访问。
//
// 按 id 对齐（两侧 id 是同一套 hash），逐字段比较 alias/target/provider/
// targetProvider/priority/enabled/description。
//
// 用法：node scripts/compare-model-aliases.js [--json]
//       [--node-db ~/.ai_home/app-state.db] [--go-db ~/.ai_home/aih.db]
// 退出码：0 = 一致；2 = 存在差异（先查清来源再谈翻转所有权）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseArgs(argv) {
  const home = process.env.HOME || os.homedir();
  const options = {
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
      case '--node-db': options.nodeDb = next(); break;
      case '--go-db': options.goDb = next(); break;
      case '--json': options.json = true; break;
      case '--help': options.help = true; break;
      default: throw new Error('未知参数: ' + flag);
    }
  }
  return options;
}

function usage() {
  return [
    '用法: node scripts/compare-model-aliases.js [选项]',
    '',
    '  --node-db <path>  Node 库（默认 ~/.ai_home/app-state.db）',
    '  --go-db <path>    Go 库（默认 ~/.ai_home/aih.db）',
    '  --json            输出机器可读结果'
  ].join('\n');
}

function openReadOnly(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (!fs.existsSync(file)) throw new Error('数据库不存在: ' + file);
  return new DatabaseSync(file, { readOnly: true });
}

function readNodeAliases(file) {
  const db = openReadOnly(file);
  try {
    return db.prepare(
      'SELECT id, alias, target, provider, target_provider, priority, enabled, description' +
      ' FROM model_aliases ORDER BY created_at, id'
    ).all().map((row) => ({
      id: String(row.id || ''),
      alias: String(row.alias || ''),
      target: String(row.target || ''),
      provider: String(row.provider || 'all'),
      targetProvider: String(row.target_provider || 'auto'),
      priority: Number(row.priority) || 0,
      enabled: Number(row.enabled) !== 0,
      description: String(row.description || '')
    }));
  } finally {
    db.close();
  }
}

function readGoAliases(file) {
  const db = openReadOnly(file);
  try {
    return db.prepare(
      'SELECT id, alias, target, provider, target_provider, priority, enabled, description' +
      ' FROM model_alias ORDER BY position'
    ).all().map((row) => ({
      id: String(row.id || ''),
      alias: String(row.alias || ''),
      target: String(row.target || ''),
      provider: String(row.provider || 'all'),
      targetProvider: String(row.target_provider || 'auto'),
      priority: Number(row.priority) || 0,
      enabled: Number(row.enabled) !== 0,
      description: String(row.description || '')
    }));
  } finally {
    db.close();
  }
}

const FIELDS = ['alias', 'target', 'provider', 'targetProvider', 'priority', 'enabled', 'description'];

// compareAliasesById 是纯函数：按 id 对齐，列出缺失、多余与字段差异。
function compareAliasesById(nodeAliases, goAliases) {
  const nodeIndex = new Map(nodeAliases.map((record) => [record.id, record]));
  const goIndex = new Map(goAliases.map((record) => [record.id, record]));
  const missing = [];
  const changed = [];
  for (const [id, nodeRecord] of nodeIndex) {
    const goRecord = goIndex.get(id);
    if (!goRecord) {
      missing.push({ id, alias: nodeRecord.alias });
      continue;
    }
    const fields = FIELDS.filter((field) => nodeRecord[field] !== goRecord[field]);
    if (fields.length > 0) {
      changed.push({ id, alias: nodeRecord.alias, fields });
    }
  }
  const extra = [];
  for (const [id, goRecord] of goIndex) {
    if (!nodeIndex.has(id)) extra.push({ id, alias: goRecord.alias });
  }
  return {
    equal: missing.length === 0 && extra.length === 0 && changed.length === 0,
    nodeCount: nodeAliases.length,
    goCount: goAliases.length,
    missing,
    extra,
    changed
  };
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
  let nodeAliases;
  let goAliases;
  try {
    nodeAliases = readNodeAliases(options.nodeDb);
    goAliases = readGoAliases(options.goDb);
  } catch (error) {
    process.stderr.write('读取数据库失败: ' + String(error.message) + '\n');
    return 1;
  }
  const result = compareAliasesById(nodeAliases, goAliases);
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write('Node ' + result.nodeCount + ' 条 / Go ' + result.goCount + ' 条\n');
    if (result.missing.length) process.stdout.write('仅 Node: ' + JSON.stringify(result.missing) + '\n');
    if (result.extra.length) process.stdout.write('仅 Go:   ' + JSON.stringify(result.extra) + '\n');
    if (result.changed.length) process.stdout.write('字段差异: ' + JSON.stringify(result.changed) + '\n');
    process.stdout.write('结论: ' + (result.equal ? 'aliases_in_sync' : 'aliases_diverged') + '\n');
  }
  return result.equal ? 0 : 2;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { compareAliasesById, parseArgs };

