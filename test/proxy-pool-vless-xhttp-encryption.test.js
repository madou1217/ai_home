'use strict';

// VLESS 的 XHTTP 传输与 VLESS Encryption：能表达的格式往返一致，表达不了的格式如实跳过。

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseSubscriptionContentDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const { compileMihomoProxy } = require('../lib/cli/services/toolkit/proxy-pool/cores/mihomo/proxy-compiler');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const { compileSurgeFamilyLine } = require('../lib/cli/services/toolkit/proxy-pool/cores/surge/proxy-line');
const { buildProxyNodeConnectionKey, validateProxyNodeInput } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const { UUID, VLESS_XHTTP_NODE, assertRoundTrip } = require('./helpers/proxy-format-samples');

const NAME = VLESS_XHTTP_NODE.name;

// Clash 系没有单独的 security 键（明文 TLS 就是 tls: true），而分享链接只认 security=，
// 所以同一个节点在两个方向上的等价写法不同：链接往返用带 security 的那一份。
const asLinkNode = (node) => ({ ...node, security: 'tls' });

test('XHTTP compiles to mihomo xhttp-opts and round-trips through Clash, links and JSON', () => {
  const proxy = compileMihomoProxy(VLESS_XHTTP_NODE, NAME);
  assert.equal(proxy.network, 'xhttp');
  assert.deepEqual(proxy['xhttp-opts'], { path: '/xh', host: 'cdn.example', mode: 'packet-up' });
  assert.equal(proxy.tls, true);

  for (const id of ['mihomo', 'stash']) {
    const renderer = getRenderer(id);
    assertRoundTrip(id, renderer.render(null, [renderer.compileNode({ node: VLESS_XHTTP_NODE, name: NAME })], { view: 'nodes' }), [VLESS_XHTTP_NODE]);
  }

  const links = getRenderer('base64');
  const linkNode = asLinkNode(VLESS_XHTTP_NODE);
  const link = links.compileNode({ node: linkNode, name: NAME });
  assert.match(link, /[?&]type=xhttp(&|#|$)/);
  assert.match(link, /[?&]mode=packet-up(&|#|$)/);
  assertRoundTrip('link', links.render(null, [link]), [linkNode]);

  const json = getRenderer('json');
  assertRoundTrip('json', json.render(null, [json.compileNode({ node: VLESS_XHTTP_NODE, name: NAME })]), [VLESS_XHTTP_NODE]);
});

test('XHTTP is skipped by the formats that cannot express it', () => {
  // sing-box 没有 xhttp 传输。
  assert.throws(() => compileSingBoxNodeOutbound(VLESS_XHTTP_NODE, NAME), { code: 'unsupported_proxy_transport_xhttp' });
  for (const id of ['loon', 'quantumult-x', 'egern']) {
    assert.throws(() => getRenderer(id).compileNode({ node: VLESS_XHTTP_NODE, name: NAME }), { code: 'unsupported_proxy_transport_xhttp' }, id);
  }
  // Loon 的传输参数只认 tcp / ws / http。
  assert.throws(() => compileSurgeFamilyLine('loon', VLESS_XHTTP_NODE, NAME), { code: 'unsupported_proxy_transport_xhttp' });
});

test('splithttp is the same transport as xhttp', () => {
  const node = parseSubscriptionContentDetailed(
    `vless://${UUID}@xh.example:443?type=splithttp&mode=stream-up&path=%2Fsp&host=sp.example&security=tls#split`
  ).nodes[0];
  assert.equal(node.network, 'xhttp');
  assert.equal(node.mode, 'stream-up');
  validateProxyNodeInput(node);
  // 导出统一写 xhttp。
  assert.match(getRenderer('uri').compileNode({ node, name: 'split' }), /[?&]type=xhttp(&|#|$)/);
  // VMess 不能用 XHTTP。
  assert.throws(
    () => validateProxyNodeInput({ protocol: 'vmess', server: 'a.example', port: 443, uuid: UUID, network: 'xhttp' }),
    /unsupported_proxy_transport_xhttp/
  );
});

test('VLESS Encryption is written where it is understood and skipped where it is not', () => {
  // 明文 tcp 上没有传输层参数：路径与 Host 与 xhttp 样本无关，一并去掉。
  const node = {
    ...VLESS_XHTTP_NODE, network: 'tcp', mode: undefined, path: undefined, host: undefined,
    encryption: 'mlkem768x25519plus.native.0rtt.KEY', pqv: '1'
  };
  const proxy = compileMihomoProxy(node, 'enc');
  assert.equal(proxy.encryption, 'mlkem768x25519plus.native.0rtt.KEY');
  for (const id of ['mihomo', 'stash']) {
    const renderer = getRenderer(id);
    assertRoundTrip(id, renderer.render(null, [renderer.compileNode({ node, name: 'enc' })], { view: 'nodes' }), [{ ...node, name: 'enc' }]);
  }

  // 链接保留 encryption 与 pqv。
  const linkNode = { ...asLinkNode(node), name: 'enc' };
  const link = getRenderer('uri').compileNode({ node: linkNode, name: 'enc' });
  assert.match(link, /[?&]encryption=mlkem768x25519plus\.native\.0rtt\.KEY(&|#|$)/);
  assert.match(link, /[?&]pqv=1(&|#|$)/);
  assertRoundTrip('link', getRenderer('base64').render(null, [link]), [linkNode]);

  // pqv 只是后量子校验开关，不进连接身份；encryption 则进。
  const key = (extra) => buildProxyNodeConnectionKey({ ...node, ...extra });
  assert.equal(key({ pqv: '0' }), key({ pqv: '1' }));
  assert.notEqual(key({ encryption: undefined }), key({}));

  // sing-box / Loon / QX / Egern 都不认 VLESS Encryption。
  assert.throws(() => compileSingBoxNodeOutbound(node, 'enc'), { code: 'unsupported_vless_encryption' });
  for (const id of ['loon', 'quantumult-x', 'egern']) {
    assert.throws(() => getRenderer(id).compileNode({ node, name: 'enc' }), { code: 'unsupported_vless_encryption' }, id);
  }
  // 明文的 encryption=none 等于没开。
  assert.equal(compileMihomoProxy({ ...node, encryption: 'none' }, 'plain').encryption, undefined);
});
