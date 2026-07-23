'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const {
  freePort,
  listen,
  readJson,
  startAihServer,
  stopChild,
  waitFor,
  withTimeout
} = require('./fabric-reverse-gateway-harness');

function seedCodexAccount(homeDir) {
  const aiHomeDir = homeDir;
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:fabric-e2e@example.com'
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { auth: {
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: 'fabric-e2e-access-token',
      id_token: 'fabric-e2e-id-token',
      refresh_token: 'fabric-e2e-refresh-token',
      account_id: 'fabric-e2e-upstream-account'
    }
  } });
}

test('two real AIH Servers use the local Server outbound link as an automatic provider gateway', async (t) => {
  const publicHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-public-gateway-'));
  const localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-local-gateway-'));
  const publicPort = await freePort();
  const localPort = await freePort();
  const publicManagementKey = 'public-management-key-fabric-e2e';
  const localManagementKey = 'local-management-key-fabric-e2e';
  const publicClientKey = 'public-client-key-fabric-e2e';
  const localClientKey = 'local-client-key-fabric-e2e';
  seedCodexAccount(localHome);

  const upstream = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        models: [{ slug: 'gpt-fabric-e2e', supported_in_api: true, visibility: 'list' }]
      }));
      return;
    }
    if (req.method === 'POST' && pathname === '/responses') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      });
      res.write('data: {"type":"response.output_text.delta","delta":"fabric-http-pong"}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  const upstreamWebSocket = new WebSocket.Server({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => {
    if (req.url !== '/responses') {
      socket.destroy();
      return;
    }
    upstreamWebSocket.handleUpgrade(req, socket, head, (client) => {
      client.on('message', (data) => {
        client.send(`gateway:${data.toString()}`);
      });
    });
  });
  const upstreamAddress = await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const publicServer = startAihServer({
    homeDir: publicHome,
    port: publicPort,
    managementKey: publicManagementKey,
    clientKey: publicClientKey,
    codexBaseUrl: upstreamUrl
  });
  const localServer = startAihServer({
    homeDir: localHome,
    port: localPort,
    managementKey: localManagementKey,
    clientKey: localClientKey,
    codexBaseUrl: upstreamUrl
  });

  t.after(async () => {
    upstreamWebSocket.clients.forEach((client) => client.terminate());
    upstreamWebSocket.close();
    await stopChild(localServer.child);
    await stopChild(publicServer.child);
    await new Promise((resolve) => upstream.close(resolve));
    const cleanupOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 25 };
    fs.rmSync(localHome, cleanupOptions);
    fs.rmSync(publicHome, cleanupOptions);
  });

  await waitFor(async () => {
    const [publicHealth, localHealth] = await Promise.all([
      fetch(`http://127.0.0.1:${publicPort}/healthz`),
      fetch(`http://127.0.0.1:${localPort}/healthz`)
    ]);
    return publicHealth.ok && localHealth.ok;
  }).catch((error) => {
    assert.fail(`${error.message}\npublic:\n${publicServer.output()}\nlocal:\n${localServer.output()}`);
  });

  const before = await readJson(`http://127.0.0.1:${publicPort}/readyz`);
  assert.equal(before.payload.ready, false);
  assert.equal(before.payload.gateway.ready, false);

  const configured = await readJson(
    `http://127.0.0.1:${localPort}/v0/webui/server-routes/relays`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${localManagementKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        relays: [{
          endpoint: `http://127.0.0.1:${publicPort}`,
          name: 'Public Server 1',
          enabled: true,
          managementKey: publicManagementKey
        }]
      })
    }
  );
  assert.equal(configured.response.status, 200, JSON.stringify(configured.payload));

  const ready = await waitFor(async () => {
    const result = await readJson(`http://127.0.0.1:${publicPort}/readyz`);
    return result.payload.gateway?.ready ? result.payload : null;
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.gateway.connectedServers, 1);
  assert.equal(ready.gateway.availableAccounts, 1);

  const directory = await readJson(`http://127.0.0.1:${publicPort}/v0/fabric/broker/servers`, {
    headers: { authorization: `Bearer ${publicManagementKey}` }
  });
  assert.equal(directory.response.status, 200);
  assert.equal(directory.payload.result.servers.length, 1);
  const localServerId = directory.payload.result.servers[0].stableServerId;

  const models = await readJson(`http://127.0.0.1:${publicPort}/v1/models`, {
    headers: { authorization: `Bearer ${publicClientKey}` }
  });
  assert.equal(models.response.status, 200, JSON.stringify(models.payload));
  assert.equal(models.response.headers.get('x-aih-fabric-broker-server-id'), localServerId);
  assert.equal(models.payload.data.some((model) => model.id === 'gpt-fabric-e2e'), true);
  assert.equal(JSON.stringify(directory.payload).includes(localClientKey), false);
  assert.equal(JSON.stringify(directory.payload).includes(publicClientKey), false);

  const streamed = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${publicClientKey}`,
      accept: 'text/event-stream',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: 'gpt-fabric-e2e', input: 'ping', stream: true })
  });
  const streamedText = await streamed.text();
  assert.equal(streamed.status, 200, streamedText);
  assert.equal(streamed.headers.get('x-aih-fabric-broker-server-id'), localServerId);
  assert.equal(streamedText.includes('fabric-http-pong'), true);

  const client = new WebSocket(`ws://127.0.0.1:${publicPort}/v1/responses`, {
    headers: { authorization: `Bearer ${publicClientKey}` }
  });
  await withTimeout(new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  }), 5_000, 'gateway_websocket_open_timeout').catch((error) => {
    assert.fail(`${error.message}\npublic:\n${publicServer.output()}\nlocal:\n${localServer.output()}`);
  });
  const reply = new Promise((resolve, reject) => {
    client.once('message', (data) => resolve(data.toString()));
    client.once('error', reject);
    client.once('close', (code) => reject(new Error(`gateway_websocket_closed:${code}`)));
  });
  client.send('ping');
  const responseMessage = await withTimeout(reply, 5_000, 'gateway_websocket_reply_timeout')
    .catch((error) => {
      assert.fail(`${error.message}\npublic:\n${publicServer.output()}\nlocal:\n${localServer.output()}`);
    });
  assert.equal(responseMessage, 'gateway:ping');
  client.close();
});
