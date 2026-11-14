#!/usr/bin/env node
'use strict';

// 账号页行的 Node / Go 对拍（只读）。
//
// 比的是两个真实响应：
//   Node  GET /v0/webui/accounts（生产前端当前的行）
//   Go    GET /v1/management/webui/accounts（本切片新增的读模型）
//
// 判据来自 Go 响应自带的三份字段清单，脚本不维护第二份名单：
//   filled_fields    Go 独占事实 → 必须与 Node 完全一致，任一不同就是真差异（退出码 2）
//   approx_fields    Go 也有值但口径/时机由 Node 定 → 差异列出但不算失败
//   unfilled_fields  Go 的空占位 → 差异必然存在，只统计条数
// 键集合差异单独报 missing / extra：missing 是 Node 有、Go 没发的键（覆盖层不受影响），
// extra 是 Go 多出来的键（例如 modelCount），供下一轮代理时决定是否透出。
//
// 脚本只做 SELECT 与 GET，不写库、不改服务。
//
// 用法:
//   node scripts/compare-webui-accounts.js --go-base-url http://127.0.0.1:PORT
//   node scripts/compare-webui-accounts.js --node-payload node.json --go-payload go.json
// 退出码：0 = filled 字段零差异；2 = 有差异；1 = 运行失败。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

function parseArgs(argv) {
  const home = process.env.HOME || os.homedir();
  const options = {
    nodeDb: path.join(home, '.ai_home', 'app-state.db'),
    baseUrl: 'http://127.0.0.1:9527',
    goBaseUrl: String(process.env.AIH_SERVER_BASE_URL || '').trim(),
    nodePayload: '',
    goPayload: '',
    json: false,
    help: false
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
      case '--base-url': options.baseUrl = next(); break;
      case '--go-base-url': options.goBaseUrl = next(); break;
      case '--node-payload': options.nodePayload = next(); break;
      case '--go-payload': options.goPayload = next(); break;
      case '--json': options.json = true; break;
      case '--help': options.help = true; break;
      default: throw new Error('未知参数: ' + flag);
    }
  }
  return options;
}

function usage() {
  return [
    '用法: node scripts/compare-webui-accounts.js [选项]',
    '',
    '  --go-base-url <url>   Go Core 地址（默认读 AIH_SERVER_BASE_URL）',
    '  --go-payload <path>   直接用已保存的 Go 响应 JSON（离线对拍）',
    '  --node-payload <path> 直接用已保存的 Node 响应 JSON（默认实时抓取）',
    '  --node-db <path>      Node 库，读 management key 与账号链接（默认 ~/.ai_home/app-state.db）',
    '  --base-url <url>      Node 服务地址（默认 http://127.0.0.1:9527）',
    '  --json                输出 JSON',
    '',
    '退出码：0 filled 字段零差异；2 有差异；1 运行失败'
  ].join('\n');
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA query_only = ON');
  return db;
}

function readAppKv(nodeDb, key) {
  try {
    const db = openDb(nodeDb);
    try {
      const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(key);
      return row && row.value ? JSON.parse(row.value) : null;
    } finally {
      db.close();
    }
  } catch (_error) {
    return null;
  }
}

function readManagementKey(nodeDb) {
  const config = readAppKv(nodeDb, 'config:server');
  return config && typeof config.managementKey === 'string' ? config.managementKey : '';
}

function readSyncLinks(nodeDb) {
  const state = readAppKv(nodeDb, 'go-account-sync:state');
  return (state && state.links) || {};
}

async function fetchJSON(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error('请求失败: HTTP ' + response.status + ' ' + url);
  return response.json();
}

async function readNodeRows(options) {
  if (options.nodePayload) {
    const parsed = JSON.parse(fs.readFileSync(options.nodePayload, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.accounts || []);
  }
  const managementKey = readManagementKey(options.nodeDb);
  if (!managementKey) throw new Error('缺少 management key，无法实时抓取 Node 响应；请用 --node-payload');
  const body = await fetchJSON(options.baseUrl.replace(/\/+$/, '') + '/v0/webui/accounts', {
    authorization: 'Bearer ' + managementKey
  });
  return Array.isArray(body.accounts) ? body.accounts : [];
}

// Go 侧按 keyset 翻页取全量；字段清单取第一页的（同一进程内是常量）。
async function readGoRows(options) {
  if (options.goPayload) {
    const parsed = JSON.parse(fs.readFileSync(options.goPayload, 'utf8'));
    return {
      rows: Array.isArray(parsed) ? parsed : (parsed.accounts || []),
      meta: parsed || {}
    };
  }
  if (!options.goBaseUrl) {
    throw new Error('缺少 --go-base-url（或 AIH_SERVER_BASE_URL）；Go Core 的端口在启动日志 "Go Core ready at" 一行');
  }
  const managementKey = readManagementKey(options.nodeDb);
  if (!managementKey) throw new Error('缺少 management key，无法调用 Go 管理接口');
  const base = options.goBaseUrl.replace(/\/+$/, '');
  const rows = [];
  let afterRef = '';
  let meta = null;
  for (let page = 0; page < 20; page += 1) {
    const search = new URLSearchParams({ limit: '200' });
    if (afterRef) search.set('after_ref', afterRef);
    const body = await fetchJSON(base + '/v1/management/webui/accounts?' + search.toString(), {
      authorization: 'Bearer ' + managementKey
    });
    if (body && body.derived_by !== 'go_partial') {
      throw new Error('Go 响应缺少 derived_by=go_partial，确认版本是否匹配');
    }
    if (!meta) meta = body;
    const data = Array.isArray(body.accounts) ? body.accounts : [];
    rows.push(...data);
    const next = body.page && body.page.next_after_ref;
    if (!next || data.length === 0) break;
    afterRef = String(next);
  }
  return { rows, meta: meta || {} };
}

function goRefFor(nodeRef, links) {
  const link = links && links[nodeRef];
  const goRef = link && link.goRef ? String(link.goRef).trim() : '';
  return goRef || String(nodeRef || '').trim();
}

function classify(meta) {
  const toSet = (list) => new Set(Array.isArray(list) ? list.map(String) : []);
  const filled = toSet(meta.filled_fields);
  const approx = toSet(meta.approx_fields);
  const unfilled = toSet(meta.unfilled_fields);
  return { filled, approx, unfilled };
}

function fieldClass(field, classes) {
  if (classes.filled.has(field)) return 'filled';
  if (classes.approx.has(field)) return 'approx';
  if (classes.unfilled.has(field)) return 'unfilled';
  return 'unknown';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const nodeRows = await readNodeRows(options);
  const { rows: goRows, meta } = await readGoRows(options);
  const links = readSyncLinks(options.nodeDb);
  const classes = classify(meta);
  if (classes.filled.size === 0) {
    throw new Error('Go 响应没有 filled_fields，无法判定权威字段');
  }

  const goIndex = new Map();
  for (const row of goRows) goIndex.set(String(row.accountRef || ''), row);

  const buckets = { filled: [], approx: [], unfilled: [], unknown: [] };
  const missingKeys = new Map();
  const extraKeys = new Map();
  const unmatchedNode = [];
  let matched = 0;

  for (const nodeRow of nodeRows) {
    const nodeRef = String(nodeRow.accountRef || '');
    const goRow = goIndex.get(goRefFor(nodeRef, links)) || null;
    if (!goRow) {
      unmatchedNode.push(nodeRef);
      continue;
    }
    matched += 1;
    for (const field of Object.keys(nodeRow)) {
      if (!(field in goRow)) {
        missingKeys.set(field, (missingKeys.get(field) || 0) + 1);
        continue;
      }
      if (isDeepStrictEqual(nodeRow[field], goRow[field])) continue;
      const bucket = fieldClass(field, classes);
      buckets[bucket].push({
        accountRef: nodeRef,
        provider: nodeRow.provider,
        field,
        node: nodeRow[field],
        go: goRow[field]
      });
    }
    for (const field of Object.keys(goRow)) {
      if (!(field in nodeRow)) extraKeys.set(field, (extraKeys.get(field) || 0) + 1);
    }
  }

  const goOnly = goRows
    .map((row) => String(row.accountRef || ''))
    .filter((ref) => !nodeRows.some((row) => goRefFor(String(row.accountRef || ''), links) === ref));

  const report = {
    nodeRows: nodeRows.length,
    goRows: goRows.length,
    matched,
    unmatchedNode,
    goOnly,
    filledMismatchCount: buckets.filled.length,
    approxMismatchCount: buckets.approx.length,
    unfilledMismatchCount: buckets.unfilled.length,
    unknownMismatchCount: buckets.unknown.length,
    missingKeys: Object.fromEntries(missingKeys),
    extraKeys: Object.fromEntries(extraKeys),
    mismatches: buckets,
    zeroDiff: buckets.filled.length === 0 && buckets.unknown.length === 0 && unmatchedNode.length === 0 && goOnly.length === 0
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('账号页行对拍: Node ' + report.nodeRows + ' 行 / Go ' + report.goRows + ' 行 / 匹配 ' + matched);
    console.log('filled 差异=' + report.filledMismatchCount +
      ' approx 差异=' + report.approxMismatchCount +
      ' unfilled 差异=' + report.unfilledMismatchCount +
      ' 未分类差异=' + report.unknownMismatchCount);
    if (unmatchedNode.length > 0) console.log('Node 有、Go 无: ' + unmatchedNode.join(', '));
    if (goOnly.length > 0) console.log('Go 有、Node 无: ' + goOnly.join(', '));
    const missing = Object.keys(report.missingKeys);
    if (missing.length > 0) console.log('Go 未发出的 Node 键: ' + missing.map((k) => k + '×' + report.missingKeys[k]).join(', '));
    const extra = Object.keys(report.extraKeys);
    if (extra.length > 0) console.log('Go 多出的键: ' + extra.map((k) => k + '×' + report.extraKeys[k]).join(', '));
    for (const [bucket, list] of Object.entries(buckets)) {
      if (bucket === 'unfilled' || list.length === 0) continue;
      console.log('[' + bucket + ']');
      for (const diff of list.slice(0, 15)) {
        console.log('  ! ' + diff.accountRef + ' ' + diff.field + ' node=' + JSON.stringify(diff.node) + ' go=' + JSON.stringify(diff.go));
      }
      if (list.length > 15) console.log('  … 另有 ' + (list.length - 15) + ' 条');
    }
  }
  return report.zeroDiff ? 0 : 2;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(String((error && error.message) || error));
    process.exitCode = 1;
  });
