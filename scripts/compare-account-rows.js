#!/usr/bin/env node
'use strict';

// 账号页行的 39 字段对拍：Node 当前响应 vs Go 账号事实装配。
//
// 与运行时影子对账（lib/server/account-shadow.js）的分工：
//   - 影子对账跑在服务进程里，比的是**接口刚返回的那一帧**，受页面访问触发、限频 60s；
//   - 这个脚本在外部直接读两个库 + 抓一次真实响应，适合切片 C 的「翻转前零差异」验收，
//     不依赖页面被打开，也能一次跑完全部账号。
//
// 判据（来自 lib/server/account-row-sources.js 的来源表）：
//   1. row_identical：assembleAccountRow(Node 行, Go 事实) 是否与 Node 行逐字段相同；
//      Node 独有字段与 go-projected 字段原样保留，所以这一项检查的其实是「Go 覆盖不改变行」。
//   2. field_mismatch：Go 有值且与 Node 不同的字段——这些是翻转后会变的地方，必须为 0。
//   3. fallback：Go 没写、沿用 Node 的字段（当前是 displayName/email/planType，缺口不是漂移）。
//
// Go 事实直接读 aih.db，SQL 镜像 Go 账号视图的 LEFT JOIN（accounts/credentials/profiles/
// usage_snapshots）。这是**只读近似**：真正的视图语义在 internal/transport/http/accountsapi，
// 字段增删要同步改这里（对拍脚本本身就是契约的复制品，不一致会被 row_identical 暴露）。
//
// 用法：node scripts/compare-account-rows.js [--json] [--node-payload <file>]
//       [--node-db ~/.ai_home/app-state.db] [--go-db ~/.ai_home/aih.db] [--base-url http://127.0.0.1:9527]
// 退出码：0 = 零差异；2 = 存在差异。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const {
  ACCOUNT_ROW_FIELDS,
  assembleAccountRow,
  diffAccountRow,
  diffProjectedRow,
  usageSnapshotLagMs,
  countNodeOnlySnapshots,
  countFallbacks
} = require('../lib/server/account-row-sources');

function parseArgs(argv) {
  const home = process.env.HOME || os.homedir();
  const options = {
    nodeDb: path.join(home, '.ai_home', 'app-state.db'),
    goDb: path.join(home, '.ai_home', 'aih.db'),
    baseUrl: 'http://127.0.0.1:9527',
    nodePayload: '',
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
      case '--base-url': options.baseUrl = next(); break;
      case '--node-payload': options.nodePayload = next(); break;
      case '--json': options.json = true; break;
      case '--help': options.help = true; break;
      default: throw new Error('未知参数: ' + flag);
    }
  }
  return options;
}

function usage() {
  return [
    '用法: node scripts/compare-account-rows.js [选项]',
    '',
    '  --node-payload <path> Node 响应 JSON（默认实时抓 /v0/webui/accounts）',
    '  --node-db <path>      Node 库（默认 ~/.ai_home/app-state.db）',
    '  --go-db <path>        Go 库（默认 ~/.ai_home/aih.db）',
    '  --base-url <url>      Node 服务地址（默认 http://127.0.0.1:9527）',
    '  --json                输出 JSON',
    '',
    '退出码：0 零差异；2 有差异'
  ].join('\n');
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA query_only = ON');
  return db;
}

function readManagementKey(nodeDb) {
  try {
    const db = openDb(nodeDb);
    try {
      const row = db.prepare("SELECT value FROM app_kv WHERE key = 'config:server'").get();
      const parsed = row && row.value ? JSON.parse(row.value) : null;
      return parsed && typeof parsed.managementKey === 'string' ? parsed.managementKey : '';
    } finally {
      db.close();
    }
  } catch (_error) {
    return '';
  }
}

function readSyncLinks(nodeDb) {
  try {
    const db = openDb(nodeDb);
    try {
      const row = db.prepare("SELECT value FROM app_kv WHERE key = 'go-account-sync:state'").get();
      const parsed = row && row.value ? JSON.parse(row.value) : null;
      return (parsed && parsed.links) || {};
    } finally {
      db.close();
    }
  } catch (_error) {
    return {};
  }
}

async function readNodeRows(options) {
  if (options.nodePayload) {
    const parsed = JSON.parse(fs.readFileSync(options.nodePayload, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.accounts || []);
  }
  const managementKey = readManagementKey(options.nodeDb);
  if (!managementKey) throw new Error('缺少 management key，无法实时抓取；请用 --node-payload 指定响应文件');
  const response = await fetch(options.baseUrl.replace(/\/+$/, '') + '/v0/webui/accounts', {
    headers: { authorization: 'Bearer ' + managementKey }
  });
  if (!response.ok) throw new Error('抓取 Node 响应失败: HTTP ' + response.status);
  const body = await response.json();
  return Array.isArray(body.accounts) ? body.accounts : [];
}

// buildGoFacts 按 Go 账号视图的口径把库里的行转成 accountView 形状（snake_case）。
function buildGoFacts(goDb) {
  const db = openDb(goDb);
  try {
    const rows = db.prepare(`
      SELECT a.account_ref, a.provider_id, a.enabled,
             c.auth_kind, c.auth_mode,
             p.display_name, p.email, p.subscription_kind,
             s.captured_at_ms, s.quota_status, s.quota_reason,
             EXISTS (
               SELECT 1 FROM account_defaults d
               WHERE d.provider_id = a.provider_id AND d.account_ref = a.account_ref
             ) AS is_default
        FROM accounts a
        LEFT JOIN account_credentials c ON c.account_ref = a.account_ref
        LEFT JOIN account_profiles p ON p.account_ref = a.account_ref
        LEFT JOIN account_usage_snapshots s ON s.account_ref = a.account_ref
       ORDER BY a.account_ref
    `).all();
    const index = new Map();
    for (const row of rows) {
      index.set(String(row.account_ref), {
        account_ref: String(row.account_ref),
        provider_id: String(row.provider_id || ''),
        enabled: Number(row.enabled) === 1,
        has_credential: Boolean(String(row.auth_kind || '')),
        auth_kind: String(row.auth_kind || ''),
        auth_mode: String(row.auth_mode || ''),
        display_name: String(row.display_name || ''),
        email: String(row.email || ''),
        subscription_kind: String(row.subscription_kind || ''),
        usage_snapshot: Number(row.captured_at_ms) > 0
          ? { captured_at: new Date(Number(row.captured_at_ms)).toISOString() }
          : null,
        is_default: Number(row.is_default) === 1,
        quota_status: String(row.quota_status || ''),
        quota_reason: String(row.quota_reason || '')
      });
    }
    return index;
  } finally {
    db.close();
  }
}

function goRefFor(nodeRef, links) {
  const link = links && links[nodeRef];
  const goRef = link && link.goRef ? String(link.goRef).trim() : '';
  return goRef || String(nodeRef || '').trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const nodeRows = await readNodeRows(options);
  const goFacts = buildGoFacts(options.goDb);
  const links = readSyncLinks(options.nodeDb);

  const fieldStats = new Map();
  for (const entry of ACCOUNT_ROW_FIELDS) {
    if (entry.source === 'node' || entry.source === 'go-projected') continue;
    fieldStats.set(entry.field, { compared: 0, mismatch: 0 });
  }
  // 覆盖口径要如实打出来：字段总数 / Go 参与判定 / Go 缺值回退 / Node 独有。
  // 「零差异」只对前两类负责，不能拿 39 个字段的名义宣称全部由 Go 校验过。
  const coverage = {
    total: ACCOUNT_ROW_FIELDS.length,
    goCompared: ACCOUNT_ROW_FIELDS.filter((entry) => entry.source === 'go').length,
    nodeOnly: ACCOUNT_ROW_FIELDS.filter((entry) => entry.source === 'node').length,
    goProjected: ACCOUNT_ROW_FIELDS.filter((entry) => entry.source === 'go-projected').length
  };
  const mismatches = [];
  const fallbacks = new Map();
  const rowDiff = [];
  const warnings = [];

  for (const nodeRow of nodeRows) {
    const goRow = goFacts.get(goRefFor(nodeRow.accountRef, links)) || null;
    const assembled = assembleAccountRow(nodeRow, goRow);
    if (!isDeepStrictEqual(assembled, nodeRow)) {
      rowDiff.push({
        accountRef: nodeRow.accountRef,
        provider: nodeRow.provider,
        fields: Object.keys(nodeRow).filter((key) => !isDeepStrictEqual(assembled[key], nodeRow[key]))
      });
    }
    const diffs = goRow ? [...diffAccountRow(nodeRow, goRow), ...diffProjectedRow(nodeRow, goRow)] : [];
    for (const diff of diffs) {
      const stat = fieldStats.get(diff.field);
      if (stat) stat.mismatch += 1;
      mismatches.push({ accountRef: nodeRow.accountRef, provider: nodeRow.provider, ...diff });
    }
    for (const field of goRow ? countFallbacks(goRow) : []) {
      fallbacks.set(field, (fallbacks.get(field) || 0) + 1);
    }
    if (goRow) {
      const lag = usageSnapshotLagMs(nodeRow, goRow);
      if (lag < -1000) {
        warnings.push({
          accountRef: nodeRow.accountRef,
          provider: nodeRow.provider,
          warning: 'go_snapshot_ahead_ms',
          lagMs: lag
        });
      }
    }
    if (goRow && countNodeOnlySnapshots(nodeRow, goRow)) {
      warnings.push({
        accountRef: nodeRow.accountRef,
        provider: nodeRow.provider,
        warning: 'node_only_usage_snapshot',
        capturedAt: nodeRow.usageSnapshot && nodeRow.usageSnapshot.capturedAt
      });
    }
  }

  const report = {
    nodeRows: nodeRows.length,
    goRows: goFacts.size,
    unmatched: nodeRows.filter((row) => !goFacts.has(goRefFor(row.accountRef, links))).length,
    rowIdentical: rowDiff.length === 0,
    rowDiff,
    mismatchCount: mismatches.length,
    mismatches,
    coverage,
    fieldStats: Object.fromEntries(fieldStats),
    fallbacks: Object.fromEntries(fallbacks),
    warnings,
    zeroDiff: rowDiff.length === 0 && mismatches.length === 0
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('账号行对拍: Node ' + report.nodeRows + ' 行 / Go ' + report.goRows + ' 个账号 / 未匹配 ' + report.unmatched);
    console.log('row_identical=' + report.rowIdentical + ' field_mismatch=' + report.mismatchCount);
    console.log('覆盖: 共 ' + report.coverage.total + ' 字段 = Go 判定 ' + report.coverage.goCompared +
      ' + Go 投影(Node 直读) ' + report.coverage.goProjected + ' + Node 独有 ' + report.coverage.nodeOnly);
    for (const [field, stat] of Object.entries(report.fieldStats)) {
      console.log('  ' + field.padEnd(20) + ' mismatch=' + stat.mismatch);
    }
    if (Object.keys(report.fallbacks).length > 0) {
      console.log('fallback（Go 缺值，沿用 Node）:');
      for (const [field, count] of Object.entries(report.fallbacks)) {
        console.log('  ' + field.padEnd(20) + ' ' + count + ' 行');
      }
    }
    for (const diff of report.mismatches.slice(0, 10)) {
      console.log('  ! ' + diff.accountRef + ' ' + diff.field + ' node=' + String(diff.node) + ' go=' + String(diff.go));
    }
    for (const diff of report.rowDiff.slice(0, 5)) {
      console.log('  ! row ' + diff.accountRef + ' 字段不同: ' + diff.fields.join(','));
    }
    for (const warning of report.warnings.slice(0, 10)) {
      const detail = warning.warning === 'go_snapshot_ahead_ms'
        ? ' ' + Math.abs(warning.lagMs) + 'ms'
        : ' capturedAt=' + (warning.capturedAt ? new Date(warning.capturedAt).toISOString() : '-');
      console.log('  ~ ' + warning.accountRef + ' ' + warning.provider + ' ' + warning.warning + detail);
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
