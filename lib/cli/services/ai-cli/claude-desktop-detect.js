'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IDENTITY_SCOPE = 'same_os_user_main_candidate';
const FAILURE_REASONS = new Set([
  'unsupported_platform', 'desktop_detection_scan_failed',
  'desktop_detection_identity_unavailable', 'desktop_detection_ambiguous'
]);

function refused(reason) {
  return { ok: false, supported: true, detected: false, clientName: 'Claude', reason };
}

function exactKeys(value, names) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && Object.keys(value).length === names.length
    && names.every((name) => Object.hasOwn(value, name));
}

// All Claude host-running callers use this read-only Go projection. A candidate
// identifies an OS user and main image, not an AIH account or permission to stop.
function detectClaudeDesktop(options = {}) {
  const binary = options.goBinary || path.resolve(__dirname, '../../../../bin/native',
    `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  let result;
  try {
    result = spawnSync(binary, ['__claude-desktop-detect'], {
      input: JSON.stringify({ intent: 'host-claude-running' }), encoding: 'utf8',
      timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true
    });
  } catch (_) {
    return refused('desktop_detection_core_unavailable');
  }
  if (result.error || result.status !== 0 || result.signal) {
    return refused(result.error && !['ENOENT', 'EACCES'].includes(result.error.code)
      ? 'desktop_detection_failed' : 'desktop_detection_core_unavailable');
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const keys = ['ok', 'supported', 'detected', 'platform', 'clientName', 'reason', 'identityScope'];
    if (parsed?.detected === true) keys.push('processInfo');
    if (!exactKeys(parsed, keys) || typeof parsed.ok !== 'boolean'
      || typeof parsed.supported !== 'boolean' || typeof parsed.detected !== 'boolean'
      || parsed.platform !== process.platform || parsed.clientName !== 'Claude'
      || parsed.identityScope !== IDENTITY_SCOPE) throw new Error();
    if (parsed.ok) {
      if (!parsed.supported || parsed.reason !== (parsed.detected ? '' : 'not_running')) throw new Error();
    } else if (parsed.detected || !FAILURE_REASONS.has(parsed.reason)
      || parsed.supported !== (parsed.reason !== 'unsupported_platform')) throw new Error();
    if (parsed.detected) {
      const info = parsed.processInfo;
      if (!exactKeys(info, ['pid', 'name', 'executablePath']) || !Number.isSafeInteger(info.pid)
        || info.pid <= 1 || typeof info.executablePath !== 'string'
        || /[\x00-\x1f\x7f]/.test(info.executablePath)
        || !path.isAbsolute(info.executablePath)) throw new Error();
      if (process.platform === 'darwin') {
        if (info.name !== 'Claude' || !info.executablePath.endsWith('/Claude.app/Contents/MacOS/Claude')) throw new Error();
      } else if (process.platform === 'win32') {
        if (info.name.toLowerCase() !== 'claude.exe'
          || path.basename(info.executablePath).toLowerCase() !== 'claude.exe') throw new Error();
      } else throw new Error();
    }
    return parsed;
  } catch (_) {
    return refused('desktop_detection_response_invalid');
  }
}

module.exports = { detectClaudeDesktop };
