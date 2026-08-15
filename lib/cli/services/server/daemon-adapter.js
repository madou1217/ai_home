'use strict';

function createServerDaemonAdapter(serverDaemonService) {
  return {
    start: (rawServeArgs, startOptions) => serverDaemonService.start(rawServeArgs, startOptions),
    restart: (rawServeArgs, restartOptions) => serverDaemonService.restart(rawServeArgs, restartOptions),
    stop: (stopOptions) => serverDaemonService.stop(stopOptions),
    startGoCore: (startOptions) => serverDaemonService.startGoCore(startOptions),
    stopGoCore: (stopOptions) => serverDaemonService.stopGoCore(stopOptions),
    goCoreStatus: () => serverDaemonService.getGoCoreStatus(),
    status: () => serverDaemonService.getStatus(),
    autostartStatus: () => serverDaemonService.getAutostartStatus(),
    installAutostart: () => serverDaemonService.installAutostart(),
    uninstallAutostart: () => serverDaemonService.uninstallAutostart()
  };
}

module.exports = {
  createServerDaemonAdapter
};
