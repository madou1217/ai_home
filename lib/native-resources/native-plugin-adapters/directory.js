'use strict';
const path = require('node:path');
const { resolveProviderNativeRoot } = require('../../runtime/provider-storage-policy');
const { requireMcp } = require('../mcp-errors');
const { ensureOwned, removeOwned, directoryStatus } = require('../native-plugin-files');
module.exports = {
  target(ctx, id) {
    const root = ctx.capability.pathBase === 'host-home' ? ctx.hostHomeDir : resolveProviderNativeRoot(ctx.hostHomeDir, ctx.provider);
    const relative = ctx.capability.paths[0];
    requireMcp(root && relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), 'native_plugin_path_invalid');
    return path.join(root, relative, id);
  },
  install(ctx, pkg, record, previous) {
    ensureOwned(pkg, record, previous);
    return { status: 'projected' };
  },
  disable(_ctx, _pkg, record) { removeOwned(record); },
  inspect(_ctx, record) { return directoryStatus(record); }
};
