'use strict';

// Go Core 用量事件 → 账号页实时通知。持久事实及管理投影由 Go 同事务写入。
// 仅接受显式 go-ledger-v1 能力；旧 Go 缺此能力时拒绝通知并明确提示升级，
// 绝不恢复 Node 的 model_usage_records 写者。普通 poll 与 shutdown pull 同约束。
// boot_id/seq 仅为易失通知游标，不冒充 durable ledger/上游 attempt identity。

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
 * @param {(payload: object) => void} deps.notifyUsage 只通知，不得持久化或记账号成功
 * @param {(reason: string) => void} [deps.onProjectionUnavailable] 成对构件缺失时显式告警
 */
function createGoUsageEventFeed(deps = {}) {
  let cursor = { bootId: '', seq: 0 };
  let lastError = '';

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
        deps.notifyUsage({
          provider,
          accountRef: nodeRef,
          model: String(event.model || ''),
          usage: toAnthropicUsage(event),
          usageFormat: 'anthropic',
          eventKey: `go:${bootId}:${seq}`,
          requestId: `go-${bootId}-${seq}`,
          sourceKind: SOURCE_KIND,
          timestampMs: toCount(event.at_ms) || Date.now()
        });
        recorded += 1;
      } catch (_error) {
        // 单条通知失败不影响已持久化的 Go 事实或后续事件。
      }
    }
    return recorded;
  }

  async function poll() {
    if (typeof deps.listUsageEvents !== 'function' || typeof deps.notifyUsage !== 'function') return 0;
    let page = await fetchPage(cursor.seq);
    if (!page) return 0;
    // Persistence is exclusively Go-owned. An older Go process is not a
    // reason to re-enable the retired Node writer: fail closed and report the
    // incompatible pair instead of guessing whether this page was projected.
    if (page.usage_projection !== 'go-ledger-v1') {
      if (lastError !== 'go_usage_projection_required') {
        lastError = 'go_usage_projection_required';
        if (typeof deps.onProjectionUnavailable === 'function') deps.onProjectionUnavailable(lastError);
      }
      return 0;
    }
    lastError = '';
    const bootId = String(page.boot_id || '');
    if (bootId !== cursor.bootId && cursor.seq > 0) {
      // Go 重启：新进程的序号从 1 开始，按旧游标会漏掉新事件，从头读。
      cursor = { bootId, seq: 0 };
      page = await fetchPage(0);
      if (!page || String(page.boot_id || '') !== bootId || page.usage_projection !== 'go-ledger-v1') return 0;
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

  // 关机前最后拉取只补通知；Go 已在同事务完成持久化，不在此重新记账。
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
    cursor: () => ({ ...cursor }),
    lastError: () => lastError
  };
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  SOURCE_KIND,
  createGoUsageEventFeed,
  toAnthropicUsage
};
