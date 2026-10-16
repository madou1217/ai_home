'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const frpProvider = require('../lib/cli/services/toolkit/edge-proxy/providers/frp');
const nginxProvider = require('../lib/cli/services/toolkit/edge-proxy/providers/nginx');
const caddyProvider = require('../lib/cli/services/toolkit/edge-proxy/providers/caddy');
const { EdgeProxyService } = require('../lib/cli/services/toolkit/edge-proxy/edge-proxy-service');

/**
 * 本机边缘转发管理（nginx / caddy / frp）：配置生成要正确，落地要**校验通过才重载、失败回滚**。
 * 这一层改坏配置的代价是把自己的入口（常常是 SSH 那条）关掉，所以回滚路径必须有测试。
 */

const FRPC_BASE = `serverAddr = "frp.example.com"
serverPort = 7000
auth.token = "secret"

[[proxies]]
name = "ssh-m4"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 22007
`;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-edge-'));
}

function fakeBinary(dir, name) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, '#!/bin/sh\n');
  fs.chmodSync(target, 0o755);
  return target;
}

test('frp provider lists, adds and removes only the entries it manages', () => {
  assert.deepEqual(frpProvider.listProxies(FRPC_BASE).map((proxy) => [proxy.name, proxy.managed]), [['ssh-m4', false]]);

  const added = frpProvider.upsertProxy(FRPC_BASE, { name: 'aih-server', type: 'tcp', localPort: 9527, remotePort: 29527 });
  const withUdp = frpProvider.upsertProxy(added, { name: 'aih-server-udp', type: 'udp', localPort: 9527, remotePort: 29527 });
  assert.deepEqual(frpProvider.listProxies(withUdp).map((proxy) => [proxy.name, proxy.managed]), [
    ['ssh-m4', false],
    ['aih-server', true],
    ['aih-server-udp', true]
  ]);
  // 重复 apply 不叠加：同名受管条目先被替换。
  const again = frpProvider.upsertProxy(withUdp, { name: 'aih-server', type: 'tcp', localPort: 9527, remotePort: 29999 });
  assert.equal(frpProvider.listProxies(again).filter((proxy) => proxy.name === 'aih-server').length, 1);
  assert.equal(frpProvider.listProxies(again).find((proxy) => proxy.name === 'aih-server').remotePort, 29999);

  // 删除受管条目时用户那条 ssh 必须原样保留。
  const removed = frpProvider.removeProxy(again, 'aih-server');
  assert.deepEqual(frpProvider.listProxies(removed).map((proxy) => proxy.name), ['ssh-m4', 'aih-server-udp']);
  assert.match(removed, /name = "ssh-m4"/);
  assert.doesNotMatch(removed, /name = "aih-server"\n/);
});

test('nginx plans cover the split / passthrough / http-only shapes', () => {
  const service = new EdgeProxyService({ env: { AIH_EDGE_NGINX_CONF_DIR: '/etc/nginx' }, path, aihPort: 9527 });

  const split = service.plan('nginx', { domain: 'aih.example.com', mode: 'split' });
  const stream = split.files.find((file) => file.topLevel).content;
  // 一个端口同时扛 HTTPS 与 SOCKS5：用 ssl_preread 分辨 TLS；UDP 直接透传。
  assert.match(stream, /map \$ssl_preread_protocol \$aih_443_backend/);
  assert.match(stream, /""\s+127\.0\.0\.1:9527/);
  assert.match(stream, /listen 443 udp;/);
  const site = split.files.find((file) => !file.topLevel).content;
  assert.match(site, /listen 127\.0\.0\.1:8443 ssl;/);
  assert.match(site, /X-Forwarded-Host \$host/);
  assert.match(site, /proxy_buffering off/);

  const passthrough = service.plan('nginx', { domain: 'aih.example.com', mode: 'passthrough' });
  assert.match(passthrough.files[0].content, /proxy_pass 127\.0\.0\.1:9527/);
  assert.match(passthrough.files[0].content, /listen 443 udp;/);

  const httpOnly = service.plan('nginx', {
    domain: 'aih.example.com', mode: 'http-only', certDir: '/etc/letsencrypt/live/aih.example.com'
  });
  assert.equal(httpOnly.files.length, 1);
  assert.match(httpOnly.files[0].content, /ssl_certificate\s+\/etc\/letsencrypt\/live\/aih\.example\.com\/fullchain\.pem/);
});

test('caddy plan is an https reverse proxy and says what it cannot do', () => {
  const service = new EdgeProxyService({ env: { AIH_EDGE_CADDYFILE: '/etc/caddy/Caddyfile' }, path, aihPort: 9527 });
  const plan = service.plan('caddy', { domain: 'aih.example.com' });
  assert.match(plan.files[0].content, /aih\.example\.com \{/);
  assert.match(plan.files[0].content, /reverse_proxy 127\.0\.0\.1:9527/);
  assert.ok(plan.notes.some((note) => note.includes('不做四层转发')));
  assert.equal(caddyProvider.configPathFromArgs('caddy run --config /etc/caddy/Caddyfile'), '/etc/caddy/Caddyfile');
});

test('applyFrp validates a staged copy first and never leaves a rejected config behind', () => {
  const dir = tempDir();
  const configPath = path.join(dir, 'frpc.toml');
  fs.writeFileSync(configPath, FRPC_BASE);
  const calls = [];
  const service = new EdgeProxyService({
    env: { AIH_EDGE_FRPC_CONFIG: configPath, AIH_EDGE_FRPC_BIN: fakeBinary(dir, 'frpc'), HOME: dir },
    run: (command, args) => {
      calls.push([command, ...args].join(' '));
      if (args[0] === 'verify' && service.rejectVerify) return { status: 1, stderr: 'bad config', stdout: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    path,
    now: () => 0
  });

  // 正常路径：校验通过 → 写真配置（带备份）→ 重载（本机没有服务管理器时给 hint，不假装成功）。
  const applied = service.apply('frp', { remotePort: 29527, localPort: 9527, udp: true });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.entries.map((entry) => entry.type), ['tcp', 'udp']);
  assert.ok(applied.backupPath.endsWith('.bak-1970-01-01T00-00-00-000Z'));
  assert.equal(applied.reloaded, false);
  assert.match(applied.hint, /手动重启/);
  const written = fs.readFileSync(configPath, 'utf8');
  assert.match(written, /name = "aih-server"/);
  assert.match(written, /name = "aih-server-udp"/);
  assert.match(written, /name = "ssh-m4"/);
  assert.equal(fs.existsSync(`${configPath}.aih-staged`), false, '临时文件必须清理');
  assert.ok(calls.some((call) => call.includes('verify')));

  // 校验失败：真配置必须保持原样（只有临时文件被用来验证）。
  const before = fs.readFileSync(configPath, 'utf8');
  service.rejectVerify = true;
  const rejected = service.apply('frp', { remotePort: 29999, localPort: 9527 });
  assert.deepEqual([rejected.ok, rejected.error], [false, 'edge_config_rejected']);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.equal(fs.existsSync(`${configPath}.aih-staged`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a config we cannot write is reported instead of guessing sudo', () => {
  const dir = tempDir();
  const configPath = path.join(dir, 'frpc.toml');
  fs.writeFileSync(configPath, FRPC_BASE);
  const service = new EdgeProxyService({
    env: { AIH_EDGE_FRPC_CONFIG: configPath, AIH_EDGE_FRPC_BIN: fakeBinary(dir, 'frpc') },
    path,
    run: () => ({ status: 0, stdout: '', stderr: '' })
  });
  service.isWritable = () => false;
  const result = service.apply('frp', { remotePort: 29527 });
  assert.deepEqual([result.ok, result.error], [false, 'edge_config_not_writable']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dry-run only prints the plan', () => {
  const dir = tempDir();
  const service = new EdgeProxyService({ env: { AIH_EDGE_FRPC_CONFIG: path.join(dir, 'frpc.toml') }, path });
  const result = service.apply('frp', { remotePort: 29527, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.kind, 'frp');
  assert.equal(fs.existsSync(path.join(dir, 'frpc.toml')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nginx apply rolls back every file when the kernel rejects the config', () => {
  const dir = tempDir();
  const configDir = path.join(dir, 'nginx');
  fs.mkdirSync(path.join(configDir, 'conf.d'), { recursive: true });
  const service = new EdgeProxyService({
    env: { AIH_EDGE_NGINX_BIN: fakeBinary(dir, 'nginx-bin'), AIH_EDGE_NGINX_CONF_DIR: configDir, HOME: dir },
    path,
    run: (command, args) => (args[0] === '-t'
      ? { status: 1, stderr: 'unexpected end of file', stdout: '' }
      : { status: 0, stdout: '', stderr: '' })
  });
  const result = service.apply('nginx', { domain: 'aih.example.com', mode: 'split' });
  assert.deepEqual([result.ok, result.error], [false, 'edge_config_rejected']);
  assert.equal(fs.existsSync(path.join(configDir, 'aih-edge-stream.conf')), false);
  assert.equal(fs.existsSync(path.join(configDir, 'conf.d', 'aih-edge-aih.example.com.conf')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('caddy apply replaces its managed block instead of appending again', () => {
  const dir = tempDir();
  const caddyfile = path.join(dir, 'Caddyfile');
  fs.writeFileSync(caddyfile, 'example.org {\n\trespond "hi"\n}\n');
  const service = new EdgeProxyService({
    env: { AIH_EDGE_CADDY_BIN: fakeBinary(dir, 'caddy'), AIH_EDGE_CADDYFILE: caddyfile, HOME: dir },
    path,
    run: () => ({ status: 0, stdout: '', stderr: '' })
  });
  service.apply('caddy', { domain: 'aih.example.com' });
  service.apply('caddy', { domain: 'aih.example.com' });
  const text = fs.readFileSync(caddyfile, 'utf8');
  assert.equal((text.match(/# >>> aih-edge:aih\.example\.com >>>/g) || []).length, 1, '受管块不能叠加');
  assert.match(text, /example\.org \{/);
  assert.match(text, /reverse_proxy 127\.0\.0\.1:9527/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nginx provider reads the config directory out of the version banner', () => {
  const output = 'nginx version: nginx/1.27.2\nbuilt by clang\nconfigure arguments: --prefix=/opt/homebrew/Cellar/nginx/1.27.2 --conf-path=/opt/homebrew/etc/nginx/nginx.conf';
  assert.equal(nginxProvider.configDirFromVersionOutput(output), '/opt/homebrew/etc/nginx');
  assert.equal(nginxProvider.configDirFromVersionOutput('no conf path here'), '');
});

