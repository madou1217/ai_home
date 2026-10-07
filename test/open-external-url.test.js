const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function loadModule() {
  const filename = path.join(__dirname, '../web/src/services/open-external-url.ts');
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

test('external URL adapter opens only credential-free HTTP(S) URLs', async (t) => {
  const previousWindow = global.window;
  const calls = [];
  global.window = {
    open(url, target, features) {
      calls.push({ url, target, features });
      return { opener: {} };
    }
  };
  t.after(() => {
    global.window = previousWindow;
  });
  const external = loadModule();

  await external.openExternalUrl('https://example.com/oauth?state=1');

  assert.deepEqual(calls, [{
    url: 'https://example.com/oauth?state=1',
    target: '_blank',
    features: 'noopener,noreferrer'
  }]);
  assert.equal(external.isExternalHttpUrl('http://127.0.0.1/callback'), true);
  assert.equal(external.isExternalHttpUrl('javascript:alert(1)'), false);
  await assert.rejects(external.openExternalUrl('file:///tmp/secret'), /invalid_external_url/);
  await assert.rejects(external.openExternalUrl('https://user:pass@example.com'), /invalid_external_url/);
});
