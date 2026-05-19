'use strict';

function createServerDaemonAdapter(serverDaemonService) {
  return {
    start: (rawServeArgs, startOptions) => serverDaemonService.start(rawServeArgs, startOptions),
    stop: (stopOptions) => serverDaemonService.stop(stopOptions),
    status: (statusOptions) => serverDaemonService.getStatus(statusOptions),
    autostartStatus: () => serverDaemonService.getAutostartStatus(),
    installAutostart: () => serverDaemonService.installAutostart(),
    uninstallAutostart: () => serverDaemonService.uninstallAutostart()
  };
}

module.exports = {
  createServerDaemonAdapter
};
