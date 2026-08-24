'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const compilerPath = path.resolve(__dirname, '../lib/server/zcode-sing-box-config.js');

function loadCompiler() {
  assert.equal(fs.existsSync(compilerPath), true, '缺少独立的 ZCode sing-box 配置编译器');
  return require(compilerPath);
}

function collectKeys(value, result = new Set()) {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, result);
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    result.add(key);
    collectKeys(item, result);
  }
  return result;
}

test('ZCode 使用独立 sing-box JSON 编译器', () => {
  const compiler = loadCompiler();
  assert.equal(typeof compiler.compileZcodeSingBoxConfig, 'function');
  assert.equal(typeof compiler.compileZcodeSingBoxOutbound, 'function');
});

test('每个账号只创建回环 mixed inbound，并路由到专属 selector', () => {
  const { compileZcodeSingBoxConfig } = loadCompiler();
  const node = {
    id: 'node-a',
    protocol: 'vless',
    server: 'edge.example',
    port: 443,
    uuid: '00000000-0000-4000-8000-000000000001',
    network: 'tcp',
    tls: true,
    sni: 'edge.example'
  };
  const compiled = compileZcodeSingBoxConfig({
    controllerPort: 22190,
    controllerSecret: 'controller-secret',
    logPath: '/private/zcode-egress.log',
    accounts: [
      {
        accountRef: 'acct_11111111111111111111',
        listenPort: 22101,
        selectedTarget: { kind: 'node', node },
        candidateTargets: [{ kind: 'node', node }]
      },
      {
        accountRef: 'acct_22222222222222222222',
        listenPort: 22102,
        selectedTarget: { kind: 'direct' },
        candidateTargets: [{ kind: 'direct' }]
      }
    ]
  });

  assert.equal(compiled.config.inbounds.length, 2);
  for (const inbound of compiled.config.inbounds) {
    assert.equal(inbound.type, 'mixed');
    assert.equal(inbound.listen, '127.0.0.1');
    assert.equal(Number.isInteger(inbound.listen_port), true);
  }
  assert.deepEqual(
    compiled.config.inbounds.map((inbound) => inbound.listen_port),
    [22101, 22102]
  );

  for (const account of Object.values(compiled.accounts)) {
    const selector = compiled.config.outbounds.find((outbound) => outbound.tag === account.selectorTag);
    assert.equal(selector.type, 'selector');
    assert.equal(selector.default, account.selectedOutboundTag);
    assert.equal(selector.interrupt_exist_connections, true);
    assert.ok(selector.outbounds.includes(account.selectedOutboundTag));
    assert.ok(compiled.config.route.rules.some((rule) => (
      rule.inbound?.includes(account.inboundTag)
      && rule.action === 'route'
      && rule.outbound === account.selectorTag
    )));
  }

  assert.deepEqual(
    compiled.accounts.acct_11111111111111111111.candidateOutbounds,
    [{ nodeId: 'node-a', outboundTag: compiled.accounts.acct_11111111111111111111.selectedOutboundTag }]
  );
  assert.deepEqual(compiled.accounts.acct_22222222222222222222.candidateOutbounds, []);

  assert.deepEqual(compiled.config.experimental.clash_api, {
    external_controller: '127.0.0.1:22190',
    secret: 'controller-secret'
  });
  assert.deepEqual(compiled.config.log, {
    level: 'warn',
    timestamp: true,
    output: '/private/zcode-egress.log'
  });
});

test('编译器禁止 TUN、系统代理接管和非回环监听字段', () => {
  const { compileZcodeSingBoxConfig } = loadCompiler();
  const compiled = compileZcodeSingBoxConfig({
    controllerPort: 22190,
    controllerSecret: 'secret',
    accounts: [{
      accountRef: 'acct_11111111111111111111',
      listenPort: 22101,
      selectedTarget: { kind: 'direct' },
      candidateTargets: [{ kind: 'direct' }]
    }]
  });
  const keys = collectKeys(compiled.config);

  for (const forbidden of ['tun', 'set_system_proxy', 'auto_route', 'auto_redirect']) {
    assert.equal(keys.has(forbidden), false, forbidden);
  }
  assert.ok(compiled.config.inbounds.every((inbound) => inbound.listen === '127.0.0.1'));
  assert.equal(compiled.config.experimental.clash_api.external_controller.startsWith('127.0.0.1:'), true);
});

test('VLESS Reality TCP 节点编译为 sing-box 原生 outbound', () => {
  const { compileZcodeSingBoxOutbound } = loadCompiler();
  const compiled = compileZcodeSingBoxOutbound({
    kind: 'node',
    node: {
      id: 'node-reality',
      protocol: 'vless',
      server: 'reality.example',
      port: 443,
      uuid: '00000000-0000-4000-8000-000000000001',
      network: 'tcp',
      security: 'reality',
      sni: 'www.example.com',
      publicKey: 'public-key-value',
      shortId: '0123456789abcdef',
      fingerprint: 'chrome',
      flow: 'xtls-rprx-vision'
    }
  });

  assert.deepEqual(compiled.outbound, {
    type: 'vless',
    tag: compiled.tag,
    server: 'reality.example',
    server_port: 443,
    uuid: '00000000-0000-4000-8000-000000000001',
    flow: 'xtls-rprx-vision',
    tls: {
      enabled: true,
      server_name: 'www.example.com',
      reality: {
        enabled: true,
        public_key: 'public-key-value',
        short_id: '0123456789abcdef'
      },
      utls: {
        enabled: true,
        fingerprint: 'chrome'
      }
    }
  });
});

test('远端节点只在自身 outbound 和 DNS 上绑定物理 underlay，不改变 direct 账号路由', () => {
  const { compileZcodeSingBoxConfig } = loadCompiler();
  const node = {
    id: 'node-underlay',
    protocol: 'vless',
    server: 'reality.example',
    port: 443,
    uuid: '00000000-0000-4000-8000-000000000001',
    network: 'tcp',
    security: 'reality',
    sni: 'www.example.com',
    publicKey: 'public-key-value',
    shortId: '0123456789abcdef',
    fingerprint: 'chrome',
    flow: 'xtls-rprx-vision'
  };
  const compiled = compileZcodeSingBoxConfig({
    controllerPort: 22190,
    controllerSecret: 'secret',
    underlay: {
      interfaceName: 'en1',
      dnsServer: '114.114.114.114'
    },
    accounts: [
      {
        accountRef: 'acct_11111111111111111111',
        listenPort: 22101,
        selectedTarget: { kind: 'node', node },
        candidateTargets: [{ kind: 'node', node }]
      },
      {
        accountRef: 'acct_22222222222222222222',
        listenPort: 22102,
        selectedTarget: { kind: 'direct' },
        candidateTargets: [{ kind: 'direct' }]
      }
    ]
  });
  const remote = compiled.config.outbounds.find((outbound) => outbound.type === 'vless');
  const direct = compiled.config.outbounds.find((outbound) => outbound.type === 'direct');

  assert.deepEqual(compiled.config.dns, {
    servers: [{
      type: 'udp',
      tag: 'aih-zcode-underlay-dns',
      server: '114.114.114.114',
      server_port: 53,
      bind_interface: 'en1'
    }]
  });
  assert.equal(remote.bind_interface, 'en1');
  assert.equal(remote.domain_resolver, 'aih-zcode-underlay-dns');
  assert.equal(direct.bind_interface, undefined);
  assert.equal(direct.domain_resolver, undefined);
  assert.equal(compiled.config.route.default_interface, undefined);
});

test('字面 IP 节点只绑定物理接口，不生成无用 DNS 配置', () => {
  const { compileZcodeSingBoxConfig } = loadCompiler();
  const node = {
    id: 'node-ip-underlay',
    protocol: 'socks5',
    server: '203.0.113.9',
    port: 1080
  };
  const compiled = compileZcodeSingBoxConfig({
    controllerPort: 22190,
    controllerSecret: 'secret',
    underlay: { interfaceName: 'en1', dnsServer: '' },
    accounts: [{
      accountRef: 'acct_11111111111111111111',
      listenPort: 22101,
      selectedTarget: { kind: 'node', node },
      candidateTargets: [{ kind: 'node', node }]
    }]
  });
  const remote = compiled.config.outbounds.find((outbound) => outbound.type === 'socks');

  assert.equal(remote.bind_interface, 'en1');
  assert.equal(remote.domain_resolver, undefined);
  assert.equal(compiled.config.dns, undefined);
});

test('编译器拒绝虚拟 underlay 接口和非物理 DNS，避免绕过探测器', () => {
  const { compileZcodeSingBoxConfig } = loadCompiler();
  const node = {
    id: 'node-invalid-underlay',
    protocol: 'socks5',
    server: 'proxy.example',
    port: 1080
  };
  const compile = (underlay) => compileZcodeSingBoxConfig({
    controllerPort: 22190,
    controllerSecret: 'secret',
    underlay,
    accounts: [{
      accountRef: 'acct_11111111111111111111',
      listenPort: 22101,
      selectedTarget: { kind: 'node', node },
      candidateTargets: [{ kind: 'node', node }]
    }]
  });

  assert.throws(
    () => compile({ interfaceName: 'utun1024', dnsServer: '114.114.114.114' }),
    /invalid_zcode_underlay/
  );
  assert.throws(
    () => compile({ interfaceName: 'en1', dnsServer: '127.0.0.1' }),
    /invalid_zcode_underlay/
  );
});

test('URL target 支持 HTTP、HTTPS、SOCKS4、SOCKS4a 与 SOCKS5 上游', () => {
  const { compileZcodeSingBoxOutbound } = loadCompiler();
  const expectations = [
    ['http://proxy.example:8080', { type: 'http', server_port: 8080, tls: undefined }],
    ['https://proxy.example:8443', { type: 'http', server_port: 8443, tls: { enabled: true, server_name: 'proxy.example' } }],
    ['socks4://proxy.example:1080', { type: 'socks', version: '4' }],
    ['socks4a://proxy.example:1080', { type: 'socks', version: '4a' }],
    ['socks5://proxy.example:1080', { type: 'socks', version: '5' }]
  ];

  for (const [proxyUrl, expected] of expectations) {
    const { outbound } = compileZcodeSingBoxOutbound({ kind: 'proxy-url', proxyUrl });
    assert.equal(outbound.type, expected.type, proxyUrl);
    assert.equal(outbound.server, 'proxy.example', proxyUrl);
    if (expected.server_port) assert.equal(outbound.server_port, expected.server_port, proxyUrl);
    if (expected.version) assert.equal(outbound.version, expected.version, proxyUrl);
    assert.deepEqual(outbound.tls, expected.tls, proxyUrl);
  }
});

test('编译器拒绝端口冲突、空候选和不支持的节点协议', () => {
  const { compileZcodeSingBoxConfig, compileZcodeSingBoxOutbound } = loadCompiler();

  assert.throws(() => compileZcodeSingBoxConfig({
    controllerPort: 22190,
    controllerSecret: 'secret',
    accounts: [
      {
        accountRef: 'acct_11111111111111111111',
        listenPort: 22101,
        selectedTarget: { kind: 'direct' },
        candidateTargets: [{ kind: 'direct' }]
      },
      {
        accountRef: 'acct_22222222222222222222',
        listenPort: 22101,
        selectedTarget: { kind: 'direct' },
        candidateTargets: [{ kind: 'direct' }]
      }
    ]
  }), /duplicate_zcode_sidecar_port/);

  assert.throws(() => compileZcodeSingBoxConfig({
    controllerPort: 22190,
    controllerSecret: 'secret',
    accounts: [{
      accountRef: 'acct_11111111111111111111',
      listenPort: 22101,
      selectedTarget: { kind: 'direct' },
      candidateTargets: []
    }]
  }), /missing_zcode_sidecar_candidates/);

  assert.throws(() => compileZcodeSingBoxOutbound({
    kind: 'node',
    node: { id: 'unsupported', protocol: 'tuic', server: 'edge.example', port: 443 }
  }), /unsupported_proxy_protocol_tuic/);
});
