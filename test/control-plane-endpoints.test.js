const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function loadControlPlaneEndpointsModule(options = {}) {
  const filename = path.join(__dirname, '../web/src/services/control-plane-endpoints.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => request === './native-server-profile-repository'
    ? { isNativeDesktopRuntime: () => options.native === true }
    : originalRequire(request);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

test('native desktop never treats the WebView origin as a Server URL', (t) => {
  const previousWindow = global.window;
  global.window = { location: { origin: 'tauri://localhost' } };
  t.after(() => {
    global.window = previousWindow;
  });

  const endpoints = loadControlPlaneEndpointsModule({ native: true });

  assert.equal(endpoints.getBrowserControlEndpoint(), '');
});

test('resolveDefaultControlEndpoint prefers recommended non-loopback hints', () => {
  const endpoints = loadControlPlaneEndpointsModule();
  const result = endpoints.resolveDefaultControlEndpoint([
    { endpoint: 'http://127.0.0.1:5175', source: 'request', label: 'localhost', recommended: true },
    { endpoint: 'http://192.168.3.8:5175', source: 'lan', label: 'lan', recommended: true }
  ], 'http://localhost:5175');

  assert.equal(result, 'http://192.168.3.8:5175');
});

test('resolveDefaultControlEndpoint uses LAN fallback before localhost for mobile Server access', () => {
  const endpoints = loadControlPlaneEndpointsModule();
  const result = endpoints.resolveDefaultControlEndpoint([
    { endpoint: 'http://localhost:5175', source: 'request', label: 'localhost', recommended: false },
    { endpoint: 'http://192.168.3.76:5175', source: 'lan', label: 'lan', recommended: false }
  ], 'http://localhost:5175');

  assert.equal(result, 'http://192.168.3.76:5175');
});

test('resolveDefaultControlEndpoint keeps fallback when every hint is loopback', () => {
  const endpoints = loadControlPlaneEndpointsModule();
  const result = endpoints.resolveDefaultControlEndpoint([
    { endpoint: 'http://127.0.0.1:5175', source: 'request', label: 'localhost', recommended: false }
  ], 'http://localhost:5175');

  assert.equal(result, 'http://localhost:5175');
});

test('normalizeEndpointHintWarnings deduplicates route and hint warnings', () => {
  const endpoints = loadControlPlaneEndpointsModule();
  const result = endpoints.normalizeEndpointHintWarnings([
    { endpoint: 'http://192.168.3.8:5175', source: 'lan', label: 'lan', warning: '需要同一网络。' }
  ], ['需要同一网络。', '']);

  assert.deepEqual(result, ['需要同一网络。']);
});
