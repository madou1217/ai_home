'use strict';

const crypto = require('node:crypto');

const CODEX_RESET_TYPES = new Set(['codexRateLimits', 'codex_rate_limits']);
const STATUS_MAP = Object.freeze({
  available: 'available',
  redeeming: 'consuming',
  redeemed: 'consumed',
  unknown: 'unknown'
});

function normalizeText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeCount(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value < 10_000_000_000 ? value * 1000 : value);
  }
  const text = normalizeText(value);
  if (!text) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    return Number.isFinite(numeric)
      ? Math.trunc(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
      : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCredit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const resetType = normalizeText(value.resetType ?? value.reset_type);
  if (!CODEX_RESET_TYPES.has(resetType)) return null;
  const creditId = normalizeText(value.id ?? value.creditId ?? value.credit_id);
  if (!creditId) return null;
  const status = STATUS_MAP[normalizeText(value.status)] || 'unknown';
  return {
    creditId,
    status,
    grantedAt: normalizeTimestamp(value.grantedAt ?? value.granted_at),
    expiresAt: normalizeTimestamp(value.expiresAt ?? value.expires_at)
  };
}

function compareCredits(left, right) {
  const leftExpiry = left.expiresAt === null ? Number.POSITIVE_INFINITY : left.expiresAt;
  const rightExpiry = right.expiresAt === null ? Number.POSITIVE_INFINITY : right.expiresAt;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
  const leftGranted = left.grantedAt === null ? Number.POSITIVE_INFINITY : left.grantedAt;
  const rightGranted = right.grantedAt === null ? Number.POSITIVE_INFINITY : right.grantedAt;
  if (leftGranted !== rightGranted) return leftGranted - rightGranted;
  return left.creditId.localeCompare(right.creditId);
}

function normalizeResetCreditInventory(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawCredits = Array.isArray(source.credits) ? source.credits : [];
  const credits = [];
  const seenCreditIds = new Set();
  let hasDuplicateCreditId = false;
  let hasUnsafeAvailableExpiry = false;
  for (const rawCredit of rawCredits) {
    const credit = normalizeCredit(rawCredit);
    if (!credit) continue;
    if (seenCreditIds.has(credit.creditId)) {
      hasDuplicateCreditId = true;
      continue;
    }
    seenCreditIds.add(credit.creditId);
    if (credit.status === 'available' && !Number.isFinite(credit.expiresAt)) {
      hasUnsafeAvailableExpiry = true;
    }
    credits.push(credit);
  }
  credits.sort(compareCredits);
  const availableCount = normalizeCount(source.availableCount ?? source.available_count);
  const normalizedAvailableCount = credits.filter((credit) => credit.status === 'available').length;
  return {
    availableCount,
    detailsComplete: !hasDuplicateCreditId
      && !hasUnsafeAvailableExpiry
      && normalizedAvailableCount === availableCount
      && (availableCount === 0 || Array.isArray(source.credits)),
    credits
  };
}

function selectNextResetCredit(credits, now = Date.now()) {
  const parsedNow = Number(now);
  const currentTime = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  return (Array.isArray(credits) ? credits : [])
    .filter((credit) => credit
      && credit.status === 'available'
      && Number.isFinite(credit.expiresAt)
      && credit.expiresAt > currentTime)
    .slice()
    .sort(compareCredits)[0] || null;
}

function buildResetCreditInventoryVersion(inventory = {}) {
  const credits = (Array.isArray(inventory.credits) ? inventory.credits : [])
    .map((credit) => ({
      creditId: normalizeText(credit && credit.creditId),
      status: normalizeText(credit && credit.status),
      grantedAt: normalizeTimestamp(credit && credit.grantedAt),
      expiresAt: normalizeTimestamp(credit && credit.expiresAt)
    }))
    .filter((credit) => credit.creditId)
    .sort(compareCredits);
  const canonical = JSON.stringify({
    availableCount: normalizeCount(inventory.availableCount),
    credits
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = {
  buildResetCreditInventoryVersion,
  normalizeResetCreditInventory,
  selectNextResetCredit
};
