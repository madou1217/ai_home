const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function loadScopeModule() {
  const filename = path.join(__dirname, '../web/src/services/server-selection-scope.ts');
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
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('explicit Server query pins one browser tab without changing the default Server', () => {
  const scope = loadScopeModule();
  const sessionStorage = createStorage();

  assert.equal(scope.getExplicitServerProfileId(
    { search: '?server=cp-aws&view=compact', hash: '' },
    sessionStorage
  ), 'cp-aws');
  assert.equal(scope.getEffectiveServerProfileId(
    'cp-default',
    { search: '', hash: '' },
    sessionStorage
  ), 'cp-aws');
  assert.equal(sessionStorage.getItem(scope.EXPLICIT_SERVER_SESSION_KEY), 'cp-aws');
});

test('explicit Server selector supports native hash routes and replaces only its own query key', () => {
  const scope = loadScopeModule();
  const sessionStorage = createStorage();

  assert.equal(scope.getExplicitServerProfileId(
    { search: '', hash: '#/dashboard?server=cp-native&range=day' },
    sessionStorage
  ), 'cp-native');
  assert.equal(
    scope.buildServerScopedSearch('?range=day&server=cp-old', 'cp-new'),
    '?range=day&server=cp-new'
  );
  assert.equal(scope.buildServerScopedSearch('?range=day', ''), '?range=day');
});

test('Server scoped href keeps explicit identity out of path and preserves existing parameters', () => {
  const scope = loadScopeModule();

  assert.equal(
    scope.buildServerScopedHref('/ui/usage?range=week#cost', 'cp-aws'),
    '/ui/usage?range=week&server=cp-aws#cost'
  );
  assert.equal(
    scope.buildServerScopedHref('#/usage?range=week', 'cp-native'),
    '#/usage?range=week&server=cp-native'
  );
});
