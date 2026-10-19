'use strict';

/**
 * Common transport strategy contract for upstream passthrough attempts
 * (Strategy pattern).
 *
 * Each internal transport branch of the passthrough pipeline is modeled as a
 * strategy object with two methods:
 *
 *   - matches(ctx): boolean — whether this transport applies to the attempt
 *     (e.g. the opencode go API transport only applies when the protocol
 *     route plan resolved to OPENCODE_GO_API).
 *   - run(ctx): Promise<action|null> — performs the upstream exchange and
 *     returns a terminal attempt action ({ action: 'return' | 'retry_next' |
 *     'break' }) or null to indicate "not handled, try the next strategy".
 *
 * Strategies are tried in priority order; the first one that returns an
 * action wins. Mutable attempt state (streamTransport/lastError/
 * finalStatusCode) is carried on ctx.attemptMutable so every strategy reads
 * and writes the same values the attempt handler syncs in/out.
 */
const { annotateAttempt } = require('./attempt-annotations');

const CAPABILITY_DEGRADED_HEADER = 'x-aih-capability-degraded';

function requestCarriesClientTools(requestJson) {
  return Boolean(requestJson && Array.isArray(requestJson.tools) && requestJson.tools.length > 0);
}

/**
 * 能力协商（声明式）：strategy 可声明 `capabilities: { clientTools: false }`，表示它无法把客户端
 * 工具交给上游执行（例如原生 CLI headless 通道只能作答）。请求带工具却落到这种通道时，
 * **不静默降级**：在尝试注解与响应头上标出降级，客户端与日志都能看到。
 * 不在这里拒绝：WebUI chat harness 总是带工具，纯文本作答对它仍有价值。
 */
function markCapabilityDegradation(ctx, transport) {
  const capabilities = (transport && transport.capabilities) || {};
  if (capabilities.clientTools !== false || !requestCarriesClientTools(ctx && ctx.requestJson)) return;
  annotateAttempt(ctx.attemptMutable, 'transportCapabilityDegraded', 'client_tools_dropped');
  const res = ctx && ctx.res;
  if (res && !res.headersSent && typeof res.setHeader === 'function') {
    try { res.setHeader(CAPABILITY_DEGRADED_HEADER, 'client_tools'); } catch (_error) { /* best effort */ }
  }
}

async function runTransportChain(ctx, transports) {
  for (const transport of transports) {
    if (!transport.matches(ctx)) continue;
    markCapabilityDegradation(ctx, transport);
    const action = await transport.run(ctx);
    if (action) return action;
  }
  return null;
}

module.exports = { runTransportChain, requestCarriesClientTools, CAPABILITY_DEGRADED_HEADER };