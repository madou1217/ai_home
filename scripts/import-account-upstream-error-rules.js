#!/usr/bin/env node
'use strict';

/**
 * 把 Node 的存量账号级上游错误规则导入 Go，并与 Go 做逐账号对拍。
 *
 * 为什么走 Node 中转：Go 的 management key 由 Node 启动时生成，不落盘、不对外，
 * 脚本拿不到。Node 的 /v0/webui/account-upstream-error-rules/* 是唯一持有者
 * （goCoreSync）暴露出来的入口，与 scripts/import-upstream-mappings.js 同一模式。
 *
 * 用法：
 *   node scripts/import-account-upstream-error-rules.js --dry-run   只看 Node 存量
 *   node scripts/import-account-upstream-error-rules.js            导入（可重复跑）
 *   node scripts/import-account-upstream-error-rules.js --verify   对拍 Node 与 Go
 *
 * 环境变量：
 *   AIH_HOME_DIR                    app-state 所在目录（默认 ~/.ai_home）
 *   AIH_SERVER_MANAGEMENT_KEY              WebUI Management Key（默认从 app-state 的 config:server 读）
 *   AIH_ACCOUNT_RULES_ENDPOINT      Node 服务地址（默认 http://127.0.0.1:9527）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readNodeAccounts } = require('../lib/account/go-bridge/node-account-reader');
const { collectAccountUpstreamErrorRuleRecords } = require('../lib/server/upstream-error-rules-projection');
const { readJsonValue } = require('../lib/server/app-state-store');

const COLLECTION_PATH = '/v0/webui/account-upstream-error-rules';
const IMPORT_PATH = COLLECTION_PATH + '/import';
const ENDPOINT = String(process.env.AIH_ACCOUNT_RULES_ENDPOINT || 'http://127.0.0.1:9527')
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
  console.log('用法: node scripts/import-account-upstream-error-rules.js [--dry-run | --verify]');
}

function resolveAiHomeDir() {
  const explicit = String(process.env.AIH_HOME_DIR || process.env.AI_HOME_DIR || '').trim();
  return explicit || path.join(os.homedir(), '.ai_home');
}

function resolveManagementKey(aiHomeDir) {
  const fromEnv = String(process.env.AIH_SERVER_MANAGEMENT_KEY || process.env.AIH_IMPORT_KEY || '').trim();
  if (fromEnv) return fromEnv;
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

// 逐层比较，数组按下标比——规则顺序与挂载顺序都是匹配语义的一部分，不能排序后再比。
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function describe(record) {
  const rules = Array.isArray(record.rules) ? record.rules.length : 0;
  const groups = Array.isArray(record.group_ids) ? record.group_ids.length : 0;
  return record.account_ref + '  provider=' + String(record.provider || '?')
    + '  group_ids=' + groups + '  rules=' + rules;
}

function buildNodeRecords(aiHomeDir) {
  const { accounts } = readNodeAccounts(aiHomeDir);
  const collected = collectAccountUpstreamErrorRuleRecords(accounts);
  return collected;
}

function compareRecords(nodeRecords, goAccounts) {
  const diffs = [];
  const goByNodeRef = new Map();
  for (const account of goAccounts) {
    const key = String(account && (account.node_account_ref || account.account_ref) || '').trim();
    if (key) goByNodeRef.set(key, account);
  }
  if (nodeRecords.length !== goByNodeRef.size) {
    diffs.push('账号数量不一致: Node=' + nodeRecords.length + ' Go=' + goByNodeRef.size);
  }
  for (const record of nodeRecords) {
    const goRecord = goByNodeRef.get(record.account_ref);
    if (!goRecord) {
      diffs.push(record.account_ref + ': Node 有，Go 缺失');
      continue;
    }
    if (!sameValue(record.group_ids || [], goRecord.group_ids || [])) {
      diffs.push(record.account_ref + ': group_ids Node=' + JSON.stringify(record.group_ids || [])
        + ' Go=' + JSON.stringify(goRecord.group_ids || []));
    }
    if (!sameValue(record.rules || [], goRecord.rules || [])) {
      diffs.push(record.account_ref + ': rules 不一致');
    }
  }
  const nodeRefs = new Set(nodeRecords.map((record) => record.account_ref));
  for (const key of goByNodeRef.keys()) {
    if (!nodeRefs.has(key)) diffs.push(key + ': Go 有，Node 缺失');
  }
  return diffs;
}

async function runImport(key) {
  const payload = await request(IMPORT_PATH, { method: 'POST', key, body: {} });
  console.log('pushed=' + (Number(payload.pushed) || 0)
    + ' accepted=' + (Number(payload.accepted) || 0)
    + ' dropped=' + (Number(payload.dropped) || 0)
    + ' failed=' + (Number(payload.failed) || 0));
  if (Array.isArray(payload.droppedReasons) && payload.droppedReasons.length) {
    console.log('  dropped reasons: ' + payload.droppedReasons.join(', '));
  }
  if (Array.isArray(payload.skippedAccounts) && payload.skippedAccounts.length) {
    for (const item of payload.skippedAccounts) {
      console.log('  skipped: ' + String(item.accountRef || '?') + ' ' + String(item.reason || ''));
    }
  }
  if ((Number(payload.failed) || 0) > 0) {
    console.error('导入存在失败账号，未完全收敛');
    return 1;
  }
  return 0;
}

async function runVerify(nodeRecords, key) {
  const payload = await request(COLLECTION_PATH, { method: 'GET', key });
  const goAccounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  console.log('verify: Node=' + nodeRecords.length + ' Go=' + goAccounts.length);
  const diffs = compareRecords(nodeRecords, goAccounts);
  if (diffs.length === 0) {
    console.log('对拍通过：账号、挂载顺序与规则一致');
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
  const collected = buildNodeRecords(aiHomeDir);
  console.log('Node 存量账号级规则: ' + collected.records.length + '（' + aiHomeDir + '）');
  for (const record of collected.records) console.log('  ' + describe(record));
  for (const skipped of collected.skipped) {
    console.log('  skipped: ' + String(skipped.accountRef || '?') + ' ' + String(skipped.reason || ''));
  }

  if (options.dryRun) {
    console.log('dry-run：不发送导入请求');
    return 0;
  }
  const key = resolveManagementKey(aiHomeDir);
  if (!key) throw new Error('缺少 Management Key（app-state 的 config:server 或 AIH_SERVER_MANAGEMENT_KEY）');
  if (options.verify) return runVerify(collected.records, key);
  return runImport(key);
}

main().then((code) => {
  process.exitCode = Number(code) || 0;
}).catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
