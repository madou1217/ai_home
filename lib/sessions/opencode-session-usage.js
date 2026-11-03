'use strict';

// 从 opencode 会话库读**一轮对话**的 token 用量（v1/v2 两代布局；布局知识唯一来源是
// lib/sessions/opencode-db-layouts.js 的布局表）。
//
// 为什么需要它（2026-10-29 真机取证 + 官方源码）：
//   v2 的 `opencode run --format json` **事件很稀疏**。官方源码
//   `packages/cli/src/run/noninteractive.ts` 里 `step_finish`（携带 tokens）挂在
//   `session.step.ended` 上，但实测（2.2.1 + Zen 免费模型）流里只有 `text`，一条
//   `step_finish` 都不发 —— 用量**只落在会话库**：
//     session_message.data.tokens = { input, output, reasoning, cache: { read, write } }
//   （v1 的 `message` 行同形，另外还带 `total`）。所以「流里没有用量就回查会话库」
//   是 v2 唯一的可靠来源；v1 由 `step_finish` 提供，不会走到这里。
//
// 口径：把该会话所有**带 tokens 的消息行**求和。relay 每次请求都是一次全新会话
// （不传 `--session`），所以「会话总量 == 这一轮用量」；工具轮会有多条 assistant
// 消息，求和正是整轮消耗。两代并存时同一条消息在两表都有行 —— 按 message id 去重、
// 保留 token 总量更大的一份（与 model-usage-scanner 的合并口径一致），否则会双计。
//
// fail-closed：任何异常都返回 null。这是指标补充，绝不能影响正文交付。

const { detectOpenCodeDbLayouts, buildOpenCodeMessageQuery } = require('./opencode-db-layouts');

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 与 model-usage-scanner 的 extractOpenCodeTokens 同口径（两代同形；total 缺失时求和）。 */
function extractTokens(data) {
  const payload = data && typeof data === 'object' ? data : {};
  const tokens = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : {};
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const input = toInt(tokens.input ?? tokens.prompt_tokens ?? tokens.input_tokens ?? payload.input_tokens);
  const output = toInt(tokens.output ?? tokens.completion_tokens ?? tokens.output_tokens ?? payload.output_tokens);
  const reasoning = toInt(tokens.reasoning ?? tokens.reasoning_tokens ?? payload.reasoning_tokens);
  const cacheRead = toInt(cache.read ?? tokens.cache_read ?? tokens.cache_read_tokens ?? payload.cache_read_tokens);
  const cacheWrite = toInt(cache.write ?? tokens.cache_write ?? tokens.cache_write_tokens ?? payload.cache_write_tokens);
  return { input, output, reasoning, cacheRead, cacheWrite };
}

function safeParseJson(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 读某个 opencode 会话的 token 用量。
 *
 * @param {object} options
 * @param {object} options.fs         node:fs（必需）
 * @param {string} options.dbPath     opencode.db 绝对路径（必需）
 * @param {string} options.sessionId  会话 id（必需）
 * @param {Function} options.DatabaseSync node:sqlite 的 DatabaseSync 构造器（必需）
 * @returns {{input:number,output:number,reasoning:number,cache:{read:number,write:number}}|null}
 *          形状与 CLI `step_finish.part.tokens` 一致，可直接喂给 toOpenAiUsage。
 */
function readOpenCodeSessionUsage(options = {}) {
  const fs = options.fs;
  const dbPath = String(options.dbPath || '').trim();
  const sessionId = String(options.sessionId || '').trim();
  const DatabaseSync = options.DatabaseSync;
  if (!fs || !dbPath || !sessionId || typeof DatabaseSync !== 'function') return null;
  if (typeof fs.existsSync !== 'function' || !fs.existsSync(dbPath)) return null;

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON;');
    const layouts = detectOpenCodeDbLayouts(db);
    if (layouts.length === 0) return null;

    // 按 message id 归并（两代双写同一条消息时只算一次，取 token 更大的一份）。
    const byMessageId = new Map();
    let anonymousRows = 0;
    const absorb = (row) => {
      const data = safeParseJson(row && row.message_data);
      if (!data) return;
      const tokens = extractTokens(data);
      const total = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;
      if (total <= 0) return;
      const messageId = String((row && row.message_id) || '').trim();
      if (!messageId) {
        anonymousRows += 1;
        byMessageId.set(`__anon__:${anonymousRows}`, tokens);
        return;
      }
      const existing = byMessageId.get(messageId);
      const existingTotal = existing
        ? existing.input + existing.output + existing.reasoning + existing.cacheRead + existing.cacheWrite
        : -1;
      if (!existing || total > existingTotal) byMessageId.set(messageId, tokens);
    };

    for (const layout of layouts) {
      let statement = null;
      try {
        statement = db.prepare(buildOpenCodeMessageQuery(layout, { hasProjectTable: false, sessionId }));
      } catch (_error) {
        continue;
      }
      let rows = [];
      try {
        rows = statement.all(sessionId) || [];
      } catch (_error) {
        rows = [];
      }
      rows.forEach(absorb);
    }

    if (byMessageId.size === 0) return null;
    const sum = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    for (const tokens of byMessageId.values()) {
      sum.input += tokens.input;
      sum.output += tokens.output;
      sum.reasoning += tokens.reasoning;
      sum.cacheRead += tokens.cacheRead;
      sum.cacheWrite += tokens.cacheWrite;
    }
    if (sum.input + sum.output + sum.reasoning + sum.cacheRead + sum.cacheWrite <= 0) return null;
    return {
      input: sum.input,
      output: sum.output,
      reasoning: sum.reasoning,
      cache: { read: sum.cacheRead, write: sum.cacheWrite }
    };
  } catch (_error) {
    return null;
  } finally {
    try { if (db && typeof db.close === 'function') db.close(); } catch (_error) { /* 忽略 */ }
  }
}

module.exports = {
  extractTokens,
  readOpenCodeSessionUsage
};
