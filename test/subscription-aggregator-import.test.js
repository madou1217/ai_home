'use strict';

// 一键导入：各客户端深链接的模板与编码、本机安装检测（按 URL Scheme 查处理程序），
// 以及各格式的节点视图（?view=nodes，供 proxy-providers / policy-path / nodelist / server_remote 用）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const { buildImportLinks, importSchemes, normalizeOrigin } = require('../lib/cli/services/toolkit/subscription-aggregator/client-import-links');
const {
  LocalClientDetector,
  isLoopbackAddress,
  windowsAppName
} = require('../lib/cli/services/toolkit/subscription-aggregator/local-client-detector');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const { handleWebUiSubscriptionAggregatorRoutes } = require('../lib/server/webui-subscription-aggregator-routes');
const { SAMPLE_NODES } = require('./helpers/proxy-format-samples');

const TOKEN = 'AbC_d-1xYz';
const ORIGIN = 'http://192.168.31.10:9527';
const SUB = `${ORIGIN}/sub/${TOKEN}`;

function linkOf(links, id) {
  return links.clients.find((client) => client.id === id);
}

test('deep links follow each client\'s own import contract', () => {
  const links = buildImportLinks({ origin: `${ORIGIN}/`, token: TOKEN, name: '我的 聚合' });
  assert.equal(links.url, SUB);

  // Clash Verge Rev 把 url= 之后整段当地址：name 必须在前。
  const clash = new URL(linkOf(links, 'clash').link);
  assert.match(linkOf(links, 'clash').link, /^clash:\/\/install-config\?name=[^&]+&url=/);
  assert.equal(clash.searchParams.get('url'), `${SUB}?target=mihomo`);
  assert.equal(clash.searchParams.get('name'), '我的 聚合');

  const singBox = new URL(linkOf(links, 'sing-box').link);
  assert.equal(singBox.searchParams.get('url'), `${SUB}?target=sing-box`);
  assert.equal(decodeURIComponent(singBox.hash.slice(1)), '我的 聚合');

  // Hiddify / Karing / Husi 的格式随内核版本，交给服务端按 UA 选：链接里不带 target。
  for (const id of ['hiddify', 'karing', 'husi']) {
    assert.equal(new URL(linkOf(links, id).link).searchParams.get('url'), SUB, id);
  }

  // QX 只能加节点订阅：server_remote + 节点视图。
  const qx = new URL(linkOf(links, 'quantumult-x').link);
  assert.deepEqual(JSON.parse(qx.searchParams.get('remote-resource')), {
    server_remote: [`${SUB}?target=quantumult-x&view=nodes, tag=我的 聚合`]
  });

  const rocket = linkOf(links, 'shadowrocket').link;
  assert.equal(Buffer.from(rocket.match(/sub:\/\/([^?]+)/)[1], 'base64').toString('utf8'), `${SUB}?target=base64`);
  assert.equal(linkOf(links, 'shadowrocket').verified, false);

  // v2rayNG 会把参数解码两次，解两次后仍是原地址。
  const v2rayng = linkOf(links, 'v2rayng').link;
  const once = v2rayng.match(/url=([^#]+)/)[1];
  assert.equal(decodeURIComponent(decodeURIComponent(once)), `${SUB}?target=base64`);

  assert.deepEqual([linkOf(links, 'surge-mac').download, linkOf(links, 'surge-mac').link], [true, '']);
  assert.deepEqual([linkOf(links, 'v2rayn').link, linkOf(links, 'v2rayn').url], ['', `${SUB}?target=base64`]);
  assert.equal(new URL(linkOf(links, 'loon').link).searchParams.get('sub'), `${SUB}?target=loon`);
  assert.equal(new URL(linkOf(links, 'egern').link.replace('egern:/', 'egern://x/')).searchParams.get('url'), `${SUB}?target=egern`);

  assert.equal(buildImportLinks({ origin: 'http://x/path', token: TOKEN }), null);
  assert.equal(normalizeOrigin('ftp://x'), '');
  assert.equal(normalizeOrigin('https://user:pw@x'), '');
  assert.ok(importSchemes().includes('clash') && !importSchemes().includes(''));
});

test('local client detection asks the OS who handles each scheme and caches the answer', async () => {
  const calls = [];
  let now = 0;
  const mac = new LocalClientDetector({
    platform: 'darwin',
    now: () => now,
    run: async (file, args) => {
      calls.push(file);
      assert.equal(args[0], '-l');
      return JSON.stringify({ clash: '/Applications/Clash Verge.app', stash: null });
    }
  });
  assert.deepEqual(await mac.detect(['clash', 'stash']), { clash: 'Clash Verge', stash: null });
  await mac.detect(['clash', 'stash']);
  assert.equal(calls.length, 1, '5 分钟内用缓存');
  now += 5 * 60 * 1000;
  await mac.detect(['clash', 'stash']);
  assert.equal(calls.length, 2);

  const windows = new LocalClientDetector({
    platform: 'win32',
    run: async () => JSON.stringify({ clash: '"C:\\Program Files\\FlClash\\FlClash.exe" "%1"', 'sing-box': null })
  });
  assert.deepEqual(await windows.detect(['clash', 'sing-box']), { clash: 'FlClash', 'sing-box': null });
  assert.equal(windowsAppName('C:\\Apps\\karing.exe %1'), 'karing');

  const linux = new LocalClientDetector({
    platform: 'linux',
    run: async (_file, args) => (args[2] === 'x-scheme-handler/clash' ? 'clash-verge.desktop\n' : '')
  });
  assert.deepEqual(await linux.detect(['clash', 'hiddify']), { clash: 'clash-verge', hiddify: null });

  const other = new LocalClientDetector({ platform: 'freebsd', run: async () => { throw new Error('should not run'); } });
  assert.deepEqual(await other.detect(['clash']), { clash: null });

  assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].every(isLoopbackAddress));
  assert.ok(!['192.168.1.5', '::ffff:10.0.0.2', ''].some(isLoopbackAddress));
});

function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nodes = SAMPLE_NODES.filter((node) => ['ss', 'trojan', 'wg'].includes(node.name));
  const sources = [{ id: 'sub_a', name: '机场 A', url: 'https://a.example/sub', nodeCount: nodes.length, lastSyncedAt: 1000 }];
  const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now: () => 1000 });
  const service = new SubscriptionAggregatorService({
    store,
    now: () => 1000,
    sources: {
      listSources: () => sources,
      listNodes: () => nodes.map((node) => ({ ...node, subscriptionId: 'sub_a' })),
      syncSource: async () => ({ ok: true })
    },
    ...extra
  });
  const profile = store.saveProfile({ name: '聚合', refreshHours: 0 });
  return { service, profile };
}

test('every format has a nodes view for adding the nodes into an existing client config', (t) => {
  const { service, profile } = setup(t);
  const view = (format) => service.preview(profile.id, format, { view: 'nodes' }).content;

  assert.deepEqual(Object.keys(YAML.parse(view('mihomo'))), ['proxies']);
  assert.deepEqual(Object.keys(YAML.parse(view('stash'))), ['proxies']);
  assert.deepEqual(Object.keys(YAML.parse(view('egern'))), ['proxies']);
  assert.deepEqual(Object.keys(JSON.parse(view('sing-box'))), ['outbounds', 'endpoints']);
  for (const format of ['surge', 'loon', 'quantumult-x']) {
    const text = view(format);
    assert.doesNotMatch(text, /^\[|MANAGED-CONFIG|FINAL/m, format);
    assert.ok(text.trim().split('\n').length >= 2, format);
  }
  // 完整视图不受影响。
  assert.match(service.preview(profile.id, 'surge').content, /^\[Proxy Group\]$/m);
});

test('the WebUI routes serve import links and only detect clients for same-machine requests', async (t) => {
  const detected = [];
  const { service, profile } = setup(t, {
    localClients: { detect: async (schemes) => { detected.push(schemes.length); return { clash: 'Clash Verge' }; } }
  });
  const call = async (pathname, remoteAddress) => {
    const writes = [];
    await handleWebUiSubscriptionAggregatorRoutes(
      { url: pathname, headers: { host: '127.0.0.1:9527' }, socket: { remoteAddress } },
      {},
      'GET',
      pathname.split('?')[0],
      { subscriptionAggregatorService: service, writeJson: (_res, status, payload) => writes.push({ status, payload }) }
    );
    return writes[0];
  };
  const prefix = '/v0/webui/toolkit/subscription-aggregator';

  const remote = await call(`${prefix}/local-clients`, '192.168.31.20');
  assert.deepEqual(remote.payload, { ok: true, local: false, handlers: {} });
  assert.deepEqual(detected, []);
  const local = await call(`${prefix}/local-clients`, '127.0.0.1');
  assert.deepEqual(local.payload, { ok: true, local: true, handlers: { clash: 'Clash Verge' } });

  const links = await call(`${prefix}/profiles/${profile.id}/import-links?origin=${encodeURIComponent(ORIGIN)}`, '127.0.0.1');
  assert.equal(links.status, 200);
  assert.equal(links.payload.url, `${ORIGIN}/sub/${profile.token}`);
  const fallback = await call(`${prefix}/profiles/${profile.id}/import-links`, '127.0.0.1');
  assert.equal(fallback.payload.origin, 'http://127.0.0.1:9527', '没传 origin 时用请求的地址');
  const bad = await call(`${prefix}/profiles/${profile.id}/import-links?origin=nope`, '127.0.0.1');
  assert.deepEqual([bad.status, bad.payload.error], [422, 'invalid_aggregator_origin']);
});
