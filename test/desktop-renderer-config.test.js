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

function restoreEnvironment(name, previousValue) {
  if (previousValue === undefined) delete process.env[name];
  else process.env[name] = previousValue;
}

function loadWebConfig(environment) {
  const filename = path.join(projectRoot, 'web', 'config', 'config.ts');
  const previousDesktopBuild = process.env.AIH_DESKTOP_BUILD;
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.AIH_DESKTOP_BUILD = environment.AIH_DESKTOP_BUILD || '';
  process.env.NODE_ENV = environment.NODE_ENV || '';

  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request === '@umijs/max') return { defineConfig: (config) => config };
    if (request === './routes') return { __esModule: true, default: [] };
    return originalRequire(request);
  };

  try {
    mod._compile(compileTypeScript(filename), filename);
    return mod.exports.default;
  } finally {
    restoreEnvironment('AIH_DESKTOP_BUILD', previousDesktopBuild);
    restoreEnvironment('NODE_ENV', previousNodeEnvironment);
  }
}

test('desktop renderer paths distinguish development from packaged builds', () => {
  const development = loadWebConfig({
    AIH_DESKTOP_BUILD: '1',
    NODE_ENV: 'development',
  });
  const production = loadWebConfig({
    AIH_DESKTOP_BUILD: '1',
    NODE_ENV: 'production',
  });
  const browser = loadWebConfig({ NODE_ENV: 'production' });

  assert.deepEqual(
    {
      history: development.history.type,
      publicPath: development.publicPath,
      base: development.base,
      fastRefresh: development.fastRefresh,
    },
    { history: 'hash', publicPath: '/', base: '/', fastRefresh: false },
  );
  assert.deepEqual(
    { history: production.history.type, publicPath: production.publicPath, base: production.base },
    { history: 'hash', publicPath: './', base: '/' },
  );
  assert.deepEqual(
    {
      history: browser.history.type,
      publicPath: browser.publicPath,
      base: browser.base,
      fastRefresh: browser.fastRefresh,
    },
    { history: 'browser', publicPath: '/ui/', base: '/ui', fastRefresh: true },
  );
});

test('desktop renderer keeps prototypes mutable while retaining IPC hardening', () => {
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  const security = tauriConfig.tauri.security;

  assert.equal(security.freezePrototype, false);
  assert.deepEqual(security.dangerousRemoteDomainIpcAccess, []);
  assert.equal(security.dangerousUseHttpScheme, false);
  assert.match(security.csp, /default-src 'self'/u);
  assert.match(security.csp, /object-src 'none'/u);
  assert.match(security.csp, /frame-ancestors 'none'/u);
});

test('desktop product and renderer titles use the AI Home brand', () => {
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  const rendererConfig = loadWebConfig({
    AIH_DESKTOP_BUILD: '1',
    NODE_ENV: 'production',
  });
  const appSource = fs.readFileSync(
    path.join(projectRoot, 'web', 'src', 'app.tsx'),
    'utf8',
  );

  assert.equal(tauriConfig.package.productName, 'AI Home');
  assert.equal(tauriConfig.tauri.windows[0].title, 'AI Home');
  assert.equal(rendererConfig.layout.title, 'AI Home');
  assert.match(appSource, /title:\s*["']AI Home["']/u);
});

test('desktop registers native LAN Server discovery without a renderer-side UDP dependency', () => {
  const mainSource = fs.readFileSync(
    path.join(projectRoot, 'src-tauri', 'src', 'main.rs'),
    'utf8',
  );
  const commandsSource = fs.readFileSync(
    path.join(projectRoot, 'src-tauri', 'src', 'commands.rs'),
    'utf8',
  );

  assert.match(mainSource, /commands::desktop_discover_servers/u);
  assert.match(mainSource, /commands::desktop_outbound_relays_configure/u);
  assert.match(mainSource, /commands::desktop_frp_route_configure/u);
  assert.match(mainSource, /commands::desktop_relay_route_trust/u);
  assert.match(mainSource, /commands::desktop_lan_profile_authorize/u);
  assert.match(mainSource, /commands::desktop_lan_routes_refresh/u);
  assert.match(commandsSource, /pub async fn desktop_discover_servers/u);
  assert.match(commandsSource, /pub async fn desktop_outbound_relays_configure/u);
  assert.match(commandsSource, /pub async fn desktop_frp_route_configure/u);
  assert.match(commandsSource, /pub async fn desktop_relay_route_trust/u);
  assert.match(commandsSource, /pub async fn desktop_lan_profile_authorize/u);
  assert.match(commandsSource, /pub async fn desktop_lan_routes_refresh/u);
  assert.match(commandsSource, /run_server_discovery/u);
});
