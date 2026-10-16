'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleWebUiEdgeProxyRoutes } = require('../lib/server/webui-edge-proxy-routes');
const { EdgeProxyService } = require('../lib/cli/services/toolkit/edge-proxy/edge-proxy-service');

function makeHarness(options = {}) {
  const confDir = options.confDir || fs.mkdtempSync(path.join(os.tmpdir(), 'aih-edge-routes-'));
  const calls = [];
  let body = options.body || {};
  const run = options.run || (() => ({ status: 0, stdout: '', stderr: '' }));
  // 假二进制必须是真实存在的文件：探测逻辑会校验路径（不存在就报「没装」）。
  const fakeBin = path.join(path.dirname(confDir), `nginx-${path.basename(confDir)}`);
  fs.writeFileSync(fakeBin, '#!/bin/sh\n');
  fs.chmodSync(fakeBin, 0o755);
  const env = { AIH_EDGE_NGINX_BIN: fakeBin, AIH_EDGE_NGINX_CONF_DIR: confDir };
  const ctx = {
    fs,
    serverPort: options.port || 9527,
    writeJson: (res, status, payload) => {
      calls.push({ status, payload });
    },
    readRequestBody: async () => Buffer.from(JSON.stringify(body)),
    deps: {
      createEdgeProxyService: ({ aihPort }) => new EdgeProxyService({ fs, env, run, aihPort: aihPort || options.port || 9527 })
    }
  };
  return {
    confDir,
    calls,
    ctx,
    setBody: (next) => {
      body = next;
    }
  };
}

function url(pathname, query = '') {
  return `/v0/webui/toolkit/edge${pathname}${query}`;
}

test('edge routes: 非本前缀的请求交还给其它 toolkit 处理器', async () => {
  const { ctx } = makeHarness();
  const handled = await handleWebUiEdgeProxyRoutes({ url: '/v0/webui/toolkit/tools' }, {}, 'GET', '/v0/webui/toolkit/tools', ctx);
  assert.equal(handled, false);
});

test('edge routes: status 暴露真实探测结果与 AIH 端口（转发目标跟随端口）', async () => {
  const { ctx, calls } = makeHarness({ port: 9600 });
  const handled = await handleWebUiEdgeProxyRoutes({ url: url('') }, {}, 'GET', url(''), ctx);

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  const { status, payload } = calls[0];
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.aihPort, 9600);
  assert.equal(payload.platform, process.platform);
  assert.ok(payload.providers.nginx, '要能看到 nginx 的探测结果');
  assert.ok(payload.providers.caddy, '要能看到 caddy 的探测结果');
  assert.ok(payload.providers.frp, '要能看到 frp 的探测结果');
});

test('edge routes: 转发目标取请求实际落到的本地监听端口（AIH 换过端口也不会指错）', async () => {
  const { ctx, calls } = makeHarness({ port: 9527 });
  await handleWebUiEdgeProxyRoutes({ url: url(''), socket: { localPort: 9600 } }, {}, 'GET', url(''), ctx);
  assert.equal(calls[0].payload.aihPort, 9600, '以 socket.localPort 为准，而不是配置里的旧值');
});

test('edge routes: plan 只生成不落盘，内容就是要写入的那一份', async () => {
  const { ctx, calls, confDir } = makeHarness();
  const handled = await handleWebUiEdgeProxyRoutes(
    { url: url('/plan', '?provider=nginx&mode=passthrough&domain=edge.example.com') },
    {},
    'GET',
    url('/plan'),
    ctx
  );

  assert.equal(handled, true);
  const { status, payload } = calls[0];
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.match(payload.plan.files[0].content, /^stream \{/m);
  assert.equal(path.dirname(payload.plan.files[0].path), confDir);
  assert.deepEqual(fs.readdirSync(confDir), [], 'plan 阶段不写任何文件');
});

test('edge routes: plan 缺域名/未知 provider 明确报错，不猜默认值', async () => {
  const { ctx, calls } = makeHarness();
  await handleWebUiEdgeProxyRoutes({ url: url('/plan', '?provider=nginx&mode=split') }, {}, 'GET', url('/plan'), ctx);
  assert.equal(calls[0].status, 400);
  assert.equal(calls[0].payload.error, 'edge_domain_required');

  const second = makeHarness();
  await handleWebUiEdgeProxyRoutes({ url: url('/plan', '?provider=haproxy&domain=x.com') }, {}, 'GET', url('/plan'), second.ctx);
  assert.equal(second.calls[0].status, 400);
  assert.equal(second.calls[0].payload.error, 'edge_unknown_provider');
});

test('edge routes: apply 写片段并补 nginx.conf include，校验通过才算成功', async () => {
  const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-edge-apply-'));
  fs.writeFileSync(path.join(confDir, 'nginx.conf'), 'events {}\nhttp {\n    include /etc/nginx/conf.d/*.conf;\n}\n');
  const { ctx, calls, setBody } = makeHarness({ confDir });
  setBody({ provider: 'nginx', mode: 'passthrough', domain: 'edge.example.com' });

  const handled = await handleWebUiEdgeProxyRoutes(
    { url: url('/apply') },
    {},
    'POST',
    url('/apply'),
    ctx
  );

  assert.equal(handled, true);
  const { status, payload } = calls[0];
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.reloaded, true);

  const streamFile = path.join(confDir, 'aih-edge-stream.conf');
  assert.ok(fs.existsSync(streamFile), '片段要落盘');
  const mainConf = fs.readFileSync(path.join(confDir, 'nginx.conf'), 'utf8');
  const includeLine = mainConf.split('\n').findIndex((line) => line.includes(streamFile));
  const httpLine = mainConf.split('\n').findIndex((line) => /^\s*http\s*\{/.test(line));
  assert.ok(includeLine >= 0, '要在 nginx.conf 里补 include');
  assert.ok(includeLine < httpLine, 'include 必须在 http{} 之前（stream 只能挂顶层）');
});

test('edge routes: apply 校验失败 → 422 且回滚（不留下半份配置）', async () => {
  const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-edge-rollback-'));
  const original = 'events {}\nhttp {\n    include /etc/nginx/conf.d/*.conf;\n}\n';
  fs.writeFileSync(path.join(confDir, 'nginx.conf'), original);
  const { ctx, calls, setBody } = makeHarness({
    confDir,
    run: (command, args) => (args.includes('-t')
      ? { status: 1, stdout: '', stderr: 'nginx: [emerg] unknown directive "stream"' }
      : { status: 0, stdout: '', stderr: '' })
  });
  setBody({ provider: 'nginx', mode: 'passthrough', domain: 'edge.example.com' });

  await handleWebUiEdgeProxyRoutes({ url: url('/apply') }, {}, 'POST', url('/apply'), ctx);

  const { status, payload } = calls[0];
  assert.equal(status, 422);
  assert.equal(payload.error, 'edge_config_rejected');
  assert.equal(fs.existsSync(path.join(confDir, 'aih-edge-stream.conf')), false, '被拒的片段要删掉');
  assert.equal(fs.readFileSync(path.join(confDir, 'nginx.conf'), 'utf8'), original, 'nginx.conf 要还原');
});
