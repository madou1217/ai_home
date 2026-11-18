'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Wire OS names follow Go; package lookup continues to use Node platform names.
const WIRE_PLATFORM = process.platform === 'win32' ? 'windows' : process.platform;

const REASONS = new Set([
  '', 'missing', 'record_changed', 'desktop_cache_request_invalid',
  'desktop_cache_record_invalid', 'desktop_cache_migration_required',
  'desktop_cache_cancelled', 'desktop_cache_unavailable', 'desktop_cache_busy',
  'account_maintenance_busy', 'account_maintenance_in_progress'
]);

function refused(reason, outcomeUnknown = false) {
  return {
    ok: false, found: false, changed: false, platform: WIRE_PLATFORM,
    reason, record: null, recordSha256: '', outcomeUnknown
  };
}

function exactKeys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length
    && names.every((name) => Object.hasOwn(value, name));
}

// The caller only transports intent. Go owns the complete key and transactions.
// The package and this bridge must be installed together; no host/ENV fallback.
function desktopClientPaths(request) {
  const binary = path.resolve(__dirname, '../../../../bin/native',
    `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  let result;
  try {
    result = spawnSync(binary, ['__desktop-client-paths'], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 10000,
      killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (_) {
    return refused('desktop_cache_core_unavailable');
  }
  if (result.error || result.status !== 0 || result.signal) {
    const unavailable = ['ENOENT', 'EACCES'].includes(result.error?.code);
    return refused(unavailable ? 'desktop_cache_core_unavailable' : 'desktop_cache_core_failed',
      !unavailable && request.operation !== 'get');
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!exactKeys(parsed, ['ok', 'found', 'changed', 'platform', 'reason', 'record',
      'recordSha256', 'outcomeUnknown']) || parsed.platform !== WIRE_PLATFORM
      || !['ok', 'found', 'changed', 'outcomeUnknown'].every((key) => typeof parsed[key] === 'boolean')
      || !REASONS.has(parsed.reason) || typeof parsed.recordSha256 !== 'string') throw new Error();
    if (!parsed.ok) {
      if (parsed.found || parsed.changed || parsed.record !== null || parsed.recordSha256 !== ''
        || ['', 'missing', 'record_changed'].includes(parsed.reason)
        || request.operation === 'get' && parsed.outcomeUnknown) throw new Error();
    } else {
      if (parsed.outcomeUnknown) throw new Error();
      switch (request.operation) {
        case 'get':
          if (parsed.changed || parsed.reason !== (parsed.found ? '' : 'missing')) throw new Error();
          break;
        case 'remember':
          if (!parsed.found || parsed.reason !== '') throw new Error();
          break;
        case 'forget':
          if (parsed.changed ? parsed.found || parsed.reason !== ''
            : parsed.reason !== (parsed.found ? 'record_changed' : 'missing')) throw new Error();
          break;
        default: throw new Error();
      }
      if (parsed.found) {
        const record = parsed.record;
        if (!exactKeys(record, ['clientName', 'executablePath', 'bundlePath'])
          || !['clientName', 'executablePath', 'bundlePath'].every((key) => typeof record[key] === 'string')
          || !record.clientName || record.clientName !== record.clientName.trim()
          || Object.values(record).some((value) => value.length > 8192 || /[\x00-\x1f\x7f]/.test(value))
          || !path.isAbsolute(record.executablePath) || path.normalize(record.executablePath) !== record.executablePath
          || !/^[a-f0-9]{64}$/.test(parsed.recordSha256)
          || request.operation === 'remember' && record.executablePath !== request.executablePath) throw new Error();
        if (process.platform === 'darwin') {
          const marker = '/Contents/MacOS/';
          const split = record.executablePath.indexOf(marker);
          if (split < 0 || record.bundlePath !== record.executablePath.slice(0, split)
            || !record.bundlePath.endsWith('.app') || record.bundlePath.includes('.app/Contents/')
            || !record.executablePath.slice(split + marker.length)
            || record.executablePath.slice(split + marker.length).includes('/')) throw new Error();
        } else if (record.bundlePath !== '') throw new Error();
      } else if (parsed.record !== null || parsed.recordSha256 !== '') throw new Error();
    }
    return parsed;
  } catch (_) {
    return refused('desktop_cache_response_invalid', request.operation !== 'get');
  }
}

module.exports = { desktopClientPaths };
