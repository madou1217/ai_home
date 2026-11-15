'use strict';

// One adapter selects the existing canonical Go daemon or a private local pipe.
// Never autostart a server and never fall back to a compat-only restore.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { readNativeIdentity } = require('../../cli/services/server/native-process');
const { readServerConfig } = require('../../server/server-config-store');
const MAX_BYTES = 64 * 1024 * 1024;
const protocolError = (code) => Object.assign(new Error(code), { code });

function daemonFor(home) {
  const file = path.join(home, 'run', 'go-server-runtime.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw protocolError('backup_core_state_unknown'); }
  let record;
  try { record = JSON.parse(raw); } catch (_) { throw protocolError('backup_core_state_unknown'); }
  const verified = readNativeIdentity({ fs, path, aiHomeDir: home, platform: process.platform, spawnSync });
  if (verified) return verified;
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) throw protocolError('backup_core_state_unknown');
  try { process.kill(record.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return null; throw protocolError('backup_core_state_unknown'); }
  // Alive but unverifiable (permissions, timeout or creation-ID mismatch) is
  // never authorization to bypass its in-memory routing index.
  throw protocolError('backup_core_state_unknown');
}
async function requestDaemon(identity, home, action, input, options) {
  const config = readServerConfig({ fs, aiHomeDir: home });
  const env = options.env || process.env;
  const key = env.AIH_SERVER_MANAGEMENT_KEY || config.managementKey || env.AIH_SERVER_API_KEY || config.apiKey;
  if (!key) throw protocolError('backup_core_management_key_missing');
  const suffix = action === 'import' && options.dryRun ? 'preflight' : action;
  const response = await fetch(`http://127.0.0.1:${identity.port}/v1/management/accounts/backup/${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(input || {}), signal: options.signal || AbortSignal.timeout(120000), redirect: 'error'
  });
  if (!response.ok) throw protocolError(`backup_core_http_${response.status}`);
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    if (size > MAX_BYTES) { await reader.cancel(); throw protocolError('backup_core_output_too_large'); }
    chunks.push(Buffer.from(value)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw protocolError('backup_core_invalid_response'); }
}
function requestPipe(home, action, input, options) {
  const binary = options.coreBinary || path.resolve(__dirname, '../../../bin/native', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  return new Promise((resolve, reject) => {
    const argv = ['__backup-accounts', action, ...(action === 'import' && options.dryRun ? ['--dry-run'] : [])];
    const child = spawn(binary, argv, { env: { ...(options.env || process.env), AIH_HOME_DIR: path.resolve(home) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const parts = []; let size = 0, failure;
    const timer = setTimeout(() => { failure = protocolError('backup_core_timeout'); child.kill('SIGKILL'); }, 120000);
    const abort = () => { failure = protocolError('backup_core_cancelled'); child.kill('SIGTERM'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (data) => { size += data.length; if (size > MAX_BYTES) { failure = protocolError('backup_core_output_too_large'); child.kill('SIGKILL'); } else parts.push(data); });
    child.stderr.on('data', () => {}); // Never surface process diagnostics that might contain artifact text.
    child.once('error', () => { failure = protocolError('backup_core_unavailable'); });
    child.stdin.on('error', () => {});
    child.once('close', (code) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) { reject(failure || protocolError('backup_core_failed')); return; }
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
      catch (_) { reject(protocolError('backup_core_invalid_response')); }
    });
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}
async function coreAccounts(home, action, input, options = {}) {
  if (!home || !['import', 'export'].includes(action)) throw protocolError('backup_core_invalid_request');
  if (input && Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) throw protocolError('backup_core_input_too_large');
  const identity = daemonFor(home);
  const result = identity ? await requestDaemon(identity, home, action, input, options) : await requestPipe(home, action, input, options);
  if (!result || result.protocolVersion !== 1 || typeof result.ok !== 'boolean') throw protocolError('backup_core_invalid_response');
  return result;
}
module.exports = { coreAccounts };
