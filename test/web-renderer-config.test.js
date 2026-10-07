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
      esModuleInterop: true,
    },
  }).outputText;
}

function loadWebConfig() {
  const filename = path.join(projectRoot, 'web', 'config', 'config.ts');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request === '@umijs/max') return { defineConfig: (config) => config };
    if (request === './routes') return { __esModule: true, default: [] };
    return originalRequire(request);
  };
  mod._compile(compileTypeScript(filename), filename);
  return mod.exports.default;
}

test('web renderer is served from the /ui base with browser history', () => {
  const config = loadWebConfig();

  assert.deepEqual(
    {
      history: config.history.type,
      publicPath: config.publicPath,
      base: config.base,
      favicons: config.favicons,
    },
    {
      history: 'browser',
      publicPath: '/ui/',
      base: '/ui',
      favicons: ['/ui/ai-home-logo.png'],
    },
  );
});

test('web renderer titles use the AI Home brand', () => {
  const config = loadWebConfig();
  const appSource = fs.readFileSync(
    path.join(projectRoot, 'web', 'src', 'app.tsx'),
    'utf8',
  );

  assert.equal(config.layout.title, 'AI Home');
  assert.match(appSource, /title:\s*["']AI Home["']/u);
});
