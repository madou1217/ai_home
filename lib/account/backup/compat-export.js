'use strict';

// The remaining remote caller's compatibility account document is Go-owned.
// This adapter transports a fixed bounded wire only. Merge/prediction/SSH and
// restore remain unchanged in their existing owners, never a fallback here.
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const MAX_INPUT = 16 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024;
const PROVIDERS = new Set(require('../../provider-catalog').listProviderIds());
function failure(code) { return Object.assign(new Error(code), { code }); }
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function valid(result) {
  if (!exact(result, ['version', 'document', 'exported', 'skipped']) || result.version !== 1
    || !Number.isSafeInteger(result.exported) || result.exported < 0
    || !exact(result.document, ['kind', 'version', 'exportedAt', 'source', 'accounts'])
    || result.document.kind !== 'aih-accounts' || result.document.version !== 1
    || typeof result.document.exportedAt !== 'string' || !Number.isFinite(Date.parse(result.document.exportedAt))
    || !exact(result.document.source, ['host']) || typeof result.document.source.host !== 'string'
    || !Array.isArray(result.document.accounts) || result.document.accounts.length !== result.exported
    || !Array.isArray(result.skipped)) return false;
  const seen = new Set();
  for (const account of result.document.accounts) {
    if (!exact(account, ['provider', 'accountRef', 'cliAccountId', 'status', 'env', 'nativeAuth'])
      || !PROVIDERS.has(account.provider) || !/^acct_[a-f0-9]{20}$/.test(account.accountRef)
      || seen.has(account.accountRef) || typeof account.cliAccountId !== 'string'
      || (account.cliAccountId !== '' && !/^\d+$/.test(account.cliAccountId))
      || !['up', 'down'].includes(account.status) || !object(account.env) || !object(account.nativeAuth)) return false;
    seen.add(account.accountRef);
  }
  for (const item of result.skipped) {
    if (!exact(item, ['accountRef', 'provider', 'reason']) || !/^acct_[a-f0-9]{20}$/.test(item.accountRef)
      || !PROVIDERS.has(item.provider) || item.reason !== 'credentials_missing') return false;
  }
  return true;
}

function exportCompatibilityAccounts(options = {}) {
  const home = String(options.aiHomeDir || '').trim();
  const hostName = options.hostName || '';
  if (!home || typeof hostName !== 'string' || /[\x00-\x1f\x7f]/.test(hostName)) {
    return Promise.reject(failure('compat_export_input_invalid'));
  }
  if (options.signal?.aborted) return Promise.reject(failure('compat_export_cancelled'));
  const explicitBinary = Object.prototype.hasOwnProperty.call(options, 'coreBinary')
    && options.coreBinary !== undefined;
  if (explicitBinary && (typeof options.coreBinary !== 'string' || !path.isAbsolute(options.coreBinary)
    || options.coreBinary.includes('\0') || options.coreBinary.trim() === '')) {
    return Promise.reject(failure('compat_export_input_invalid'));
  }
  if (options.env !== undefined && !object(options.env)) {
    return Promise.reject(failure('compat_export_input_invalid'));
  }
  const binary = explicitBinary ? options.coreBinary
    : path.resolve(__dirname, '../../../bin/native', `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  const env = { ...(options.env || process.env), AIH_HOME_DIR: path.resolve(home) };
  const input = JSON.stringify({ version: 1, hostName });
  if (Buffer.byteLength(input) > MAX_INPUT) return Promise.reject(failure('compat_export_input_invalid'));
  const capability = spawnSync(binary, ['__backup-accounts', 'export-compat', '--capabilities'], {
    encoding: 'utf8', env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096, windowsHide: true
  });
  if (capability.error || capability.status !== 0 || String(capability.stdout).trim() !== 'aih-compat-export-v1') {
    return Promise.reject(failure('compat_export_native_unavailable'));
  }
  if (options.signal?.aborted) return Promise.reject(failure('compat_export_cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['__backup-accounts', 'export-compat'], {
      env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    const chunks = []; let bytes = 0; let error;
    const clearChunks = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const stop = (code) => {
      error ||= failure(code);
      clearChunks();
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('compat_export_timeout'), 65000);
    timer.unref?.();
    const abort = () => stop('compat_export_cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (data) => {
      if (error) { data.fill(0); return; }
      bytes += data.length;
      if (bytes > MAX_OUTPUT) {
        data.fill(0);
        stop('compat_export_output_invalid');
      } else chunks.push(data);
    });
    child.stderr.on('data', (data) => { data.fill(0); }); // Never surface raw diagnostics.
    child.stdin.on('error', () => {});
    child.once('error', () => {
      error ||= failure('compat_export_native_unavailable');
      clearChunks();
    });
    child.once('close', (code) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      let output;
      try {
        if (error || code !== 0) { reject(error || failure('compat_export_failed')); return; }
        output = Buffer.concat(chunks);
        let result;
        try { result = JSON.parse(output.toString('utf8')); }
        catch (_) { reject(failure('compat_export_output_invalid')); return; }
        if (!valid(result)) { reject(failure('compat_export_output_invalid')); return; }
        // Parsed business objects are retained; this clears only the raw buffers.
        resolve({ document: result.document, exported: result.exported, skipped: result.skipped });
      } finally {
        output?.fill(0);
        clearChunks();
      }
    });
    child.stdin.end(input);
  });
}

module.exports = { exportCompatibilityAccounts };
