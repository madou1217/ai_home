const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadRemoteNodeView() {
  return import(pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'pages',
    'settings-remote-node-view.js'
  )).href);
}

test('settings remote node preview exposes derived identity and provider', async () => {
  const {
    buildRemoteNodeDefaultPreview,
    formatRemoteNodeIdentity
  } = await loadRemoteNodeView();

  const defaults = {
    nodeId: 'dev-macbook-pro-7f23a911',
    name: 'Dev MacBook Pro',
    provider: 'aih-relay'
  };

  assert.equal(formatRemoteNodeIdentity(defaults), 'Dev MacBook Pro (dev-macbook-pro-7f23a911)');
  assert.deepEqual(buildRemoteNodeDefaultPreview(defaults), [
    { id: 'nodeId', label: '默认节点 ID', value: 'dev-macbook-pro-7f23a911' },
    { id: 'name', label: '默认显示名称', value: 'Dev MacBook Pro' },
    { id: 'provider', label: '派生 Provider', value: 'aih-relay' }
  ]);
});

test('settings remote node preview falls back to transport provider and visible empty labels', async () => {
  const {
    buildRemoteNodeDefaultPreview,
    formatRemoteNodeIdentity
  } = await loadRemoteNodeView();

  assert.equal(formatRemoteNodeIdentity({}), '未加载');
  assert.deepEqual(buildRemoteNodeDefaultPreview({}, { provider: 'frp' }), [
    { id: 'nodeId', label: '默认节点 ID', value: '未加载' },
    { id: 'name', label: '默认显示名称', value: '未加载' },
    { id: 'provider', label: '派生 Provider', value: 'frp' }
  ]);
});
