#!/usr/bin/env node
'use strict';

/**
 * 把 Node app-state 里的存量「上游错误映射组」导入 Go 的新表，并与 Go 做逐字段对拍。
 *
 * 为什么走 Node 中转：Go 的 management key 由 Node 启动时生成，不落盘、不对外，
 * 脚本拿不到。Node 的 /v0/webui/upstream-error-mapping-groups/* 是唯一持有者
 * （goCoreSync）暴露出来的入口，与 scripts/backfill-usage-ledger.js 同一模式。
 *
 * 用法：
 *   node scripts/import-upstream-mappings.js --dry-run   只看 Node 存量，不发请求
 *   node scripts/import-upstream-mappings.js            导入（可重复跑，同内容幂等）
 *   node scripts/import-upstream-mappings.js --verify    对拍 Node 与 Go，不一致时退出码 1
 *
 * 环境变量：
 *   AIH_HOME_DIR                  app-state 所在目录（默认 ~/.ai_home）
 *   AIH_SERVER_MANAGEMENT_KEY            WebUI Management Key（默认从 app-state 的 config:server 读）
 *   AIH_UPSTREAM_MAPPING_ENDPOINT Node 服务地址（默认 http://127.0.0.1:9527）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readUpstreamErrorMappingGroups } = require('../lib/server/upstream-error-mapping-store');
const { readJsonValue } = require('../lib/server/app-state-store');

const COLLECTION_PATH = '/v0/webui/upstream-error-mapping-groups';
const IMPORT_PATH = COLLECTION_PATH + '/import';
const CONTENT_FIELDS = Object.freeze(['name', 'description', 'provider', 'enabled', 'rules']);
const ENDPOINT = String(process.env.AIH_UPSTREAM_MAPPING_ENDPOINT || 'http://127.0.0.1:9527')
  .replace(/\/+$/, '');

function parseArgs(argv) {
  const options = { dryRun: false, verify: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('未知参数: ' + arg);
  }
  return options;
}

function printUsage() {
  console.log('用法: node scripts/import-upstream-mappings.js [--dry-run | --verify]');
}

function resolveAiHomeDir() {
  const explicit = String(process.env.AIH_HOME_DIR || process.env.AI_HOME_DIR || '').trim();
  return explicit || path.join(os.homedir(), '.ai_home');
}

function resolveManagementKey(aiHomeDir) {
  const fromEnv = String(process.env.AIH_SERVER_MANAGEMENT_KEY || '').trim();
  if (fromEnv) return fromEnv;
  // 与 backfill 脚本一致：WebUI 的 key 在 app-state 的 config:server 里。
  const config = readJsonValue(fs, aiHomeDir, 'config:server');
  return String(config && config.managementKey || '').trim();
}

async function request(pathname, options = {}) {
  const headers = { authorization: 'Bearer ' + options.key };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(ENDPOINT + pathname, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_error) {}
  if (!response.ok) {
    const error = payload && payload.error ? payload.error : 'http_' + response.status;
    const failure = new Error((options.method || 'GET') + ' ' + pathname + ' -> ' + response.status + ' ' + error);
    failure.status = response.status;
    failure.payload = payload;
    throw failure;
  }
  return payload || {};
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatValue(value) {
  if (value === undefined) return 'undefined';
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

// 逐层比较，数组按下标比——规则顺序是匹配语义的一部分，不能排序后再比。
function diffValues(pathname, nodeValue, goValue, diffs) {
  if (Array.isArray(nodeValue) || Array.isArray(goValue)) {
    if (!Array.isArray(nodeValue) || !Array.isArray(goValue)) {
      diffs.push(pathname + ': 类型不一致 node=' + formatValue(nodeValue) + ' go=' + formatValue(goValue));
      return;
    }
    if (nodeValue.length !== goValue.length) {
      diffs.push(pathname + ': 长度不一致 node=' + nodeValue.length + ' go=' + goValue.length);
    }
    const length = Math.max(nodeValue.length, goValue.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= nodeValue.length) diffs.push(pathname + '[' + index + ']: Node 缺失，Go=' + formatValue(goValue[index]));
      else if (index >= goValue.length) diffs.push(pathname + '[' + index + ']: Go 缺失，Node=' + formatValue(nodeValue[index]));
      else diffValues(pathname + '[' + index + ']', nodeValue[index], goValue[index], diffs);
    }
    return;
  }
  if (isPlainObject(nodeValue) || isPlainObject(goValue)) {
    if (!isPlainObject(nodeValue) || !isPlainObject(goValue)) {
      diffs.push(pathname + ': 类型不一致 node=' + formatValue(nodeValue) + ' go=' + formatValue(goValue));
      return;
    }
    const keys = new Set([...Object.keys(nodeValue), ...Object.keys(goValue)]);
    for (const key of [...keys].sort()) {
      const childPath = pathname + '.' + key;
      if (!Object.prototype.hasOwnProperty.call(nodeValue, key)) {
        diffs.push(childPath + ': Node 缺失，Go=' + formatValue(goValue[key]));
      } else if (!Object.prototype.hasOwnProperty.call(goValue, key)) {
        diffs.push(childPath + ': Go 缺失，Node=' + formatValue(nodeValue[key]));
      } else {
        diffValues(childPath, nodeValue[key], goValue[key], diffs);
      }
    }
    return;
  }
  if (!Object.is(nodeValue, goValue)) {
    diffs.push(pathname + ': node=' + formatValue(nodeValue) + ' go=' + formatValue(goValue));
  }
}

function contentOf(group) {
  const source = group && typeof group === 'object' ? group : {};
  const content = {};
  for (const field of CONTENT_FIELDS) content[field] = source[field];
  return content;
}

function compareGroups(nodeGroups, goGroups) {
  const diffs = [];
  const nodeById = new Map(nodeGroups.map((group) => [String(group && group.id || ''), group]));
  const goById = new Map(goGroups.map((group) => [String(group && group.id || ''), group]));
  if (nodeGroups.length !== goGroups.length) {
    diffs.push('组数量不一致: Node=' + nodeGroups.length + ' Go=' + goGroups.length);
  }
  for (const [id, group] of nodeById) {
    if (!goById.has(id)) {
      diffs.push('组 ' + id + ': Node 有，Go 缺失');
      continue;
    }
    diffValues('组 ' + id, contentOf(group), contentOf(goById.get(id)), diffs);
  }
  for (const id of goById.keys()) {
    if (!nodeById.has(id)) diffs.push('组 ' + id + ': Go 有，Node 缺失');
  }
  return diffs;
}

function printGroups(groups) {
  for (const group of groups) {
    const rules = Array.isArray(group.rules) ? group.rules.length : 0;
    console.log('  ' + String(group.id || '(no id)')
      + '  provider=' + String(group.provider || 'all')
      + '  enabled=' + (group.enabled !== false)
      + '  rules=' + rules
      + '  ' + String(group.name || ''));
  }
}

async function runImport(groups, key) {
  const payload = await request(IMPORT_PATH, { method: 'POST', key, body: { groups } });
  console.log('imported=' + (Number(payload.imported) || 0)
    + ' skipped=' + (Number(payload.skipped) || 0)
    + ' conflicts=' + (Number(payload.conflicts) || 0));
  if (Array.isArray(payload.errors) && payload.errors.length) {
    for (const failure of payload.errors) {
      console.log('  failed: ' + String(failure.id || '(no id)') + ' ' + String(failure.error || ''));
    }
    console.error('导入存在失败组，未完全收敛');
    return 1;
  }
  if ((Number(payload.conflicts) || 0) > 0) {
    console.error('存在同 id 但内容不同的组（Go 保留原内容）；先人工确认再重跑');
    return 1;
  }
  return 0;
}

async function runVerify(nodeGroups, key) {
  const payload = await request(COLLECTION_PATH, { method: 'GET', key });
  const goGroups = Array.isArray(payload.groups) ? payload.groups : [];
  console.log('verify: Node=' + nodeGroups.length + ' Go=' + goGroups.length);
  const diffs = compareGroups(nodeGroups, goGroups);
  if (diffs.length === 0) {
    console.log('对拍通过：幂等键与各字段一致');
    return 0;
  }
  for (const diff of diffs) console.log('DIFF ' + diff);
  console.error('对拍失败：共 ' + diffs.length + ' 处差异');
  return 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return 0;
  }
  const aiHomeDir = resolveAiHomeDir();
  // 复用 store 的读函数：它已经做了 id / provider / rules 的归一化，
  // 自己解析 KV 会把「Node 归一化后的真值」变成另一份实现。
  const stored = readUpstreamErrorMappingGroups(fs, aiHomeDir);
  const groups = Array.isArray(stored.groups) ? stored.groups : [];
  console.log('Node 存量映射组: ' + groups.length + '（' + aiHomeDir + '）');
  printGroups(groups);

  if (options.verify) {
    const key = resolveManagementKey(aiHomeDir);
    if (!key) throw new Error('缺少 Management Key（app-state 的 config:server 或 AIH_SERVER_MANAGEMENT_KEY）');
    return runVerify(groups, key);
  }
  if (options.dryRun) {
    console.log('dry-run：不发送导入请求');
    return 0;
  }
  if (groups.length === 0) {
    console.log('没有需要导入的映射组');
    return 0;
  }
  const key = resolveManagementKey(aiHomeDir);
  if (!key) throw new Error('缺少 Management Key（app-state 的 config:server 或 AIH_SERVER_MANAGEMENT_KEY）');
  return runImport(groups, key);
}

main().then((code) => {
  process.exitCode = Number(code) || 0;
}).catch((error) => {
  console.error('import-upstream-mappings failed:', error && error.message);
  process.exitCode = 1;
});
