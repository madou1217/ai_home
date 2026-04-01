'use strict';

function createServerDaemonAdapter(serverDaemonService) {
  return {
    start: (rawServeArgs) => serverDaemonService.start(rawServeArgs),
    stop: () => serverDaemonService.stop(),
    status: () => serverDaemonService.getStatus(),
    autostartStatus: () => serverDaemonService.getAutostartStatus(),
    installAutostart: () => serverDaemonService.installAutostart(),
    uninstallAutostart: () => serverDaemonService.uninstallAutostart()
  };
}

module.exports = {
  createServerDaemonAdapter
};
