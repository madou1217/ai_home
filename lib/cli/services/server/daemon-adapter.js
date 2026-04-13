'use strict';

function createServerDaemonAdapter(serverDaemonService) {
  return {
    start: (rawServeArgs, startOptions) => serverDaemonService.start(rawServeArgs, startOptions),
    stop: (stopOptions) => serverDaemonService.stop(stopOptions),
    status: () => serverDaemonService.getStatus(),
    autostartStatus: () => serverDaemonService.getAutostartStatus(),
    installAutostart: () => serverDaemonService.installAutostart(),
    uninstallAutostart: () => serverDaemonService.uninstallAutostart()
  };
}

module.exports = {
  createServerDaemonAdapter
};
