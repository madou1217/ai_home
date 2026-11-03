'use strict';

const { CODEBUDDY_FAMILY_PROVIDERS } = require('../sessions/session-reader-codebuddy');

const FAMILY = new Set(CODEBUDDY_FAMILY_PROVIDERS);

// 原生消息 ID 跨同地区共享目录保持不变。以消息为键校正投影，复制文件、
// 补齐账单或后来取得明确账号归属均不会追加第二笔计费记录。
function reconcileCodebuddyUsageRecords(db, records) {
  if (!records.every((record) => FAMILY.has(record.provider)
    && (record.sourceKind === 'session_jsonl'
      && /^codebuddy:message:[a-f0-9]{16}:[a-f0-9]{16}:usage$/.test(record.eventKey)
      || record.sourceKind === 'desktop_history'
      && /^codebuddy:ide-request:[a-f0-9]{16}:[a-f0-9]{16}:usage$/.test(record.eventKey)))) {
    throw new Error('codebuddy_usage_projection_scope_invalid');
  }
  const statement = db.prepare(`
    INSERT INTO model_usage_records (
      event_key, provider, account_ref, session_id, request_id, source_kind, model,
      input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
      reasoning_output_tokens, total_tokens, cost_usd, timestamp_ms,
      project, cwd, git_branch, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET
      provider = excluded.provider, account_ref = excluded.account_ref,
      request_id = excluded.request_id, model = excluded.model,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read_input_tokens = excluded.cache_read_input_tokens,
      cache_creation_input_tokens = excluded.cache_creation_input_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens, cost_usd = excluded.cost_usd,
      timestamp_ms = excluded.timestamp_ms, project = excluded.project, cwd = excluded.cwd
    WHERE model_usage_records.provider IS NOT excluded.provider
      OR model_usage_records.account_ref IS NOT excluded.account_ref
      OR model_usage_records.request_id IS NOT excluded.request_id
      OR model_usage_records.model IS NOT excluded.model
      OR model_usage_records.input_tokens IS NOT excluded.input_tokens
      OR model_usage_records.output_tokens IS NOT excluded.output_tokens
      OR model_usage_records.cache_read_input_tokens IS NOT excluded.cache_read_input_tokens
      OR model_usage_records.cache_creation_input_tokens IS NOT excluded.cache_creation_input_tokens
      OR model_usage_records.reasoning_output_tokens IS NOT excluded.reasoning_output_tokens
      OR model_usage_records.total_tokens IS NOT excluded.total_tokens
      OR model_usage_records.cost_usd IS NOT excluded.cost_usd
      OR model_usage_records.timestamp_ms IS NOT excluded.timestamp_ms
      OR model_usage_records.project IS NOT excluded.project
      OR model_usage_records.cwd IS NOT excluded.cwd
  `);
  let changed = 0;
  for (const record of records) {
    changed += Number(statement.run(
      record.eventKey, record.provider, record.accountRef, record.sessionId, record.requestId,
      record.sourceKind, record.model, record.inputTokens, record.outputTokens,
      record.cacheReadInputTokens, record.cacheCreationInputTokens, record.reasoningOutputTokens,
      record.totalTokens, record.costUsd, record.timestampMs, record.project, record.cwd,
      record.gitBranch, Date.now()
    ).changes) || 0;
  }
  return changed;
}

module.exports = { reconcileCodebuddyUsageRecords };
