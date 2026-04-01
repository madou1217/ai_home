'use strict';

async function runServerCommand(args, deps) {
  const action = String(args[1] || '').trim();
  const showServerUsage = deps.showServerUsage;
  const serverDaemon = deps.serverDaemon;
  const parseServerEnvArgs = deps.parseServerEnvArgs;
  const parseServerServeArgs = deps.parseServerServeArgs;
  const parseServerSyncArgs = deps.parseServerSyncArgs;
  const startLocalServer = deps.startLocalServer;
  const syncCodexAccountsToServer = deps.syncCodexAccountsToServer;

  if (action === 'help' || action === '--help' || action === '-h') {
    showServerUsage();
    return 0;
  }

  if (action === 'status') {
    const st = serverDaemon.status();
    if (st.running) {
      console.log(`\x1b[36m[aih]\x1b[0m server is running (pid=${st.pid})`);
      console.log('  base_url: http://127.0.0.1:8317/v1');
      console.log('  api_key: dummy');
      console.log(`  pid_file: ${st.pidFile}`);
      console.log(`  log_file: ${st.logFile}`);
    } else {
      console.log('\x1b[90m[aih]\x1b[0m server is not running');
    }
    const auto = serverDaemon.autostartStatus();
    if (auto.supported) {
      console.log(`  autostart: installed=${auto.installed} loaded=${auto.loaded}`);
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
      console.log(`  installed: ${st.installed}`);
      console.log(`  loaded: ${st.loaded}`);
      console.log(`  plist: ${st.plist}`);
      return 0;
    } catch (e) {
      console.error(`\x1b[31m[aih] server autostart failed: ${e.message}\x1b[0m`);
      return 1;
    }
  }

  if (action === 'stop') {
    const res = serverDaemon.stop();
    if (res.stopped) {
      console.log(`\x1b[32m[aih]\x1b[0m server stopped (pid=${res.pid})${res.forced ? ' [forced]' : ''}`);
      return 0;
    }
    console.log(`\x1b[90m[aih]\x1b[0m server stop skipped (${res.reason || 'not_running'})`);
    return 0;
  }

  if (action === 'start' || !action || action.startsWith('-')) {
    try {
      const serveArgs = action === 'start' ? args.slice(2) : args.slice(1);
      const result = await serverDaemon.start(serveArgs);
      if (result.alreadyRunning) {
        console.log(`\x1b[90m[aih]\x1b[0m server already running (pid=${result.pid})`);
      } else if (result.started) {
        console.log(`\x1b[32m[aih]\x1b[0m server started in background (pid=${result.pid})`);
      } else {
        console.log(`\x1b[33m[aih]\x1b[0m server process created (pid=${result.pid}), but health check timed out`);
      }
      console.log('  base_url: http://127.0.0.1:8317/v1');
      console.log('  api_key: dummy');
      return 0;
    } catch (e) {
      console.error(`\x1b[31m[aih] server start failed: ${e.message}\x1b[0m`);
      return 1;
    }
  }

  if (action === 'restart') {
    const stopped = serverDaemon.stop();
    if (stopped.stopped) {
      console.log(`\x1b[90m[aih]\x1b[0m server stopped for restart (pid=${stopped.pid})`);
    }
    try {
      const result = await serverDaemon.start(args.slice(2));
      if (result.alreadyRunning) {
        console.log(`\x1b[90m[aih]\x1b[0m server already running (pid=${result.pid})`);
      } else if (result.started) {
        console.log(`\x1b[32m[aih]\x1b[0m server restarted in background (pid=${result.pid})`);
      } else {
        console.log(`\x1b[33m[aih]\x1b[0m server process created (pid=${result.pid}), but health check timed out`);
      }
      console.log('  base_url: http://127.0.0.1:8317/v1');
      console.log('  api_key: dummy');
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
      serveOpts = parseServerServeArgs(serveArgs);
    } catch (e) {
      console.error(`\x1b[31m[aih] ${e.message}\x1b[0m`);
      console.log('\x1b[90mUsage:\x1b[0m aih server [--port <n>]  (or: aih server serve [options])');
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
  runServerCommand
};
