'use strict';

// 节点标识的单一真相：持久键（nodeKey = 连接身份）与人类短号（label）的语义边界。
// 这条不变量是「改名/重启/重排后冷却、拦截、延迟数据仍对得上」的地基。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { test } = require('node:test');

const { isKeyable, nodeKeyOf, nodeLabelOf } = require('../lib/runtime/node-identity');
const { ProxyNodeStore, buildProxyNodeConnectionKey } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');

function vless(server, extra = {}) {
  return {
    protocol: 'vless', server, port: 443, uuid: `u-${server}`, network: 'tcp', tls: true,
    security: 'reality', sni: server, publicKey: 'pk', shortId: 'sid', fingerprint: 'ios',
    name: `节点 ${server}`, ...extra
  };
}

test('nodeKey is the connection identity: renaming never moves it, credentials do', () => {
  const base = vless('a.example.com');
  const key = nodeKeyOf(base);
  assert.ok(key, 'keyable');
  // 改名不变：这是「节点当单例」的核心要求（名字只是展示）。
  assert.equal(nodeKeyOf({ ...base, name: '完全不同的名字' }), key);
  assert.equal(nodeKeyOf({ ...base, countryFlag: '🇭🇰', tags: ['ai'] }), key);
  // 换凭据会变：那是另一个出口，必须分开记账。
  assert.notEqual(nodeKeyOf({ ...base, uuid: 'other-uuid' }), key);
  // 换服务器/端口会变。
  assert.notEqual(nodeKeyOf({ ...base, server: 'b.example.com' }), key);
  assert.notEqual(nodeKeyOf({ ...base, port: 8443 }), key);
  // 已知边界（既有行为，不是本次引入）：连接身份不做主机小写化，也不忽略 sni。
  // 所以同一服务器的不同大小写写法会算成两个出口 —— 记录在这里，免得被误当成本次的回归。
  assert.notEqual(nodeKeyOf(vless('A.Example.com')), key);
  // 与既有连接身份函数同源（不新造概念）。
  assert.equal(key, buildProxyNodeConnectionKey(base));
});

test('an unusable node is reported as unkeyable instead of falling back to its name', () => {
  assert.equal(nodeKeyOf(null), '');
  assert.equal(nodeKeyOf({}), '');
  assert.equal(nodeKeyOf({ protocol: 'vless', server: '', port: 443 }), '');
  assert.equal(nodeKeyOf({ protocol: 'vless', server: 'a.example.com', port: 0 }), '');
  assert.equal(isKeyable({ protocol: 'vless', server: 'a.example.com', port: 443 }), true);
  // 名称绝不作为键：改名必须不影响任何引用。
  assert.equal(nodeKeyOf({ name: '只有名字' }), '');
});

test('nodeLabel is display-only and never used as a reference', () => {
  assert.equal(nodeLabelOf({ name: '🇭🇰 HK-01', server: 'a.example.com', port: 443 }), '🇭🇰 HK-01');
  assert.equal(nodeLabelOf({ server: 'a.example.com', port: 443 }), 'a.example.com:443');
  assert.equal(nodeLabelOf({}, 'node-3'), 'node-3');
  assert.equal(nodeLabelOf(null), '');
});

test('latency results survive a rename because they are stored by nodeKey, not by id', (t) => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-node-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ProxyNodeStore(nodePath.join(dir, 'pool.json'));
  const node = vless('a.example.com');
  const sub = store.upsertSubscription({ name: '机场', url: 'https://a.example/sub' });
  const [stored] = store.replaceSubscriptionNodes(sub.id, [node]);
  const key = nodeKeyOf(stored);

  // 按连接身份落库（新契约）。
  assert.equal(store.recordNodeLatency({ [key]: { ms: 1234, measuredAt: 1000 } }), 1);
  assert.equal(store.listNodes()[0].latencyMs, 1234);

  // 改名后重新同步：id 可能漂（种子含 name），但测量结果按连接身份仍然对上。
  const renamed = store.replaceSubscriptionNodes(sub.id, [{ ...node, name: '改了个名字' }])[0];
  assert.equal(nodeKeyOf(renamed), key, '改名后连接身份不变');
  assert.equal(renamed.latencyMs, 1234, '测量结果跟着连接身份保留');
  // 再按连接身份写一次也照样命中。
  assert.equal(store.recordNodeLatency({ [key]: { ms: 999 } }), 1);
  assert.equal(store.listNodes()[0].latencyMs, 999);
  // 老调用方按 id 传也仍然认（向后兼容）。
  assert.equal(store.recordNodeLatency({ [renamed.id]: { ms: 777 } }), 1);
  assert.equal(store.listNodes()[0].latencyMs, 777);
});

test('a node id changes when its name changes, which is exactly why ids are not reference keys', () => {
  const base = vless('a.example.com');
  const withName = { ...base, name: '甲' };
  const otherName = { ...base, name: '乙' };
  // 记录这个已知性质：id 会漂（所以跨层引用一律用 nodeKey）。
  const idOf = (n) => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-node-id-'));
    try {
      const store = new ProxyNodeStore(nodePath.join(dir, 'pool.json'));
      const sub = store.upsertSubscription({ name: 'x', url: 'https://x.example/sub' });
      return store.replaceSubscriptionNodes(sub.id, [n])[0].id;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.notEqual(idOf(withName), idOf(otherName), 'id 含 name：改名就漂');
  assert.equal(nodeKeyOf(withName), nodeKeyOf(otherName), 'nodeKey 不含 name：改名稳定');
});
