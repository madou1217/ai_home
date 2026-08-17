'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createAppInstallJobManager } = require('../lib/server/app-install-job-manager');
const { handleWebUIRequest } = require('../lib/server/web-ui-router');

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    },
    end(chunk = '') {
      this.body += String(chunk);
      this.writableEnded = true;
    },
    on() { return this; }
  };
}

function createDeps(manager, body = '') {
  return {
    fs: require('node:fs'),
    appInstallJobManager: manager,
    readRequestBody: async () => Buffer.from(body),
    writeJson(res, status, payload) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }
  };
}

async function request(manager, method, pathname, body = '') {
  const req = new EventEmitter();
  req.method = method;
  req.url = pathname;
  req.headers = {};
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req,
    res,
    state: {},
    options: {},
    deps: createDeps(manager, body)
  });
  return { handled, req, res };
}

test('统一安装接口返回 202，并可查询异步任务', async () => {
  const manager = createAppInstallJobManager({
    installCli: async () => ({ installed: true, cliPath: '/tmp/codex' })
  });
  const created = await request(manager, 'POST', '/v0/webui/app-install', JSON.stringify({
    provider: 'codex',
    kind: 'cli'
  }));
  assert.equal(created.handled, true);
  assert.equal(created.res.statusCode, 202);
  const createdBody = JSON.parse(created.res.body);
  assert.equal(createdBody.accepted, true);
  assert.equal(createdBody.job.kind, 'cli');

  const queried = await request(manager, 'GET', `/v0/webui/app-install/jobs/${createdBody.job.id}`);
  assert.equal(queried.handled, true);
  assert.equal(queried.res.statusCode, 200);
  assert.equal(JSON.parse(queried.res.body).job.id, createdBody.job.id);
});

test('安装任务 watch 使用 SSE 推送初始状态，取消接口只取消 queued 任务', async () => {
  const manager = createAppInstallJobManager({
    installCli: async () => ({ installed: true, cliPath: '/tmp/codex' })
  });
  const created = manager.start({ appId: 'codex' });
  const watched = await request(manager, 'GET', `/v0/webui/app-install/jobs/${created.job.id}/watch`);
  assert.equal(watched.handled, true);
  assert.equal(watched.res.statusCode, 200);
  assert.equal(watched.res.headers['Content-Type'], 'text/event-stream');
  assert.match(watched.res.body, /"type":"connected"/);
  assert.match(watched.res.body, /"type":"install-job"/);
  watched.req.emit('close');

  const queuedManager = createAppInstallJobManager({ installCli: async () => ({ installed: true }) });
  const queued = queuedManager.start({ appId: 'codex' });
  const cancelled = await request(
    queuedManager,
    'POST',
    `/v0/webui/app-install/jobs/${queued.job.id}/cancel`
  );
  assert.equal(cancelled.res.statusCode, 200);
  assert.equal(JSON.parse(cancelled.res.body).job.status, 'cancelled');
});

test('安装任务路径无法解码时返回 400，不抛出到 server', async () => {
  const manager = createAppInstallJobManager();
  const result = await request(manager, 'GET', '/v0/webui/app-install/jobs/%E0%A4%A');
  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 400);
  assert.equal(JSON.parse(result.res.body).error, 'invalid_job_path');
});
