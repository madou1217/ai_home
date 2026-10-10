'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { compileMihomoProxy } = require('../lib/cli/services/toolkit/proxy-pool/cores/mihomo/proxy-compiler');
const { compileSingBoxNodeOutbound } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/node-outbound');
const { encodeProxyNode } = require('../lib/cli/services/toolkit/proxy-pool/protocol-parsers');
const { buildProxyNodeConnectionKey } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');

const BASE = { protocol: 'shadowsocks', name: 'n', server: 'ss.example', port: 8388, cipher: 'aes-256-gcm', password: 'p' };
const SIP003_OBFS = { ...BASE, plugin: 'obfs-local', pluginOpts: 'obfs=http;obfs-host=cdn.example' };
const CLASH_OBFS = { ...BASE, plugin: 'obfs', pluginOpts: { mode: 'http', host: 'cdn.example' } };
const SIP003_V2RAY = { ...BASE, plugin: 'v2ray-plugin', pluginOpts: 'mode=websocket;tls;host=edge.example;path=/ws' };
const CLASH_V2RAY = { ...BASE, plugin: 'v2ray-plugin', pluginOpts: { mode: 'websocket', tls: true, host: 'edge.example', path: '/ws' } };

test('SIP003 and Clash spellings of the same plugin are one connection', () => {
  assert.equal(buildProxyNodeConnectionKey(SIP003_OBFS), buildProxyNodeConnectionKey(CLASH_OBFS));
  assert.equal(buildProxyNodeConnectionKey(SIP003_V2RAY), buildProxyNodeConnectionKey(CLASH_V2RAY));
  assert.notEqual(
    buildProxyNodeConnectionKey(SIP003_OBFS),
    buildProxyNodeConnectionKey({ ...SIP003_OBFS, pluginOpts: 'obfs=tls;obfs-host=cdn.example' })
  );
});

test('mihomo always gets the Clash spelling and sing-box the SIP003 one', () => {
  for (const node of [SIP003_OBFS, CLASH_OBFS]) {
    const proxy = compileMihomoProxy(node, 'n');
    assert.equal(proxy.plugin, 'obfs');
    assert.deepEqual(proxy['plugin-opts'], { mode: 'http', host: 'cdn.example' });
    const outbound = compileSingBoxNodeOutbound(node, 'n');
    assert.equal(outbound.plugin, 'obfs-local');
    assert.equal(outbound.plugin_opts, 'obfs=http;obfs-host=cdn.example');
  }
  for (const node of [SIP003_V2RAY, CLASH_V2RAY]) {
    assert.deepEqual(compileMihomoProxy(node, 'n')['plugin-opts'], { mode: 'websocket', tls: true, host: 'edge.example', path: '/ws' });
    assert.equal(compileSingBoxNodeOutbound(node, 'n').plugin_opts, 'mode=websocket;tls;host=edge.example;path=/ws');
  }
});

test('share links use the SIP003 spelling even for Clash-imported nodes', () => {
  assert.match(encodeProxyNode(CLASH_OBFS), /\/\?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dcdn\.example#n$/);
});
