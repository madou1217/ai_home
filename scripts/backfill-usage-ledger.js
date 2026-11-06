#!/usr/bin/env node
'use strict';

/**
 * 把 Node 的历史 token 事实（app-state.model_usage_records）导入 Go 的 usage_ledger。
 *
 * 为什么需要：额度统计页要切到 Go，但 Go 账本只有切换之后的数据；Node 手里有一百多万条
 * 历史。导入接口按 source_key 幂等，脚本可以反复跑，切流前再补一次增量即可。
 *
 * 用法：node scripts/backfill-usage-ledger.js [--batch 2000] [--dry-run] [--limit N]
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const APP_STATE = '/Users/model/.ai_home/app-state.db';
const GO_DB = process.env.AIH_GO_DB || '/Users/model/.ai_home/aih.db';
const ENDPOINT = process.env.AIH_IMPORT_ENDPOINT
  || 'http://127.0.0.1:19550/v1/management/usage/import';

function parseArgs(argv) {
  const options = { batch: 2000, dryRun: false, limit: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--batch') options.batch = Number(argv[index + 1]) || options.batch;
    if (argv[index] === '--dry-run') options.dryRun = true;
    if (argv[index] === '--limit') options.limit = Number(argv[index + 1]) || 0;
  }
  return options;
}

function readManagementKey() {
  const db = new DatabaseSync(APP_STATE, { readOnly: true });
  try {
    const row = db.prepare("select json_extract(value,'$.managementKey') as key from app_kv where key='config:server'").get();
    return row && row.key ? String(row.key) : '';
  } finally {
    db.close();
  }
}

// toEvent 把 Node 的计数口径翻译成 Go 账本口径。
//
// Node 的 input_tokens **不含**缓存，total_tokens = input + cache_read + cache_write + output；
// Go 的 input_tokens **含**缓存（CHECK: cached + cache_write <= input），且
// total = input + output。直接照抄会被表约束整批拒掉（实测 2 万行全 skipped）。
function toEvent(row) {
  const input = Number(row.input_tokens) || 0;
  const output = Number(row.output_tokens) || 0;
  const cacheRead = Number(row.cache_read_input_tokens) || 0;
  const cacheWrite = Number(row.cache_creation_input_tokens) || 0;
  return {
    source_key: 'node:' + String(row.event_key || ''),
    account_ref: String(row.account_ref || ''),
    provider: String(row.provider || '').toLowerCase(),
    model: String(row.model || ''),
    session_id: String(row.session_id || ''),
    occurred_at_ms: Number(row.timestamp_ms) || 0,
    input_tokens: input + cacheRead + cacheWrite,
    output_tokens: output,
    cached_input_tokens: cacheRead,
    cache_write_input_tokens: cacheWrite,
    reasoning_tokens: Math.min(Number(row.reasoning_output_tokens) || 0, output),
    // Go 的 total 是「含缓存的 input + output」：表 CHECK 要求 total = input + output，
    // 而这里的 input 已经把缓存并进来了。
    total_tokens: input + cacheRead + cacheWrite + output
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const key = process.env.AIH_IMPORT_KEY || readManagementKey();
  if (!key && !options.dryRun) throw new Error('缺少管理密钥');
  // 只导「Go 里还存在的账号」：账本有账号外键，已删除/已 rekey 的账号历史无法落库。
  // 额度统计页是按账号看数据，这些历史本来就不会出现在页面上。
  const goDb = new DatabaseSync(GO_DB, { readOnly: true });
  const accounts = new Set(goDb.prepare('select account_ref from accounts').all().map((row) => String(row.account_ref)));
  goDb.close();
  const db = new DatabaseSync(APP_STATE, { readOnly: true });
  let cursor = 0;
  let total = 0;
  let imported = 0;
  let skipped = 0;
  try {
      // 只取可导入的行：早期记录没有账号与模型（account_ref=''），无法落进账本；
      // 它们留在 Node 侧不影响统计，导入时直接跳过。
      const select = db.prepare(`
      SELECT id, event_key, account_ref, provider, model, session_id, timestamp_ms,
             input_tokens, output_tokens, cache_read_input_tokens,
             cache_creation_input_tokens, reasoning_output_tokens, total_tokens
        FROM model_usage_records
       WHERE id > ? AND account_ref <> '' AND model <> ''
       ORDER BY id
       LIMIT ?`);
    for (;;) {
      const rows = select.all(cursor, options.batch);
      if (rows.length === 0) break;
      cursor = Number(rows[rows.length - 1].id);
      total += rows.length;
      const events = rows
        .map(toEvent)
        .filter((event) => event.source_key !== 'node:' && accounts.has(event.account_ref));
      if (!options.dryRun && events.length > 0) {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify({ events })
        });
        if (!response.ok) throw new Error('import failed: ' + response.status + ' ' + (await response.text()).slice(0, 200));
        const payload = await response.json();
        imported += Number(payload.data && payload.data.imported) || 0;
        skipped += Number(payload.data && payload.data.skipped) || 0;
      }
      if (total % 50000 === 0) {
        console.log('progress scanned=' + total + ' imported=' + imported + ' skipped=' + skipped);
      }
      if (options.limit && total >= options.limit) break;
    }
  } finally {
    db.close();
  }
  console.log('done scanned=' + total + ' imported=' + imported + ' skipped=' + skipped + (options.dryRun ? ' (dry-run)' : ''));
}

main().catch((error) => {
  console.error('backfill failed:', error && error.message);
  process.exitCode = 1;
});
