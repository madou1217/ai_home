const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FINGERPRINT_MODES,
  DEFAULT_FINGERPRINT_MODE,
  normalizeFingerprintMode,
  generateDeterministicDeviceId,
  applyDeviceFingerprintMask
} = require('../lib/server/device-fingerprint-mask');

test('device-fingerprint-mask exports valid mode constants and default is off', () => {
  assert.equal(DEFAULT_FINGERPRINT_MODE, 'off');
  assert.equal(FINGERPRINT_MODES.OFF, 'off');
  assert.equal(FINGERPRINT_MODES.DEVICE, 'device');
  assert.equal(FINGERPRINT_MODES.SESSION, 'session');
  assert.equal(FINGERPRINT_MODES.FULL, 'full');
});

test('normalizeFingerprintMode falls back to off for unknown or empty values', () => {
  assert.equal(normalizeFingerprintMode(null), 'off');
  assert.equal(normalizeFingerprintMode(''), 'off');
  assert.equal(normalizeFingerprintMode('invalid'), 'off');
  assert.equal(normalizeFingerprintMode('DEVICE'), 'device');
  assert.equal(normalizeFingerprintMode('  session '), 'session');
  assert.equal(normalizeFingerprintMode('full'), 'full');
});

test('generateDeterministicDeviceId produces stable pseudo device IDs for same accountRef', () => {
  const id1 = generateDeterministicDeviceId('acct_123');
  const id2 = generateDeterministicDeviceId('acct_123');
  const id3 = generateDeterministicDeviceId('acct_456');

  assert.equal(typeof id1, 'string');
  assert.equal(id1.startsWith('dev_'), true);
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
});

test('applyDeviceFingerprintMask returns unmodified headers when mode is off', () => {
  const originalHeaders = { 'authorization': 'Bearer token', 'custom-header': 'value' };
  const masked = applyDeviceFingerprintMask(originalHeaders, { mode: 'off', accountRef: 'acct_1' });
  assert.deepEqual(masked, originalHeaders);
});

test('applyDeviceFingerprintMask injects pseudo device ID when mode is device', () => {
  const originalHeaders = { 'authorization': 'Bearer token' };
  const masked = applyDeviceFingerprintMask(originalHeaders, { mode: 'device', accountRef: 'acct_1' });

  assert.equal(masked.authorization, 'Bearer token');
  assert.equal(typeof masked['x-device-id'], 'string');
  assert.equal(masked['x-device-id'].startsWith('dev_'), true);
  assert.equal(masked['x-client-device-id'], masked['x-device-id']);
  assert.equal(masked['x-session-affinity'], undefined);
});

test('applyDeviceFingerprintMask injects session affinity when mode is session or full', () => {
  const originalHeaders = { 'authorization': 'Bearer token' };
  const maskedSession = applyDeviceFingerprintMask(originalHeaders, { mode: 'session', accountRef: 'acct_1' });
  assert.equal(typeof maskedSession['x-session-affinity'], 'string');

  const maskedFull = applyDeviceFingerprintMask(originalHeaders, { mode: 'full', accountRef: 'acct_1' });
  assert.equal(typeof maskedFull['x-session-affinity'], 'string');
  assert.equal(maskedFull['x-origin-client'], 'ai-home-runtime');
});
