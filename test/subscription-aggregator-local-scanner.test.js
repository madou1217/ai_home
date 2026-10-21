'use strict';

// 「扫描本机客户端」：用假 HOME 造出各客户端的真实配置布局，验证能扫到什么、跳过什么、
// 以及「地址相同即已导入」的判定（这是用户要的「匹配一下配置文件是不是已经导入过了」）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LocalClientConfigScanner, markImportedSources } = require('../lib/cli/services/toolkit/subscription-aggregator/local-client-config-scanner');

const SUB_A = 'https://popcornlab.example/api/v1/miaomiao?OuO=aaa&name=iNetS';
const SUB_B = 'https://86c0158a.example.com/s?q=f468&t=x.jpg';
const SURGE_MANAGED = 'https://02ba0e51.example.sbs/s?token=surge-managed';
const SURGE_PROXY = 'https://15769.ssrdog.example/s?token=surge-proxy';
const SURGE_RULESET = 'https://rules.example.com/ACL4SSR.list';

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** 造一台「装了 Clash Verge + Surge」的机器；返回它的假 HOME。 */
function fakeMachine(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-local-scan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const verge = path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev');
  write(path.join(verge, 'profiles.yaml'), [
    'current: RDxoE4TZaSGD',
    'items:',
    '- uid: Merge',
    '  type: merge',
    '  file: Merge.yaml',
    '- uid: RDxoE4TZaSGD',
    '  type: remote',
    '  name: iNetS',
    '  file: RDxoE4TZaSGD.yaml',
    `  url: ${SUB_A}`,
    '  extra:',
    '    upload: 1',
    '- uid: RFxRUH5jQr31',
    '  type: remote',
    '  name: SSRDOG',
    '  file: RFxRUH5jQr31.yaml',
    `  url: ${SUB_B}`,
    // 同一订阅在另一个 profile 里出现（换名字了）：只应列一次。
    '- uid: RrnjvhUdzjSJ',
    '  type: remote',
    '  name: iNetS 备用',
    '  file: RrnjvhUdzjSJ.yaml',
    `  url: ${SUB_A.replace('name=iNetS', 'name=other')}`,
    '- uid: local-file',
    '  type: local',
    '  name: 本地配置',
    '  file: local.yaml'
  ].join('\n'));

  const surge = path.join(home, 'Library', 'Application Support', 'Surge', 'Profiles');
  write(path.join(surge, '.managed', 'a89e0eec.conf'), [
    `#!MANAGED-CONFIG ${SURGE_MANAGED} interval=43200 strict=true`,
    '[General]',
    'dns-server = 119.29.29.29',
    '[Proxy]',
    `#!include ${SURGE_PROXY}`,
    '[Rule]',
    `#!include ${SURGE_RULESET}`
  ].join('\n'));
  write(path.join(surge, 'me.conf'), ['[General]', 'dns-server = 1.1.1.1'].join('\n'));

  return { home, verge, surge };
}

function scanFor(home, overrides = {}) {
  return new LocalClientConfigScanner().scanSources({
    platform: 'darwin',
    hostHomeDir: home,
    env: { HOME: home },
    ...overrides
  });
}

test('scan finds Clash Verge remote profiles and Surge managed subscriptions', (t) => {
  const { home } = fakeMachine(t);
  const scan = scanFor(home);
  const urls = scan.candidates.map((candidate) => candidate.url);
  assert.deepEqual(urls, [SUB_A, SUB_B, SURGE_MANAGED, SURGE_PROXY]);
  const byUrl = new Map(scan.candidates.map((candidate) => [candidate.url, candidate]));
  assert.deepEqual(
    [byUrl.get(SUB_A).clientId, byUrl.get(SUB_A).name, byUrl.get(SUB_A).clientName],
    ['clash-verge', 'iNetS', 'Clash Verge Rev']
  );
  assert.equal(byUrl.get(SURGE_MANAGED).clientId, 'surge');
  assert.match(byUrl.get(SURGE_PROXY).file, /\.managed\/a89e0eec\.conf$/);
  // 本地 / merge 型 profile 不是订阅；[Rule] 的 include 是规则集，不能当订阅导入。
  assert.ok(!urls.some((url) => url.includes('ACL4SSR')));
  assert.ok(!urls.includes(''));
});

test('scan reports each client it looked at, including ones that found nothing', (t) => {
  const { home } = fakeMachine(t);
  const scan = scanFor(home);
  assert.deepEqual(
    scan.clients.map((client) => [client.id, client.found, client.error]),
    [['clash-verge', 3, ''], ['clash-family', 0, ''], ['surge', 2, ''], ['v2rayn', 0, '']]
  );
  assert.equal(scan.platform, 'darwin');
});

test('the same subscription cached by two clients is listed once', (t) => {
  const { home, surge } = fakeMachine(t);
  // Surge 也托管了 Clash Verge 那份订阅（只有查询串顺序不同）。
  write(path.join(surge, '.managed', 'dupe.conf'), [
    `#!MANAGED-CONFIG ${SUB_A.replace('OuO=aaa&name=iNetS', 'name=iNetS&OuO=aaa')} interval=43200`,
    '[Proxy]'
  ].join('\n'));
  const scan = scanFor(home);
  assert.equal(scan.candidates.filter((candidate) => candidate.url.includes('popcornlab.example')).length, 1);
  assert.equal(scan.clients.find((client) => client.id === 'surge').found, 3, 'Surge 自己扫到 3 条');
});

test('markImportedSources flags addresses already in the source list', (t) => {
  const { home } = fakeMachine(t);
  const scan = scanFor(home);
  const marked = markImportedSources(scan.candidates, [
    // 已导入的那条：查询串顺序不同、路径末尾多个斜杠、name 也换了，仍应认出是同一份订阅。
    { id: 'sub_1', name: 'iNets 100G', kind: 'remote', url: 'https://POPCORNLAB.example/api/v1/miaomiao/?name=iNets-100G&OuO=aaa' },
    { id: 'sub_2', name: '本地节点', kind: 'local', url: null }
  ]);
  const byUrl = new Map(marked.map((candidate) => [candidate.url, candidate]));
  assert.deepEqual(
    [byUrl.get(SUB_A).imported, byUrl.get(SUB_A).importedSourceId, byUrl.get(SUB_A).importedSourceName],
    [true, 'sub_1', 'iNets 100G']
  );
  assert.deepEqual(
    marked.filter((candidate) => !candidate.imported).map((candidate) => candidate.url),
    [SUB_B, SURGE_MANAGED, SURGE_PROXY]
  );
});

test('a subscription URL without a name still gets a usable name', (t) => {
  const { home, verge, surge } = fakeMachine(t);
  fs.rmSync(surge, { recursive: true, force: true });
  write(path.join(verge, 'profiles.yaml'), [
    'items:',
    '- uid: noname',
    '  type: remote',
    `  url: ${SUB_B}`,
    '- uid: named',
    '  type: remote',
    `  url: https://airport.example/sub?token=t&name=机场甲`
  ].join('\n'));
  const names = scanFor(home).candidates.map((candidate) => candidate.name);
  // 地址里带 name 就用它当名字；没带就退回域名。
  assert.deepEqual(names, ['86c0158a.example.com', '机场甲']);
});

test('Windows and Linux look in their own places, and a missing client is not an error', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-local-scan-win-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'AppData', 'Roaming');
  const home = path.join(root, 'home');
  write(path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev', 'profiles.yaml'), [
    'items:',
    '- uid: win1',
    '  type: remote',
    '  name: 机场W',
    `  url: ${SUB_B}`
  ].join('\n'));
  write(path.join(appData, 'v2rayN', 'guiNConfig.json'), JSON.stringify({
    subItem: [
      { remarks: 'v2rayN 订阅', url: SUB_A },
      { remarks: '没有地址', url: '' },
      { url: SUB_B }
    ]
  }));

  const windows = new LocalClientConfigScanner().scanSources({
    platform: 'win32',
    hostHomeDir: home,
    env: { USERPROFILE: home, APPDATA: appData }
  });
  assert.deepEqual(windows.candidates.map((candidate) => candidate.clientId), ['clash-verge', 'v2rayn']);
  assert.deepEqual(windows.candidates.map((candidate) => candidate.url), [SUB_B, SUB_A]);
  assert.deepEqual(
    windows.clients.map((client) => [client.id, client.found, client.error]),
    [['clash-verge', 1, ''], ['clash-family', 0, ''], ['surge', 0, ''], ['v2rayn', 2, '']]
  );

  const empty = new LocalClientConfigScanner().scanSources({ platform: 'linux', hostHomeDir: home, env: { HOME: home } });
  assert.deepEqual(empty.candidates, []);
  assert.ok(empty.clients.every((client) => client.error === ''));
});

test('a broken config file is skipped without breaking the other clients', (t) => {
  const { home, verge, surge } = fakeMachine(t);
  write(path.join(verge, 'profiles.yaml'), 'items: [ this is not: valid: yaml');
  write(path.join(surge, '.managed', 'broken.conf'), `#!MANAGED-CONFIG ${SURGE_MANAGED} interval=43200`);
  const scan = scanFor(home);
  // 坏掉的 profiles.yaml 只让 clash-verge 少几条，Surge 照常扫到。
  assert.deepEqual(scan.candidates.map((candidate) => candidate.url), [SURGE_MANAGED, SURGE_PROXY]);
  assert.ok(scan.clients.every((client) => client.error === ''));
});

test('scanners never write to the client config directories', (t) => {
  const { home, verge, surge } = fakeMachine(t);
  const before = fs.readdirSync(verge).sort();
  const beforeSurge = fs.readdirSync(surge).sort();
  scanFor(home);
  assert.deepEqual(fs.readdirSync(verge).sort(), before);
  assert.deepEqual(fs.readdirSync(surge).sort(), beforeSurge);
  assert.ok(fs.existsSync(path.join(surge, '.managed', 'a89e0eec.conf')), 'Surge 配置原样保留');
});
