'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const servicePath = path.join(projectRoot, 'lib/account/account-egress-catalog-service.js');

test('账号出口目录只管理中立节点、分组和订阅，不提供代理核心或系统网络写入', async (t) => {
  assert.equal(fs.existsSync(servicePath), true, '账号出口目录服务尚未实现');
  const { AccountEgressCatalogService } = require(servicePath);
  const { ProxyNodeStore } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-egress-catalog-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(tempDir, 'proxy-pool.json'));
  const subscriptionFetcher = {
    async fetch(url) {
      return {
        url,
        content: 'socks5://member:secret@subscription.example.com:1080#subscription-node'
      };
    }
  };
  const service = new AccountEgressCatalogService({ store, subscriptionFetcher });

  const imported = await service.importNodes([
    'proxies:',
    '  - name: yaml-http-node',
    '    type: http',
    '    server: proxy.example.com',
    '    port: 8080',
    '    username: member',
    '    password: secret'
  ].join('\n'));
  assert.equal(imported.ok, true);
  assert.equal(imported.count, 1);

  const listed = service.listNodes();
  assert.equal(listed.ok, true);
  assert.equal(listed.nodes.length, 1);
  assert.equal(listed.nodes[0].name, 'yaml-http-node');
  assert.equal(Object.hasOwn(listed.nodes[0], 'dedicatedPort'), false);
  assert.equal(listed.groups.some((item) => item.id === 'dedicated'), false);

  const group = await service.upsertGroup({
    name: '账号出口组',
    nodeIds: [listed.nodes[0].id],
    strategy: 'sticky',
    failoverStrategy: 'lowest_latency'
  });
  assert.equal(group.ok, true);
  const groups = service.listGroups().groups;
  assert.equal(groups.some((item) => item.id === group.group.id), true);
  assert.equal(groups.some((item) => item.id === 'dedicated'), false);

  const saved = await service.upsertSubscription({
    name: '订阅源',
    url: 'https://subscription.example.com/list'
  });
  const synced = await service.syncSubscription(saved.subscription.id);
  assert.equal(synced.ok, true);
  assert.equal(synced.applied, true);
  assert.equal(synced.count, 1);
  assert.equal(service.listSubscriptions().subscriptions[0].manualSyncOnly, true);

  assert.equal(service.startCore, undefined);
  assert.equal(service.reloadCore, undefined);
  assert.equal(service.planNetworkIntegration, undefined);
  assert.equal(service.applyTunIntegration, undefined);
});
