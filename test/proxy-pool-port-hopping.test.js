'use strict';

// Hysteria2 端口跳跃：端口列表的规范化、连接指纹、各格式的写法与往返、链接的两种端口写法。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  firstPortOf,
  formatPortRanges,
  normalizePortRanges,
  parsePortRanges
} = require('../lib/cli/services/toolkit/proxy-pool/port-range');
const { parseSubscriptionContentDetailed } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const {
  buildProxyNodeConnectionKey,
  validateProxyNodeInput
} = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const { compiledLine } = require('../lib/cli/services/toolkit/proxy-pool/compile-result');
const { getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const { HY2_PORT_HOPPING_NODE, assertRoundTrip } = require('./helpers/proxy-format-samples');

const NAME = HY2_PORT_HOPPING_NODE.name;

test('port lists normalize to ascending comma-separated ranges', () => {
  assert.equal(normalizePortRanges('3000,1000-2000'), '1000-2000,3000');
  assert.equal(normalizePortRanges('1000 - 2000; 3000'), '1000-2000,3000');
  assert.equal(normalizePortRanges(['1000:2000', '3000']), '1000-2000,3000');
  assert.equal(normalizePortRanges('443,443,443'), '443');
  assert.equal(normalizePortRanges(''), undefined);
  assert.equal(normalizePortRanges(undefined), undefined);
  assert.deepEqual(parsePortRanges('1000-2000'), [{ start: 1000, end: 2000 }]);
  assert.equal(firstPortOf('3000,1000-2000'), 1000);
  assert.equal(formatPortRanges('1000-2000,3000', { separator: ';' }), '1000-2000;3000');
  assert.equal(formatPortRanges('1000-2000,3000', { rangeSeparator: ':' }), '1000:2000,3000');
  for (const invalid of ['0', '70000', '2000-1000', 'abc', '1000-', '-2000']) {
    assert.throws(() => parsePortRanges(invalid), { code: 'invalid_proxy_field_ports' });
  }
  assert.throws(() => validateProxyNodeInput({ ...HY2_PORT_HOPPING_NODE, ports: '2000-1000' }), /invalid_proxy_field/);
});

test('the port list joins the connection identity while the hop interval does not', () => {
  const base = HY2_PORT_HOPPING_NODE;
  const key = (node) => buildProxyNodeConnectionKey({ ...base, ...node });
  // 写法与顺序不影响身份。
  assert.equal(key({ ports: '3000,1000-2000' }), key({ ports: '1000-2000,3000' }));
  assert.equal(key({ ports: ['1000:2000', '3000'] }), key({ ports: '1000-2000,3000' }));
  // 端口列表本身变了就是另一个连接。
  assert.notEqual(key({ ports: '1000-2000' }), key({ ports: '1000-2000,3000' }));
  assert.notEqual(key({ ports: undefined }), key({ ports: '1000-2000,3000' }));
  // hopInterval 只是客户端调优项。
  assert.equal(key({ hopInterval: 60 }), key({ hopInterval: 30 }));
  assert.equal(key({ hopInterval: undefined }), key({ hopInterval: 30 }));
});

test('hysteria2 links carry the port list in mport and accept it in the host section', () => {
  const renderer = getRenderer('base64');
  const link = renderer.compileNode({ node: HY2_PORT_HOPPING_NODE, name: NAME });
  assert.match(link, /^hy2:\/\/p@hy\.example:1000\?/);
  assert.match(link, /mport=1000-2000%2C3000/);
  assertRoundTrip('link', renderer.render(null, [link]), [HY2_PORT_HOPPING_NODE]);

  // 端口列表直接写在主机段（没有单端口）时，取列表里的第一个端口。
  const inHost = parseSubscriptionContentDetailed('hy2://p@hy.example:1000-2000,3000#hop');
  assert.deepEqual(inHost.skippedNodes, []);
  assert.equal(inHost.nodes[0].port, 1000);
  assert.equal(inHost.nodes[0].ports, '1000-2000,3000');

  // mport 与主机段单端口并存时，主机段的端口优先。
  const both = parseSubscriptionContentDetailed('hy2://p@hy.example:443?mport=1000-2000,3000#hop');
  assert.equal(both.nodes[0].port, 443);
  assert.equal(both.nodes[0].ports, '1000-2000,3000');

  // IPv6 主机段（方括号）里的端口列表。
  const ipv6 = parseSubscriptionContentDetailed('hy2://p@[2001:4860:4860::8888]:1000-2000#hop6');
  assert.equal(ipv6.nodes[0].server, '2001:4860:4860::8888');
  assert.equal(ipv6.nodes[0].port, 1000);
  assert.equal(ipv6.nodes[0].ports, '1000-2000');
  assert.match(
    renderer.compileNode({ node: ipv6.nodes[0], name: 'hop6' }),
    /^hy2:\/\/p@\[2001:4860:4860::8888\]:1000\?mport=1000-2000/
  );

  // 端口不是数字也不是列表：仍然算非法链接。
  assert.deepEqual(parseSubscriptionContentDetailed('hy2://p@hy.example:abc#bad').nodes, []);
});

test('mihomo, Stash, Surge, Loon, Egern, sing-box and JSON all keep the port list', () => {
  for (const id of ['mihomo', 'stash']) {
    const renderer = getRenderer(id);
    const proxy = renderer.compileNode({ node: HY2_PORT_HOPPING_NODE, name: NAME });
    assert.equal(proxy.ports, '1000-2000,3000', id);
    assert.equal(proxy['hop-interval'], 30, id);
    assertRoundTrip(id, renderer.render(null, [proxy], { view: 'nodes' }), [HY2_PORT_HOPPING_NODE]);
  }

  const surge = getRenderer('surge');
  const surgeLine = compiledLine(surge.compileNode({ node: HY2_PORT_HOPPING_NODE, name: NAME }));
  assert.match(surgeLine, /port-hopping=1000-2000;3000/);
  assertRoundTrip('surge', `[Proxy]\n${surgeLine}\n`, [HY2_PORT_HOPPING_NODE]);

  const loon = getRenderer('loon');
  const loonLine = compiledLine(loon.compileNode({ node: HY2_PORT_HOPPING_NODE, name: NAME }));
  // Loon 的区间用冒号（官方文档：server-ports="20000:20100"）。
  assert.match(loonLine, /server-ports="1000:2000,3000"/);
  assertRoundTrip('loon', `[Proxy]\n${loonLine}\n`, [HY2_PORT_HOPPING_NODE]);

  const egern = getRenderer('egern');
  const egernEntry = egern.compileNode({ node: HY2_PORT_HOPPING_NODE, name: NAME });
  assert.equal(egernEntry.hysteria2.port_hopping, '1000-2000,3000');
  assertRoundTrip('egern', egern.render(null, [egernEntry], { view: 'nodes' }), [HY2_PORT_HOPPING_NODE]);

  const outbound = compileSingBoxNodeOutbound(HY2_PORT_HOPPING_NODE, NAME);
  // 有 server_ports 时不能再写 server_port，区间用冒号。
  assert.equal(outbound.server_port, undefined);
  assert.deepEqual(outbound.server_ports, ['1000:2000', '3000:3000']);
  assert.equal(outbound.hop_interval, '30s');
  assertRoundTrip('sing-box', JSON.stringify({ outbounds: [outbound] }, null, 2), [HY2_PORT_HOPPING_NODE]);

  const json = getRenderer('json');
  const compiled = json.compileNode({ node: HY2_PORT_HOPPING_NODE, name: NAME });
  assert.equal(compiled.ports, '1000-2000,3000');
  assertRoundTrip('json', json.render(null, [compiled]), [HY2_PORT_HOPPING_NODE]);
});

test('a port list without a single port still imports from Clash and sing-box', () => {
  const clash = parseSubscriptionContentDetailed(`
proxies:
  - name: hop-only
    type: hysteria2
    server: hy.example
    ports: "3000,1000-2000"
    password: p
    sni: hy.example
`);
  assert.deepEqual(clash.skippedNodes, []);
  assert.equal(clash.nodes[0].port, 1000);
  assert.equal(clash.nodes[0].ports, '1000-2000,3000');

  const singBox = parseSubscriptionContentDetailed(JSON.stringify({
    outbounds: [{
      type: 'hysteria2', tag: 'hop-only', server: 'hy.example',
      server_ports: ['3000', '1000:2000'], password: 'p', tls: { enabled: true }
    }]
  }));
  assert.deepEqual(singBox.skippedNodes, []);
  assert.equal(singBox.nodes[0].port, 1000);
  assert.equal(singBox.nodes[0].ports, '1000-2000,3000');
});
