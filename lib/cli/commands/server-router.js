'use strict';

const { runServerCommand } = require('../../server/command-handler');
const {
  formatServerProfileResult,
  runServerProfileCommand
} = require('../services/server/profile-command');

function buildServerDaemonAdapter(deps) {
  return {
    status: deps.getServerDaemonStatus,
    autostartStatus: deps.getServerAutostartStatus,
    installAutostart: deps.installServerAutostart,
    uninstallAutostart: deps.uninstallServerAutostart,
    stop: deps.stopServerDaemon,
    start: deps.startServerDaemon,
    restart: deps.restartServerDaemon
  };
}

function runServerCommandRouter(args, deps = {}) {
  const processImpl = deps.processImpl || process;

  runServerCommand(args, {
    showServerUsage: deps.showServerUsage,
    serverDaemon: buildServerDaemonAdapter(deps),
    parseServerEnvArgs: deps.parseServerEnvArgs,
    parseServerServeArgs: deps.parseServerServeArgs,
    parseServerSyncArgs: deps.parseServerSyncArgs,
    startLocalServer: deps.startLocalServer,
    syncCodexAccountsToServer: deps.syncCodexAccountsToServer,
    readServerConfig: deps.readServerConfig,
    writeServerConfig: deps.writeServerConfig,
    runServerProfileCommand: deps.runServerProfileCommand || ((action, args) => runServerProfileCommand(action, args, {
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir
    })),
    formatServerProfileResult: deps.formatServerProfileResult || formatServerProfileResult
  }).then((code) => {
    if (typeof code === 'number') {
      processImpl.exit(code);
    }
  }).catch((error) => {
    console.error(`\x1b[31m[aih] server failed: ${error.message}\x1b[0m`);
    processImpl.exit(1);
  });
}

module.exports = {
  runServerCommandRouter
};
