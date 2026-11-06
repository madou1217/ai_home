#!/usr/bin/env node
'use strict';

/**
 * 账号 token 用量「Node 行 vs Go 账本」对拍。
 *
 * 背景：账号页的 tokenUsage（day/week/month/total + 分模型）原先由 Node 从
 * model_usage_records 现算，Go 侧对应的是 usage_ledger 的
 * /v1/management/accounts/{ref}/token-usage。两边口径必须一致，否则切流后
 * 同一个账号的「今天用了多少」会在页面上跳变。
 *
 * 怎么取数：
 *   - Node 侧：GET /v0/webui/accounts，取账号行里已经装配好的 tokenUsage（正式数据面）；
 *   - Go 侧：GET /v0/webui/accounts/:provider/:ref/token-usage?source=go（调试对拍入口）。
 *   走同一个 Node 进程而不是直连 Go，是因为 Go 的 management key 每次启动随机生成、
 *   只存在 Node 内存里，外部脚本拿不到。
 *
 * 判据：每个维度按 max(|node|,|go|) 归一算差异百分比，> 阈值（默认 1%）打 WARN。
 * 成本不参与对拍：Go 的 usage_ledger 只存 token 事实，响应里 cost_known=false、
 * 成本恒为 null，拿它和 Node 的历史成本比只会得到无意义的 100%。
 *
 * 用法：node scripts/parity-token-usage.js [--base-url http://127.0.0.1:9527]
 *        [--limit 5] [--threshold 1] [--node-db ~/.ai_home/app-state.db] [--key <management key>]
 * 退出码：0 = 全部在阈值内；2 = 存在超阈值差异或请求失败。
 */

const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DIMENSIONS = ['day', 'week', 'month', 'total'];
// 覆盖范围：账号页里最容易出现「窗口边界/跨进程写入」差异的家族。
// agy 在本机可能没有账号，缺失时按「未覆盖」提示，不当成失败。
const COVERAGE_PROVIDERS = ['codex', 'claude', 'codebuddy', 'zcode', 'agy'];
const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD_PCT = 1;

function parseArgs(argv) {
  const home = process.env.HOME || os.homedir();
  const options = {
    baseUrl: 'http://127.0.0.1:9527',
    limit: DEFAULT_LIMIT,
    thresholdPct: DEFAULT_THRESHOLD_PCT,
    nodeDb: path.join(home, '.ai_home', 'app-state.db'),
    key: '',
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
      case '--base-url': options.baseUrl = next(); break;
      case '--limit': options.limit = Math.max(1, Number(next()) || DEFAULT_LIMIT); break;
      case '--threshold': options.thresholdPct = Math.max(0, Number(next()) || 0); break;
      case '--node-db': options.nodeDb = next(); break;
      case '--key': options.key = next(); break;
      case '--help': options.help = true; break;
      default: throw new Error('未知参数: ' + flag);
    }
  }
  return options;
}

function usage() {
  return [
    '用法: node scripts/parity-token-usage.js [选项]',
    '  --base-url <url>   AIH Server 地址（默认 http://127.0.0.1:9527）',
    '  --limit <n>        对拍账号数上限（默认 5，先按 codex/claude/codebuddy/zcode/agy 覆盖）',
    '  --threshold <pct>  差异告警阈值，百分比（默认 1）',
    '  --node-db <path>   Node 库（默认 ~/.ai_home/app-state.db，用于取 Management Key）',
    '  --key <key>        显式指定 Management Key（默认从 config:server 读）',
    '  --help'
  ].join('\n');
}

// Management Key 只在这里读：它落盘在 config:server，和 compare-quota-stats.js 同源。
// 不建议用环境变量传：同一台机器上换 Key 后环境变量会变成过期值，症状是全线 401。
function readManagementKey(nodeDb) {
  const db = new DatabaseSync(nodeDb, { readOnly: true });
  try {
    const row = db.prepare("select json_extract(value,'$.managementKey') as key from app_kv where key='config:server'").get();
    return String(row && row.key || '').trim();
  } finally {
    db.close();
  }
}

async function requestJson(url, managementKey) {
  const response = await fetch(url, { headers: { authorization: 'Bearer ' + managementKey } });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }
  return { status: response.status, ok: response.ok, payload };
}

// 选账号：先保证 provider 覆盖（这几家的 token 用量形状差别最大），不够再用列表顺序补齐。
// 不直接取「前 5 个」是因为列表按 provider 分组排序，前 5 个经常全落在同一两家。
function selectAccounts(accounts, limit) {
  const selected = [];
  const seen = new Set();
  const add = (account) => {
    if (!account || !account.accountRef || seen.has(account.accountRef)) return;
    if (selected.length >= limit) return;
    seen.add(account.accountRef);
    selected.push(account);
  };
  for (const provider of COVERAGE_PROVIDERS) {
    if (selected.length >= limit) break;
    add(accounts.find((account) => String(account.provider || '').toLowerCase() === provider));
  }
  for (const account of accounts) add(account);
  return selected;
}

// 差异百分比：两边都 0 视为一致；否则按较大值归一，范围恒在 0..100。
// 用 max 而不是 node 做分母：Node 少算（go>node）时若按 node 归一，percentage 会 >100，
// 数字看着像脚本算错了，而对拍要的是「差多远」，不是「差几倍」。
function diffPct(nodeValue, goValue) {
  const left = Math.abs(Number(nodeValue) || 0);
  const right = Math.abs(Number(goValue) || 0);
  if (left === 0 && right === 0) return 0;
  return (Math.abs(left - right) / Math.max(left, right)) * 100;
}

function formatNumber(value) {
  return (Number(value) || 0).toLocaleString('en-US');
}

function formatPct(value) {
  return value.toFixed(2) + '%';
}

function modelUsageMap(models) {
  const map = new Map();
  for (const item of Array.isArray(models) ? models : []) {
    const model = String(item && item.model || '').trim();
    if (!model) continue;
    map.set(model, item);
  }
  return map;
}

function compareAccount(account, goUsage) {
  const nodeUsage = account.tokenUsage && typeof account.tokenUsage === 'object' ? account.tokenUsage : null;
  const lines = [];
  const warnings = [];

  for (const dimension of DIMENSIONS) {
    const nodeValue = Number(nodeUsage && nodeUsage[dimension]) || 0;
    const goValue = Number(goUsage && goUsage[dimension]) || 0;
    const pct = diffPct(nodeValue, goValue);
    lines.push('  ' + dimension.padEnd(5)
      + ' node=' + formatNumber(nodeValue).padStart(15)
      + ' go=' + formatNumber(goValue).padStart(15)
      + ' diff=' + formatPct(pct).padStart(8));
    if (pct > 0) warnings.push({ kind: 'dimension', dimension, nodeValue, goValue, pct });
  }

  const nodeModels = modelUsageMap(nodeUsage && nodeUsage.models);
  const goModels = modelUsageMap(goUsage && goUsage.models);
  const modelNames = new Set([...nodeModels.keys(), ...goModels.keys()]);
  let worst = null;
  for (const model of modelNames) {
    const nodeRow = nodeModels.get(model) || {};
    const goRow = goModels.get(model) || {};
    for (const dimension of DIMENSIONS) {
      const nodeValue = Number(nodeRow[dimension]) || 0;
      const goValue = Number(goRow[dimension]) || 0;
      const pct = diffPct(nodeValue, goValue);
      if (!worst || pct > worst.pct) worst = { model, dimension, pct, nodeValue, goValue };
    }
  }
  // 模型数两边都有值时也要报「最大差异 0.00%」：只写「无可比模型」会让读者以为
  // 模型维度根本没比对，而实际上比过了、结论是一致。
  lines.push('  models node=' + nodeModels.size + ' go=' + goModels.size
    + (worst
      ? ' 最大差异 ' + worst.model + ' ' + worst.dimension + ' ' + formatPct(worst.pct)
      : ' 无可比模型'));
  if (worst && worst.pct > 0) {
    warnings.push({ kind: 'model', dimension: worst.dimension, model: worst.model, nodeValue: worst.nodeValue, goValue: worst.goValue, pct: worst.pct });
  }

  return { lines, warnings, nodeUsagePresent: Boolean(nodeUsage) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const managementKey = options.key || readManagementKey(options.nodeDb);
  if (!managementKey) {
    throw new Error('没有读到 Management Key（' + options.nodeDb + ' 的 config:server）。'
      + '请在真实用户 HOME 下运行，或用 --key 显式指定。');
  }

  const accountsResponse = await requestJson(options.baseUrl + '/v0/webui/accounts', managementKey);
  if (!accountsResponse.ok || !accountsResponse.payload || accountsResponse.payload.ok !== true) {
    throw new Error('读取账号列表失败: status=' + accountsResponse.status
      + ' error=' + String(accountsResponse.payload && accountsResponse.payload.error || 'unknown'));
  }
  const accounts = Array.isArray(accountsResponse.payload.accounts) ? accountsResponse.payload.accounts : [];
  const selected = selectAccounts(accounts, options.limit);
  if (selected.length === 0) throw new Error('账号列表为空，没有可对拍的账号');

  console.log('Node token 用量 vs Go usage_ledger');
  console.log('账号数 ' + selected.length + '/' + accounts.length
    + '，阈值 ' + formatPct(options.thresholdPct)
    + '，时区偏移交给服务端本地日历（tz_offset_minutes 由 Node 侧补）');
  console.log('成本不参与对拍：Go 的 cost_known=false，成本恒为 null');
  console.log('');

  const problems = [];
  for (const account of selected) {
    const provider = String(account.provider || '').trim().toLowerCase();
    const accountRef = String(account.accountRef || '').trim();
    const debugUrl = options.baseUrl + '/v0/webui/accounts/' + encodeURIComponent(provider) + '/'
      + encodeURIComponent(accountRef) + '/token-usage?source=go';
    const result = await requestJson(debugUrl, managementKey);
    const label = provider + '/' + accountRef;
    console.log(label);
    if (!result.ok || !result.payload || result.payload.ok !== true) {
      const error = String(result.payload && result.payload.error || 'unknown');
      console.log('  ERROR status=' + result.status + ' error=' + error);
      problems.push({ label, what: 'Go 请求失败 (' + error + ')', pct: null });
      console.log('');
      continue;
    }
    const comparison = compareAccount(account, result.payload.go);
    if (!comparison.nodeUsagePresent) {
      console.log('  注意：Node 行没有 tokenUsage，按 0 参与比较');
    }
    for (const line of comparison.lines) console.log(line);
    for (const warning of comparison.warnings) {
      if (warning.pct <= options.thresholdPct) continue;
      const target = warning.kind === 'model' ? warning.model + ' ' + warning.dimension + ' ' : warning.dimension + ' ';
      console.log('  WARN ' + target + formatPct(warning.pct)
        + ' (node=' + formatNumber(warning.nodeValue) + ' go=' + formatNumber(warning.goValue) + ')');
      problems.push({ label, what: target.trim(), pct: warning.pct });
    }
    console.log('');
  }

  const missingCoverage = COVERAGE_PROVIDERS.filter((provider) => (
    !selected.some((account) => String(account.provider || '').toLowerCase() === provider)
  ));
  console.log('汇总：' + selected.length + ' 个账号，' + problems.length + ' 项超阈值/失败');
  for (const problem of problems) {
    console.log('  - ' + problem.label + ' ' + problem.what
      + (problem.pct === null ? '' : ' ' + formatPct(problem.pct)));
  }
  if (missingCoverage.length > 0) {
    console.log('未覆盖的 provider（本机没有账号）：' + missingCoverage.join(', '));
  }
  return problems.length > 0 ? 2 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('parity failed:', error && error.message);
    process.exitCode = 1;
  });
