'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let compileMihomoConfig;
let buildStableProxyName;
try {
  ({ compileMihomoConfig, buildStableProxyName } = require('../lib/cli/services/toolkit/proxy-pool/mihomo-config-compiler'));
} catch (_error) {
  // RED: the compiler is introduced by this change.
}

test('mihomo compiler emits loopback-only listeners with unique stable outbound names', () => {
  assert.equal(typeof compileMihomoConfig, 'function');
  assert.equal(typeof buildStableProxyName, 'function');
  assert.equal(
    buildStableProxyName({ id: 'stable-id', name: 'before', protocol: 'http' }),
    buildStableProxyName({ id: 'stable-id', name: 'after', protocol: 'http' })
  );

  const nodes = [
    {
      id: 'node_a',
      name: 'same\nexternal-controller: 0.0.0.0:9090',
      protocol: 'shadowsocks',
      server: '198.51.100.10',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'secret"\nrules:'
    },
    {
      id: 'node_b',
      name: 'same\nexternal-controller: 0.0.0.0:9090',
      protocol: 'trojan',
      server: '203.0.113.20',
      port: 443,
      password: 'trojan-secret',
      sni: 'edge.example.com'
    }
  ];

  const result = compileMihomoConfig({
    nodes,
    routing: {
      mode: 'global',
      activeOutboundNodeId: 'node_a',
      rules: []
    },
    dedicatedPorts: {
      mappings: { node_a: 10801, node_b: 10802 }
    },
    controllerPort: 19090,
    controllerSecret: 'controller-secret'
  });

  assert.equal(result.config['allow-lan'], false);
  assert.equal(result.config['bind-address'], '127.0.0.1');
  assert.equal(result.config['mixed-port'], 10800);
  assert.equal(result.config['external-controller'], '127.0.0.1:19090');
  assert.equal(result.config.listeners.length, 2);
  assert.ok(result.config.listeners.every((listener) => listener.listen === '127.0.0.1'));
  assert.ok(result.config.listeners.every((listener) => listener.type === 'mixed'));
  assert.equal(new Set(result.config.proxies.map((proxy) => proxy.name)).size, 2);
  assert.deepEqual(
    result.config.listeners.map((listener) => listener.proxy).sort(),
    result.config.proxies.map((proxy) => proxy.name).sort()
  );
  assert.match(result.content, /allow-lan: false/);
  assert.doesNotMatch(result.content, /\nexternal-controller: 0\.0\.0\.0:9090\n/);
  assert.equal(result.exportedNodeCount, 2);
  assert.deepEqual(result.skippedNodes, []);
});

test('mihomo compiler maps routing rules to real outbound names and reports unsupported nodes', () => {
  assert.equal(typeof compileMihomoConfig, 'function');

  const result = compileMihomoConfig({
    nodes: [
      {
        id: 'node_http',
        name: 'HTTP',
        protocol: 'http',
        server: 'proxy.example.com',
        port: 8080
      },
      {
        id: 'node_unknown',
        name: 'Unknown',
        protocol: 'wireguard',
        server: 'wg.example.com',
        port: 51820
      }
    ],
    routing: {
      mode: 'rule',
      activeOutboundNodeId: 'node_http',
      rules: [
        { id: 'openai', outbound: 'proxy', domains: ['openai.com'] },
        { id: 'direct', outbound: 'direct', domains: ['example.cn'] }
      ]
    },
    dedicatedPorts: { mappings: { node_http: 10801 } }
  });

  const outboundName = result.nodeNameById.node_http;
  assert.ok(outboundName);
  assert.deepEqual(result.config.rules, [
    `DOMAIN-SUFFIX,openai.com,${outboundName}`,
    'DOMAIN-SUFFIX,example.cn,DIRECT',
    `MATCH,${outboundName}`
  ]);
  assert.equal(result.exportedNodeCount, 1);
  assert.deepEqual(result.skippedNodes, [{
    nodeId: 'node_unknown',
    name: 'Unknown',
    reason: 'unsupported_proxy_protocol_wireguard'
  }]);
});

test('mihomo compiler preserves structured SS plugin options and compiles reject/IP rules', () => {
  const result = compileMihomoConfig({
    nodes: [{
      id: 'node_plugin',
      name: 'plugin',
      protocol: 'shadowsocks',
      server: '198.51.100.5',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'secret',
      plugin: 'v2ray-plugin',
      pluginOpts: { mode: 'websocket', tls: true, host: 'edge.example.com' }
    }],
    routing: {
      mode: 'rule',
      activeOutboundNodeId: 'node_plugin',
      rules: [{
        id: 'blocked',
        outbound: 'reject',
        domains: ['tracker.example'],
        ips: ['203.0.113.0/24', '2001:db8::/32']
      }]
    }
  }, { includeController: false });

  assert.deepEqual(result.config.proxies[0]['plugin-opts'], {
    mode: 'websocket',
    tls: true,
    host: 'edge.example.com'
  });
  assert.ok(result.config.rules.includes('DOMAIN-SUFFIX,tracker.example,REJECT'));
  assert.ok(result.config.rules.includes('IP-CIDR,203.0.113.0/24,REJECT,no-resolve'));
  assert.ok(result.config.rules.includes('IP-CIDR6,2001:db8::/32,REJECT,no-resolve'));
  assert.equal(result.config['external-controller'], undefined);
  assert.equal(result.config.secret, undefined);
  assert.doesNotMatch(result.content, /\[object Object\]/);
  assert.doesNotMatch(result.content, /external-controller|secret:/);
});

test('mihomo compiler emits a loopback-safe TUN block only when explicitly enabled', () => {
  const disabled = compileMihomoConfig({ nodes: [], tun: { enabled: false } }, { includeController: false });
  assert.equal(disabled.config.tun, undefined);

  const enabled = compileMihomoConfig({
    nodes: [],
    tun: {
      enabled: true,
      stack: 'gvisor',
      autoRoute: false,
      autoDetectInterface: false,
      strictRoute: true,
      dnsHijack: ['any:53']
    }
  }, { includeController: false });
  assert.deepEqual(enabled.config.tun, {
    enable: true,
    stack: 'gvisor',
    'auto-route': false,
    'auto-detect-interface': false,
    'strict-route': true,
    'dns-hijack': ['any:53']
  });
  assert.match(enabled.content, /tun:/);
  assert.doesNotMatch(enabled.content, /allow-lan: true/);
});
