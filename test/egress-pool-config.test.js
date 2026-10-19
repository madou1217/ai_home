'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  buildEgressPoolConfig,
  resolvePhysicalInterface
} = require('../lib/runtime/egress-pool-config');
const {
  isExecutableFile,
  resolveMihomoCorePath
} = require('../lib/runtime/egress-pool-core-resolver');

const VLESS_REALITY_NODE = {
  protocol: 'vless',
  server: 'node.example.com',
  port: 443,
  uuid: '26e6c41b-71cf-4a1b-99cf-8050e0a64a02',
  network: 'tcp',
  tls: true,
  security: 'reality',
  sni: 'swdist.apple.com',
  flow: 'xtls-rprx-vision',
  publicKey: 'rBLgYxDPw9nmzppUc_8Hr-puEW7lkpN1zoRDRcA-Ywo',
  shortId: '5f7b',
  fingerprint: 'ios'
};

// ── 物理网卡探测 ───────────────────────────────────────────────────────────

test('resolvePhysicalInterface skips utun and internal interfaces', () => {
  const name = resolvePhysicalInterface(() => ({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    utun4: [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
    en1: [{ family: 'IPv4', address: '192.168.31.8', internal: false }]
  }));
  assert.equal(name, 'en1');
});

test('resolvePhysicalInterface returns empty when only TUN and loopback exist', () => {
  const name = resolvePhysicalInterface(() => ({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    utun4: [{ family: 'IPv4', address: '198.18.0.1', internal: false }]
  }));
  assert.equal(name, '');
});

test('resolvePhysicalInterface tolerates a throwing probe', () => {
  assert.equal(resolvePhysicalInterface(() => { throw new Error('boom'); }), '');
});

const SECRET = 'test-controller-secret';

// ── 配置编译 ───────────────────────────────────────────────────────────────

test('the pool config never takes over the host network', () => {
  const { config } = buildEgressPoolConfig({
    nodes: [VLESS_REALITY_NODE],
    mixedPort: 17900,
    controllerPort: 19100,
    secret: SECRET
  });
  // 不写 tun 段、不开 auto-route、不监听对外地址 —— 用户电脑网络不受影响。
  assert.equal('tun' in config, false);
  assert.equal(config['allow-lan'], false);
  assert.equal(config['mixed-port'], 17900);
  assert.match(config['external-controller'], /^127\.0\.0\.1:/);
  // 控制端口必须带密钥：否则本机任意进程/浏览器页面都能 PUT /configs 改写内核。
  assert.equal(config.secret, SECRET);
});

test('the controller secret is mandatory', () => {
  assert.throws(() => buildEgressPoolConfig({
    nodes: [VLESS_REALITY_NODE],
    mixedPort: 17900,
    controllerPort: 19100
  }), /egress_pool_controller_secret_required/);
  assert.throws(() => buildEgressPoolConfig({
    nodes: [VLESS_REALITY_NODE],
    mixedPort: 17900,
    controllerPort: 19100,
    secret: '   '
  }), /egress_pool_controller_secret_required/);
});

test('the pool binds the physical interface so TUN interception cannot hijack it', () => {
  const { config, interfaceName } = buildEgressPoolConfig({
    nodes: [VLESS_REALITY_NODE],
    mixedPort: 17900,
    controllerPort: 19100,
    secret: SECRET,
    networkInterfaces: () => ({
      utun4: [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
      en1: [{ family: 'IPv4', address: '192.168.31.8', internal: false }]
    })
  });
  assert.equal(interfaceName, 'en1');
  // 实测：不绑网卡时内核直连节点超时（000），绑网卡后 200 —— 这是必需字段。
  assert.equal(config.proxies[0]['interface-name'], 'en1');
});

test('the pool resolves names through its own DoH, not the host resolver', () => {
  const { config } = buildEgressPoolConfig({
    nodes: [VLESS_REALITY_NODE],
    mixedPort: 17900,
    controllerPort: 19100,
    secret: SECRET,
    interfaceName: ''
  });
  // TUN 环境下系统 DNS 返回 fake-ip（198.18.x.x），内核必须自带 DoH 才解析得对。
  assert.ok(config.dns.nameserver.every((server) => server.startsWith('https://')));
  assert.ok(config.dns['proxy-server-nameserver'].every((server) => server.startsWith('https://')));
});

test('REALITY nodes compile to mihomo reality-opts, not a plain TLS handshake', () => {
  const { config } = buildEgressPoolConfig({
    nodes: [VLESS_REALITY_NODE],
    mixedPort: 17900,
    controllerPort: 19100,
    secret: SECRET,
    interfaceName: ''
  });
  const proxy = config.proxies[0];
  // 字段名写错（reality:{publicKey}）会被 mihomo 静默忽略 → 按普通 TLS 握手 → 超时。
  assert.deepEqual(proxy['reality-opts'], {
    'public-key': VLESS_REALITY_NODE.publicKey,
    'short-id': VLESS_REALITY_NODE.shortId
  });
  assert.equal(proxy['client-fingerprint'], 'ios');
  assert.equal(proxy.tls, true);
});

test('an uncompilable node is skipped instead of sinking the whole pool', () => {
  const { nodeNames } = buildEgressPoolConfig({
    nodes: [
      { protocol: 'not-a-protocol', server: 'x.example.com', port: 443 },
      VLESS_REALITY_NODE
    ],
    mixedPort: 17900,
    controllerPort: 19100,
    secret: SECRET,
    interfaceName: ''
  });
  assert.equal(nodeNames.length, 1);
  assert.equal(nodeNames[0], 'node-0');
});

test('a pool with no compilable node fails loudly', () => {
  assert.throws(() => buildEgressPoolConfig({
    nodes: [{ protocol: 'not-a-protocol', server: 'x.example.com', port: 443 }],
    mixedPort: 17900,
    controllerPort: 19100,
    secret: SECRET
  }), /egress_pool_no_usable_nodes/);
});

test('ports are mandatory so the pool can never bind an implicit port', () => {
  assert.throws(() => buildEgressPoolConfig({ nodes: [VLESS_REALITY_NODE], controllerPort: 19100, secret: SECRET }),
    /egress_pool_mixed_port_required/);
  assert.throws(() => buildEgressPoolConfig({ nodes: [VLESS_REALITY_NODE], mixedPort: 17900, secret: SECRET }),
    /egress_pool_controller_port_required/);
});

// ── 内核探测 ───────────────────────────────────────────────────────────────

test('isExecutableFile rejects the zero-byte placeholder cores clients ship', () => {
  const fs = {
    statSync: (filePath) => {
      if (filePath === '/zero/mihomo') return { isFile: () => true, size: 0 };
      if (filePath === '/real/mihomo') return { isFile: () => true, size: 4096 };
      throw new Error('ENOENT');
    }
  };
  assert.equal(isExecutableFile(fs, '/zero/mihomo'), false);
  assert.equal(isExecutableFile(fs, '/real/mihomo'), true);
  assert.equal(isExecutableFile(fs, '/missing/mihomo'), false);
});

test('the managed core wins over a client-bundled one', () => {
  const fs = {
    statSync: (filePath) => {
      if (filePath === '/home/.ai_home/tools/mihomo') return { isFile: () => true, size: 4096 };
      throw new Error('ENOENT');
    }
  };
  const resolved = resolveMihomoCorePath({
    fs,
    path: require('node:path'),
    env: {},
    aiHomeDir: '/home/.ai_home',
    platform: 'darwin'
  });
  assert.equal(resolved.source, 'managed');
});

test('Windows resolves .exe cores (managed, client-bundled, PATH) and never an extensionless file', () => {
  const winPath = require('node:path').win32;
  const files = new Set();
  const fs = { statSync: (filePath) => { if (files.has(filePath)) return { isFile: () => true, size: 4096 }; throw new Error('ENOENT'); } };
  const resolve = (env = {}) => resolveMihomoCorePath({ fs, path: winPath, env, aiHomeDir: 'C:\\Users\\u\\.ai_home', platform: 'win32' });
  files.add('C:\\Users\\u\\.ai_home\\tools\\mihomo');
  assert.equal(resolve(), null, 'an extensionless file cannot be spawned on Windows');
  files.add('C:\\Program Files\\Clash Verge\\verge-mihomo-alpha.exe');
  assert.deepEqual(resolve(), { path: 'C:\\Program Files\\Clash Verge\\verge-mihomo-alpha.exe', source: 'client' });
  files.add('C:\\Users\\u\\.ai_home\\tools\\mihomo.exe');
  assert.equal(resolve().source, 'managed');
  files.clear();
  files.add('D:\\bin\\mihomo.exe');
  assert.deepEqual(resolve({ PATH: 'D:\\bin' }), { path: 'D:\\bin\\mihomo.exe', source: 'path' });
});

test('a missing core resolves to null so callers can fail closed', () => {
  const fs = { statSync: () => { throw new Error('ENOENT'); } };
  const resolved = resolveMihomoCorePath({
    fs,
    path: require('node:path'),
    env: { PATH: '/nonexistent' },
    aiHomeDir: '/home/.ai_home'
  });
  assert.equal(resolved, null);
});

test('no AIH_* env override exists: the managed path is the only explicit override', () => {
  const fs = {
    statSync: (filePath) => {
      if (filePath === '/custom/mihomo') return { isFile: () => true, size: 4096 };
      throw new Error('ENOENT');
    }
  };
  const resolved = resolveMihomoCorePath({
    fs,
    path: require('node:path'),
    env: { AIH_EGRESS_POOL_CORE: '/custom/mihomo', PATH: '/nonexistent' },
    aiHomeDir: '/home/.ai_home'
  });
  assert.equal(resolved, null);
});

test('physical interface skips Windows / macOS TUN adapters by name and fake-ip address', () => {
  const { resolvePhysicalInterface } = require('../lib/runtime/egress-pool-config');
  // Windows 真机（2026-10-19）：Clash Verge 的 TUN 网卡排在以太网前面。
  assert.equal(resolvePhysicalInterface(() => ({
    Clash: [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
    '以太网': [{ family: 'IPv4', address: '192.168.3.76', internal: false }]
  })), '以太网');
  assert.equal(resolvePhysicalInterface(() => ({
    utun4: [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
    'Unnamed TUN': [{ family: 'IPv4', address: '198.19.0.2', internal: false }],
    en0: [{ family: 'IPv4', address: '192.168.31.8', internal: false }]
  })), 'en0');
  assert.equal(resolvePhysicalInterface(() => ({ wintun: [{ family: 'IPv4', address: '10.0.0.2', internal: false }] })), '');
});
