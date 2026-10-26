'use strict';
const path = require('node:path');
const directory = require('./native-plugin-adapters/directory');
const { resolveProviderNativeRoot } = require('../runtime/provider-storage-policy');
const ADAPTERS = Object.freeze({
  'native-directory': directory,
  'cordis-patch': require('./native-plugin-adapters/cordis-patch'),
  'native-marketplace': require('./native-plugin-adapters/native-marketplace'),
  'claude-skills-dir': { ...directory, target: (ctx, id) => path.join(resolveProviderNativeRoot(ctx.hostHomeDir, ctx.provider), 'skills', id) },
  'opencode-local': require('./native-plugin-adapters/opencode'),
  'codex-marketplace': require('./native-plugin-adapters/codex')
});
module.exports = { ADAPTERS };
