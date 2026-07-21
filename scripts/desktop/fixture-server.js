#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');
const {
  BLOB_BYTES,
  CONTRACT_VERSION,
  FIXTURE_PATHS,
  buildExpectedFixture,
} = require('./lib/smoke-contract');

function authorized(actualHeader, expectedToken) {
  const expectedHeader = Buffer.from(`Bearer ${expectedToken}`, 'utf8');
  const actual = Buffer.from(typeof actualHeader === 'string' ? actualHeader : '', 'utf8');
  return actual.length === expectedHeader.length && crypto.timingSafeEqual(actual, expectedHeader);
}

function sendJson(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': payload.length,
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(payload);
}

function createFixtureServer(options) {
  const expected = buildExpectedFixture(options.runId);
  const requests = [];

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const record = {
      authorized: false,
      method: request.method || 'UNKNOWN',
      path: requestUrl.pathname,
      status: 500,
    };
    requests.push(record);

    if (request.method === 'GET' && requestUrl.pathname === FIXTURE_PATHS.health) {
      record.status = 200;
      sendJson(response, 200, { ok: true, schemaVersion: CONTRACT_VERSION });
      return;
    }

    record.authorized = authorized(request.headers.authorization, options.managementKey);
    if (!record.authorized) {
      record.status = 401;
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === FIXTURE_PATHS.json) {
      record.status = 200;
      sendJson(response, 200, expected.json);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === FIXTURE_PATHS.sse) {
      record.status = 200;
      response.writeHead(200, {
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      });
      for (const event of expected.sse) {
        response.write(`event: ${event.event}\n`);
        response.write(`data: ${JSON.stringify(event.data)}\n\n`);
      }
      response.end();
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === FIXTURE_PATHS.blob) {
      record.status = 200;
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="desktop-smoke.bin"',
        'Content-Length': BLOB_BYTES.length,
        'Content-Type': 'application/octet-stream',
        'X-Content-SHA256': expected.blob.sha256,
      });
      response.end(BLOB_BYTES);
      return;
    }

    record.status = 404;
    sendJson(response, 404, { error: 'not_found' });
  });

  return {
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
    expected,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        resolve(`http://127.0.0.1:${address.port}`);
      });
    }),
    snapshot: () => ({
      requests: requests.map((request) => ({ ...request })),
    }),
  };
}

async function runChildProcessFixture() {
  const runId = process.env.AIH_DESKTOP_FIXTURE_RUN_ID;
  const managementKey = process.env.AIH_DESKTOP_FIXTURE_MANAGEMENT_KEY;
  if (!runId || !managementKey) {
    throw new Error('fixture 缺少进程环境配置');
  }
  if (typeof process.send !== 'function') {
    throw new Error('fixture 必须由 packaged smoke runner 通过 IPC 启动');
  }

  const fixture = createFixtureServer({ managementKey, runId });
  const baseUrl = await fixture.listen();
  process.send({
    type: 'ready',
    baseUrl,
    expected: fixture.expected,
  });

  process.on('message', async (message) => {
    if (message?.type === 'snapshot') {
      process.send({ type: 'snapshot', ...fixture.snapshot() });
      return;
    }
    if (message?.type === 'close') {
      await fixture.close();
      process.exit(0);
    }
  });
}

if (require.main === module) {
  runChildProcessFixture().catch((error) => {
    process.stderr.write(`desktop fixture 启动失败: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createFixtureServer,
};
