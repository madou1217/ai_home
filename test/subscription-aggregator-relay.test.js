'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const YAML = require('yaml');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const {
  compileRelayConfig,
  inboundTag,
  outboundTag
} = require('../lib/cli/services/toolkit/subscription-aggregator/relay/relay-config');
const { parseSingBoxVersion, resolveSingBoxBinary, binaryNameCandidates } = require('../lib/cli/services/toolkit/subscription-aggregator/relay/sing-box-binary');
const { SAMPLE_NODES, UUID } = require('./helpers/proxy-format-samples');

// ============================================================
// 内核查找：显式 → 托管 → PATH → 系统目录；找不到就 fail-closed
// ============================================================

function fakeFs(existing) {
  const files = new Set(existing);
  return {
    constants: { X_OK: 1 },
    statSync: (file) => ({ isFile: () => files.has(file) }),
    accessSync: (file) => { if (!files.has(file)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }
  };
}

test('sing-box binary lookup prefers explicit → managed → PATH → system directories', () => {
  // 平台必须与 path 实现成对：这条断言 POSIX 形态，就在 Windows 上也按 darwin 跑
  // （Windows 的 .exe 形态另有下面那条用例）。
  const posixOptions = { path: path.posix, platform: 'darwin', aiHomeDir: '/home/u/.ai_home' };
  const env = { PATH: '/path/bin:/other/bin' };
  const managed = '/home/u/.ai_home/bin/sing-box';

  // 显式注入优先于一切。
  assert.deepEqual(
    resolveSingBoxBinary({ ...posixOptions, fs: fakeFs(['/custom/sing-box', managed, '/path/bin/sing-box']), env, binaryPath: '/custom/sing-box' }),
    { path: '/custom/sing-box', source: 'explicit' }
  );
  // 显式路径不可执行时不再回退 —— 用户明确点名了一个内核，替他换别的才是意外。
  assert.equal(resolveSingBoxBinary({ ...posixOptions, fs: fakeFs([managed]), env, binaryPath: '/custom/sing-box' }), null);
  // 托管位置（AIH 自己的 bin/）。
  assert.deepEqual(
    resolveSingBoxBinary({ ...posixOptions, fs: fakeFs([managed, '/path/bin/sing-box']), env }),
    { path: managed, source: 'managed' }
  );
  // PATH。
  assert.deepEqual(
    resolveSingBoxBinary({ ...posixOptions, fs: fakeFs(['/other/bin/sing-box']), env }),
    { path: '/other/bin/sing-box', source: 'path' }
  );
  // 常见系统目录。
  assert.deepEqual(
    resolveSingBoxBinary({ ...posixOptions, fs: fakeFs(['/opt/homebrew/bin/sing-box']), env: { PATH: '' } }),
    { path: '/opt/homebrew/bin/sing-box', source: 'system' }
  );
  // 全都没有：null（调用方 fail-closed，不输出本地端口）。
  assert.equal(resolveSingBoxBinary({ ...posixOptions, fs: fakeFs([]), env: { PATH: '' } }), null);
  // 环境变量也是「显式」的一种（部署脚本用）。
  assert.deepEqual(
    resolveSingBoxBinary({ ...posixOptions, fs: fakeFs(['/env/sing-box']), env: { PATH: '', AIH_RELAY_SING_BOX_BIN: '/env/sing-box' } }),
    { path: '/env/sing-box', source: 'explicit' }
  );
});

test('windows looks for sing-box.exe in the managed directory and on PATH', () => {
  const winPath = path.win32;
  const aiHomeDir = 'C:\\Users\\u\\.ai_home';
  // 托管位置：%USERPROFILE%\.ai_home\bin\sing-box.exe
  assert.deepEqual(
    resolveSingBoxBinary({ fs: fakeFs([`${aiHomeDir}\\bin\\sing-box.exe`]), path: winPath, env: { PATH: '' }, platform: 'win32', aiHomeDir }),
    { path: `${aiHomeDir}\\bin\\sing-box.exe`, source: 'managed' }
  );
  // PATH（Windows 用分号分隔）。
  assert.deepEqual(
    resolveSingBoxBinary({ fs: fakeFs(['C:\\tools\\sing-box.exe']), path: winPath, env: { PATH: 'C:\\tools;D:\\bin' }, platform: 'win32', aiHomeDir }),
    { path: 'C:\\tools\\sing-box.exe', source: 'path' }
  );
  // PATHEXT 里额外的后缀也认。
  assert.deepEqual(
    resolveSingBoxBinary({ fs: fakeFs(['C:\\tools\\sing-box.bat']), path: winPath, env: { PATH: 'C:\\tools', PATHEXT: '.COM;.BAT' }, platform: 'win32', aiHomeDir }),
    { path: 'C:\\tools\\sing-box.bat', source: 'path' }
  );
  // 裸名在 Windows 上不算内核（发布包带 .exe）。
  assert.equal(resolveSingBoxBinary({ fs: fakeFs(['C:\\tools\\sing-box']), path: winPath, env: { PATH: 'C:\\tools' }, platform: 'win32', aiHomeDir }), null);
  assert.deepEqual(binaryNameCandidates({}, 'win32'), ['sing-box.exe']);
  assert.deepEqual(binaryNameCandidates({}, 'darwin'), ['sing-box']);
});

test('sing-box version parsing tolerates the shapes the CLI prints', () => {
  assert.equal(parseSingBoxVersion('sing-box version 1.13.19\nEnvironment: ...'), '1.13.19');
  assert.equal(parseSingBoxVersion('sing-box version v1.11'), '1.11');
  assert.equal(parseSingBoxVersion('command not found'), '');
});

// ============================================================
// 中转配置编译：本地入口 / 路由 / 链式 detour / 上游剪枝
// ============================================================

const VLESS_NODE = Object.freeze({
  id: 'n_vless', protocol: 'vless', name: 'vless', server: 'v.example', port: 443,
  uuid: UUID, tls: true, sni: 'v.example'
});
const TROJAN_NODE = Object.freeze({
  id: 'n_trojan', protocol: 'trojan', name: 'trojan', server: 't.example', port: 443, password: 'p', tls: true
});

test('every relayed node gets a loopback mixed inbound routed to its own outbound', () => {
  const { config, endpoints, skipped } = compileRelayConfig([VLESS_NODE]);
  assert.deepEqual(skipped, []);
  assert.deepEqual([...endpoints.keys()], ['n_vless']);
  const endpoint = endpoints.get('n_vless');
  assert.deepEqual([endpoint.host, endpoint.port, endpoint.udp], ['127.0.0.1', 23100, true]);
  assert.deepEqual(config.inbounds, [{
    type: 'mixed', tag: inboundTag('n_vless'), listen: '127.0.0.1', listen_port: 23100
  }]);
  assert.deepEqual(config.route.rules, [{ inbound: [inboundTag('n_vless')], outbound: outboundTag('n_vless') }]);
  assert.equal(config.route.final, 'relay-direct');
  const outbound = config.outbounds.find((item) => item.tag === outboundTag('n_vless'));
  assert.equal(outbound.type, 'vless');
  assert.equal(typeof outbound.detour, 'undefined');
});

test('a chain upstream joins the config as an outbound only, and the detour points at its tag', () => {
  const chained = { ...VLESS_NODE, chain: 'n_trojan' };
  // onlyIds 只把 VLESS 标成「要有入口」；TROJAN 是链上前置，不该白开端口，但必须在配置里。
  const { config, endpoints, skipped } = compileRelayConfig([chained, TROJAN_NODE], { onlyIds: new Set(['n_vless']) });
  assert.deepEqual(skipped, []);
  assert.deepEqual([...endpoints.keys()], ['n_vless']);
  assert.deepEqual(config.inbounds.map((item) => item.tag), [inboundTag('n_vless')]);
  const vlessOut = config.outbounds.find((item) => item.tag === outboundTag('n_vless'));
  const trojanOut = config.outbounds.find((item) => item.tag === outboundTag('n_trojan'));
  assert.equal(vlessOut.detour, outboundTag('n_trojan'));
  assert.equal(typeof trojanOut.detour, 'undefined');
  // 上游没有入口：没有它的 inbound 与 route 规则。
  assert.equal(config.inbounds.some((item) => item.tag === inboundTag('n_trojan')), false);
  assert.equal(config.route.rules.some((rule) => rule.outbound === outboundTag('n_trojan')), false);
});

test('a broken chain is skipped instead of emitting a config the kernel would reject', () => {
  const orphan = { ...VLESS_NODE, chain: 'n_missing' };
  const { config, endpoints, skipped } = compileRelayConfig([orphan]);
  assert.deepEqual(skipped, [{ nodeId: 'n_vless', reason: 'invalid_proxy_chain_missing' }]);
  assert.equal(endpoints.size, 0);
  assert.deepEqual(config.inbounds, []);
  assert.deepEqual(config.outbounds.map((item) => item.tag), ['relay-direct']);
});

test('an upstream that cannot compile prunes its downstream instead of leaking a direct dial', () => {
  const anytls = { id: 'n_up', protocol: 'anytls', name: 'up', server: 'u.example', port: 443, password: 'p', tls: true, sni: 'u.example' };
  const chained = { ...VLESS_NODE, chain: 'n_up' };
  // sing-box 1.12 才有 AnyTLS 出站：1.11 内核下上游编不出来，下游也必须一起剔除。
  const { endpoints, skipped } = compileRelayConfig([chained, anytls], { version: '1.11.0', onlyIds: new Set(['n_vless']) });
  assert.equal(endpoints.size, 0);
  assert.deepEqual(skipped, [{ nodeId: 'n_vless', reason: 'unsupported_proxy_chain_upstream_skipped' }]);
});

test('wireguard goes into the endpoints section, not outbounds, and still gets an inbound', () => {
  const wg = { ...SAMPLE_NODES.find((node) => node.name === 'wg'), id: 'n_wg' };
  const { config, endpoints } = compileRelayConfig([wg], { version: '1.13.19' });
  assert.deepEqual([...endpoints.keys()], ['n_wg']);
  assert.deepEqual((config.endpoints || []).map((item) => item.tag), [outboundTag('n_wg')]);
  assert.equal(config.outbounds.some((item) => item.tag === outboundTag('n_wg')), false);
  assert.deepEqual(config.inbounds.map((item) => item.tag), [inboundTag('n_wg')]);
});

// ============================================================
// 服务层：本机中转回退 / fail-closed / 只对本机生效
// ============================================================

const SERVICE_NODES = Object.freeze([
  { id: 'n_vless', protocol: 'vless', name: 'vless', server: 'v.example', port: 443, uuid: UUID, tls: true, sni: 'v.example' },
  { id: 'n_ss', protocol: 'shadowsocks', name: 'ss', server: 'ss.example', port: 8388, cipher: 'aes-256-gcm', password: 'secret' }
]);

function fakeRelay({ available = true, endpoints = new Map(), listenHost = '' } = {}) {
  const calls = { ensure: [] };
  return {
    calls,
    availability: () => (available
      ? {
        available: true, binary: '/opt/sing-box', source: 'explicit', version: '1.13.19',
        running: endpoints.size > 0, nodes: endpoints.size, basePort: 23100, maxPort: 23355,
        portRange: '23100-23655', listenHost, authRequired: [...endpoints.values()].some((item) => item.username),
        kernels: []
      }
      : { available: false, error: 'relay_binary_not_found' }),
    activeEndpoints: () => new Map(endpoints),
    activeListenHost: () => (endpoints.size ? listenHost : ''),
    ensure: async (nodes, options = {}) => {
      calls.ensure.push({
        ids: nodes.map((node) => node.id),
        onlyIds: options.onlyIds ? [...options.onlyIds] : null,
        remote: options.remote === true
      });
      return { ok: true, endpoints: new Map(endpoints), skipped: [] };
    }
  };
}

async function withService(nodes, relay, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-relay-'));
  try {
    const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now: () => 1 });
    const service = new SubscriptionAggregatorService({
      store,
      now: () => 1,
      relay,
      sources: {
        listSources: () => [{ id: 'sub_a', name: 'A', url: 'https://a.example', nodeCount: nodes.length, lastSyncedAt: 1 }],
        listNodes: () => nodes.map((node) => ({ ...node, subscriptionId: 'sub_a' })),
        syncSource: async () => ({ ok: true })
      }
    });
    const profile = store.saveProfile({ name: 'relay', refreshHours: 0 });
    // 必须 await：不然 finally 会在异步用例跑完之前就把临时目录删掉。
    return await run(service, profile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function proxiesOf(body) {
  return YAML.parse(body).proxies;
}

test('a running relay substitutes a local socks5 entry for the protocols the Premium core cannot dial', async () => {
  const relay = fakeRelay({ endpoints: new Map([['n_vless', { host: '127.0.0.1', port: 23101, udp: true }]]) });
  await withService(SERVICE_NODES, relay, (service, profile) => {
    // 预览是同步的，而且不拉进程：读的是已经在跑的那一份（本机请求才有意义）。
    const result = service.preview(profile.id, 'clash-classic', { remoteAddress: '127.0.0.1' });
    assert.equal(result.ok, true);
    assert.equal(result.relay.active, true);
    assert.equal(result.relay.nodes, 1);
    assert.equal(result.relay.candidates, 1);
    const proxies = proxiesOf(result.content);
    // 名字必须保持原样：策略组与分流规则引用的都是节点名。
    assert.deepEqual(proxies.find((proxy) => proxy.name === 'vless'), {
      name: 'vless', type: 'socks5', server: '127.0.0.1', port: 23101, udp: true
    });
    // 内核本来就认的协议照常直连。
    const ss = proxies.find((proxy) => proxy.name === 'ss');
    assert.equal(ss.type, 'ss');
    assert.equal(ss.server, 'ss.example');
    // 已经交给边车的节点不该再报「内核不支持」，也不该再写 dialer-proxy（链在边车里）。
    assert.deepEqual(result.warnings, []);
    assert.equal('dialer-proxy' in proxies.find((proxy) => proxy.name === 'vless'), false);
    assert.equal(relay.calls.ensure.length, 0);
  });
});

test('asking for the relay while the sidecar is idle warns instead of silently emitting raw nodes', async () => {
  const relay = fakeRelay({ endpoints: new Map() });
  await withService(SERVICE_NODES, relay, (service, profile) => {
    const result = service.preview(profile.id, 'clash-classic', { relay: true, remoteAddress: '127.0.0.1' });
    assert.equal(result.relay.active, false);
    // 预览不起进程：提示「先启动中转」，而不是静默输出内核可能加载不了的节点。
    assert.deepEqual(result.warnings, ['aggregator_relay_unavailable:relay_not_running']);
    assert.equal(proxiesOf(result.content).find((proxy) => proxy.name === 'vless').type, 'vless');
    assert.equal(relay.calls.ensure.length, 0);
  });
});

test('a target without relayFallback never falls back, even if the relay is running', async () => {
  const relay = fakeRelay({ endpoints: new Map([['n_vless', { host: '127.0.0.1', port: 23101, udp: true }]]) });
  await withService(SERVICE_NODES, relay, (service, profile) => {
    const result = service.preview(profile.id, 'mihomo');
    assert.equal(result.relay.candidates, 0);
    assert.equal(result.relay.active, false);
    assert.equal(proxiesOf(result.content).find((proxy) => proxy.name === 'vless').type, 'vless');
    assert.deepEqual(result.warnings, []);
  });
});

test('a loopback Premium client pull starts the sidecar by default and reports it on the pull record', async () => {
  const relay = fakeRelay({ endpoints: new Map([['n_vless', { host: '127.0.0.1', port: 23101, udp: true }]]) });
  await withService(SERVICE_NODES, relay, async (service, profile) => {
    const pulled = await service.serveSubscription(profile.token, {
      userAgent: 'ClashX/1.118.0 (com.west2online.ClashX)',
      remoteAddress: '127.0.0.1'
    });
    assert.equal(pulled.status, 200);
    // 只需中转内核认不出的那个节点；本机请求不升级成暴露形态（remote: false）。
    assert.deepEqual(relay.calls.ensure, [{ ids: ['n_vless'], onlyIds: ['n_vless'], remote: false }]);
    assert.equal(proxiesOf(pulled.body).find((proxy) => proxy.name === 'vless').type, 'socks5');
    const pull = service.getOverview().profiles[0].recentPulls[0];
    assert.deepEqual([pull.relayNodes, pull.relayError], [1, '']);
  });
});

test('relay=0 from a loopback client skips the sidecar entirely', async () => {
  const relay = fakeRelay({ endpoints: new Map() });
  await withService(SERVICE_NODES, relay, async (service, profile) => {
    const pulled = await service.serveSubscription(profile.token, {
      userAgent: 'ClashX/1.118.0 (com.west2online.ClashX)',
      remoteAddress: '127.0.0.1',
      relay: false
    });
    assert.equal(relay.calls.ensure.length, 0);
    assert.equal(proxiesOf(pulled.body).find((proxy) => proxy.name === 'vless').type, 'vless');
    const pull = service.getOverview().profiles[0].recentPulls[0];
    assert.deepEqual([pull.relayNodes, pull.relayError], [0, '']);
  });
});

test('a remote client gets entries on its own host with credentials instead of loopback ones', async () => {
  const relay = fakeRelay({
    endpoints: new Map([['n_vless', { host: '0.0.0.0', port: 23101, udp: true, username: 'aih-relay', password: 'secret' }]]),
    listenHost: '0.0.0.0'
  });
  await withService(SERVICE_NODES, relay, async (service, profile) => {
    const pulled = await service.serveSubscription(profile.token, {
      userAgent: 'ClashX/1.118.0 (com.west2online.ClashX)',
      remoteAddress: '203.0.113.8',
      origin: 'http://aih.example:9527'
    });
    // 远端客户端也要能用：这次真的拉边车，并要求它绑可达地址（remote: true）。
    assert.deepEqual(relay.calls.ensure.map((call) => call.remote), [true]);
    // 入口写客户端自己用的 Host，并带上认证 —— 127.0.0.1 对那边没有意义。
    assert.deepEqual(proxiesOf(pulled.body).find((proxy) => proxy.name === 'vless'), {
      name: 'vless', type: 'socks5', server: 'aih.example', port: 23101,
      username: 'aih-relay', password: 'secret', udp: true
    });
    const pull = service.getOverview().profiles[0].recentPulls[0];
    assert.deepEqual([pull.relayNodes, pull.relayError], [1, '']);
  });
});

test('a remote client without a usable Host gets no entries at all (fail-closed)', async () => {
  const relay = fakeRelay({ endpoints: new Map([['n_vless', { host: '0.0.0.0', port: 23101, udp: true }]]), listenHost: '0.0.0.0' });
  await withService(SERVICE_NODES, relay, async (service, profile) => {
    const pulled = await service.serveSubscription(profile.token, {
      userAgent: 'ClashX/1.118.0 (com.west2online.ClashX)',
      remoteAddress: '203.0.113.8'
    });
    // 拿不到客户端用的地址就给不出可达入口：这一轮不中转，节点按原样输出。
    assert.equal(relay.calls.ensure.length, 0);
    assert.equal(proxiesOf(pulled.body).find((proxy) => proxy.name === 'vless').type, 'vless');
  });
});

test('startRelay spawns on demand from the machine itself and upgrades to the exposed form for remote callers', async () => {
  const relay = fakeRelay({ endpoints: new Map([['n_vless', { host: '127.0.0.1', port: 23101, udp: true }]]) });
  await withService(SERVICE_NODES, relay, async (service, profile) => {
    const started = await service.startRelay(profile.id, { target: 'clash-classic', remoteAddress: '127.0.0.1' });
    assert.equal(started.ok, true);
    assert.deepEqual([started.relay.active, started.relay.nodes, started.relay.remote], [true, 1, false]);
    assert.deepEqual(relay.calls.ensure.map((call) => call.remote), [false]);

    const remote = await service.startRelay(profile.id, {
      target: 'clash-classic', remoteAddress: '203.0.113.8', origin: 'http://aih.example:9527'
    });
    assert.equal(remote.relay.error, '');
    assert.deepEqual([remote.relay.remote, remote.relay.advertiseHost], [true, 'aih.example']);
    assert.deepEqual(relay.calls.ensure.map((call) => call.remote), [false, true]);

    // 远端但拿不到 Host：直接失败并说清原因，不去拉一个客户端连不到的边车。
    const unknown = await service.startRelay(profile.id, { target: 'clash-classic', remoteAddress: '203.0.113.8' });
    assert.equal(unknown.relay.error, 'relay_origin_unknown');
    assert.equal(relay.calls.ensure.length, 2);
  });
});




// ============================================================
// 多内核：sing-box 编不出来的（xhttp / VLESS Encryption / SSR / Mieru）交给 mihomo
// ============================================================

const { KERNELS, splitByKernel } = require('../lib/cli/services/toolkit/subscription-aggregator/relay/kernels');
const { compileMihomoRelayConfig } = require('../lib/cli/services/toolkit/subscription-aggregator/relay/mihomo-config');
const { resolveRelayCredentials } = require('../lib/cli/services/toolkit/subscription-aggregator/relay/relay-credentials');

const KERNEL_NODES = Object.freeze([
  { id: 'k_vless', protocol: 'vless', name: 'vless', server: 'v.example', port: 443, uuid: UUID, tls: true },
  { id: 'k_xhttp', protocol: 'vless', name: 'xhttp', server: 'x.example', port: 443, uuid: UUID, network: 'xhttp', path: '/x', tls: true },
  { id: 'k_enc', protocol: 'vless', name: 'enc', server: 'e.example', port: 443, uuid: UUID, encryption: 'mlkem768x25519plus.native.0rtt.KEY', tls: true },
  { id: 'k_ssr', protocol: 'shadowsocksr', name: 'ssr', server: 's.example', port: 8443, cipher: 'aes-256-cfb', password: 'p', ssrProtocol: 'auth_aes128_md5', ssrObfs: 'tls1.2_ticket_auth' },
  { id: 'k_naive', protocol: 'naive', name: 'naive', server: 'n.example', port: 443, username: 'u', password: 'p', tls: true }
]);

test('nodes sing-box cannot compile go to mihomo, and a chain never straddles the two kernels', () => {
  assert.deepEqual(KERNELS.map((kernel) => kernel.id), ['sing-box', 'mihomo']);
  const groups = splitByKernel(KERNEL_NODES);
  const byKernel = Object.fromEntries(groups.map((group) => [group.kernel.id, group.nodes.map((node) => node.id)]));
  // sing-box 没有 xhttp 传输、没有 VLESS Encryption、没有 SSR 出站；naive 反过来只有它有。
  assert.deepEqual(byKernel['sing-box'], ['k_vless', 'k_naive']);
  assert.deepEqual(byKernel.mihomo, ['k_xhttp', 'k_enc', 'k_ssr']);

  // 链上的前置跟着下游走：同一个内核才能让 detour 指得到 tag。
  const chained = [{ ...KERNEL_NODES[1], chain: 'k_ssr' }, KERNEL_NODES[3]];
  const chainedGroups = splitByKernel(chained);
  assert.deepEqual(chainedGroups.map((group) => [group.kernel.id, group.nodes.map((node) => node.id)]), [
    ['mihomo', ['k_xhttp', 'k_ssr']]
  ]);
});

test('the mihomo relay config binds one listener per node to its own outbound, with credentials', () => {
  const { config, endpoints, skipped } = compileMihomoRelayConfig(
    [{ ...KERNEL_NODES[2], chain: 'k_ssr' }, KERNEL_NODES[3]],
    { onlyIds: new Set(['k_enc']), listenHost: '0.0.0.0', advertiseHost: '1.2.3.4', auth: { username: 'u', password: 'p' } }
  );
  assert.deepEqual(skipped, []);
  assert.deepEqual([...endpoints.keys()], ['k_enc']);
  assert.deepEqual(endpoints.get('k_enc'), { host: '1.2.3.4', port: 23400, udp: true });
  // 入口 → 出站是钉死的（listeners[].proxy），并带认证。
  assert.deepEqual(config.listeners, [{
    name: 'relay-in-k_enc',
    type: 'mixed',
    listen: '0.0.0.0',
    port: 23400,
    proxy: 'relay-k_enc',
    users: [{ username: 'u', password: 'p' }]
  }]);
  // 链上前置只做出站（没有入口），下游用 dialer-proxy 指过去。
  assert.deepEqual(config.proxies.map((proxy) => proxy.name), ['relay-k_enc', 'relay-k_ssr']);
  assert.equal(config.proxies[0]['dialer-proxy'], 'relay-k_ssr');
  assert.equal('dialer-proxy' in config.proxies[1], false);
});

test('a kernel installed after the fact is picked up without restarting the server', () => {
  // 内核查找失败不能缓存：用户把 sing-box 装进 ~/.ai_home/bin 之后，下一次拉订阅就该能用，
  // 而不是「必须重启服务」（真实踩到过：AWS 上装完内核仍然 0 节点）。
  const files = new Set();
  const fakeFs = {
    constants: { X_OK: 1 },
    statSync: (file) => {
      if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
    accessSync: (file) => { if (!files.has(file)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    readFileSync: () => '{}'
  };
  const { KernelSidecar } = require('../lib/cli/services/toolkit/subscription-aggregator/relay/kernel-sidecar');
  const sidecar = new KernelSidecar({
    kernel: KERNELS[0],
    fs: fakeFs,
    path: path.posix,
    env: { PATH: '', AIH_RELAY_SING_BOX_BIN: '/opt/sing-box' },
    aiHomeDir: '/home/u/.ai_home',
    spawnSync: () => ({ status: 0, stdout: 'sing-box version 1.13.19' })
  });
  assert.equal(sidecar.availability().available, false);
  assert.equal(sidecar.availability().error, 'relay_binary_not_found');
  files.add('/opt/sing-box');
  assert.deepEqual([sidecar.availability().available, sidecar.availability().version], [true, '1.13.19']);
});

test('relay credentials live in a private file that survives restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-relay-creds-'));
  try {
    const generated = resolveRelayCredentials({ runDir: dir, env: {} });
    assert.equal(generated.source, 'generated');
    assert.ok(generated.password.length >= 16);
    // 重启后必须还能读到同一串（客户端配置里已经写着它了）。
    const again = resolveRelayCredentials({ runDir: dir, env: {} });
    assert.deepEqual([again.username, again.password, again.source], [generated.username, generated.password, 'file']);
    const mode = fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 真内核校验：装了内核就校验编译结果与真实监听，没装就跳过（不依赖内核也能跑单测）
// ============================================================

test('the compiled relay config passes the real kernel check when sing-box is installed', (t) => {
  const { spawnSync } = require('node:child_process');
  const binary = resolveSingBoxBinary({});
  if (!binary) {
    t.skip('本机没有 sing-box，跳过真内核校验');
    return;
  }
  const probe = spawnSync(binary.path, ['version'], { encoding: 'utf8', timeout: 10000 });
  const version = probe && probe.status === 0 ? parseSingBoxVersion(probe.stdout) : '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-relay-check-'));
  try {
    // 一条链式 VLESS（前置 TROJAN）+ Hysteria2 + WireGuard（endpoints 段）。
    // WireGuard 的密钥必须是合法 base64（样本里的占位值会被内核拒绝，那是夹具问题不是编译器问题）。
    const chained = { ...VLESS_NODE, chain: 'n_trojan' };
    const hy2 = { ...SAMPLE_NODES.find((node) => node.name === 'hy2'), id: 'n_hy2' };
    const wg = {
      ...SAMPLE_NODES.find((node) => node.name === 'wg'),
      id: 'n_wg',
      privateKey: Buffer.alloc(32, 1).toString('base64'),
      publicKey: Buffer.alloc(32, 2).toString('base64')
    };
    const { config, endpoints } = compileRelayConfig([chained, TROJAN_NODE, hy2, wg], {
      version: version || undefined,
      onlyIds: new Set(['n_vless', 'n_hy2', 'n_wg'])
    });
    assert.deepEqual([...endpoints.keys()].sort(), ['n_hy2', 'n_vless', 'n_wg']);
    const configPath = path.join(dir, 'relay.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const check = spawnSync(binary.path, ['check', '-c', configPath], { encoding: 'utf8', timeout: 20000 });
    assert.equal(check.status, 0, check.stderr || check.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a remote client gets a working, authenticated entry on the LAN address (real sing-box)', async (t) => {
  const { spawnSync } = require('node:child_process');
  const net = require('node:net');
  const { LocalRelay } = require('../lib/cli/services/toolkit/subscription-aggregator/relay/local-relay');
  const binary = resolveSingBoxBinary({});
  if (!binary) {
    t.skip('本机没有 sing-box，跳过真内核中转校验');
    return;
  }
  const lanAddress = Object.values(require('node:os').networkInterfaces())
    .flat()
    .find((item) => item && item.family === 'IPv4' && !item.internal)?.address || '';
  if (!lanAddress) {
    t.skip('这台机器没有非回环 IPv4，跳过');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-relay-exposed-'));
  // dedicated 模式（每节点一个端口 + 远端绑 0.0.0.0）：server 模式默认不暴露，另有用例覆盖。
  // basePort 挪到 24100：本机可能正跑着生产边车（占着 23100+），测试不该跟它抢端口。
  const relay = new LocalRelay({
    runDir: dir, env: { AIH_RELAY_PORT_MODE: 'dedicated' }, basePort: 24100, readinessTimeoutMs: 15000
  });
  try {
    // 远端客户端：绑可达地址 + 认证。节点是假的上游（连不通没关系，验的是入口本身）。
    const result = await relay.ensure([{ ...VLESS_NODE }], { onlyIds: new Set(['n_vless']), remote: true });
    assert.equal(result.ok, true, result.error + ' ' + (result.detail || ''));
    const endpoint = result.endpoints.get('n_vless');
    const credentials = relay.credentials();
    assert.deepEqual([endpoint.port, endpoint.username, endpoint.password], [24100, credentials.username, credentials.password]);
    assert.equal(relay.activeListenHost(), '0.0.0.0');
    assert.equal(relay.isExposed(), true);

    // 从本机（回环）与局域网地址都连得上；认证必须真的生效：
    // 只提供 no-auth 的握手被拒（0xff），密码错被拒，密码对才通过。
    const handshake = (host, credentials = null) => new Promise((resolve) => {
      const socket = net.connect({ host, port: endpoint.port });
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.setTimeout(3000);
      socket.once('error', () => done('error'));
      socket.once('connect', () => {
        socket.write(credentials ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
      });
      let stage = 'greeting';
      socket.on('data', (chunk) => {
        if (stage === 'greeting') {
          if (chunk[1] === 0xff) return done('no-acceptable-method');
          if (chunk[1] === 0x00) return done('no-auth-accepted');
          stage = 'auth';
          const user = Buffer.from(credentials.username);
          const password = Buffer.from(credentials.password);
          socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([password.length]), password]));
          return undefined;
        }
        return done(chunk[1] === 0x00 ? 'authenticated' : 'auth-rejected');
      });
    });
    for (const host of ['127.0.0.1', lanAddress]) {
      assert.equal(await handshake(host), 'no-acceptable-method', `${host}: 无凭据必须被拒`);
      assert.equal(await handshake(host, { username: credentials.username, password: 'wrong' }), 'auth-rejected');
      assert.equal(await handshake(host, credentials), 'authenticated');
    }
    // 边车配置里确实写着认证（不是靠别的手段）。
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'sing-box', 'sing-box.json'), 'utf8'));
    assert.deepEqual(config.inbounds[0].users, [{ username: credentials.username, password: credentials.password }]);
    assert.equal(config.inbounds[0].listen, '0.0.0.0');
  } finally {
    await relay.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server port mode keeps the sidecar on loopback and resolves a node from its SOCKS5 username', async (t) => {
  const { LocalRelay } = require('../lib/cli/services/toolkit/subscription-aggregator/relay/local-relay');
  const { userNameForNode } = require('../lib/cli/services/toolkit/subscription-aggregator/relay/relay-users');
  const binary = resolveSingBoxBinary({});
  if (!binary) {
    t.skip('本机没有 sing-box，跳过真内核中转校验');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-relay-serverport-'));
  const relay = new LocalRelay({
    runDir: dir, env: { AIH_RELAY_PORT_MODE: 'server' }, basePort: 24100, readinessTimeoutMs: 15000
  });
  try {
    assert.equal(relay.portMode(), 'server');
    assert.equal(relay.serverPortMode(), true);
    const result = await relay.ensure([{ ...VLESS_NODE }], { onlyIds: new Set(['n_vless']), remote: true });
    assert.equal(result.ok, true, result.error + ' ' + (result.detail || ''));
    // 关键：server 模式下即使请求来自远端也不暴露边车 —— 入口是 AIH 自己的端口。
    assert.equal(relay.activeListenHost(), '127.0.0.1');
    assert.equal(relay.isExposed(), false);

    const mux = relay.muxConfig();
    const user = userNameForNode('n_vless');
    assert.equal(mux.enabled, true);
    assert.equal(mux.portForUser(user), result.endpoints.get('n_vless').port);
    assert.equal(mux.portForUser('n_unknown'), 0);
    assert.equal(userNameForNode('n_vless'), user, '用户名必须稳定（客户端会缓存它）');
    // 边车配置里没有 users：认证在分流器那一层做（见 lib/server/relay-port-mux）。
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'sing-box', 'sing-box.json'), 'utf8'));
    assert.equal(config.inbounds[0].listen, '127.0.0.1');
    assert.equal('users' in config.inbounds[0], false);
  } finally {
    await relay.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mihomo carries the transports sing-box cannot (real mihomo, when installed)', async (t) => {
  const { LocalRelay } = require('../lib/cli/services/toolkit/subscription-aggregator/relay/local-relay');
  const mihomoKernel = KERNELS.find((kernel) => kernel.id === 'mihomo');
  const binary = mihomoKernel.resolveBinary({});
  if (!binary) {
    t.skip('本机没有 mihomo（AIH_RELAY_MIHOMO_BIN 或 ~/.ai_home/bin/mihomo），跳过');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-relay-mihomo-'));
  // 用真实环境变量（AIH_RELAY_MIHOMO_BIN 等）：内核位置就是这么传进去的。
  const relay = new LocalRelay({
    runDir: dir, env: { ...process.env, AIH_RELAY_PORT_MODE: 'dedicated' }, basePort: 24400, readinessTimeoutMs: 15000
  });
  try {
    const result = await relay.ensure([{ ...KERNEL_NODES[1] }], { onlyIds: new Set(['k_xhttp']), remote: true });
    assert.equal(result.ok, true, result.error + ' ' + (result.detail || ''));
    const endpoint = result.endpoints.get('k_xhttp');
    assert.equal(typeof endpoint.port, 'number');
    assert.equal(relay.sidecar('mihomo').activeListenHost(), '0.0.0.0');
    const text = fs.readFileSync(path.join(dir, 'mihomo', 'mihomo.yaml'), 'utf8');
    assert.match(text, /proxy: "?relay-k_xhttp"?/);
    // 监听与认证都落在配置里（mihomo 的 listeners[].proxy 把入口钉到这个出站）。
    assert.match(text, /listen: "?0\.0\.0\.0"?/);
    assert.match(text, /username: "?aih-relay"?/);
  } finally {
    await relay.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

