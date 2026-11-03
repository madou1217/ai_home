'use strict';

// 免费档请求的「换出口原地重发」：账号绑定出口池时，上游因**出口**受限（免费额度按
// (端点, 出口 IP) 计的 429，或池节点本身连不上）就切到池里下一个节点、用同一账号重发。
//
// 为什么不交给账号重试循环（2026-10-18）：编排器的 retry_next 是「换下一个账号」，
// 单账号池的上限是 min(maxAttempts, 池大小) = 1 —— 轮换完节点却没有下一次尝试，
// 请求照样失败。出口是 transport 自己的维度（账号没问题，换的是出口），所以在这里
// 原地重试，账号循环的语义与计数都不受影响。
//
// 只在**尚未向客户端写出任何字节**的阶段使用：调用方传入的 call 必须是「发请求并拿到
// 上游响应头」这一步，它抛错时响应还没开始，重发是安全的。

const { classifyUpstreamFailure } = require('./upstream-failure-policy');

// 被限的节点 429 通常 1s 内返回，6 跳足以越过一串已被打光额度的节点，又不会让
// 全池都受限时把请求拖成几十秒。
const DEFAULT_MAX_EGRESS_HOPS = 6;

function statusCodeOf(error) {
  const explicit = Number(error && error.statusCode);
  if (explicit > 0) return explicit;
  const match = String(error && error.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
  return match ? Number(match[1]) : 0;
}

/**
 * 这个失败换一个出口有没有机会好：
 *   - 出口额度用完（429 FreeUsageLimitError）；
 *   - 节点连不上（network_error）；
 *   - 免费档门禁 403 FreeTierError —— 它也随出口 IP 变：同一请求 node-0/3 被拒、
 *     node-10/20/35/50/60/70 全 200（2026-10-18 实测），且同一节点几分钟内会翻转。
 *     请求形状本身被拒时换几个节点仍然全拒，跳数用完后照旧交还 CLI 兜底通道。
 */
function isEgressBoundFailure(error, provider, cooldownMs) {
  return Boolean(egressFailureKind(error, provider, cooldownMs));
}

/**
 * 出口类失败的类别（节点账本据此决定冷却时长）；不是出口问题返回 ''。
 *   free_limit = 429 FreeUsageLimitError；gate = 403 FreeTierError；network = 节点连不上。
 */
function egressFailureKind(error, provider, cooldownMs) {
  const policy = classifyUpstreamFailure({
    provider,
    statusCode: statusCodeOf(error),
    body: error && error.responseBody,
    error,
    defaultCooldownMs: cooldownMs
  });
  if (policy.openCodeFreeEgressLimited) return 'free_limit';
  if (policy.openCodeFreeIpBlocked) return 'ip_blocked';
  if (policy.failureReason === 'opencode_free_tier_client_gated') return 'gate';
  if (policy.kind === 'network_error') return 'network';
  return '';
}

/**
 * 执行 call；出口受限且账号绑定了出口池时，轮换节点后重发，最多 maxHops 次。
 * 其它失败、未绑池、轮换失败、请求已被客户端取消 —— 一律把原始错误抛给调用方。
 *
 * @param {() => Promise<any>} call
 * @param {object} input
 * @param {boolean} input.poolBound      本次请求是否经出口池出网
 * @param {(fromNode: string) => Promise<string>} input.rotate  从 fromNode 切到下一个节点，
 *        返回此后的活动节点名（'' = 失败）；池已被别的请求切走时原样返回当前节点
 * @param {() => string} [input.currentNode]  池当前的活动节点（发请求前记下，作为 fromNode）
 * @param {(node: string, hop: number) => void} [input.onRotate]
 */
async function fetchWithEgressRotation(call, input = {}) {
  const maxHops = Number.isInteger(input.maxHops) && input.maxHops >= 0 ? input.maxHops : DEFAULT_MAX_EGRESS_HOPS;
  const readNode = typeof input.currentNode === 'function' ? input.currentNode : () => '';
  // 节点账本：只有走出口池的请求才记（url / system 出口与池节点无关）。
  const recordOutcome = input.poolBound === true && typeof input.recordOutcome === 'function'
    ? input.recordOutcome
    : () => {};
  for (let hop = 0; ; hop += 1) {
    const usedNode = readNode();
    try {
      const result = await call();
      if (usedNode) recordOutcome(usedNode, { ok: true });
      return result;
    } catch (error) {
      const kind = input.signal && input.signal.aborted ? '' : egressFailureKind(error, input.provider, input.cooldownMs);
      if (usedNode && kind) recordOutcome(usedNode, { ok: false, kind });
      const canRotate = input.poolBound === true
        && hop < maxHops
        && typeof input.rotate === 'function'
        && Boolean(kind);
      if (!canRotate) throw error;
      const node = await input.rotate(usedNode, kind);
      if (!node) throw error;
      if (typeof input.onRotate === 'function') input.onRotate(node, hop + 1);
    }
  }
}

module.exports = {
  DEFAULT_MAX_EGRESS_HOPS,
  egressFailureKind,
  fetchWithEgressRotation,
  isEgressBoundFailure
};
