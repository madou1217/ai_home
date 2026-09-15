'use strict';

const nodePath = require('node:path');
const { randomBytes } = require('node:crypto');
const { parse } = require('smol-toml');
const {
  AIH_CODEX_PROVIDER_KEY,
  AIH_CODEX_PROVIDER_NAME,
  AIH_CODEX_PROVIDER_WIRE_API
} = require('../cli/services/pty/codex-config-sync');
const { readCodexGatewayConnection } = require('../server/codex-gateway-connection');
const { readDefaultAccountRef } = require('./default-account-store');
const { createHookSelfHealLoop } = require('../server/hook-self-heal');

// Registration is independent of the default login method. Historical threads
// can still resolve this provider while new threads use native OpenAI OAuth.
// The auth command reads the gateway key; it never needs the OAuth account's key.
function quote(value) {
  const text = String(value);
  return /['\x00-\x1f\x7f]/.test(text)
    ? JSON.stringify(text).replace(/\x7f/g, '\\u007f')
    : `'${text}'`;
}

function buildCodexHostProviderBlock(connection, options = {}) {
  const path = options.path || nodePath;
  if (!connection || !connection.baseUrl || !options.aiHomeDir) {
    throw new Error('host_provider_context_required');
  }
  const headers = Object.entries(connection.httpHeaders || {});
  const args = [
    path.join(__dirname, '..', '..', 'scripts', 'aih-codex-provider-auth.js'),
    '--gateway', '--ai-home', options.aiHomeDir
  ];
  // Host credentials are command-backed, unlike sandbox env-backed providers.
  // Share canonical identity/protocol constants, not a secret-dependent auth
  // branch: an empty key during generation must not remove the auth command.
  return [
    `[model_providers.${AIH_CODEX_PROVIDER_KEY}]`,
    `name = "${AIH_CODEX_PROVIDER_NAME}"`,
    `base_url = ${JSON.stringify(String(connection.baseUrl))}`,
    `wire_api = "${AIH_CODEX_PROVIDER_WIRE_API}"`,
    'supports_websockets = true',
    ...(headers.length ? [`http_headers = { ${headers.map(([k, v]) => `${quote(k)} = ${quote(v)}`).join(', ')} }`] : []),
    '',
    `[model_providers.${AIH_CODEX_PROVIDER_KEY}.auth]`,
    `command = ${quote(options.nodeExecPath || process.execPath)}`,
    `args = [${args.map(quote).join(', ')}]`,
    'refresh_interval_ms = 300000',
    'timeout_ms = 10000'
  ].join('\n');
}

function sameFile(a, b) {
  return a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

// Only restore an absent registration. Existing provider definitions, including
// user changes and account pins, remain untouched by the background reconciler.
// Explicit set-default owns updating the selected-account connection contract.
function createCodexHostProviderReconciler(options = {}) {
  const fs = options.fs || require('node:fs');
  const path = options.path || nodePath;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const getConnection = options.getConnection || (() => readCodexGatewayConnection(
    fs, aiHomeDir, readDefaultAccountRef(fs, aiHomeDir, 'codex')
  ));

  return function reconcile() {
    if (!aiHomeDir || !hostHomeDir) return { ok: true, repaired: false, reason: 'host_scope_unavailable' };
    const codexHome = path.join(hostHomeDir, '.codex');
    const configPath = path.join(codexHome, 'config.toml');
    let temporary = '';
    let stage = 'read';
    try {
      // Never interpret CODEX_HOME from an account sandbox as the host home.
      // Do not create a new Codex installation or follow a redirected config.
      let directory;
      try { directory = fs.lstatSync(codexHome); }
      catch (error) {
        if (error.code === 'ENOENT') return { ok: true, repaired: false, reason: 'codex_home_absent' };
        throw error;
      }
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        return { ok: false, repaired: false, reason: 'host_config_directory_redirected' };
      }
      let before = null;
      try { before = fs.lstatSync(configPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (before && (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 * 1024)) {
        return { ok: false, repaired: false, reason: 'host_config_not_regular' };
      }
      const original = before ? fs.readFileSync(configPath, 'utf8') : '';
      stage = 'parse';
      const document = parse(original);
      const providers = document.model_providers;
      if (providers && Object.hasOwn(providers, 'aih_server')) {
        return { ok: true, repaired: false, reason: 'provider_present' };
      }
      const newline = original.includes('\r\n') ? '\r\n' : '\n';
      stage = 'connection';
      const block = buildCodexHostProviderBlock(getConnection(), { ...options, path, aiHomeDir });
      // Keep the original document byte-for-byte; a final comment cannot eat the
      // appended table. Parsing also rejects extending a sealed inline table.
      const content = original + (original ? newline + newline : '')
        + block.replace(/\r?\n/g, newline) + newline;
      stage = 'validate';
      const provider = parse(content).model_providers.aih_server;
      if (!provider.name || !provider.base_url || provider.wire_api !== 'responses'
        || !provider.auth || provider.env_key || provider.bearer_token) {
        return { ok: false, repaired: false, reason: 'invalid_host_provider_block' };
      }
      stage = 'write';
      temporary = `${configPath}.aih-provider-${randomBytes(8).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      // Detect concurrent App writes before publication; do not overwrite the
      // snapshot we did not inspect. Non-cooperating external writers still
      // require eventual reconciliation, not a claim of an OS-wide transaction.
      const currentDirectory = fs.lstatSync(codexHome);
      if (directory.dev !== currentDirectory.dev || directory.ino !== currentDirectory.ino
        || !currentDirectory.isDirectory() || currentDirectory.isSymbolicLink()) {
        return { ok: false, repaired: false, reason: 'host_config_changed_during_repair' };
      }
      if (before) {
        const current = fs.lstatSync(configPath);
        if (!sameFile(before, current) || current.isSymbolicLink()
          || fs.readFileSync(configPath, 'utf8') !== original) {
          return { ok: false, repaired: false, reason: 'host_config_changed_during_repair' };
        }
        fs.renameSync(temporary, configPath);
      } else {
        // Atomic create-if-absent; a concurrently created App config wins.
        fs.linkSync(temporary, configPath);
      }
      return { ok: true, repaired: true, reason: 'provider_restored', configPath };
    } catch (error) {
      // Parser/IO exceptions may include config text; report only closed codes.
      const reason = stage === 'parse' ? 'invalid_host_toml'
        : stage === 'validate' ? 'unsupported_host_provider_layout'
          : ['ENOENT', 'EEXIST'].includes(error && error.code) ? 'host_config_changed_during_repair'
            : 'host_provider_repair_failed';
      return { ok: false, repaired: false, reason };
    } finally {
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch (_) {}
      }
    }
  };
}

function startCodexHostProviderSelfHeal(options = {}) {
  const loop = createHookSelfHealLoop({
    ensureInstalled: createCodexHostProviderReconciler(options),
    intervalMs: options.intervalMs || 15_000,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    now: options.now,
    onRepaired: options.onRepaired,
    onFailure: options.onFailure
  });
  loop.tick();
  return loop;
}

module.exports = {
  buildCodexHostProviderBlock,
  createCodexHostProviderReconciler,
  startCodexHostProviderSelfHeal
};
