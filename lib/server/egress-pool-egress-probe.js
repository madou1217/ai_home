'use strict';

// 出口池保存出口时的连通性探测：先换一个可用节点，再探测。
//
// 为什么需要（2026-10-21 用户报障）：出口池的意义就是「节点坏了自动换」。但保存
// 出口时的探测是拿池当前的活动节点直接打一次 204 —— 该节点恰好连不上（实测默认
// 组停在已失效的节点，curl exit 35），探测失败就 fail-closed 回滚绑定，用户看到
// 「新出口不可用，已恢复原绑定」，可他明明只是想启用出口池。用户不该为「池恰好停在
// 坏节点上」买单。
//
// 所以：探测失败时按池自己的挑选规则（跳过冷却/被拦节点）换一个节点重探，最多
// DEFAULT_MAX_PROBE_HOPS 跳。全都不行才如实报失败 —— 那是池整体不可用，回滚是对的。

const DEFAULT_MAX_PROBE_HOPS = 4;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {object} input
 * @param {string} input.proxyUrl 池的入口地址（车道口或默认口）
 * @param {Function} input.probe 探测函数 (proxyUrl) => Promise<{ok, reason?}>
 * @param {Function} [input.currentNode] () => string 当前节点名
 * @param {Function} [input.rotate] (fromNode) => Promise<string> 换下一个节点，返回新节点名
 * @param {number} [input.maxHops]
 * @returns {Promise<{ ok: boolean, proxyUrl: string, hops: number, reason?: string, rotatedTo?: string }>}
 */
async function probePoolEgressWithRotation(input = {}) {
  const probe = input.probe;
  const proxyUrl = normalizeString(input.proxyUrl);
  if (typeof probe !== 'function' || !proxyUrl) return { ok: false, hops: 0, proxyUrl, reason: 'egress_pool_probe_unavailable' };
  const maxHops = Number.isInteger(input.maxHops) && input.maxHops >= 0 ? input.maxHops : DEFAULT_MAX_PROBE_HOPS;
  const currentNode = typeof input.currentNode === 'function' ? input.currentNode : () => '';
  const rotate = typeof input.rotate === 'function' ? input.rotate : null;

  let reason = '';
  let rotatedTo = '';
  for (let hop = 0; hop <= maxHops; hop += 1) {
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await probe(proxyUrl);
    } catch (error) {
      result = { ok: false, reason: String((error && error.message) || error || 'proxy_probe_failed') };
    }
    if (result && result.ok) return { ok: true, hops: hop, proxyUrl, rotatedTo };
    reason = String((result && (result.reason || result.error)) || 'proxy_probe_failed');
    if (!rotate || hop === maxHops) break;
    // eslint-disable-next-line no-await-in-loop
    const next = await rotate(normalizeString(currentNode())).catch(() => '');
    if (!normalizeString(next)) break;
    rotatedTo = normalizeString(next);
  }
  return { ok: false, hops: maxHops, proxyUrl, reason, rotatedTo };
}

module.exports = {
  DEFAULT_MAX_PROBE_HOPS,
  probePoolEgressWithRotation
};
