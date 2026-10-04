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
  // 协议字段白名单由协议插件声明（服务端下发，旧服务端用 FALLBACK_PROXY_PROTOCOLS 兜底）。
  const modulePath = path.resolve(
    __dirname,
    '../web/src/components/toolkit/proxy-pool/proxy-protocol-schema.ts'
  );
  const { buildProxyNodePayload, FALLBACK_PROXY_PROTOCOLS } = loadTypeScriptModule(modulePath);

  assert.deepEqual(buildProxyNodePayload?.(
    FALLBACK_PROXY_PROTOCOLS,
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

test('core status presentation names the active proxy core plugin', () => {
  const modulePath = path.resolve(
    __dirname,
    '../web/src/components/toolkit/proxy-pool/proxy-pool-utils.ts'
  );
  const { coreDisplayName, coreStatusPresentation } = loadTypeScriptModule(modulePath);
  assert.equal(coreDisplayName({ engine: 'sing-box', engineName: 'sing-box' }), 'sing-box');
  assert.equal(coreDisplayName({ engine: 'mihomo' }), 'Mihomo');
  const missing = coreStatusPresentation({ engine: 'sing-box', engineName: 'sing-box', binaryEnvVar: 'AIH_SING_BOX_BIN', installed: false, running: false, dataPlaneReady: false, activeListeners: [] });
  assert.equal(missing.title, 'sing-box 代理核心未安装');
  assert.match(missing.description, /AIH_SING_BOX_BIN/);
  const ready = coreStatusPresentation({ engine: 'sing-box', engineName: 'sing-box', installed: true, running: true, dataPlaneReady: true, version: '1.14.2', mixedPort: 10800, activeListeners: [] });
  assert.equal(ready.title, 'sing-box 数据面已就绪');
});

test('outbound issue: rule/global modes without a usable default outbound fall back to direct', () => {
  const modulePath = path.resolve(
    __dirname,
    '../web/src/components/toolkit/proxy-pool/proxy-pool-utils.ts'
  );
  const { outboundIssue, outboundIssueText } = loadTypeScriptModule(modulePath);
  const nodes = [{ id: 'n1' }, { id: 'n2' }];
  const rules = [
    { id: 'r1', name: 'OpenAI 规则', outbound: 'proxy', domains: ['openai.com'] },
    { id: 'r2', name: '专用节点规则', outbound: 'proxy', nodeId: 'n2' },
    { id: 'r3', name: '中国大陆直连', outbound: 'direct' }
  ];
  assert.equal(outboundIssue({ mode: 'direct', activeOutboundNodeId: null, rules }, nodes), null);
  assert.equal(outboundIssue({ mode: 'rule', activeOutboundNodeId: 'n1', rules }, nodes), null);
  const missing = outboundIssue({ mode: 'rule', activeOutboundNodeId: null, rules }, nodes);
  assert.deepEqual(missing, { kind: 'missing', mode: 'rule', affectedRules: ['OpenAI 规则'] });
  assert.equal(outboundIssueText(missing).title, '未选择默认出口节点');
  assert.equal(outboundIssue({ mode: 'global', activeOutboundNodeId: 'gone', rules }, nodes).kind, 'deleted');
  assert.equal(outboundIssue({ mode: 'rule', activeOutboundNodeId: null, rules: [rules[1], rules[2]] }, nodes), null);
});
