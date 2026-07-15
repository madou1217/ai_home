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

function loadNativeControlPlaneProfiles(nativeRepository) {
  const filename = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'services',
    'control-plane-profiles.ts'
  );
  const previousTsLoader = require.extensions['.ts'];
  require.extensions['.ts'] = (mod, moduleFilename) => {
    mod._compile(compileTypeScript(moduleFilename), moduleFilename);
  };
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request === './webui-auth-transport') {
      return { resolveWebUiManagementKey: () => '' };
    }
    if (request === './native-server-profile-repository') {
      return {
        isNativeDesktopRuntime: () => true,
        ...nativeRepository
      };
    }
    if (request === './native-server-transport') {
      return {
        isNativeServerTransportAvailable: () => false,
        openNativeServerSse: async () => {
          throw new Error('unexpected_native_stream');
        },
        requestNativeServerJson: async () => {
          throw new Error('unexpected_native_request');
        }
      };
    }
    return originalRequire(request);
  };
  try {
    mod._compile(compileTypeScript(filename), filename);
    return mod.exports;
  } finally {
    if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
    else delete require.extensions['.ts'];
  }
}

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function installNativeWindow(t) {
  const previousWindow = global.window;
  const eventTarget = new EventTarget();
  const storage = createStorage();
  global.window = Object.assign(eventTarget, {
    __TAURI_IPC__: () => {},
    localStorage: storage,
    location: { origin: 'tauri://localhost' }
  });
  t.after(() => {
    global.window = previousWindow;
  });
  return storage;
}

test('native profile initialization projects Keyring metadata without exposing the key', async (t) => {
  const storage = installNativeWindow(t);
  const activeChanges = [];
  const nativeSummary = {
    id: 'server-aws',
    name: 'AWS',
    endpoint: 'https://aws.example.com',
    credentialRef: 'profile:server-aws',
    managementKeyConfigured: true,
    metadata: {
      state: 'ready',
      managementKey: 'must-never-enter-the-renderer-cache',
      nodeCount: 2,
      lastError: ''
    },
    createdAt: 10,
    updatedAt: 20
  };
  const profiles = loadNativeControlPlaneProfiles({
    listNativeServerProfiles: async () => ({
      profiles: [nativeSummary],
      activeProfileId: ''
    }),
    setActiveNativeServerProfile: async (profileId) => {
      activeChanges.push(profileId);
      return { activeProfileId: profileId, profile: nativeSummary };
    },
    upsertNativeServerProfile: async () => {
      throw new Error('unexpected_upsert');
    },
    removeNativeServerProfile: async () => {
      throw new Error('unexpected_remove');
    }
  });

  const initialized = await profiles.initializeNativeControlPlaneProfiles();
  const cached = JSON.parse(storage.getItem('aih:control-plane-profiles:v1'));

  assert.equal(initialized.activeProfileId, 'server-aws');
  assert.deepEqual(activeChanges, ['server-aws']);
  assert.equal(initialized.profiles[0].managementKey, '');
  assert.equal(initialized.profiles[0].managementKeyConfigured, true);
  assert.equal(initialized.profiles[0].credentialRef, 'profile:server-aws');
  assert.equal(cached[0].managementKey, '');
  assert.equal(JSON.stringify(cached).includes('must-never-enter-the-renderer-cache'), false);
});

test('native secure profile save sends the entered key once and caches only credential metadata', async (t) => {
  const storage = installNativeWindow(t);
  const upserts = [];
  const profiles = loadNativeControlPlaneProfiles({
    listNativeServerProfiles: async () => ({ profiles: [], activeProfileId: '' }),
    setActiveNativeServerProfile: async () => ({ activeProfileId: '', profile: null }),
    removeNativeServerProfile: async () => ({ removed: false, activeProfileId: '' }),
    upsertNativeServerProfile: async (input) => {
      upserts.push(input);
      return {
        id: input.id,
        name: input.name,
        endpoint: input.endpoint,
        credentialRef: `profile:${input.id}`,
        managementKeyConfigured: true,
        metadata: input.metadata,
        createdAt: 30,
        updatedAt: 30
      };
    }
  });

  const saved = await profiles.saveControlPlaneProfileSecure({
    name: 'Home',
    endpoint: 'https://home.example.com',
    state: 'offline',
    managementKey: 'entered-management-key',
    nodes: Array.from({ length: 100 }, (_, index) => ({
      id: `node-${index}`,
      name: `Node ${index}`,
      transports: [{ kind: 'relay', endpoint: `https://relay-${index}.example.com` }]
    }))
  });
  const rawCache = String(storage.getItem('aih:control-plane-profiles:v1') || '');

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].managementKey, 'entered-management-key');
  assert.equal(JSON.stringify(upserts[0].metadata).includes('entered-management-key'), false);
  assert.equal(Object.hasOwn(upserts[0].metadata, 'nodes'), false);
  assert.equal(saved.managementKey, '');
  assert.equal(saved.managementKeyConfigured, true);
  assert.equal(rawCache.includes('entered-management-key'), false);
  assert.equal(JSON.parse(rawCache)[0].credentialRef, `profile:${saved.id}`);
});
