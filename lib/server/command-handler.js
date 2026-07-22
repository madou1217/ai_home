'use strict';

const { runServerConfigCommand } = require('./server-config-command');
const { buildServerBaseUrl } = require('./server-defaults');
const { BACKGROUND_RESTART_ENV } = require('./source-auto-restart');

function formatResultBaseUrl(result) {
  return String(result && result.baseUrl || buildServerBaseUrl({ port: result && result.port })).trim();
}

function readServerApiKeyConfigured(readServerConfig) {
  if (typeof readServerConfig !== 'function') return false;
  try {
    const config = readServerConfig() || {};
    return Boolean(String(config.apiKey || '').trim());
  } catch (_error) {
    return false;
  }
}

function printServerApiKeyStatus(readServerConfig) {
  console.log(`  api_key: ${readServerApiKeyConfigured(readServerConfig) ? 'configured' : 'missing'}`);
}

function readStoredServerConfig(readServerConfig) {
  if (typeof readServerConfig !== 'function') return {};
  try {
    return readServerConfig() || {};
  } catch (_error) {
    return {};
  }
}

function applyStoredServerConfigToServeOptions(serveOpts, readServerConfig) {
  const options = { ...(serveOpts || {}) };
  const stored = readStoredServerConfig(readServerConfig);
  const apiKey = String(stored.apiKey || '').trim();
  const managementKey = String(stored.managementKey || '').trim();
  const proxyUrl = String(stored.proxyUrl || '').trim();
  const noProxy = String(stored.noProxy || '').trim();

  if (!String(options.clientKey || '').trim() && apiKey) {
    options.clientKey = apiKey;
    options.clientKeySource = 'server-config';
  }
  if (!String(options.managementKey || '').trim() && managementKey) {
    options.managementKey = managementKey;
    options.managementKeySource = 'server-config';
  }
  if (!String(options.proxyUrl || '').trim() && proxyUrl) {
    options.proxyUrl = proxyUrl;
  }
  if (!String(options.noProxy || '').trim() && noProxy) {
    options.noProxy = noProxy;
  }
  return options;
}

function restartNeedsElevation(result) {
  const stopped = result && result.stoppedForRestart;
  if (!stopped) return false;
  if (stopped.reason === 'permission_denied') return true;
  return Array.isArray(stopped.stoppedServers)
    && stopped.stoppedServers.some((item) => item && item.reason === 'permission_denied');
}

function isBackgroundRestart(processObj) {
  const env = processObj && processObj.env ? processObj.env : process.env;
  return String(env && env[BACKGROUND_RESTART_ENV] || '') === '1';
}

async function runServerCommand(args, deps) {
  const action = String(args[1] || '').trim();
  const showServerUsage = deps.showServerUsage;
  const serverDaemon = deps.serverDaemon;
  const parseServerEnvArgs = deps.parseServerEnvArgs;
  const parseServerServeArgs = deps.parseServerServeArgs;
  const parseServerSyncArgs = deps.parseServerSyncArgs;
  const startLocalServer = deps.startLocalServer;
  const syncCodexAccountsToServer = deps.syncCodexAccountsToServer;
  const readServerConfig = deps.readServerConfig;
  const writeServerConfig = deps.writeServerConfig;
  const generateManagementKey = deps.generateManagementKey;
  const runServerProfileCommand = deps.runServerProfileCommand;
  const formatServerProfileResult = deps.formatServerProfileResult;
  const elevateServerRestart = deps.elevateServerRestart;
  const processObj = deps.processObj || process;

  if (action === 'help' || action === '--help' || action === '-h') {
    showServerUsage();
    return 0;
  }

  if (['add', 'ls', 'list', 'use', 'remove', 'rm'].includes(action)) {
    if (typeof runServerProfileCommand !== 'function') {
      console.error('\x1b[31m[aih] server profile management is unavailable\x1b[0m');
      return 1;
    }
    try {
      const result = await Promise.resolve(runServerProfileCommand(action, args.slice(2)));
      if (result.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(formatServerProfileResult(result));
      }
      return result.ok === false ? 1 : 0;
    } catch (error) {
      console.error(`\x1b[31m[aih] server ${action} failed: ${error.message}\x1b[0m`);
      return 1;
    }
  }

  if (action === 'status') {
    if (args.length > 2) {
      console.error('\x1b[31m[aih] server status does not accept serve options\x1b[0m');
      return 1;
    }
    const st = serverDaemon.status();
    if (st.running) {
      const stateLabel = st.ready === false || st.state === 'starting' ? 'starting' : 'running';
      console.log(`\x1b[36m[aih]\x1b[0m server is ${stateLabel} (pid=${st.pid})`);
      console.log(`  base_url: ${formatResultBaseUrl(st)}`);
      printServerApiKeyStatus(readServerConfig);
      if (typeof st.ready === 'boolean') {
        console.log(`  ready: ${st.ready}`);
      }
      if (st.stale) {
        console.log(`  stale: true (${st.staleReason || 'source_changed'})`);
        console.log('  action: aih server restart');
      }
      console.log(`  pid_file: ${st.pidFile}`);
      console.log(`  log_file: ${st.logFile}`);
      if (st.entryFilePath) {
        console.log(`  entry: ${st.entryFilePath}`);
      }
    } else {
      console.log('\x1b[90m[aih]\x1b[0m server is not running');
    }
    const auto = serverDaemon.autostartStatus();
    if (auto.supported) {
      console.log(`  autostart: type=${auto.type || 'unknown'} installed=${auto.installed} loaded=${auto.loaded}`);
    } else {
      console.log('  autostart: unsupported_on_this_platform');
    }
    return 0;
  }

  if (action === 'autostart') {
    const sub = String(args[2] || 'status').trim().toLowerCase();
    try {
      if (sub === 'install') {
        serverDaemon.installAutostart();
        console.log(`\x1b[32m[aih]\x1b[0m server autostart installed`);
        return 0;
      }
      if (sub === 'uninstall' || sub === 'remove') {
        serverDaemon.uninstallAutostart();
        console.log(`\x1b[32m[aih]\x1b[0m server autostart removed`);
        return 0;
      }
      const st = serverDaemon.autostartStatus();
      if (!st.supported) {
        console.log('\x1b[90m[aih]\x1b[0m autostart is unsupported on this platform');
        return 0;
      }
      console.log(`\x1b[36m[aih]\x1b[0m server autostart status`);
      console.log(`  type: ${st.type || 'unknown'}`);
      console.log(`  installed: ${st.installed}`);
      console.log(`  loaded: ${st.loaded}`);
      if (typeof st.enabled === 'boolean') {
        console.log(`  enabled: ${st.enabled}`);
      }
      if (typeof st.active === 'boolean') {
        console.log(`  active: ${st.active}`);
      }
      if (st.file) {
        console.log(`  file: ${st.file}`);
      }
      if (st.label) {
        console.log(`  label: ${st.label}`);
      }
      if (st.unit) {
        console.log(`  unit: ${st.unit}`);
      }
      return 0;
    } catch (e) {
      console.error(`\x1b[31m[aih] server autostart failed: ${e.message}\x1b[0m`);
      return 1;
    }
  }

  if (action === 'config') {
    return runServerConfigCommand(args.slice(2), { readServerConfig, writeServerConfig, generateManagementKey });
  }

  if (action === 'stop') {
    if (args.length > 2) {
      console.error('\x1b[31m[aih] server stop does not accept serve options\x1b[0m');
      return 1;
    }
    const res = serverDaemon.stop();
    if (res.stopped) {
      console.log(`\x1b[32m[aih]\x1b[0m server stopped (pid=${res.pid})${res.forced ? ' [forced]' : ''}`);
      return 0;
    }
    console.log(`\x1b[90m[aih]\x1b[0m server stop skipped (${res.reason || 'not_running'})`);
    return 0;
  }

  if (action === 'start' || !action || action.startsWith('-')) {
    if (args.length > (action === 'start' ? 2 : 1)) {
      console.error('\x1b[31m[aih] server start does not accept serve options; update server config first\x1b[0m');
      return 1;
    }
    try {
      const result = await serverDaemon.start([], {
        waitForReady: false,
        readyTimeoutMs: 7000
      });
      if (result.alreadyRunning && result.ready === false) {
        console.log(`\x1b[90m[aih]\x1b[0m server already starting (pid=${result.pid})`);
      } else if (result.alreadyRunning) {
        console.log(`\x1b[90m[aih]\x1b[0m server already running (pid=${result.pid})`);
      } else if (result.started) {
        const label = result.ready === false ? 'server starting in background' : 'server started in background';
        console.log(`\x1b[32m[aih]\x1b[0m ${label} (pid=${result.pid})`);
      } else {
        console.log(`\x1b[33m[aih]\x1b[0m server process created (pid=${result.pid}), but health check timed out`);
      }
      console.log(`  base_url: ${formatResultBaseUrl(result)}`);
      printServerApiKeyStatus(readServerConfig);
      return 0;
    } catch (e) {
      console.error(`\x1b[31m[aih] server start failed: ${e.message}\x1b[0m`);
      return 1;
    }
  }

  if (action === 'restart') {
    if (args.length > 2) {
      console.error('\x1b[31m[aih] server restart does not accept serve options; update server config first\x1b[0m');
      return 1;
    }
    try {
      if (typeof serverDaemon.restart !== 'function') {
        throw new Error('server restart service is not wired');
      }
      const result = await serverDaemon.restart([], {
        waitForReady: false,
        readyTimeoutMs: 7000,
        gracefulStopWaitMs: 500
      });
      if (restartNeedsElevation(result)) {
        if (isBackgroundRestart(processObj)) {
          return 1;
        }
        if (typeof elevateServerRestart !== 'function') {
          console.error('\x1b[31m[aih] server restart requires administrator permission\x1b[0m');
          return 1;
        }
        console.log('\x1b[90m[aih]\x1b[0m administrator permission is required; opening UAC...');
        const elevated = await Promise.resolve(elevateServerRestart());
        if (!elevated || elevated.ok !== true) {
          const reason = elevated && elevated.reason ? elevated.reason : 'elevation_failed';
          console.error(`\x1b[31m[aih] elevated server restart failed: ${reason}\x1b[0m`);
          return 1;
        }
        console.log('\x1b[32m[aih]\x1b[0m server restarted with administrator permission');
        return 0;
      }
      const stopped = result.stoppedForRestart || {};
      if (stopped.stopped) {
        console.log(`\x1b[90m[aih]\x1b[0m server stopped for restart (pid=${stopped.pid})`);
      }
      if (result.alreadyRunning && result.ready === false) {
        console.log(`\x1b[90m[aih]\x1b[0m server already starting (pid=${result.pid})`);
      } else if (result.alreadyRunning) {
        console.log(`\x1b[90m[aih]\x1b[0m server already running (pid=${result.pid})`);
      } else if (result.started) {
        const label = result.ready === false ? 'server restarting in background' : 'server restarted in background';
        console.log(`\x1b[32m[aih]\x1b[0m ${label} (pid=${result.pid})`);
      } else {
        console.log(`\x1b[33m[aih]\x1b[0m server process created (pid=${result.pid}), but health check timed out`);
      }
      console.log(`  base_url: ${formatResultBaseUrl(result)}`);
      printServerApiKeyStatus(readServerConfig);
      if (result.entryFilePath) {
        console.log(`  entry: ${result.entryFilePath}`);
      }
      return 0;
    } catch (e) {
      console.error(`\x1b[31m[aih] server restart failed: ${e.message}\x1b[0m`);
      return 1;
    }
  }

  if (action === 'env') {
    let envOpts;
    try {
      envOpts = parseServerEnvArgs(args.slice(2));
    } catch (e) {
      console.error(`\x1b[31m[aih] ${e.message}\x1b[0m`);
      console.log('\x1b[90mUsage:\x1b[0m aih server env [--base-url <url>] [--api-key <key>]');
      return 1;
    }
    console.log(`export OPENAI_BASE_URL="${envOpts.baseUrl}"`);
    console.log(`export OPENAI_API_KEY="${envOpts.apiKey}"`);
    return 0;
  }

  if (action === 'serve') {
    let serveOpts;
    try {
      const serveArgs = (action === 'serve') ? args.slice(2) : args.slice(1);
      serveOpts = applyStoredServerConfigToServeOptions(
        parseServerServeArgs(serveArgs),
        readServerConfig
      );
    } catch (e) {
      console.error(`\x1b[31m[aih] ${e.message}\x1b[0m`);
      console.log('\x1b[90mUsage:\x1b[0m aih server serve [options]');
      return 1;
    }
    try {
      await startLocalServer(serveOpts);
      return null;
    } catch (e) {
      console.error(`\x1b[31m[aih] server serve failed: ${e.message}\x1b[0m`);
      return 1;
    }
  }

  if (action === 'sync-codex' || action === 'sync_codex') {
    let syncOpts;
    try {
      syncOpts = parseServerSyncArgs(args.slice(2));
    } catch (e) {
      console.error(`\x1b[31m[aih] ${e.message}\x1b[0m`);
      console.log('\x1b[90mUsage:\x1b[0m aih server sync-codex [--management-url <url>] [--key <management-key>] [--parallel <1-32>] [--limit <n>] [--dry-run]');
      return 1;
    }
    try {
      const result = await syncCodexAccountsToServer(syncOpts);
      const modeLabel = result.dryRun ? 'dry-run' : 'write';
      console.log(`\x1b[36m[aih]\x1b[0m server sync-codex done (${modeLabel})`);
      console.log(`  management: ${result.managementUrl}`);
      console.log(`  scanned: ${result.scanned}`);
      console.log(`  eligible: ${result.eligible}`);
      console.log(`  uploaded: ${result.uploaded}`);
      console.log(`  invalid: ${result.skippedInvalid}`);
      if (!result.dryRun) {
        console.log(`  failed: ${result.failed}`);
        if (result.firstError) {
          console.log(`  first_error: ${result.firstError}`);
        }
      }
      return result.failed > 0 ? 1 : 0;
    } catch (e) {
      console.error(`\x1b[31m[aih] server sync-codex failed: ${e.message}\x1b[0m`);
      return 1;
    }
  }

  console.error(`\x1b[31m[aih] Unknown server action '${action}'.\x1b[0m`);
  showServerUsage();
  return 1;
}

module.exports = {
  applyStoredServerConfigToServeOptions,
  isBackgroundRestart,
  readServerApiKeyConfigured,
  restartNeedsElevation,
  runServerCommand
};
