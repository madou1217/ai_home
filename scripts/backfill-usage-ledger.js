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
const ENDPOINT = 'http://127.0.0.1:19550/v1/management/usage/import';

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

function toEvent(row) {
  return {
    source_key: 'node:' + String(row.event_key || ''),
    account_ref: String(row.account_ref || ''),
    provider: String(row.provider || '').toLowerCase(),
    model: String(row.model || ''),
    session_id: String(row.session_id || ''),
    occurred_at_ms: Number(row.timestamp_ms) || 0,
    input_tokens: Number(row.input_tokens) || 0,
    output_tokens: Number(row.output_tokens) || 0,
    cached_input_tokens: Number(row.cache_read_input_tokens) || 0,
    cache_write_input_tokens: Number(row.cache_creation_input_tokens) || 0,
    reasoning_tokens: Number(row.reasoning_output_tokens) || 0,
    total_tokens: Number(row.total_tokens) || 0
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const key = readManagementKey();
  if (!key && !options.dryRun) throw new Error('缺少管理密钥');
  const db = new DatabaseSync(APP_STATE, { readOnly: true });
  let cursor = 0;
  let total = 0;
  let imported = 0;
  let skipped = 0;
  try {
    const select = db.prepare(`
      SELECT id, event_key, account_ref, provider, model, session_id, timestamp_ms,
             input_tokens, output_tokens, cache_read_input_tokens,
             cache_creation_input_tokens, reasoning_output_tokens, total_tokens
        FROM model_usage_records
       WHERE id > ?
       ORDER BY id
       LIMIT ?`);
    for (;;) {
      const rows = select.all(cursor, options.batch);
      if (rows.length === 0) break;
      cursor = Number(rows[rows.length - 1].id);
      total += rows.length;
      const events = rows.map(toEvent).filter((event) => event.source_key !== 'node:');
      if (!options.dryRun) {
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
