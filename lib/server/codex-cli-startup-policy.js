'use strict';

// Startup policy has one Go owner. This adapter projects minimal inputs (API key
// presence only; opaque argv/URLs must still never be logged),
// verifies the fixed installed capability and transports its typed result.
const crypto = require('node:crypto');
const nodePath = require('node:path');
const { spawnSync } = require('node:child_process');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');

function resolveCodexHome(env = {}, options = {}) {
  const pathImpl = options.path || nodePath;
  const explicit = String(env.CODEX_HOME || '').trim();
  if (explicit) return explicit;
  const homeDir = String(env.HOME || env.USERPROFILE || '').trim();
  return homeDir ? pathImpl.join(homeDir, '.codex') : '';
}

function buildCodexDefaultCliArgs(_fs, env, args, authMode, options = {}) {
  const binary = options.goCLIBinary || nodePath.join(__dirname, '..', '..', 'bin', 'native',
    `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'aih-go.exe' : 'aih-go');
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  const request = {
    version: 1,
    authMode,
    args,
    aiHomeDir: String(options.aiHomeDir || '').trim(),
    environment: {
      hasApiKey: Boolean(String(env.OPENAI_API_KEY || '').trim()),
      baseUrl: String(env.OPENAI_BASE_URL || ''),
      gatewayAccountRef: String(env.AIH_CODEX_GATEWAY_ACCOUNT_REF || ''),
      sessionKey: String(env.AIH_CODEX_GATEWAY_SESSION_KEY || ''),
      modelAlias: String(env.AIH_MODEL_ALIAS || ''),
      flags: String(env.AIH_CODEX_FLAGS || ''),
      codexHome: String(env.CODEX_HOME || ''),
      home: String(env.HOME || ''),
      userProfile: String(env.USERPROFILE || '')
    }
  };
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) fail('codex_cli_startup_input_limit');
  const probe = spawnSync(binary, ['__codex-cli-startup', '--capabilities'], withHiddenWindowsConsole({
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16384
  }));
  if (probe.error || probe.status !== 0 || String(probe.stdout || '').trim() !== 'aih-codex-cli-startup-v1') {
    fail('codex_cli_startup_native_unavailable');
  }
  const result = spawnSync(binary, ['__codex-cli-startup'], withHiddenWindowsConsole({
    input, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024
  }));
  if (result.error || result.status !== 0) fail('codex_cli_startup_rejected');
  let response;
  try { response = JSON.parse(result.stdout); } catch (_error) { fail('codex_cli_startup_protocol_invalid'); }
  if (!response || typeof response !== 'object' || Object.keys(response).length !== 2
    || response.version !== 1 || !Array.isArray(response.args)
    || response.args.length > 8192 || response.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    fail('codex_cli_startup_protocol_invalid');
  }
  return response.args;
}

// Mechanical content-addressed publication is also consumed by Chat. Keep this
// synchronous I/O API unchanged; it does not retain a second startup policy.
function readFileIfPresent(fs, filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

function writeModelCatalogAtomically(fs, catalogDir, content, options = {}) {
  const pathImpl = options.path || nodePath;
  const fileId = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  const catalogPath = pathImpl.join(catalogDir, `${fileId}.json`);
  if (readFileIfPresent(fs, catalogPath) === content) return catalogPath;

  const processObj = options.processObj || process;
  const nonce = crypto.randomBytes(6).toString('hex');
  const tempPath = `${catalogPath}.${Number(processObj.pid) || process.pid}-${nonce}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  try {
    fs.renameSync(tempPath, catalogPath);
  } catch (error) {
    // Native Windows does not replace an existing destination during rename.
    // A concurrent writer that won the race is safe when the content matches.
    if (readFileIfPresent(fs, catalogPath) !== content) throw error;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (_error) {}
  }
  return catalogPath;
}

module.exports = { buildCodexDefaultCliArgs, resolveCodexHome, writeModelCatalogAtomically };
