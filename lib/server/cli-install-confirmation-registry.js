'use strict';

const crypto = require('node:crypto');

const DEFAULT_CLI_INSTALL_CONFIRMATION_TIMEOUT_MS = 10_000;

function normalizeTimeoutMs(value, fallback) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.trunc(timeoutMs)
    : fallback;
}

function createCliInstallConfirmationRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const randomUUID = typeof options.randomUUID === 'function'
    ? options.randomUUID
    : crypto.randomUUID;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const defaultTimeoutMs = normalizeTimeoutMs(
    options.timeoutMs,
    DEFAULT_CLI_INSTALL_CONFIRMATION_TIMEOUT_MS
  );
  const pending = new Map();

  function settle(confirmationId, decision, source) {
    const entry = pending.get(confirmationId);
    if (!entry) return null;
    pending.delete(confirmationId);
    clearTimer(entry.timer);
    const outcome = Object.freeze({
      confirmationId,
      provider: entry.provider,
      decision,
      source,
      resolvedAt: now()
    });
    entry.resolve(outcome);
    return outcome;
  }

  function create(input = {}) {
    const provider = String(input.provider || '').trim().toLowerCase();
    const timeoutMs = normalizeTimeoutMs(input.timeoutMs, defaultTimeoutMs);
    const confirmationId = randomUUID();
    const createdAt = now();
    let resolveDecision;
    const decision = new Promise((resolve) => {
      resolveDecision = resolve;
    });
    const entry = {
      provider,
      resolve: resolveDecision,
      timer: null
    };
    entry.timer = setTimer(() => {
      settle(confirmationId, 'confirm', 'timeout');
    }, timeoutMs);
    pending.set(confirmationId, entry);

    return Object.freeze({
      confirmationId,
      provider,
      createdAt,
      expiresAt: createdAt + timeoutMs,
      countdownMs: timeoutMs,
      decision
    });
  }

  function decide(confirmationId, decision, source = 'user') {
    const normalizedId = String(confirmationId || '').trim();
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!normalizedId || !['confirm', 'cancel'].includes(normalizedDecision)) return null;
    return settle(normalizedId, normalizedDecision, String(source || 'user'));
  }

  return Object.freeze({
    create,
    decide,
    has(confirmationId) {
      return pending.has(String(confirmationId || '').trim());
    }
  });
}

const defaultCliInstallConfirmationRegistry = createCliInstallConfirmationRegistry();

module.exports = {
  DEFAULT_CLI_INSTALL_CONFIRMATION_TIMEOUT_MS,
  createCliInstallConfirmationRegistry,
  defaultCliInstallConfirmationRegistry
};
