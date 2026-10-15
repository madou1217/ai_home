'use strict';

// SSH / Mieru / Naive：三个只在部分客户端有出站的协议。
// SSH 与 Mieru 没有公认的分享链接（只从配置导入）；Naive 有 naive+https:// 链接，且 sing-box
// 出站只在官方 App（自带 libcronet）上可用。

const assert = require('node:assert/strict');
const test = require('node:test');
const YAML = require('yaml');

const { compileMihomoProxy, emitYaml } = require('../lib/cli/services/toolkit/proxy-pool/cores/mihomo/proxy-compiler');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const {
  encodeProxyNode,
  parseProxyNode,
  parseSubscriptionContentDetailed
} = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const {
  buildProxyNodeConnectionKey,
  validateProxyNodeInput
} = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');

const SSH_NODE = Object.freeze({
  protocol: 'ssh', name: 'ssh-out', server: 'ssh.example', port: 22, username: 'root', password: 'pw'
});
const SSH_KEY_NODE = Object.freeze({
  protocol: 'ssh', name: 'ssh-key', server: 'ssh2.example', port: 2222, username: 'ops', privateKey: 'KEY',
  privateKeyPassphrase: 'pp', hostKey: 'ssh-rsa AAA', hostKeyAlgorithms: 'rsa'
});
const MIERU_NODE = Object.freeze({
  protocol: 'mieru', name: 'mieru', server: 'mi.example', port: 2999, username: 'u', password: 'p',
  transport: 'TCP', multiplexing: 'MULTIPLEXING_LOW', handshakeMode: 'HANDSHAKE_STANDARD', trafficPattern: 'AQID'
});
const MIERU_RANGE_NODE = Object.freeze({
  protocol: 'mieru', name: 'mieru-range', server: 'mi2.example', port: 2090, username: 'u', password: 'p',
  transport: 'UDP', ports: '2090-2099'
});
const NAIVE_NODE = Object.freeze({
  protocol: 'naive', name: 'naive', server: 'na.example', port: 443, username: 'u', password: 'p', sni: 'na.example'
});

test('SSH 编译成 mihomo 与 sing-box 出站，两边的键名各自正确', () => {
  assert.deepEqual(compileMihomoProxy(SSH_KEY_NODE, SSH_KEY_NODE.name), {
    name: 'ssh-key',
    type: 'ssh',
    server: 'ssh2.example',
    port: 2222,
    username: 'ops',
    'private-key': 'KEY',
    'private-key-passphrase': 'pp',
    'host-key': ['ssh-rsa AAA'],
    'host-key-algorithms': ['rsa']
  });
  assert.deepEqual(compileSingBoxNodeOutbound(SSH_KEY_NODE, SSH_KEY_NODE.name), {
    type: 'ssh',
    tag: 'ssh-key',
    server: 'ssh2.example',
    server_port: 2222,
    user: 'ops',
    private_key: 'KEY',
    private_key_passphrase: 'pp',
    host_key: ['ssh-rsa AAA'],
    host_key_algorithms: ['rsa']
  });
});

test('SSH 的 Clash 与 sing-box 条目都能导入，且往返后连接指纹不变', () => {
  const yaml = emitYaml({ proxies: [compileMihomoProxy(SSH_KEY_NODE, SSH_KEY_NODE.name)] });
  const [fromClash] = parseSubscriptionContentDetailed(yaml).nodes;
  assert.equal(buildProxyNodeConnectionKey(fromClash), buildProxyNodeConnectionKey(SSH_KEY_NODE));

  const config = JSON.stringify({ outbounds: [compileSingBoxNodeOutbound(SSH_KEY_NODE, SSH_KEY_NODE.name)] });
  const [fromSingBox] = parseSubscriptionContentDetailed(config).nodes;
  assert.equal(buildProxyNodeConnectionKey(fromSingBox), buildProxyNodeConnectionKey(SSH_KEY_NODE));

  // 密码与私钥二选一；都没有时导入后校验不通过。
  assert.throws(() => validateProxyNodeInput({ protocol: 'ssh', server: 'a.example', port: 22, username: 'root' }), /missing_required_proxy_field_password/);
  validateProxyNodeInput(SSH_NODE);
});

test('Mieru 只有 mihomo 有出站，端口范围写成 port-range 且与 port 互斥', () => {
  assert.deepEqual(compileMihomoProxy(MIERU_NODE, MIERU_NODE.name), {
    name: 'mieru',
    type: 'mieru',
    server: 'mi.example',
    port: 2999,
    username: 'u',
    password: 'p',
    transport: 'TCP',
    multiplexing: 'MULTIPLEXING_LOW',
    'handshake-mode': 'HANDSHAKE_STANDARD',
    'traffic-pattern': 'AQID'
  });
  const range = compileMihomoProxy(MIERU_RANGE_NODE, MIERU_RANGE_NODE.name);
  assert.equal(range.port, undefined);
  assert.equal(range['port-range'], '2090-2099');

  const yaml = emitYaml({ proxies: [compileMihomoProxy(MIERU_RANGE_NODE, MIERU_RANGE_NODE.name)] });
  const [imported] = parseSubscriptionContentDetailed(yaml).nodes;
  assert.deepEqual([imported.port, imported.ports], [2090, '2090-2099']);
  assert.equal(buildProxyNodeConnectionKey(imported), buildProxyNodeConnectionKey(MIERU_RANGE_NODE));

  // sing-box 没有 mieru 出站：整类节点跳过，不会让配置被拒。
  assert.throws(() => compileSingBoxNodeOutbound(MIERU_NODE, 'mieru'), { code: 'unsupported_proxy_protocol_mieru' });
  assert.throws(() => validateProxyNodeInput({ ...MIERU_NODE, transport: 'quic' }), /invalid_proxy_field_transport/);
  // mihomo 把 mieru 的 transport 当必填：缺了要在这里编不出来（渲染时跳过 / 中转时交给别的内核），
  // 否则它会输出一份让 mihomo 拒掉整份配置的条目。
  assert.throws(() => compileMihomoProxy({ ...MIERU_NODE, transport: undefined }, 'mieru'), {
    code: 'missing_required_proxy_field_transport'
  });
});

test('Naive 走 naive+https / naive+quic 链接，sing-box 只给官方 App 输出', () => {
  assert.equal(encodeProxyNode(NAIVE_NODE), 'naive+https://u:p@na.example:443?sni=na.example#naive');
  assert.deepEqual(
    [parseProxyNode('naive+quic://u:p@na.example:443#q').quic, parseProxyNode('naive+quic://u:p@na.example:443#q').sni],
    [true, undefined]
  );
  assert.equal(parseProxyNode('naive+https://na.example:443#no-creds'), null);

  // 自建内核没有 libcronet：非官方 App 与低版本内核都跳过。
  assert.throws(
    () => compileSingBoxNodeOutbound(NAIVE_NODE, 'naive', { version: '1.13.0' }),
    { code: 'requires_sing_box_official_app' }
  );
  assert.throws(
    () => compileSingBoxNodeOutbound(NAIVE_NODE, 'naive', { officialApp: true, version: '1.12.0' }),
    { code: 'requires_sing_box_1.13.0' }
  );
  const outbound = compileSingBoxNodeOutbound(NAIVE_NODE, 'naive', { officialApp: true, version: '1.13.0' });
  assert.deepEqual(outbound, {
    type: 'naive',
    tag: 'naive',
    server: 'na.example',
    server_port: 443,
    username: 'u',
    password: 'p',
    tls: { enabled: true, server_name: 'na.example' }
  });
  const [imported] = parseSubscriptionContentDetailed(JSON.stringify({ outbounds: [outbound] })).nodes;
  assert.equal(buildProxyNodeConnectionKey(imported), buildProxyNodeConnectionKey(NAIVE_NODE));
  // mihomo 系没有 naive 出站。
  assert.throws(() => getRenderer('mihomo').compileNode({ node: NAIVE_NODE, name: 'naive' }), { code: 'unsupported_proxy_protocol_naive' });
});

test('Surge 系与 QX 跳过这三个协议，且不写进 YAML 之外的格式', () => {
  for (const id of ['surge', 'surfboard', 'loon', 'quantumult-x', 'egern']) {
    for (const [node, protocol] of [[SSH_NODE, 'ssh'], [MIERU_NODE, 'mieru'], [NAIVE_NODE, 'naive']]) {
      assert.throws(() => getRenderer(id).compileNode({ node, name: node.name }), { code: `unsupported_proxy_protocol_${protocol}` }, `${id}/${protocol}`);
    }
  }
  // mihomo 的节点视图里只有 mihomo 编得出来的那两个。
  const mihomo = getRenderer('mihomo');
  const compiled = [SSH_NODE, MIERU_NODE].map((node) => mihomo.compileNode({ node, name: node.name }));
  assert.deepEqual(YAML.parse(emitYaml({ proxies: compiled })).proxies.map((proxy) => proxy.type), ['ssh', 'mieru']);
});
