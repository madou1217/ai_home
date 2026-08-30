'use strict';

const crypto = require('crypto');

/**
 * Device Fingerprint Modes:
 * - 'off': No fingerprint mutation/masking, pass through native headers/identifiers. (Default)
 * - 'device': Isolates hardware/device identifier derived stably per accountRef.
 * - 'session': Isolates device identifier and session UUID entropy per accountRef.
 * - 'full': Complete header & device identifier convergence per accountRef.
 */
const FINGERPRINT_MODES = Object.freeze({
  OFF: 'off',
  DEVICE: 'device',
  SESSION: 'session',
  FULL: 'full'
});

const DEFAULT_FINGERPRINT_MODE = FINGERPRINT_MODES.OFF;

function normalizeFingerprintMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'device') return FINGERPRINT_MODES.DEVICE;
  if (normalized === 'session') return FINGERPRINT_MODES.SESSION;
  if (normalized === 'full') return FINGERPRINT_MODES.FULL;
  return FINGERPRINT_MODES.OFF;
}

/**
 * Generate a deterministic pseudo-random device ID for a specific accountRef
 * so multiple accounts on the same machine appear on distinct virtual devices.
 */
function generateDeterministicDeviceId(accountRef, salt = 'aih-device-v1') {
  if (!accountRef || typeof accountRef !== 'string') return '';
  const hash = crypto.createHash('sha256').update(`${salt}:${accountRef}`).digest('hex');
  return `dev_${hash.slice(0, 32)}`;
}

/**
 * Apply device fingerprint masking options to outgoing headers/payload.
 * If mode is 'off' or disabled, returns headers unmodified.
 */
function applyDeviceFingerprintMask(headers = {}, options = {}) {
  const mode = normalizeFingerprintMode(options.mode || options.fingerprintMode || DEFAULT_FINGERPRINT_MODE);
  if (mode === FINGERPRINT_MODES.OFF) {
    return { ...headers };
  }

  const accountRef = String(options.accountRef || '').trim();
  const maskedHeaders = { ...headers };
  const pseudoDeviceId = generateDeterministicDeviceId(accountRef);

  if (pseudoDeviceId) {
    if (mode === FINGERPRINT_MODES.DEVICE || mode === FINGERPRINT_MODES.SESSION || mode === FINGERPRINT_MODES.FULL) {
      maskedHeaders['x-device-id'] = pseudoDeviceId;
      maskedHeaders['x-client-device-id'] = pseudoDeviceId;
    }

    if (mode === FINGERPRINT_MODES.SESSION || mode === FINGERPRINT_MODES.FULL) {
      const sessionEntropy = crypto.createHash('md5').update(`${pseudoDeviceId}:${Date.now()}`).digest('hex').slice(0, 16);
      maskedHeaders['x-session-affinity'] = `${pseudoDeviceId}_${sessionEntropy}`;
    }

    if (mode === FINGERPRINT_MODES.FULL) {
      maskedHeaders['x-origin-client'] = 'ai-home-runtime';
    }
  }

  return maskedHeaders;
}

module.exports = {
  FINGERPRINT_MODES,
  DEFAULT_FINGERPRINT_MODE,
  normalizeFingerprintMode,
  generateDeterministicDeviceId,
  applyDeviceFingerprintMask
};
