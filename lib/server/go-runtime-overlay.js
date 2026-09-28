'use strict';

// Go Core 账号运行态的展示叠加层。
//
// 9527 上几乎全部推理已由 Go 承接，Go 的冷却 / 熔断 / 最近结果只在 Go 进程内存里；
// Node 账号页此前只读 Node 自己的运行池，Go 产生的状态永远看不到（调度状态一直“正常”，
// 上次成功使用也不动）。这里定期拉取 GET /v1/management/account-runtime，按 Node 账号
// 投影成展示字段，并给账号 watch 签名提供一段稳定摘要，状态变化即推送到页面。
//
// 只做展示：绝不写回 Node 的 account_state / 运行池——Node 的选号器读那份状态，
// 把 Go 的阻塞写进去会让 Node 自己承接的流量也排除该账号，且 Go 重启清空后 Node 仍残留。
// Go 不可用时叠加层为空，账号记录保持 Node 原值。

// 账号级硬阻塞 → Node 账号级运行态（前端既有徽章直接可渲染）。
// 硬阻塞没有到期时间：外部真相源（重登 / 新额度快照 / 账号状态）更新后由 Go 解除。
const ACCOUNT_BLOCK_STATUS = Object.freeze({
  credentials_updated: { status: 'auth_invalid', reason: 'go_runtime_credentials_rejected' },
  usage_snapshot: { status: 'rate_limited', reason: 'go_runtime_quota_exhausted' },
  billing_snapshot: { status: 'service_unavailable', reason: 'go_runtime_billing_blocked' },
  account_status: { status: 'service_unavailable', reason: 'go_runtime_account_deactivated' },
  policy_snapshot: { status: 'service_unavailable', reason: 'go_runtime_policy_blocked' }
});

const DEFAULT_FETCH_TIMEOUT_MS = 3000;

function toMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeModelEntry(raw) {
  const model = String(raw && raw.model || '').trim();
  if (!model) return null;
  const blocks = Array.isArray(raw.blocks) ? raw.blocks.map(String).filter(Boolean) : [];
  const cooldownKind = String(raw.cooldown_kind || '').trim();
  const cooldownUntil = toMs(raw.cooldown_until_ms);
  if (blocks.length === 0 && !(cooldownKind && cooldownUntil)) return null;
  return {
    model,
    blocks,
    ...(cooldownKind && cooldownUntil ? { cooldownKind, cooldownUntil } : {})
  };
}

function normalizeEntry(raw) {
  const goRef = String(raw && raw.account_ref || '').trim();
  if (!goRef) return null;
  return {
    goRef,
    blocks: Array.isArray(raw.blocks) ? raw.blocks.map(String).filter(Boolean) : [],
    models: (Array.isArray(raw.models) ? raw.models : []).map(normalizeModelEntry).filter(Boolean),
    lastSuccessAt: toMs(raw.last_success_ms),
    lastFailureAt: toMs(raw.last_failure_ms),
    lastFailureKind: String(raw.last_failure_kind || '').trim()
  };
}

/**
 * 把 Go 账号级阻塞折算成 Node 账号运行态；只有模型级状态时返回 null（不整号标红：
 * Go 按 (账号, 模型) 冷却，一个模型 429 不代表整号不可用）。
 */
function deriveAccountRuntimeStatus(entry) {
  if (!entry) return null;
  for (const block of entry.blocks) {
    const mapped = ACCOUNT_BLOCK_STATUS[block];
    if (mapped) return { status: mapped.status, until: 0, reason: mapped.reason };
  }
  return null;
}

/** 签名只含 Go 给出的事实（不含 now），状态出现或消失时变化。 */
function buildEntrySignature(entry) {
  if (!entry) return '';
  const models = entry.models
    .map((model) => `${model.model}=${model.blocks.join('+')}/${model.cooldownKind || ''}@${model.cooldownUntil || 0}`)
    .join(',');
  return [
    entry.blocks.join('+'),
    models,
    entry.lastSuccessAt,
    entry.lastFailureAt
  ].join(';');
}

/**
 * @param {object} deps
 * @param {() => Promise<Array|null>} deps.listAccountRuntime Go 快照；Go 不可用时返回 null
 * @param {() => (Record<string, string>|null)} [deps.readGoRefsByNodeRef] Node→Go 账号映射；省略或返回 null 表示两边 id 相同
 * @param {number} [deps.fetchTimeoutMs]
 */
function createGoRuntimeOverlay(deps = {}) {
  let byNodeRef = new Map();

  function resolveLinks() {
    if (typeof deps.readGoRefsByNodeRef !== 'function') return null;
    try {
      // null 表示未启用账号同步：两边 id 相同，按原样使用 Go ref。
      return deps.readGoRefsByNodeRef();
    } catch (_error) {
      return {};
    }
  }

  function project(rows) {
    const byGoRef = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const entry = normalizeEntry(row);
      if (entry) byGoRef.set(entry.goRef, entry);
    }
    const next = new Map();
    const links = resolveLinks();
    if (!links) {
      for (const [goRef, entry] of byGoRef) next.set(goRef, entry);
      return next;
    }
    // 一个 Go 账号可能对应多个 Node 账号（迁移时同身份合并），它们共享同一份运行态。
    for (const [nodeRef, goRef] of Object.entries(links)) {
      const entry = byGoRef.get(String(goRef || ''));
      if (entry) next.set(nodeRef, entry);
    }
    return next;
  }

  async function refresh() {
    if (typeof deps.listAccountRuntime !== 'function') return false;
    const timeoutMs = Number(deps.fetchTimeoutMs) || DEFAULT_FETCH_TIMEOUT_MS;
    let timer = null;
    try {
      const rows = await Promise.race([
        deps.listAccountRuntime(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
        })
      ]);
      byNodeRef = rows ? project(rows) : new Map();
    } catch (_error) {
      byNodeRef = new Map();
    } finally {
      if (timer) clearTimeout(timer);
    }
    return true;
  }

  function get(nodeRef) {
    return byNodeRef.get(String(nodeRef || '').trim()) || null;
  }

  return {
    refresh,
    get,
    signature: (nodeRef) => buildEntrySignature(get(nodeRef)),
    size: () => byNodeRef.size
  };
}

/**
 * 把叠加层写到公开账号记录上（纯函数，返回新对象）：
 * - Node 自己没有运行态阻塞时，用 Go 账号级阻塞覆盖 runtimeStatus；
 * - 模型级阻塞 / cooldown 挂在 runtimeModels，前端作为明细展示；
 * - lastUsedAt 取 Node 与 Go 最近成功的较大者。
 */
function applyGoRuntimeOverlay(record, entry, nowMs = Date.now()) {
  if (!record || !entry) return record;
  const next = { ...record };
  const nodeBlocked = next.runtimeStatus && !['healthy', 'unknown'].includes(String(next.runtimeStatus));
  const accountStatus = deriveAccountRuntimeStatus(entry);
  if (accountStatus && !nodeBlocked) {
    next.runtimeStatus = accountStatus.status;
    next.runtimeReason = accountStatus.reason;
    next.runtimeUntil = accountStatus.until;
    next.runtimeSource = 'go';
  }
  const models = entry.models.filter((model) => model.blocks.length > 0 || Number(model.cooldownUntil) > nowMs);
  if (models.length > 0) next.runtimeModels = models;
  else delete next.runtimeModels;
  if (entry.lastSuccessAt > (Number(next.lastUsedAt) || 0)) next.lastUsedAt = entry.lastSuccessAt;
  return next;
}

module.exports = {
  ACCOUNT_BLOCK_STATUS,
  applyGoRuntimeOverlay,
  buildEntrySignature,
  createGoRuntimeOverlay,
  deriveAccountRuntimeStatus
};
