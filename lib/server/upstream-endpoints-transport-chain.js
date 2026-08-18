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
async function runTransportChain(ctx, transports) {
  for (const transport of transports) {
    if (!transport.matches(ctx)) continue;
    const action = await transport.run(ctx);
    if (action) return action;
  }
  return null;
}

module.exports = { runTransportChain };