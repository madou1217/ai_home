'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { handleCodexResponsesWebSocket } = require('../lib/server/codex-responses-websocket');
const { chooseServerAccount, markProxyAccountFailure, markProxyAccountSuccess } = require('../lib/server/router');

const MODEL = 'fixture-model';
const quota = (code = 'usage_limit_reached') => ({
  type: 'response.failed', response: { status: 'failed', error: {
    code, message: "You've hit your usage limit.", resets_in_seconds: 3600
  } }
});
const created = id => ({ type: 'response.created', response: { id, output: [] } });
const completed = (id, output = []) => ({ type: 'response.completed', response: { id, output } });
const request = (extra = {}) => ({ type: 'response.create', model: MODEL,
  input: [{ role: 'user', content: 'continue the test task' }], ...extra });
const send = (ws, event) => ws.send(JSON.stringify(event));

async function fixture(t, onMessage, options = {}) {
  const upstream = http.createServer();
  const wss = new WebSocket.Server({ noServer: true });
  const sockets = new Set();
  const attempts = [], inputs = [], retries = [], stopped = [], activity = [];
  const track = server => server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  track(upstream);
  upstream.on('upgrade', (req, socket, head) => {
    const ref = req.headers.authorization.replace('Bearer test-', '');
    attempts.push({ ref, headers: req.headers });
    if (options.onUpgrade && options.onUpgrade(ref, socket) === false) return;
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      ws.on('message', (data, binary) => {
        const payload = binary ? null : JSON.parse(data.toString());
        inputs.push({ ref, payload, binary });
        onMessage(ws, payload, ref, inputs, data, binary);
      });
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}/v1`;
  const accounts = ['first', 'second', 'third'].slice(0, options.accounts || 2).map(ref => ({
    accountRef: ref, accessToken: `test-${ref}`, upstreamAccountId: `test-user-${ref}`,
    openaiBaseUrl: base, remainingPct: 50
  }));
  options.configureAccounts?.(accounts);
  const state = { accounts: { codex: accounts }, cursors: {} };
  const gateway = http.createServer(); track(gateway);
  gateway.on('upgrade', (req, socket, head) => {
    handleCodexResponsesWebSocket({ req, socket, head, state, options: { maxAttempts: options.maxAttempts || 3 } }, {
      chooseAccount: chooseServerAccount, isLoopbackUrl: () => false, handshakeTimeoutMs: 500,
      markProxyAccountFailure, markProxyAccountSuccess,
      accountActivity: {
        begin: (_p, ref) => activity.push(`begin:${ref}`), end: (_p, ref) => activity.push(`end:${ref}`)
      },
      onRetry: event => retries.push(event), onRetryUnavailable: event => stopped.push(event)
    }).catch(() => socket.destroy());
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
    headers: { 'x-account-ref': 'first', 'x-codex-turn-state': 'first-account-opaque-state' }
  });
  client.on('error', () => {});
  const received = [];
  client.on('message', (data, binary) => received.push({ data: data.toString(), binary }));
  t.after(async () => {
    client.terminate();
    for (const ws of wss.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    wss.close();
    await Promise.all([upstream, gateway].map(server => new Promise(resolve => server.close(resolve))));
  });
  await once(client, 'open');
  return { client, received, attempts, inputs, retries, stopped, activity, accounts, state };
}

function round(client, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('no terminal response')); }, 2500);
    function cleanup() { clearTimeout(timer); client.off('message', listener); }
    function listener(data, binary) {
      if (binary) return;
      const event = JSON.parse(data.toString());
      if (['response.completed', 'response.failed', 'error'].includes(event.type)) { cleanup(); resolve(event); }
    }
    client.on('message', listener);
    client.send(JSON.stringify(payload));
  });
}

async function settleActivity(fixture) {
  const deadline = Date.now() + 1000;
  while (fixture.activity.filter(x => x.startsWith('begin:')).length !== fixture.activity.filter(x => x.startsWith('end:')).length) {
    assert.ok(Date.now() < deadline, 'connection activity did not settle after client close');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function close(client) {
  if (client.readyState === WebSocket.CLOSED) return;
  const closed = once(client, 'close'); client.close(); await closed;
}

test('mid-session quota switches accounts, carries tool results and continues on the same client', { timeout: 6000 }, async t => {
  const call = { type: 'function_call', id: 'fc_old', call_id: 'call_edit', name: 'apply_patch', arguments: '{"test":true}' };
  const f = await fixture(t, (ws, payload, ref, inputs) => {
    if (inputs.length === 1) {
      send(ws, created('resp_first'));
      send(ws, { type: 'response.output_item.done', output_index: 0, item: call });
      send(ws, completed('resp_first', [{ type: 'reasoning', id: 'rs_old', encrypted_content: 'account-bound' }, call]));
    } else if (ref === 'first') {
      send(ws, created('resp_rejected')); send(ws, quota()); ws.close(1000);
    } else {
      send(ws, created('resp_second'));
      send(ws, completed('resp_second', [{ type: 'message', id: 'msg_new', role: 'assistant', content: [{ type: 'output_text', text: 'continued' }] }]));
    }
  });
  assert.equal((await round(f.client, request())).type, 'response.completed');
  // The native client executed this tool once. Only its already-completed
  // output is replayed as history; no new user turn/continue is synthesized.
  const result = { type: 'function_call_output', call_id: 'call_edit', output: 'file updated once' };
  const terminal = await round(f.client, request({ previous_response_id: 'resp_first', input: [result] }));
  assert.equal(terminal.type, 'response.completed');
  assert.deepEqual(f.inputs.map(x => x.ref), ['first', 'first', 'second']);
  const replay = f.inputs[2].payload;
  assert.equal(replay.previous_response_id, undefined);
  assert.deepEqual(replay.input, [request().input[0], { ...call, id: undefined }, result].map(x => {
    const copy = { ...x }; delete copy.id; return copy;
  }));
  assert.equal(replay.model, MODEL);
  assert.equal(f.attempts[1].headers['x-codex-turn-state'], undefined);
  assert.equal(f.attempts[1].headers['chatgpt-account-id'], 'test-user-second');
  assert.equal(f.received.filter(x => x.data.includes('"type":"response.output_item.done"')).length, 1);
  assert.equal(f.received.some(x => x.data.includes('usage_limit_reached') || x.data.includes('resp_rejected')), false);
  assert.equal(f.accounts[0].authInvalidUntil || 0, 0);
  assert.ok(f.accounts[0].modelCooldowns[MODEL] > Date.now());
  assert.equal(f.retries.length, 1);
  const third = request({ previous_response_id: 'resp_second', input: [{ role: 'user', content: 'next' }] });
  assert.equal((await round(f.client, third)).type, 'response.completed');
  assert.deepEqual(f.inputs.at(-1).payload, third);
  assert.equal(f.inputs.at(-1).ref, 'second');
  await close(f.client);
  await settleActivity(f);
  assert.deepEqual(f.activity, ['begin:first', 'end:first', 'begin:second', 'end:second']);
});

test('quota in the first response is retried without exposing its lifecycle metadata', async t => {
  const f = await fixture(t, (ws, _payload, ref) => {
    send(ws, created(ref)); send(ws, ref === 'first' ? quota() : completed('ok'));
  });
  assert.equal((await round(f.client, request())).type, 'response.completed');
  assert.equal(f.received.some(x => x.data.includes('"id":"first"')), false);
});

test('quota visits each usable account at most once and surfaces one real error on exhaustion', async t => {
  const f = await fixture(t, ws => { send(ws, created('rejected')); send(ws, quota()); }, { accounts: 3 });
  assert.equal((await round(f.client, request())).type, 'response.failed');
  await close(f.client);
  await settleActivity(f);
  assert.equal(f.attempts.length, 3);
  assert.equal(new Set(f.attempts.map(x => x.ref)).size, 3);
  assert.equal(f.received.filter(x => x.data.includes('response.failed')).length, 1);
  assert.equal(f.activity.filter(x => x.startsWith('begin:')).length, f.activity.filter(x => x.startsWith('end:')).length);
});

for (const semantic of [
  { type: 'response.output_text.delta', delta: 'partial' },
  { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'already-delivered' } },
  { type: 'response.reasoning_summary_text.delta', delta: 'partial reasoning' }
]) {
  test(`quota after ${semantic.type} never replays an exposed attempt`, async t => {
    const f = await fixture(t, ws => { send(ws, created('started')); send(ws, semantic); send(ws, quota()); });
    assert.equal((await round(f.client, request())).type, 'response.failed');
    assert.equal(f.attempts.length, 1);
    assert.equal(f.retries.length, 0);
    assert.equal(f.stopped[0].reason, 'output_already_committed');
  });
}

for (const extra of [
  { previous_response_id: 'unknown-checkpoint', input: [] },
  { input: [{ type: 'item_reference', id: 'old' }] },
  { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'private-file' }] }] },
  { input: [{ type: 'function_call_output', call_id: 'missing', output: 'cannot reconstruct' }] }
]) {
  test(`unreconstructable context is not silently replaced: ${JSON.stringify(extra)}`, async t => {
    const f = await fixture(t, ws => send(ws, quota()));
    assert.equal((await round(f.client, request(extra))).type, 'response.failed');
    assert.equal(f.attempts.length, 1);
    assert.equal(f.stopped[0].reason, 'replay_context_unavailable');
  });
}

for (const code of ['content_policy_violation', 'invalid_request_error', 'invalid_api_key', 'response_not_found']) {
  test(`non-quota ${code} does not trigger quota account failover`, async t => {
    const f = await fixture(t, ws => send(ws, { type: 'error', error: { code } }));
    assert.equal((await round(f.client, request())).type, 'error');
    assert.equal(f.attempts.length, 1);
    assert.equal(f.retries.length, 0);
  });
}

test('replacement honors current model cooldowns instead of retrying every stored credential', async t => {
  const f = await fixture(t, (ws, _payload, ref) => send(ws, ref === 'first' ? quota() : completed('third')), {
    accounts: 3, configureAccounts: accounts => { accounts[1].modelCooldowns = { [MODEL]: Date.now() + 60000 }; }
  });
  assert.equal((await round(f.client, request())).type, 'response.completed');
  assert.deepEqual(f.inputs.map(x => x.ref), ['first', 'third']);
});

test('binary frames retain their binary type and cannot trigger account switching', async t => {
  const f = await fixture(t, (ws, _payload, _ref, _inputs, data, binary) => ws.send(data, { binary }));
  const response = once(f.client, 'message');
  f.client.send(JSON.stringify(quota()), { binary: true });
  const [data, binary] = await response;
  assert.equal(binary, true);
  assert.deepEqual(JSON.parse(data), quota());
  assert.equal(f.attempts.length, 1);
});

test('disconnect aborts replacement handshake without sending the inference to another account', { timeout: 5000 }, async t => {
  let notify;
  const replacement = new Promise(resolve => { notify = resolve; });
  const f = await fixture(t, ws => send(ws, quota()), {
    onUpgrade: (ref, socket) => {
      if (ref !== 'second') return true;
      socket.resume(); socket.once('end', () => socket.destroy()); notify(); return false;
    }
  });
  f.client.send(JSON.stringify(request()));
  await replacement;
  const closed = once(f.client, 'close'); f.client.terminate(); await closed;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.activity, ['begin:first', 'end:first', 'begin:second', 'end:second']);
});


test('attempt budget remains finite even when an additional account exists', async t => {
  const f = await fixture(t, ws => send(ws, quota()), { accounts: 3, maxAttempts: 2 });
  assert.equal((await round(f.client, request())).type, 'response.failed');
  assert.equal(f.attempts.length, 2);
  assert.equal(f.stopped[0].reason, 'attempt_budget_exhausted');
});

test('warmup completion does not clear a real model quota cooldown', async t => {
  const until = Date.now() + 60000;
  const f = await fixture(t, ws => send(ws, completed('warmup')), {
    configureAccounts: accounts => { accounts[0].modelCooldowns = { [MODEL]: until }; }
  });
  assert.equal((await round(f.client, request({ generate: false }))).type, 'response.completed');
  assert.equal(f.accounts[0].modelCooldowns[MODEL], until);
});

test('a live pool deletion is honored before choosing the replacement', async t => {
  let f;
  f = await fixture(t, (ws, _payload, ref) => {
    if (ref === 'first') {
      f.state.accounts.codex = f.state.accounts.codex.filter(account => account.accountRef !== 'second');
      send(ws, quota());
    } else send(ws, completed('third'));
  }, { accounts: 3 });
  assert.equal((await round(f.client, request())).type, 'response.completed');
  assert.deepEqual(f.inputs.map(x => x.ref), ['first', 'third']);
});

test('a failed replacement handshake tries the next eligible sibling', async t => {
  const f = await fixture(t, (ws, _payload, ref) => send(ws, ref === 'first' ? quota() : completed('third')), {
    accounts: 3, onUpgrade: (ref, socket) => {
      if (ref !== 'second') return true;
      socket.end('HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n'); return false;
    }
  });
  assert.equal((await round(f.client, request())).type, 'response.completed');
  assert.deepEqual(f.attempts.map(x => x.ref), ['first', 'second', 'third']);
  assert.deepEqual(f.inputs.map(x => x.ref), ['first', 'third']);
});

test('binary output after held text metadata preserves both frame types', async t => {
  const f = await fixture(t, (ws, _payload, _ref, _inputs, data) => {
    send(ws, created('text-first')); ws.send(data, { binary: true }); send(ws, completed('done'));
  });
  assert.equal((await round(f.client, request())).type, 'response.completed');
  assert.deepEqual(f.received.map(x => x.binary), [false, true, false]);
});

test('pipelined requests remain transparent and quota never replays both', async t => {
  const f = await fixture(t, (ws, _payload, _ref, inputs) => {
    if (inputs.length === 1) send(ws, created('first'));
    else send(ws, quota());
  });
  f.client.send(JSON.stringify(request()));
  assert.equal((await round(f.client, request())).type, 'response.failed');
  assert.equal(f.attempts.length, 1);
  assert.equal(f.inputs.length, 2);
  assert.equal(f.retries.length, 0);
});
