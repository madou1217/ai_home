'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { PROXY_CORE_PLUGINS, getProxyCore } = require('../lib/cli/services/toolkit/proxy-pool/cores');
const { compileMihomoConfig } = require('../lib/cli/services/toolkit/proxy-pool/cores/mihomo/config-compiler');
const { compileSingBoxConfig } = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/config-compiler');
const {
  discoverSingBoxCore,
  extractSingBoxArchive,
  planSingBoxInstall,
  targetAssetNames
} = require('../lib/cli/services/toolkit/proxy-pool/cores/sing-box/core-manager');

const NODES = [
  { id: 'a', name: 'A', protocol: 'shadowsocks', server: 'a.example', port: 8388, cipher: 'aes-256-gcm', password: 'p' },
  { id: 'b', name: 'B', protocol: 'vless', server: 'b.example', port: 443, uuid: 'u', network: 'ws', path: '/x', tls: true },
  { id: 'c', name: 'C', protocol: 'trojan', server: 'c.example', port: 443 },
  { id: 'a', name: 'dup', protocol: 'socks5', server: 'd.example', port: 1080 }
];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-sing-box-core-'));
}

function writeFakeBinary(dir, versionText) {
  const file = path.join(dir, 'sing-box');
  fs.writeFileSync(file, `#!/bin/sh\necho "${versionText}"\n`, { mode: 0o755 });
  return file;
}

test('sing-box 注册为第二个代理内核插件，与 mihomo 同一契约', () => {
  assert.deepEqual(PROXY_CORE_PLUGINS.map((core) => core.id), ['mihomo', 'sing-box']);
  for (const core of PROXY_CORE_PLUGINS) {
    assert.equal(core.capability, 'proxy-pool.core');
    assert.equal(typeof core.compileConfig, 'function');
    assert.equal(typeof core.createRuntime, 'function');
    assert.equal(typeof core.chooseLoopbackPort, 'function');
    for (const method of ['discover', 'plan', 'execute', 'remove']) assert.equal(typeof core.manager[method], 'function');
    assert.equal(typeof core.capabilities.hotReload, 'boolean');
  }
  assert.equal(getProxyCore('sing-box').capabilities.hotReload, false);
  assert.equal(getProxyCore('mihomo').capabilities.hotReload, true);
});

test('sing-box 编译与 mihomo 共用路由规划：节点命名、跳过原因、告警与专用监听一致', () => {
  const routings = [
    { mode: 'direct' },
    { mode: 'global', activeOutboundNodeId: 'zzz' },
    { mode: 'rule', activeOutboundNodeId: 'a', rules: [
      { id: 'r1', outbound: 'proxy', nodeId: 'b', domains: ['openai.com', 'bad domain'], ips: ['1.1.1.1', 'x'] },
      { id: 'r2', outbound: 'weird' },
      { id: 'r3', outbound: 'proxy', nodeId: 'c', domains: ['c.test'] }
    ] }
  ];
  for (const routing of routings) {
    const input = { nodes: NODES, routing, dedicatedPorts: { mappings: { a: 10901, zz: 10903 } }, controllerSecret: 's' };
    const mihomo = compileMihomoConfig(input);
    const singBox = compileSingBoxConfig(input);
    assert.deepEqual(singBox.warnings, mihomo.warnings);
    assert.deepEqual(singBox.nodeNameById, mihomo.nodeNameById);
    assert.deepEqual(singBox.activeListeners, mihomo.activeListeners);
    assert.deepEqual(singBox.skippedNodes.map((item) => item.nodeId), mihomo.skippedNodes.map((item) => item.nodeId));
  }
});

test('sing-box 路由：直连/全局/分流翻译为 final 与规则动作，专用端口优先于分流', () => {
  const rule = compileSingBoxConfig({
    nodes: NODES,
    routing: { mode: 'rule', activeOutboundNodeId: 'a', rules: [
      { id: 'p', outbound: 'proxy', nodeId: 'b', domains: ['openai.com'], ips: ['2606:4700::/32'] },
      { id: 'd', outbound: 'direct', domains: ['lan.test'] },
      { id: 'x', outbound: 'reject', ips: ['8.8.8.8'] }
    ] },
    dedicatedPorts: { mappings: { b: 10905 } }
  });
  const names = rule.nodeNameById;
  assert.equal(names.c, undefined, 'trojan 缺密码的节点被跳过');
  assert.equal(rule.config.route.final, names.a);
  assert.deepEqual(rule.config.route.rules, [
    { inbound: [rule.activeListeners[0].name], action: 'route', outbound: names.b },
    { domain_suffix: ['openai.com'], action: 'route', outbound: names.b },
    { ip_cidr: ['2606:4700::/32'], action: 'route', outbound: names.b },
    { domain_suffix: ['lan.test'], action: 'route', outbound: 'direct' },
    { ip_cidr: ['8.8.8.8/32'], action: 'reject' }
  ]);
  assert.equal(compileSingBoxConfig({ nodes: NODES, routing: { mode: 'direct' } }).config.route.final, 'direct');
  const global = compileSingBoxConfig({ nodes: NODES, routing: { mode: 'global', activeOutboundNodeId: 'b' } });
  assert.equal(global.config.route.final, names.b);
  assert.equal(global.mixedPort, 10800);
  assert.equal(global.config.experimental.clash_api.external_controller, '127.0.0.1:19091');
  assert.equal(compileSingBoxConfig({ nodes: NODES }, { includeController: false }).config.experimental, undefined);
  assert.throws(() => compileSingBoxConfig({ nodes: NODES, mixedPort: 19091 }), /sing_box_listener_port_conflict/);
});

test('sing-box TUN：tun 入站、嗅探与 DNS 劫持规则在最前，并开启出口网卡自动探测', () => {
  const compiled = compileSingBoxConfig({ nodes: NODES, routing: { mode: 'direct' }, tun: { enabled: true, stack: 'gvisor' } });
  const tun = compiled.config.inbounds.find((inbound) => inbound.type === 'tun');
  assert.equal(tun.stack, 'gvisor');
  assert.deepEqual(compiled.config.route.rules.slice(0, 2), [
    { inbound: ['aih-tun'], action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' }
  ]);
  assert.equal(compiled.config.route.auto_detect_interface, true);
});

test('sing-box 安装计划只接受带官方 sha256 digest 的发布包', async () => {
  assert.deepEqual(targetAssetNames('darwin', 'arm64', '1.14.2'), ['sing-box-1.14.2-darwin-arm64.tar.gz']);
  assert.deepEqual(targetAssetNames('windows', 'amd64', '1.14.2'), ['sing-box-1.14.2-windows-amd64.zip']);
  const release = (digest) => ({
    statusCode: 200,
    body: { text: async () => JSON.stringify({
      tag_name: 'v1.14.2',
      assets: [{
        name: 'sing-box-1.14.2-linux-amd64.tar.gz',
        size: 10,
        browser_download_url: 'https://github.com/SagerNet/sing-box/releases/download/v1.14.2/sing-box-1.14.2-linux-amd64.tar.gz',
        digest
      }]
    }) }
  });
  const aiHomeDir = tempDir();
  const planned = await planSingBoxInstall({ platform: 'linux', arch: 'x64' }, {
    aiHomeDir,
    requestImpl: async () => release(`sha256:${'a'.repeat(64)}`)
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.plan.archiveFormat, 'tar.gz');
  assert.equal(planned.plan.targetPath, path.join(aiHomeDir, 'tools', 'sing-box', '1.14.2', 'sing-box'));
  const unsigned = await planSingBoxInstall({ platform: 'linux', arch: 'x64' }, {
    aiHomeDir,
    requestImpl: async () => release(undefined)
  });
  assert.equal(unsigned.error, 'core_release_asset_unavailable');
});

test('sing-box 发布包解压：从 tar.gz 的子目录取出可执行文件', { skip: process.platform === 'win32' }, () => {
  const work = tempDir();
  const packageDir = path.join(work, 'sing-box-1.14.2-linux-amd64');
  fs.mkdirSync(packageDir);
  writeFakeBinary(packageDir, 'sing-box version 1.14.2');
  fs.writeFileSync(path.join(packageDir, 'LICENSE'), 'x');
  const archive = path.join(work, 'pkg.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', work, 'sing-box-1.14.2-linux-amd64']).status, 0);
  const target = path.join(work, 'out-binary');
  const ok = extractSingBoxArchive(fs.readFileSync(archive), target, { platform: 'linux', archiveFormat: 'tar.gz' });
  assert.equal(ok, true);
  assert.match(fs.readFileSync(target, 'utf8'), /1\.14\.2/);
  assert.equal(fs.existsSync(`${target}.extract`), false);
});

test('sing-box 程序探测：受管目录与 ZCode 的 bin/sing-box 共用，低于 1.11 的版本不可用', { skip: process.platform === 'win32' }, () => {
  const aiHomeDir = tempDir();
  const sharedBin = path.join(aiHomeDir, 'bin');
  fs.mkdirSync(sharedBin);
  writeFakeBinary(sharedBin, 'sing-box version 1.14.2');
  const found = discoverSingBoxCore({ aiHomeDir, env: { PATH: '' }, platform: 'darwin' });
  assert.equal(found.installed, true);
  assert.equal(found.version, '1.14.2');
  assert.equal(found.binaryPath, path.join(sharedBin, 'sing-box'));

  writeFakeBinary(sharedBin, 'sing-box version 1.10.7');
  const old = discoverSingBoxCore({ aiHomeDir, env: { PATH: '' }, platform: 'darwin' });
  assert.equal(old.error, 'core_version_unsupported');
  assert.equal(old.reusable, false);
});

test('代理池切换内核：持久化选择、运行中拒绝切换、端口管理器同步新内核', async () => {
  const { ProxyPoolService } = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');
  const aiHomeDir = tempDir();
  const filePath = path.join(aiHomeDir, 'proxy-pool.json');
  const runtimeOptions = { aiHomeDir, env: { PATH: '' } };
  const service = new ProxyPoolService({ storeOptions: { filePath }, coreRuntimeOptions: runtimeOptions, platform: 'darwin' });
  assert.equal(service.core.id, 'mihomo');
  assert.deepEqual(service.listCores().map((core) => [core.id, core.active]), [['mihomo', true], ['sing-box', false]]);

  const selected = await service.selectCore('sing-box');
  assert.equal(selected.ok, true);
  assert.equal(service.core.id, 'sing-box');
  assert.equal(service.getCoreStatus().engine, 'sing-box');
  assert.equal(service.portManager.core.id, 'sing-box');
  assert.equal(service.portManager.coreRuntime, service.coreRuntime);

  const reopened = new ProxyPoolService({ storeOptions: { filePath }, coreRuntimeOptions: runtimeOptions, platform: 'darwin' });
  assert.equal(reopened.core.id, 'sing-box', '内核选择持久化');

  assert.equal((await service.selectCore('nope')).error, 'unsupported_proxy_core');
  service.coreRuntime = { getStatus: () => ({ running: true }) };
  const blocked = await service.selectCore('mihomo');
  assert.equal(blocked.error, 'proxy_core_switch_requires_stop');
  assert.equal(service.core.id, 'sing-box');
});

test('代理池数据目录遵循 AIH_HOST_HOME：存储、运行时与托管内核安装落在同一处', () => {
  const { resolveProxyPoolAiHome } = require('../lib/cli/services/toolkit/proxy-pool/aih-home');
  const { ProxyNodeStore } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
  const hostHome = tempDir();
  const env = { AIH_HOST_HOME: hostHome, HOME: '/should/not/be/used', PATH: '' };
  const expected = path.join(hostHome, '.ai_home');
  assert.equal(resolveProxyPoolAiHome({ env }), expected);
  assert.equal(resolveProxyPoolAiHome({ env: { ...env, AIH_HOME: '/explicit' } }), '/explicit');
  assert.equal(resolveProxyPoolAiHome({ env, aiHomeDir: '/injected' }), '/injected');
  assert.equal(new ProxyNodeStore({ env }).filePath, path.join(expected, 'proxy-pool.json'));
  assert.equal(getProxyCore('sing-box').createRuntime({ env }).runtimeDir, path.join(expected, 'run', 'proxy-pool', 'sing-box'));
  const managed = discoverSingBoxCore({ env, platform: 'linux' });
  assert.equal(managed.installed, false);
  fs.mkdirSync(path.join(expected, 'tools', 'sing-box', 'current'), { recursive: true });
  writeFakeBinary(path.join(expected, 'tools', 'sing-box', 'current'), 'sing-box version 1.14.2');
  assert.equal(discoverSingBoxCore({ env, platform: 'linux' }).binaryPath, path.join(expected, 'tools', 'sing-box', 'current', 'sing-box'));
});
