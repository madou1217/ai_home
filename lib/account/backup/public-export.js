'use strict';

// Fixed public-export pipe only. Account reads, selectors and credential file
// creation are exclusively Go-owned; no daemon/RPC or old Node fallback.
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const MAX_INPUT = 256 * 1024;
const MAX_OUTPUT = 64 * 1024;

function failure(code) { return Object.assign(new Error(code), { code }); }

function exportPublicAccounts(tokens, options = {}) {
  const home = String(options.aiHomeDir || '').trim();
  const directory = options.directory || process.cwd();
  if (!home || !Array.isArray(tokens) || !path.isAbsolute(directory)) return Promise.reject(failure('public_export_input_invalid'));
  const binary = path.resolve(__dirname, '../../../bin/native', `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  const env = { ...process.env, AIH_HOME_DIR: path.resolve(home) };
  const input = JSON.stringify({ version: 1, tokens, provider: options.provider || '', directory });
  if (Buffer.byteLength(input) > MAX_INPUT) return Promise.reject(failure('public_export_input_invalid'));
  const capability = spawnSync(binary, ['__backup-accounts', 'export-public', '--capabilities'], {
    encoding: 'utf8', env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096, windowsHide: true
  });
  if (capability.error || capability.status !== 0 || String(capability.stdout).trim() !== 'aih-public-export-v1') {
    return Promise.reject(failure('public_export_native_unavailable'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['__backup-accounts', 'export-public'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = []; let size = 0; let error;
    const timer = setTimeout(() => { error = failure('public_export_timeout'); child.kill('SIGKILL'); }, 65000);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { error = failure('public_export_output_invalid'); child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {}); // Never relay credential-shaped diagnostics.
    child.stdin.on('error', () => {});
    child.once('error', () => { error = failure('public_export_native_unavailable'); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (error || code !== 0) { reject(error || failure('public_export_failed')); return; }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_) { reject(failure('public_export_output_invalid')); return; }
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).sort().join(',') !== 'exported,path,skipped,version'
        || result.version !== 1 || typeof result.path !== 'string' || !path.isAbsolute(result.path)
        || !Number.isSafeInteger(result.exported) || result.exported < 0 || !Array.isArray(result.skipped)
        || result.skipped.some((item) => !item || typeof item !== 'object' || item.reason !== 'credentials_missing'
          || typeof item.accountRef !== 'string' || typeof item.provider !== 'string'
          || Object.keys(item).sort().join(',') !== 'accountRef,provider,reason')) {
        reject(failure('public_export_output_invalid')); return;
      }
      resolve(result);
    });
    child.stdin.end(input);
  });
}

module.exports = { exportPublicAccounts };
