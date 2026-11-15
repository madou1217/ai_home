'use strict';

// Compatibility API only; socket framing and caller-owned provider lifecycle
// are implemented by the native Go local app-server host.
const policy = require('./codex-tui-local-policy');
const { startNativeLocalAppServer } = require('./codex-local-app-server-launcher');

module.exports = { ...policy, startCodexTuiLocalAppServer: startNativeLocalAppServer };
