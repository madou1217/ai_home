'use strict';

// The provider repair policy lives in Go. Keep the existing synchronous text
// contract; the outer healer owns diagnostics and the one locked publication.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withHiddenWindowsConsole } = require('../../../runtime/hidden-child-process-options');

function healCodexProviderConfig(configText, options = {}) {
  const binary = options.goCLIBinary || path.join(__dirname, '..', '..', '..', '..', 'bin', 'native',
    `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  const request = {
    version: 1,
    config: String(configText || ''),
    missingProviderBlock: String(options.missingProviderBlock || '')
  };
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 16 * 1024 * 1024) fail('codex_provider_heal_input_limit');
  const command = ['codex', 'effort', '--heal-provider-config'];
  const probe = spawnSync(binary, [...command, '--capabilities'], withHiddenWindowsConsole({
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16384
  }));
  if (probe.error || probe.status !== 0 || String(probe.stdout || '').trim() !== 'aih-codex-provider-heal-v1') {
    fail('codex_provider_heal_native_unavailable');
  }
  const result = spawnSync(binary, command, withHiddenWindowsConsole({
    input, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024
  }));
  if (result.error || result.status !== 0) fail('codex_provider_heal_rejected');
  let response;
  try { response = JSON.parse(result.stdout); } catch (_error) { fail('codex_provider_heal_protocol_invalid'); }
  if (!response || typeof response !== 'object' || Object.keys(response).length !== 3
    || response.version !== 1 || typeof response.config !== 'string' || typeof response.changed !== 'boolean'
    || (!response.changed && response.config !== request.config)) {
    fail('codex_provider_heal_protocol_invalid');
  }
  return { config: response.config, changed: response.changed };
}

module.exports = { healCodexProviderConfig };
