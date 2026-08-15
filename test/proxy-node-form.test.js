'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function loadTypeScriptModule(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText;
  const loaded = new Module(filePath, module);
  loaded.filename = filePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(filePath));
  loaded._compile(output, filePath);
  return loaded.exports;
}

test('proxy node form submits only fields accepted by the selected protocol', () => {
  const modulePath = path.resolve(
    __dirname,
    '../web/src/components/toolkit/proxy-pool/proxy-pool-utils.ts'
  );
  const { buildProxyNodePayload } = loadTypeScriptModule(modulePath);

  assert.deepEqual(buildProxyNodePayload?.(
    { id: 'node-1', protocol: 'vmess', uuid: 'old-uuid', network: 'ws', tls: true },
    {
      name: 'SS node',
      protocol: 'shadowsocks',
      server: 'proxy.example.test',
      port: 8388,
      password: 'secret',
      cipher: 'aes-256-gcm',
      network: 'tcp',
      tls: false,
      sni: 'stale.example.test',
      path: '/stale'
    }
  ), {
    id: 'node-1',
    name: 'SS node',
    protocol: 'shadowsocks',
    server: 'proxy.example.test',
    port: 8388,
    password: 'secret',
    cipher: 'aes-256-gcm'
  });
});

test('proxy mutations report success only after the backend confirms application', () => {
  const modulePath = path.resolve(
    __dirname,
    '../web/src/components/toolkit/proxy-pool/proxy-pool-utils.ts'
  );
  const { getMutationMessage, isMutationApplied } = loadTypeScriptModule(modulePath);

  assert.equal(isMutationApplied({ ok: true, applied: true }), true);
  assert.equal(isMutationApplied({ ok: true, applied: false }), false);
  assert.equal(isMutationApplied({ ok: true }), false);
  assert.equal(isMutationApplied({ ok: false }), false);
  assert.equal(
    getMutationMessage({ error: 'proxy_core_reload_failed' }, 'fallback'),
    'proxy_core_reload_failed'
  );
});
