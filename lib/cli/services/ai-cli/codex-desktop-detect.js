'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IDENTITY_SCOPE = 'same_os_user_main_candidate';
const CLIENT_NAME = 'ChatGPT';
const FAILURE_REASONS = new Set([
  'unsupported_platform', 'desktop_detection_scan_failed',
  'desktop_detection_identity_unavailable', 'desktop_detection_ambiguous'
]);

function refused(reason, supported = true) {
  return {
    ok: false, supported, detected: false, platform: process.platform,
    clientName: CLIENT_NAME, reason, identityScope: IDENTITY_SCOPE
  };
}

function exactKeys(value, names) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && Object.keys(value).length === names.length
    && names.every((name) => Object.hasOwn(value, name));
}

// Require the compact representation emitted by Go as well as exact fields.
// Reserializing removes duplicate keys, so duplicate-key wire is also refused.
function goCompactJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

// This leaf only observes OS facts. Callers must separately establish account
// ownership and action authority before using any candidate for process control.
function detectCodexDesktop() {
  if (process.platform !== 'darwin') return refused('unsupported_platform', false);
  const binary = path.resolve(__dirname, '../../../../bin/native',
    `${process.platform}-${process.arch}`, 'aih-go');
  let result;
  try {
    result = spawnSync(binary, ['__codex-desktop-detect'], {
      input: JSON.stringify({ intent: 'host-codex-running' }), encoding: 'utf8',
      timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (_) {
    return refused('desktop_detection_core_unavailable');
  }
  if (result.error || result.status !== 0 || result.signal) {
    return refused(result.error && ['ENOENT', 'EACCES'].includes(result.error.code)
      ? 'desktop_detection_core_unavailable' : 'desktop_detection_failed');
  }
  try {
    const wire = result.stdout;
    if (typeof wire !== 'string' || !wire.endsWith('\n')) throw new Error();
    const parsed = JSON.parse(wire);
    if (goCompactJSON(parsed) + '\n' !== wire) throw new Error();
    const keys = ['ok', 'supported', 'detected', 'platform', 'clientName', 'reason', 'identityScope'];
    if (parsed?.detected === true) keys.push('processInfo');
    if (!exactKeys(parsed, keys) || typeof parsed.ok !== 'boolean'
      || typeof parsed.supported !== 'boolean' || typeof parsed.detected !== 'boolean'
      || parsed.platform !== process.platform || parsed.clientName !== CLIENT_NAME
      || parsed.identityScope !== IDENTITY_SCOPE) throw new Error();
    if (parsed.ok) {
      if (!parsed.supported || parsed.reason !== (parsed.detected ? '' : 'not_running')) throw new Error();
    } else if (parsed.detected || !FAILURE_REASONS.has(parsed.reason)
      || parsed.supported !== (parsed.reason !== 'unsupported_platform')) throw new Error();
    if (parsed.detected) {
      const info = parsed.processInfo;
      if (!exactKeys(info, ['pid', 'name', 'executablePath']) || !Number.isSafeInteger(info.pid)
        || info.pid <= 1 || !['ChatGPT', 'Codex'].includes(info.name)
        || typeof info.executablePath !== 'string'
        || /[\x00-\x1f\x7f]/.test(info.executablePath)
        || !path.isAbsolute(info.executablePath)
        || path.normalize(info.executablePath) !== info.executablePath) throw new Error();
      const suffix = `/${info.name}.app/Contents/MacOS/${info.name}`;
      if (!info.executablePath.endsWith(suffix)
        || info.executablePath.slice(0, -suffix.length).includes('.app/Contents/')) throw new Error();
    }
    return parsed;
  } catch (_) {
    return refused('desktop_detection_response_invalid');
  }
}

module.exports = { detectCodexDesktop };
