'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('../web/node_modules/typescript');

const projectRoot = path.join(__dirname, '..');

function compileTypeScript(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;
}

function loadLanRefresh(dependencies) {
  const filename = path.join(
    projectRoot,
    'web/src/services/server-routes/native-lan-route-refresh.ts'
  );
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request === '../native-server-profile-repository') return dependencies;
    return originalRequire(request);
  };
  mod._compile(compileTypeScript(filename), filename);
  return mod.exports;
}

test('automatic LAN refresh passes only authorized native profile ids', async () => {
  const calls = [];
  const service = loadLanRefresh({
    isNativeDesktopRuntime: () => true,
    listNativeServerProfiles: async () => ({
      activeProfileId: 'home',
      profiles: [
        { id: 'home', managementKeyConfigured: true },
        { id: 'pending', managementKeyConfigured: false },
        { id: 'aws', managementKeyConfigured: true }
      ]
    }),
    refreshNativeLanRoutes: async (profileIds, timeoutMs) => {
      calls.push({ profileIds, timeoutMs });
      return { ok: true, partial: false, profiles: [] };
    }
  });

  await service.refreshAuthorizedNativeLanRoutes(2_500);

  assert.deepEqual(calls, [{ profileIds: ['home', 'aws'], timeoutMs: 2_500 }]);
  assert.doesNotMatch(JSON.stringify(calls), /https?:|endpoint|path|authorization|bearer/iu);
});
