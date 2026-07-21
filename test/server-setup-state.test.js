const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function compileTypeScript(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;
}

function loadServerSetupState() {
  const filename = path.join(__dirname, '../web/src/services/server-setup-state.ts');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request === './control-plane-profiles') {
      return {
        isAutoCurrentControlPlaneProfile: (profile) => profile?.autoCurrent === true,
        normalizeControlPlaneEndpoint: (value) => String(value || '').replace(/\/+$/u, '')
      };
    }
    if (request === './control-plane-selection') {
      return {
        resolveStoredActiveControlPlaneProfile: (profiles, activeProfileId) => {
          const profile = profiles.find((item) => item.id === activeProfileId) || profiles[0] || null;
          return { profile, profileId: profile?.id || '', source: profile ? 'stored' : 'none' };
        }
      };
    }
    return originalRequire(request);
  };
  mod._compile(compileTypeScript(filename), filename);
  return mod.exports;
}

function profile(id, endpoint, overrides = {}) {
  return { id, name: id, endpoint, ...overrides };
}

test('only an empty or auto-created browser profile forces the initial connection dialog', () => {
  const setup = loadServerSetupState();
  assert.deepEqual(setup.resolveRequiredServerSetupDialog([], ''), {
    mode: 'initial',
    profileId: ''
  });

  const local = profile('local', 'http://127.0.0.1:9527', { autoCurrent: true });
  assert.deepEqual(setup.resolveRequiredServerSetupDialog([local], 'local'), {
    mode: 'initial',
    profileId: 'local'
  });

  const aws = profile('aws', 'https://aws.example.com');
  assert.equal(setup.resolveRequiredServerSetupDialog([local, aws], 'aws'), null);
  assert.equal(setup.resolveRequiredServerSetupDialog([aws], 'aws'), null);
});

test('authorization uses the selected Server endpoint while adding starts blank', () => {
  const setup = loadServerSetupState();
  const local = profile('local', 'http://127.0.0.1:9527');
  const aws = profile('aws', 'https://aws.example.com', { name: 'AWS Tokyo' });

  assert.deepEqual(setup.resolveServerSetupFormDefaults({
    dialog: { mode: 'authorize', profileId: 'aws' },
    profiles: [local, aws],
    browserEndpoint: 'http://127.0.0.1:9527'
  }), {
    endpoint: 'https://aws.example.com',
    name: 'AWS Tokyo'
  });
  assert.deepEqual(setup.resolveServerSetupFormDefaults({
    dialog: { mode: 'add', profileId: '' },
    profiles: [local, aws],
    browserEndpoint: 'http://127.0.0.1:9527'
  }), {
    endpoint: '',
    name: 'AIH Server'
  });
});

test('Server setup page exposes switching and per-Server authorization behind the gate', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../web/src/pages/FabricServerSetup.tsx'),
    'utf8'
  );
  assert.match(source, /resolveRequiredServerSetupDialog/u);
  assert.match(source, /openServerAuthorization/u);
  assert.match(source, />\s*设为当前\s*</u);
  assert.match(source, />\s*授权\s*</u);
  assert.match(source, /closable=\{!setupModalRequired\}/u);
});
