'use strict';

const QUOTA_CODES = new Set(['usage_limit_reached', 'insufficient_quota', 'rate_limit_exceeded', 'quota_exceeded']);
// 可以在本轮尚未交付内容时被扣留、随可重试失败一起丢弃、让 Codex 换号重连的事件。
//
// 必须与 Go 侧 internal/transport/http/codexresponsesws/failover.go 的
// preambleEventTypes 保持同一集合，两边各自服务一条 WS 路径（Node 路径在 Go Core
// 未启用时生效，例如远程部署默认如此），漏登记任何一侧都会单独关掉换号窗口。
//
// 实测上游固定发这个序列：
//   codex.rate_limits -> codex.response.metadata -> response.created
//     -> response.in_progress -> response.metadata -> error
// 其中 codex.rate_limits / codex.response.metadata / response.metadata 都不携带
// response 对象（抓帧确认：前两者顶层键分别是 type/plan_type/rate_limits/... 与
// type/headers；response.metadata 只有 metadata），纯旁路信息，不产生任何输出。
// 漏掉它们时，序列的第一个非白名单帧就会把 committed 置位，此后的容量不足 /
// 过载错误无法 replay 换号，只能原样透传，Codex 侧表现为
// "stream disconnected before completion: stream closed before response.completed"。
const PREAMBLE_TYPES = new Set([
  'response.created',
  'response.in_progress',
  'response.queued',
  'response.metadata',
  'codex.rate_limits',
  'codex.response.metadata'
]);
const PORTABLE_TYPES = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output']);

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

// Inspect protocol errors only, never quota text quoted in an answer/tool result.
function getCodexQuotaFailure(payload) {
  if (!isRecord(payload)) return null;
  if (payload.type && payload.type !== 'error' && payload.type !== 'response.failed') return null;
  const error = payload.error || payload.response && payload.response.error;
  if (!isRecord(error)) return null;
  const code = String(error.code || error.type || '').toLowerCase();
  return QUOTA_CODES.has(code) ? { code, error } : null;
}

function codexQuotaRetryDelay(failure, nowMs = Date.now()) {
  const error = failure && failure.error || {};
  const relative = Number(error.resets_in_seconds || error.retry_after_seconds);
  const absolute = Number(error.resets_at);
  const delay = relative > 0 ? relative * 1000 : absolute > 0 ? absolute * 1000 - nowMs : 0;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 7 * 24 * 60 * 60 * 1000) : 0;
}

function isResponsePreamble(event) {
  return isRecord(event) && PREAMBLE_TYPES.has(event.type)
    && (!event.response || (isRecord(event.response) && (event.response.output == null
      || (Array.isArray(event.response.output) && event.response.output.length === 0))));
}

// Hold bounded lifecycle metadata, never answer text or tool-call deltas.
// The first non-preamble event commits this attempt; later errors cannot replay.
function createResponseCommitGate(maxBytes = 64 * 1024) {
  let buffered = [];
  let bytes = 0;
  let committed = false;
  return {
    get committed() { return committed; },
    push(event, frame) {
      const size = Buffer.byteLength(frame);
      if (!committed && isResponsePreamble(event) && buffered.length < 16 && bytes + size <= maxBytes) {
        buffered.push(frame);
        bytes += size;
        return [];
      }
      committed = true;
      const frames = buffered.concat([frame]);
      buffered = [];
      bytes = 0;
      return frames;
    },
    flush() {
      const frames = buffered;
      buffered = [];
      bytes = 0;
      return frames;
    }
  };
}

function containsAccountReference(value) {
  const pending = [value];
  let inspected = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (++inspected > 100000) return true;
    if (!Array.isArray(item) && (item.type === 'item_reference' || item.file_id || item.encrypted_content)) return true;
    for (const child of Object.values(item)) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}

function portableInput(input) {
  const out = [];
  const calls = new Set();
  const outputs = new Set();
  for (const source of input) {
    if (!isRecord(source)) return null;
    // Keep the public transcript and tool results, not account-bound ciphertext.
    if (source.type === 'reasoning') continue;
    if (source.type ? !PORTABLE_TYPES.has(source.type) : !['user', 'assistant', 'system', 'developer'].includes(source.role)) return null;
    if (containsAccountReference(source)) return null;
    const item = { ...source };
    delete item.id;
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (!item.call_id || calls.has(item.call_id)) return null;
      calls.add(item.call_id);
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (!calls.has(item.call_id) || outputs.has(item.call_id)) return null;
      outputs.add(item.call_id);
    }
    out.push(item);
  }
  // A call still awaiting a client-side result is not a completed checkpoint.
  return calls.size === outputs.size ? out : null;
}

// One completed checkpoint for sequential native responses. Bounded,
// connection-local memory, not another persisted conversation store.
function createResponseReplayLedger(maxBytes = 32 * 1024 * 1024) {
  let last = null;
  function withinLimit(value) {
    try { return Buffer.byteLength(JSON.stringify(value)) <= maxBytes; }
    catch (_) { return false; }
  }
  return {
    expand(payload) {
      let input = payload.input;
      if (typeof input === 'string') input = [{ role: 'user', content: input }];
      if (input == null) input = [];
      if (!Array.isArray(input)) return null;
      if (payload.previous_response_id) {
        if (!last || payload.previous_response_id !== last.id) return null;
        input = last.input.concat(input);
      }
      return withinLimit(input) ? input : null;
    },
    replay(payload, input) {
      if (!input || payload.conversation || payload.background === true) return null;
      const portable = portableInput(input);
      if (!portable) return null;
      const result = { ...payload, input: portable };
      delete result.previous_response_id;
      return withinLimit(result) ? result : null;
    },
    complete(response, input) {
      if (!response || !response.id || !Array.isArray(response.output) || !input) { last = null; return; }
      const transcript = input.concat(response.output);
      last = withinLimit(transcript) ? { id: response.id, input: transcript } : null;
    },
    clear() { last = null; }
  };
}

module.exports = {
  getCodexQuotaFailure, codexQuotaRetryDelay, isResponsePreamble,
  createResponseCommitGate, createResponseReplayLedger
};
