'use strict';

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 120_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;

function calculateReconnectDelay(attempt, options = {}, random = Math.random) {
  const exponent = Math.max(0, Math.min(30, Number(attempt) - 1));
  const baseDelay = Math.max(1, Number(options.reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS);
  const maxDelay = Math.max(
    baseDelay,
    Number(options.reconnectMaxDelayMs) || DEFAULT_RECONNECT_MAX_DELAY_MS
  );
  const configuredJitter = Number(options.reconnectJitterRatio);
  const jitterRatio = Math.max(0, Math.min(
    1,
    Number.isFinite(configuredJitter) ? configuredJitter : DEFAULT_RECONNECT_JITTER_RATIO
  ));
  const exponentialDelay = Math.min(maxDelay, baseDelay * (2 ** exponent));
  const randomValue = Math.max(0, Math.min(1, Number(random()) || 0));
  const jitterMultiplier = 1 - jitterRatio + (2 * jitterRatio * randomValue);
  return Math.min(maxDelay, Math.max(1, Math.round(exponentialDelay * jitterMultiplier)));
}

module.exports = {
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_RECONNECT_JITTER_RATIO,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
  calculateReconnectDelay
};
