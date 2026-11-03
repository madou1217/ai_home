'use strict';

// 出口 × 上游的被动探测：不带任何凭据，经指定池节点请求一次上游，判断这个出口能不能用来访问它。
//
// 判定（2026-10-19 实测为依据：HK 节点 → api.anthropic.com 连接被重置/超时，US/JP/SG → 401）：
//   1. 先经内核做中性探测（/proxies/<name>/delay）——节点自己不通时**不记**任何地区结论；
//   2. 中性通、上游连接被重置 / 超时 / 拿不到响应 → blocked（地区封锁的典型表现）；
//   3. 上游回了 HTTP：451 或命中该上游的地区拒绝特征 → blocked；
//   4. 其余（401/403/404 JSON 等）→ reachable（能连通，但没验证到认证阶段；弱于预置提示）。
// 真正的 ok 只来自真实流量（带凭据的请求经该节点成功，见 egress-traffic-evidence）。

const { isRegionDenied } = require('./egress-upstream');
const { nodeExitKey, recordUpstreamEvidence } = require('./egress-region-policy');

function probeUrlFor(upstream) {
  const base = String((upstream && upstream.baseUrl) || `https://${upstream && upstream.host}`).replace(/\/+$/, '');
  try {
    const url = new URL(base);
    return `${url.origin}/v1/models`;
  } catch (_error) {
    return '';
  }
}

/**
 * @returns {Promise<{ status: 'blocked'|'reachable'|'skipped', reason: string, node: string, exitKey?: string }>}
 */
async function probeUpstreamViaNode(input = {}) {
  const runtime = input.runtime;
  const upstream = input.upstream;
  const node = String(input.node || '').trim();
  if (!runtime || !upstream || !node) return { status: 'skipped', reason: 'probe_context_missing', node };
  const url = probeUrlFor(upstream);
  if (!url) return { status: 'skipped', reason: 'probe_url_invalid', node };
  const neutral = await runtime.probeNode(node);
  if (!neutral || !neutral.ok) return { status: 'skipped', reason: 'node_unreachable', node };
  const result = await runtime.fetchUpstreamViaNode(node, url);
  if (!result || result.ok === false) return { status: 'skipped', reason: (result && result.error) || 'probe_failed', node };
  let status = 'reachable';
  let reason = `http_${result.status}`;
  if (!result.reached) {
    status = 'blocked';
    reason = `upstream_unreachable:${result.error}`;
  } else {
    const signature = isRegionDenied(upstream, { statusCode: result.status, text: result.text });
    if (signature) {
      status = 'blocked';
      reason = `region_denied:${signature}`;
    }
  }
  const identity = runtime.health && typeof runtime.health.identityOf === 'function' ? runtime.health.identityOf(node) : '';
  const exitKey = nodeExitKey(identity);
  if (exitKey && input.fs && input.aiHomeDir) {
    recordUpstreamEvidence(input.fs, input.aiHomeDir, upstream.id, exitKey, { status, reason, source: 'probe' });
  }
  return { status, reason, node, exitKey };
}

/** 逐个探测（共享探测入站，本来就是串行）。onResult 每完成一个回调一次。 */
async function probeUpstreamNodes(input = {}) {
  const results = [];
  for (const node of input.nodes || []) {
    // eslint-disable-next-line no-await-in-loop
    const result = await probeUpstreamViaNode({ ...input, node });
    results.push(result);
    if (typeof input.onResult === 'function') input.onResult(result);
  }
  return results;
}

module.exports = {
  probeUpstreamNodes,
  probeUpstreamViaNode,
  probeUrlFor
};
