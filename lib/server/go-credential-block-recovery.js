'use strict';

// Go 凭据拒收 → Node 刷新 token 的桥。
//
// Go 承接的推理遇到上游 401 时，给账号加一个只在「凭据更新」后才解除的硬阻塞，
// 自身不刷新 token：委托模式下 Node 是唯一刷新者（OpenAI refresh token 用一次就轮换，
// 两边都刷会互相作废，真变成「需要重新登录」）。而 Node 看不到 Go 的 401，于是
// plus 升级 pro 这类「旧 access token 作废、refresh token 仍有效」的账号会被一直封着。
//
// 这里定期读 Go 运行态，把 codex 账号的凭据阻塞交给 Node 的 codex 认证修复器：
// 以 401 身份入队 → 强制刷新 → 新凭据经 go-account-sync 推给 Go → Go 导入时解除阻塞；
// 刷新被拒才由修复器停用账号。
//
// 去重：同一次阻塞（Go 的 last_failure_ms 相同）只入队一次；同一账号两次尝试至少
// 间隔 retryAfterMs，避免「刷新成功但 Go 又拒」（账号被封而非 token 过期）时反复打 token 端点。

const CREDENTIAL_BLOCK = 'credentials_updated';
const RECOVERY_PROVIDER = 'codex';
const RECOVERY_REASON = 'direct_http_status_401:go_runtime_credentials_rejected';
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 30 * 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 3000;

function nodeRefsByGoRef(links) {
  const byGoRef = new Map();
  for (const [nodeRef, goRef] of Object.entries(links || {})) {
    const key = String(goRef || '').trim();
    if (!key) continue;
    if (!byGoRef.has(key)) byGoRef.set(key, []);
    byGoRef.get(key).push(nodeRef);
  }
  return byGoRef;
}

function createGoCredentialBlockRecovery(deps = {}) {
  const intervalMs = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : DEFAULT_INTERVAL_MS;
  const retryAfterMs = Number(deps.retryAfterMs) > 0 ? Number(deps.retryAfterMs) : DEFAULT_RETRY_AFTER_MS;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const handledBlocks = new Set();
  const lastAttemptAt = new Map();

  async function fetchRuntime() {
    const timeoutMs = Number(deps.fetchTimeoutMs) || DEFAULT_FETCH_TIMEOUT_MS;
    let timer = null;
    try {
      return await Promise.race([
        deps.listAccountRuntime(),
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

  function resolveNodeRefs(goRef) {
    let links = null;
    try {
      links = typeof deps.readGoRefsByNodeRef === 'function' ? deps.readGoRefsByNodeRef() : null;
    } catch (_error) {
      return [];
    }
    // null 表示未启用账号同步：两边 id 相同。
    if (!links) return [goRef];
    return nodeRefsByGoRef(links).get(goRef) || [];
  }

  function tryEnqueue(nodeRef, blockKey) {
    if (handledBlocks.has(blockKey)) return false;
    const last = lastAttemptAt.get(nodeRef) || 0;
    if (last && now() - last < retryAfterMs) return false;
    let provider = '';
    try {
      provider = String(deps.resolveProvider(nodeRef) || '');
    } catch (_error) {
      provider = '';
    }
    if (provider !== RECOVERY_PROVIDER) return false;
    handledBlocks.add(blockKey);
    lastAttemptAt.set(nodeRef, now());
    try {
      return Boolean(deps.reconciler.enqueueDirectHttpStatus401(RECOVERY_PROVIDER, nodeRef, RECOVERY_REASON));
    } catch (_error) {
      return false;
    }
  }

  async function poll() {
    const reconciler = deps.reconciler;
    if (typeof deps.listAccountRuntime !== 'function'
      || typeof deps.resolveProvider !== 'function'
      || !reconciler || typeof reconciler.enqueueDirectHttpStatus401 !== 'function') return 0;
    const rows = await fetchRuntime();
    if (!Array.isArray(rows)) return 0;
    let enqueued = 0;
    for (const row of rows) {
      const blocks = Array.isArray(row && row.blocks) ? row.blocks.map(String) : [];
      if (!blocks.includes(CREDENTIAL_BLOCK)) continue;
      const goRef = String(row.account_ref || '').trim();
      if (!goRef) continue;
      const blockInstance = `${goRef}@${Number(row.last_failure_ms) || 0}`;
      for (const nodeRef of resolveNodeRefs(goRef)) {
        if (tryEnqueue(nodeRef, `${nodeRef}|${blockInstance}`)) enqueued += 1;
      }
    }
    return enqueued;
  }

  let timer = null;
  let inFlight = null;

  function tick() {
    if (inFlight) return inFlight;
    inFlight = poll().catch(() => 0).finally(() => { inFlight = null; });
    return inFlight;
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (inFlight) await inFlight;
  }

  return { poll, start, stop };
}

module.exports = {
  createGoCredentialBlockRecovery
};
