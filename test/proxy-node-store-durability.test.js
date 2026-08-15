'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProxyNodeStore } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');

test('ProxyNodeStore uses AIH_HOME and keeps its directory and file private', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-store-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const store = new ProxyNodeStore({ aiHomeDir, env: { AIH_HOME: aiHomeDir } });
  store.upsertNode({
    name: 'private node',
    protocol: 'http',
    server: '127.0.0.1',
    port: 8080
  });

  assert.equal(store.filePath, path.join(aiHomeDir, 'proxy-pool.json'));
  assert.equal(fs.statSync(aiHomeDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(aiHomeDir).some((name) => name.includes('.tmp-')), false);
});

test('ProxyNodeStore rejects unusable nodes and non-http subscription URLs explicitly', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));

  assert.throws(
    () => store.upsertNode({ protocol: 'wireguard', server: 'example.com', port: 443 }),
    (error) => error.code === 'unsupported_proxy_protocol'
  );
  assert.throws(
    () => store.upsertNode({ protocol: 'http', server: '', port: 8080 }),
    (error) => error.code === 'invalid_proxy_server'
  );
  assert.throws(
    () => store.upsertNode({ protocol: 'http', server: 'example.com', port: 70000 }),
    (error) => error.code === 'invalid_proxy_port'
  );
  assert.throws(
    () => store.upsertSubscription({ name: 'file', url: 'file:///etc/passwd' }),
    (error) => error.code === 'invalid_subscription_url'
  );
});

test('ProxyNodeStore exposes subscriptions as manual sync only', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));

  const subscription = store.upsertSubscription({
    name: 'manual',
    url: 'https://example.com/subscription',
    autoUpdate: true
  });

  assert.equal(subscription.manualSyncOnly, true);
  assert.equal(subscription.autoUpdate, false);
  assert.equal(store.listSubscriptions()[0].manualSyncOnly, true);
});

test('ProxyNodeStore persists explicit TUN intent without enabling it by default', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-store-tun-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  assert.equal(store.getNetworkConfig().tun.enabled, false);
  const updated = store.setNetworkConfig({ tun: { enabled: true, stack: 'gvisor', strictRoute: true } });
  assert.equal(updated.tun.enabled, true);
  assert.equal(updated.tun.stack, 'gvisor');
  assert.equal(updated.tun.strictRoute, true);
  assert.equal(new ProxyNodeStore(path.join(directory, 'pool.json')).getNetworkConfig().tun.enabled, true);
});

test('ProxyNodeStore removes dedicated mappings owned by a deleted subscription', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const subscription = store.upsertSubscription({
    name: 'manual',
    url: 'https://example.com/subscription'
  });
  const [node] = store.bulkUpsertNodes([{
    name: 'subscription node',
    protocol: 'http',
    server: 'proxy.example.com',
    port: 8080
  }], subscription.id);
  store.assignDedicatedPort(node.id, 10801);

  store.deleteSubscription(subscription.id);

  assert.equal(store.listNodes().length, 0);
  assert.deepEqual(store.getDedicatedPortsConfig().mappings, {});
});

test('ProxyNodeStore removes stale dedicated mappings when subscription nodes are replaced', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const subscription = store.upsertSubscription({
    name: 'manual',
    url: 'https://example.com/subscription'
  });
  const [oldNode] = store.bulkUpsertNodes([{
    name: 'old node',
    protocol: 'http',
    server: 'old.example.com',
    port: 8080
  }], subscription.id);
  store.assignDedicatedPort(oldNode.id, 10801);

  store.replaceSubscriptionNodes(subscription.id, [{
    name: 'new node',
    protocol: 'http',
    server: 'new.example.com',
    port: 8080
  }]);

  assert.deepEqual(store.getDedicatedPortsConfig().mappings, {});
});

test('ProxyNodeStore propagates atomic persistence failures', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  store.fs = {
    ...fs,
    renameSync() {
      const error = new Error('simulated rename failure');
      error.code = 'EIO';
      throw error;
    }
  };

  assert.throws(
    () => store.upsertNode({ protocol: 'http', server: '127.0.0.1', port: 8080 }),
    (error) => error.code === 'proxy_store_write_failed'
  );
});
