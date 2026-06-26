const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function compileTypeScript(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;
}

function loadDeviceIdentityModule() {
  const filename = path.join(__dirname, '../web/src/services/device-identity.ts');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(compileTypeScript(filename), filename);
  return mod.exports;
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
}

test('resolveCurrentDeviceIdentity creates stable iPhone name suffix', () => {
  const identity = loadDeviceIdentityModule();
  const storage = createStorage();
  const randomBytes = (length) => {
    return length === 2
      ? Uint8Array.from([0xab, 0xcd])
      : Uint8Array.from([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17]);
  };

  const first = identity.resolveCurrentDeviceIdentity({
    storage,
    navigatorObj: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone'
    },
    randomBytes
  });
  const second = identity.resolveCurrentDeviceIdentity({
    storage,
    navigatorObj: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone'
    },
    randomBytes: () => Uint8Array.from([0x12, 0x34])
  });

  assert.deepEqual(first, {
    id: 'device-ios-1011121314151617',
    name: 'iPhone abcd',
    platform: 'ios'
  });
  assert.deepEqual(second, first);
});

test('resolveCurrentDeviceIdentity labels Android and iPadOS devices', () => {
  const identity = loadDeviceIdentityModule();

  assert.deepEqual(identity.resolveCurrentDeviceIdentity({
    storage: createStorage(),
    navigatorObj: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel)',
      platform: 'Linux armv8l'
    },
    randomBytes: () => Uint8Array.from([0x01, 0x02])
  }), { id: 'device-android-0102', name: 'Android 0102', platform: 'android' });

  assert.deepEqual(identity.resolveCurrentDeviceIdentity({
    storage: createStorage(),
    navigatorObj: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
      platform: 'MacIntel',
      maxTouchPoints: 5
    },
    randomBytes: () => Uint8Array.from([0x03, 0x04])
  }), { id: 'device-ios-0304', name: 'iPad 0304', platform: 'ios' });
});
