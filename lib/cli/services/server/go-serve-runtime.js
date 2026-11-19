'use strict';

// Go-backed implementation of `aih server serve`.
//
// The Node HTTP gateway is no longer started here. Every explicit serve flag is
// either mapped to a Go aih-server flag/env entry or rejected with
// `serve_options_not_ported`; nothing is silently ignored.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { resolveGoServerBinary } = require('./go-core-supervisor');

const SUPPORTED_SERVE_FLAGS = new Set([
  '--host',
  '--port',
  '--client-key',
  '--api-key',
  '--management-key',
  '--proxy-url',
  '--no-proxy',
  '--strategy',
  '--codex-client-version',
  '--cooldown-ms',
  '--failure-threshold',
  '--upstream-timeout-ms',
  '--max-attempts',
  '--models-cache-ttl-ms',
  '--models-probe-accounts',
  '--codex-max-concurrency',
  '--gemini-max-concurrency',
  '--claude-max-concurrency',
  '--agy-max-concurrency',
  '--opencode-max-concurrency',
  '--queue-limit',
  '--session-affinity-ttl-ms',
  '--session-affinity-max',
  '--provider-cli-auto-upgrade',
  '--no-provider-cli-auto-upgrade',
  '--provider-cli-auto-upgrade-apply',
  '--no-provider-cli-auto-upgrade-apply',
  '--provider-cli-auto-upgrade-start-delay-ms',
  '--provider-cli-auto-upgrade-interval-ms',
  '--window-activation',
  '--no-window-activation',
  '--window-activation-default-interval-ms',
  '--window-activation-min-interval-ms',
  '--window-activation-tick-interval-ms',
  '--window-activation-start-delay-ms',
  '--window-activation-batch-size',
  '--window-activation-probe-timeout-ms',
  // Go aih-server binds the requested port and permits independent instances;
  // these two Node-only switches are already the Go behavior.
  '--strict-port',
  '--allow-multi'
]);

function resolveRepositoryRoot(deps = {}) {
  return path.resolve(String(deps.repositoryRoot || process.env.AIH_PACKAGE_ROOT || '').trim()
    || path.join(__dirname, '../../../..'));
}

function resolveWebDir(root, options = {}, deps = {}) {
  const candidates = [
    options.webDir,
    deps.webDir,
    process.env.AIH_WEB_DIR,
    process.env.AIH_PACKAGE_ROOT ? path.join(process.env.AIH_PACKAGE_ROOT, 'web', 'dist') : '',
    path.join(root, 'web', 'dist'),
    path.join(process.cwd(), 'web', 'dist')
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(String(candidate));
    if (fs.existsSync(path.join(resolved, 'index.html'))) return resolved;
  }
  throw new Error('serve_web_dir_missing: web/dist/index.html not found; refusing to start without the Go-hosted WebUI');
}

function explicitServeFlags(options = {}) {
  return Array.isArray(options._explicitFlags) ? options._explicitFlags.map(String) : [];
}

function boolFlag(value) {
  return value ? 'true' : 'false';
}

function setIfPresent(env, key, value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text) env[key] = text;
}

function buildGoServePlan(options = {}, deps = {}) {
  const explicit = explicitServeFlags(options);
  const explicitSet = new Set(explicit);
  const unsupported = explicit.filter((flag) => !SUPPORTED_SERVE_FLAGS.has(flag));
  if (unsupported.length > 0) {
    const error = new Error(
      'serve_options_not_ported: ' + unsupported.join(', ')
      + ' — Go aih-server 尚未支持这些 serve 选项；拒绝启动以免静默丢失。'
    );
    error.code = 'serve_options_not_ported';
    error.options = unsupported;
    throw error;
  }

  const host = String(options.host || '127.0.0.1').trim();
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('serve_host_not_loopback: Go aih-server only listens on loopback; refusing ' + host);
  }
  const root = resolveRepositoryRoot(deps);
  const command = String(deps.binaryPath || '').trim()
    || resolveGoServerBinary({ repositoryRoot: root, platform: deps.platform, arch: deps.arch });
  if (!fs.existsSync(command)) {
    throw new Error('serve_go_server_missing: ' + command);
  }
  const webDir = resolveWebDir(root, options, deps);

  const env = { ...(deps.env || process.env) };
  setIfPresent(env, 'AIH_HOME_DIR', options.aiHomeDir || deps.aiHomeDir || env.AIH_HOME_DIR
    || path.join(os.homedir(), '.ai_home'));
  env.AIH_PACKAGE_ROOT = String(env.AIH_PACKAGE_ROOT || root);
  setIfPresent(env, 'AIH_SERVER_HOST', host);
  setIfPresent(env, 'AIH_SERVER_PORT', options.port);
  setIfPresent(env, 'AIH_SERVER_API_KEY', options.clientKey);
  setIfPresent(env, 'AIH_SERVER_MANAGEMENT_KEY', options.managementKey);
  setIfPresent(env, 'AIH_SERVER_PROXY_URL', options.proxyUrl);
  setIfPresent(env, 'AIH_SERVER_NO_PROXY', options.noProxy);
  setIfPresent(env, 'AIH_SERVER_STRATEGY', options.strategy);
  setIfPresent(env, 'AIH_SERVER_CODEX_CLIENT_VERSION', options.codexClientVersion);
  env.AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE = options.providerCliAutoUpgrade ? '1' : '0';
  env.AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_APPLY = options.providerCliAutoUpgradeApply ? '1' : '0';
  setIfPresent(env, 'AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_START_DELAY_MS', options.providerCliAutoUpgradeStartDelayMs);
  setIfPresent(env, 'AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_INTERVAL_MS', options.providerCliAutoUpgradeIntervalMs);
  env.AIH_SERVER_WINDOW_ACTIVATION = options.windowActivation ? '1' : '0';
  setIfPresent(env, 'AIH_SERVER_WINDOW_ACTIVATION_DEFAULT_INTERVAL_MS', options.windowActivationDefaultIntervalMs);
  setIfPresent(env, 'AIH_SERVER_WINDOW_ACTIVATION_MIN_INTERVAL_MS', options.windowActivationMinIntervalMs);
  setIfPresent(env, 'AIH_SERVER_WINDOW_ACTIVATION_TICK_INTERVAL_MS', options.windowActivationTickIntervalMs);
  setIfPresent(env, 'AIH_SERVER_WINDOW_ACTIVATION_START_DELAY_MS', options.windowActivationStartDelayMs);
  setIfPresent(env, 'AIH_SERVER_WINDOW_ACTIVATION_BATCH_SIZE', options.windowActivationBatchSize);
  setIfPresent(env, 'AIH_SERVER_WINDOW_ACTIVATION_PROBE_TIMEOUT_MS', options.windowActivationProbeTimeoutMs);
  setIfPresent(env, 'AIH_SERVER_NODE_EXEC', deps.nodeExecPath);
  setIfPresent(env, 'AIH_SERVER_ENTRY_FILE', deps.entryFilePath);

  const args = [
    '--host', host,
    '--port', String(options.port),
    '--web-dir', webDir
  ];
  if (explicitSet.has('--cooldown-ms')) env.AIH_SERVER_COOLDOWN_MS = String(options.cooldownMs);
  if (explicitSet.has('--failure-threshold')) env.AIH_SERVER_FAILURE_THRESHOLD = String(options.failureThreshold);
  // serve keeps the Node defaults for these two even when the user does not
  // pass the flag; direct aih-server keeps its longer streaming defaults.
  env.AIH_SERVER_UPSTREAM_TIMEOUT_MS = String(options.upstreamTimeoutMs);
  env.AIH_SERVER_MAX_ATTEMPTS = String(options.maxAttempts);
  env.AIH_SERVER_MODELS_CACHE_TTL_MS = String(options.modelsCacheTtlMs);
  env.AIH_SERVER_MODELS_PROBE_ACCOUNTS = String(options.modelsProbeAccounts);
  env.AIH_SERVER_CODEX_MAX_CONCURRENCY = String(options.codexMaxConcurrency);
  env.AIH_SERVER_GEMINI_MAX_CONCURRENCY = String(options.geminiMaxConcurrency);
  env.AIH_SERVER_CLAUDE_MAX_CONCURRENCY = String(options.claudeMaxConcurrency);
  env.AIH_SERVER_AGY_MAX_CONCURRENCY = String(options.agyMaxConcurrency);
  env.AIH_SERVER_OPENCODE_MAX_CONCURRENCY = String(options.opencodeMaxConcurrency);
  env.AIH_SERVER_QUEUE_LIMIT = String(options.queueLimit);
  env.AIH_SERVER_SESSION_AFFINITY_TTL_MS = String(options.sessionAffinityTtlMs);
  env.AIH_SERVER_SESSION_AFFINITY_MAX = String(options.sessionAffinityMaxEntries);
  if (deps.enableCodexCliHook === true) args.push('--enable-codex-cli-hook');
  if (deps.enableCodexDesktopAppHook === true) args.push('--enable-codex-desktop-hook');
  args.push('--codex-cli-hook-self-heal-interval-ms', String(options.codexCliHookSelfHealIntervalMs));
  args.push('--codex-desktop-hook-self-heal-interval-ms', String(options.codexDesktopHookSelfHealIntervalMs));
  if (String(options.codexDesktopTraceFile || '').trim()) {
    args.push('--codex-desktop-trace-file', String(options.codexDesktopTraceFile).trim());
  }
  args.push('--codex-desktop-trace-responses=' + boolFlag(options.codexDesktopTraceResponses));
  args.push('--codex-desktop-trace-remote-control=' + boolFlag(options.codexDesktopTraceRemoteControl));
  args.push('--codex-desktop-remote-control-proxy=' + boolFlag(options.codexDesktopRemoteControlProxy));
  args.push('--codex-desktop-restart-app-server-on-hook-change=' + boolFlag(options.codexDesktopRestartAppServerOnHookChange));

  return { command, args, env, webDir };
}

function probeAihServer(host, port) {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: '/healthz', timeout: 500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        resolve(response.statusCode === 200 && body.includes('"service":"aih-server"'));
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function runGoServe(options = {}, deps = {}) {
  const plan = buildGoServePlan(options, deps);
  if (String(process.env.AIH_SERVE_PRINT_PLAN || '') === '1') {
    console.log(JSON.stringify({ command: plan.command, args: plan.args, webDir: plan.webDir }, null, 2));
    return;
  }
  const host = String(options.host || '127.0.0.1').trim();
  if (options.allowMulti !== true && await probeAihServer(host, options.port)) {
    // 与旧 Node 入口的 server_already_running 幂等语义保持一致：
    // 默认自启已在跑时，手动 `aih server serve` 跳过而不是制造第二个网关。
    console.log(`[aih] server already running on ${host}:${options.port}; skip this instance`);
    return;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      stdio: 'inherit',
      env: plan.env
    });
    const forward = (signal) => {
      try { child.kill(signal); } catch (_error) {}
    };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    const cleanup = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      if (code === 0 || signal) {
        resolve();
        return;
      }
      reject(new Error('serve_go_server_exit: ' + code));
    });
  });
}

module.exports = {
  SUPPORTED_SERVE_FLAGS,
  buildGoServePlan,
  runGoServe
};
