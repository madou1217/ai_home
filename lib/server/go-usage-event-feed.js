'use strict';

// Go Core 用量事件 → Node model-usage 库 + 账号页实时 token 消耗。
//
// 账号 Token 用量只统计网关写入、带 account_ref 的记录（model-usage-store 的
// queryAccountTokenUsage）。9527 的推理已几乎全由 Go 承接，而 Go 从不写这张表：
// Go 流量既不计入账号 Token 用量，也没有逐条的实时消耗推送。这里按 (boot_id, seq)
// 游标增量拉取 GET /v1/management/account-usage-events，逐条交给与 Node 自身转发
// 同一个入口 recordModelUsage（写库 + 推送 token-consumed 事件）。
//
// eventKey = go:<boot_id>:<seq>，库里 event_key 唯一（INSERT OR IGNORE）：Node 重启后
// 从 0 重放 Go 环形缓冲也不会重复计数。

const DEFAULT_FETCH_TIMEOUT_MS = 3000;
// 账号页逐条消耗动效的延迟上限；本机回环请求，开销可忽略。
const DEFAULT_POLL_INTERVAL_MS = 2000;
const SOURCE_KIND = 'server_go_gateway';

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/**
 * Go 的 Canonical usage：input 含缓存读写子集。转成 Anthropic 分项形状（非缓存输入 +
 * 缓存写 + 缓存读 + 输出），与 normalizeAnthropicUsage 口径一致，total 不变。
 * reasoning 是输出子集，使用已支持的 thinking_tokens 明细传递，避免重复计数。
 */
function toAnthropicUsage(event) {
  const input = toCount(event.input_tokens);
  const cacheRead = toCount(event.cached_input_tokens);
  const cacheWrite = toCount(event.cache_write_input_tokens);
  const reasoning = toCount(event.reasoning_tokens);
  return {
    input_tokens: Math.max(0, input - cacheRead - cacheWrite),
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: toCount(event.output_tokens),
    ...(reasoning > 0 ? { output_tokens_details: { thinking_tokens: reasoning } } : {})
  };
}

/**
 * @param {object} deps
 * @param {(afterSeq: number) => Promise<object|null>} deps.listUsageEvents Go 事件页；Go 不可用时 null
 * @param {() => (Record<string, string>|null)} [deps.readGoRefsByNodeRef] Node→Go 映射；null 表示两边 id 相同
 * @param {(nodeRef: string) => string} deps.resolveProvider Node 账号所属 Provider（找不到返回空串）
 * @param {(payload: object) => number} deps.recordUsage 与 Node 转发同一记账入口
 */
function createGoUsageEventFeed(deps = {}) {
  let cursor = { bootId: '', seq: 0 };

  function nodeRefResolver() {
    let links = null;
    try {
      links = typeof deps.readGoRefsByNodeRef === 'function' ? deps.readGoRefsByNodeRef() : null;
    } catch (_error) {
      links = {};
    }
    if (!links) return (goRef) => goRef;
    // 同一 Go 账号可能对应多个 Node 账号（迁移合并）；固定记到字典序最小的那个，避免重复计数。
    const byGoRef = new Map();
    for (const nodeRef of Object.keys(links).sort()) {
      const goRef = String(links[nodeRef] || '');
      if (goRef && !byGoRef.has(goRef)) byGoRef.set(goRef, nodeRef);
    }
    return (goRef) => byGoRef.get(goRef) || '';
  }

  async function fetchPage(afterSeq) {
    const timeoutMs = Number(deps.fetchTimeoutMs) || DEFAULT_FETCH_TIMEOUT_MS;
    let timer = null;
    try {
      return await Promise.race([
        deps.listUsageEvents(afterSeq),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
        })
      ]);
    } catch (_error) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function recordPage(page) {
    const bootId = String(page.boot_id || '');
    const resolveNodeRef = nodeRefResolver();
    let recorded = 0;
    for (const event of Array.isArray(page.data) ? page.data : []) {
      const seq = toCount(event && event.seq);
      const nodeRef = resolveNodeRef(String(event && event.account_ref || ''));
      const provider = nodeRef ? String(deps.resolveProvider(nodeRef) || '') : '';
      if (!seq || !nodeRef || !provider) continue;
      try {
        recorded += Number(deps.recordUsage({
          provider,
          accountRef: nodeRef,
          model: String(event.model || ''),
          usage: toAnthropicUsage(event),
          usageFormat: 'anthropic',
          eventKey: `go:${bootId}:${seq}`,
          requestId: `go-${bootId}-${seq}`,
          sourceKind: SOURCE_KIND,
          timestampMs: toCount(event.at_ms) || Date.now()
        })) || 0;
      } catch (_error) {
        // 单条记账失败不影响后续事件，也绝不影响推理。
      }
    }
    return recorded;
  }

  async function poll() {
    if (typeof deps.listUsageEvents !== 'function' || typeof deps.recordUsage !== 'function') return 0;
    let page = await fetchPage(cursor.seq);
    if (!page) return 0;
    const bootId = String(page.boot_id || '');
    if (bootId !== cursor.bootId && cursor.seq > 0) {
      // Go 重启：新进程的序号从 1 开始，按旧游标会漏掉新事件，从头读。
      cursor = { bootId, seq: 0 };
      page = await fetchPage(0);
      if (!page || String(page.boot_id || '') !== bootId) return 0;
    }
    const recorded = recordPage(page);
    cursor = { bootId, seq: Math.max(0, toCount(page.latest_seq)) };
    return recorded;
  }

  let timer = null;
  let inFlight = null;

  // 串行化：上一轮未结束时复用同一个 Promise，避免重复拉取同一段序号。
  function pollOnce() {
    if (!inFlight) {
      inFlight = poll().catch(() => 0).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function start(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
    if (timer) return;
    timer = setInterval(pollOnce, Math.max(250, Number(intervalMs) || DEFAULT_POLL_INTERVAL_MS));
    if (typeof timer.unref === 'function') timer.unref();
  }

  // 停止轮询并做最后一次拉取：关机时在停 Go 之前调用，排空期间完成的请求也能入账。
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return pollOnce();
  }

  return {
    poll,
    pollOnce,
    start,
    stop,
    cursor: () => ({ ...cursor })
  };
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  SOURCE_KIND,
  createGoUsageEventFeed,
  toAnthropicUsage
};
