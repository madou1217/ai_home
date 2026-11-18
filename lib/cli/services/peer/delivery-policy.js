'use strict';

const DEFAULT_AUTO_DELIVER_MS = 30 * 60 * 1000;
const MAX_TRANSMIT_ATTEMPTS = 5;
const SUCCESS_COOLDOWN_MS = 3_000;
const CLAIM_RESERVATION_MS = 5_000;
const PROBE_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000, 60_000, 120_000, 300_000]);
const WAIT_REASONS = new Set([
  'target_busy', 'target_has_draft', 'target_input_unavailable', 'chat_target_busy',
  'activity_probe_failed', 'probe_error', 'tmux_unavailable', 'chat_runtime_unavailable',
  'read_receipt_unavailable', 'already_read', 'target_probe_unavailable', 'target_state_unknown',
  'target_inflight', 'target_cooldown', 'supersedes_inflight', 'supersedes_already_delivered',
  'supersedes_missing', 'supersedes_ambiguous', 'supersedes_unavailable', 'supersedes_identity_or_history_conflict',
  'supersedes_identity_mismatch', 'peer_claim_lost', 'auto_horizon_elapsed', 'expired', 'canceled'
]);

function historicalAttempts(record) {
  const explicit = Number(record && record.attemptCount);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  return Array.isArray(record && record.attempts) ? record.attempts.length : 0;
}

function observedFailureCount(record) {
  const attempts = Array.isArray(record && record.attempts) ? record.attempts : [];
  const resetAt = Number(record && record.failureResetAt) || 0;
  return attempts.filter((attempt) => (!resetAt || Number(attempt.at) > resetAt)
    && !attempt.ok && !WAIT_REASONS.has(String(attempt.error || ''))).length;
}

function retryAttempts(record) {
  const attempts = Array.isArray(record && record.attempts) ? record.attempts : [];
  const unknown = Number(record && record.failureResetAt) > 0 ? 0
    : Math.max(0, historicalAttempts(record) - attempts.length);
  return unknown + observedFailureCount(record);
}

function failureBudgetReason(record, gate = {}) {
  if (Number(gate.failureCount) >= MAX_TRANSMIT_ATTEMPTS || observedFailureCount(record) >= MAX_TRANSMIT_ATTEMPTS) {
    return 'retry_exhausted';
  }
  return retryAttempts(record) >= MAX_TRANSMIT_ATTEMPTS ? 'legacy_attempt_history_uncertain' : '';
}

function autoDeliverUntilOf(record) {
  if (record.autoDeliverUntil != null) return Math.max(0, Number(record.autoDeliverUntil) || 0);
  return (Number(record.createdAt) || 0) + DEFAULT_AUTO_DELIVER_MS;
}

function notificationStatus(record, at, gate = {}) {
  if (record.state === 'delivered' || record.state === 'read' || Number(record.readAt) > 0 || Number(record.deliveredAt) > 0) {
    return { notificationState: 'delivered', waitingReason: '' };
  }
  if (Number(record.canceledAt) > 0 || record.notificationState === 'canceled') {
    return { notificationState: 'canceled', waitingReason: 'canceled' };
  }
  if (record.notificationState === 'expired' || (Number(record.expiresAt) > 0 && Number(record.expiresAt) <= at)) {
    return { notificationState: 'expired', waitingReason: 'expired' };
  }
  if (record.notificationState === 'manual') {
    const budget = ['retry_exhausted', 'legacy_attempt_history_uncertain'].includes(record.waitingReason)
      ? failureBudgetReason(record, gate) : '';
    return { notificationState: 'manual', waitingReason: budget || record.waitingReason || 'manual' };
  }
  if (autoDeliverUntilOf(record) <= at) {
    return { notificationState: 'manual', waitingReason: 'auto_horizon_elapsed' };
  }
  const budget = failureBudgetReason(record, gate);
  if (budget) return { notificationState: 'manual', waitingReason: budget };
  if (record.state === 'failed' || record.notificationState === 'manual') {
    return { notificationState: 'manual', waitingReason: record.waitingReason || record.error || 'manual' };
  }
  if (Number(gate.nextProbeAt) > at) {
    return { notificationState: 'waiting', waitingReason: gate.lastReason || 'target_gate' };
  }
  if (Number(record.nextAttemptAt) > at) {
    return { notificationState: 'waiting', waitingReason: record.waitingReason || 'retry_backoff' };
  }
  return { notificationState: 'ready', waitingReason: '' };
}

function timestamp(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  const numeric = typeof value === 'number' || /^\d+$/.test(text);
  if (!numeric && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) throw new Error(`invalid_${field}`);
  const number = numeric ? Number(value) : Date.parse(text);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid_${field}`);
  return number;
}

function messageMetadata(input = {}, at = Date.now()) {
  const metadata = {};
  for (const field of ['subject', 'summary', 'purpose', 'action']) {
    if (input[field] != null) {
      if (typeof input[field] !== 'string') throw new Error(`invalid_${field}`);
      metadata[field] = input[field];
    }
  }
  if (input.replyPolicy != null && input.replyPolicy !== '') {
    if (!['required', 'optional', 'none'].includes(input.replyPolicy)) throw new Error('invalid_replyPolicy');
    metadata.replyPolicy = input.replyPolicy;
  }
  metadata.expiresAt = timestamp(input.expiresAt, 'expiresAt') ?? 0;
  metadata.autoDeliverUntil = timestamp(input.autoDeliverUntil, 'autoDeliverUntil') ?? at + DEFAULT_AUTO_DELIVER_MS;
  if (input.supersedes != null) metadata.supersedes = String(input.supersedes).trim().replace(/^#/, '');
  return metadata;
}

function backoffFor(attempts) {
  return Math.min(48_000, 3_000 * (2 ** Math.max(0, Math.min(4, Number(attempts) - 1 || 0))));
}

module.exports = {
  DEFAULT_AUTO_DELIVER_MS, MAX_TRANSMIT_ATTEMPTS, SUCCESS_COOLDOWN_MS,
  CLAIM_RESERVATION_MS, PROBE_DELAYS_MS, WAIT_REASONS, historicalAttempts,
  retryAttempts, observedFailureCount, failureBudgetReason, autoDeliverUntilOf, notificationStatus, messageMetadata, timestamp, backoffFor
};
