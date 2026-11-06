#!/usr/bin/env node
'use strict';

/**
 * 额度统计「Node vs Go」对拍：同一个账号、同一组参数，分别打 Node 的 WebUI 接口与
 * Go 的 management 接口，按窗口维度比较 token 总数与可用性。
 *
 * 用途：额度统计页切 Go 之前，用它证明两边在「同一份数据」上结论一致；导入历史前后
 * 各跑一次，差异应当只剩导入补上的部分。
 *
 * 用法：node scripts/compare-quota-stats.js --provider zcode --ref acct_xxx [--days 7]
 */

const { DatabaseSync } = require('node:sqlite');

const APP_STATE = '/Users/model/.ai_home/app-state.db';
const NODE_BASE = 'http://127.0.0.1:9527';
const GO_BASE = 'http://127.0.0.1:19550';

function parseArgs(argv) {
  const options = { provider: '', ref: '', days: 7, key: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--provider') options.provider = argv[index + 1];
    if (argv[index] === '--ref') options.ref = argv[index + 1];
    if (argv[index] === '--days') options.days = Number(argv[index + 1]) || 7;
    if (argv[index] === '--key') options.key = argv[index + 1];
  }
  return options;
}

function readConfig() {
  const db = new DatabaseSync(APP_STATE, { readOnly: true });
  try {
    const row = db.prepare("select json_extract(value,'$.managementKey') as mgmt, json_extract(value,'$.apiKey') as api from app_kv where key='config:server'").get();
    const linksRow = db.prepare("select value from app_kv where key='go-account-sync:state'").get();
    const links = linksRow && linksRow.value ? JSON.parse(linksRow.value).links || {} : {};
    return { mgmt: String(row && row.mgmt || ''), links };
  } finally {
    db.close();
  }
}

function dimensionRows(payload) {
  const dimensions = Array.isArray(payload && payload.dimensions) ? payload.dimensions : [];
  return dimensions.map((dimension) => ({
    windowMinutes: Number(dimension.windowMinutes) || 0,
    available: Boolean(dimension.available),
    dataState: String(dimension.dataState || ''),
    tokens: (Array.isArray(dimension.scopes) ? dimension.scopes : [])
      .reduce((sum, scope) => sum + (Number(scope.tokens) || 0), 0)
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.provider || !options.ref) throw new Error('需要 --provider 与 --ref');
  const config = readConfig();
  // Go 的 management key 是 Node 每次启动生成的（不落盘）；本地对拍时用
  // --key 或 AIH_GO_MANAGEMENT_KEY 传入，与 Node 传给 Go 的那份一致。
  const goKey = options.key || process.env.AIH_GO_MANAGEMENT_KEY || '';
  const goRef = (config.links[options.ref] && config.links[options.ref].goRef) || options.ref;
  const nodeResponse = await fetch(
    NODE_BASE + '/v0/webui/accounts/' + encodeURIComponent(options.provider) + '/' + encodeURIComponent(options.ref)
    + '/quota-stats?range_days=' + options.days,
    { headers: { authorization: 'Bearer ' + config.mgmt } }
  );
  const goResponse = await fetch(
    GO_BASE + '/v1/management/accounts/' + encodeURIComponent(goRef)
    + '/quota-stats?range_days=' + options.days,
    { headers: { authorization: 'Bearer ' + goKey } }
  );
  if (!nodeResponse.ok || !goResponse.ok) {
    throw new Error('请求失败 node=' + nodeResponse.status + ' go=' + goResponse.status);
  }
  const nodePayload = await nodeResponse.json();
  const goPayload = (await goResponse.json()).data || {};
  const nodeRows = dimensionRows(nodePayload);
  const goRows = dimensionRows(goPayload);
  console.log('account', options.ref, '→ go', goRef, 'days', options.days);
  console.log('node 维度', JSON.stringify(nodeRows));
  console.log('go   维度', JSON.stringify(goRows));
  const nodeTotal = nodeRows.reduce((sum, row) => sum + row.tokens, 0);
  const goTotal = goRows.reduce((sum, row) => sum + row.tokens, 0);
  console.log('tokens node=' + nodeTotal + ' go=' + goTotal + ' (差 ' + (nodeTotal - goTotal) + ')');
}

main().catch((error) => {
  console.error('compare failed:', error && error.message);
  process.exitCode = 1;
});
