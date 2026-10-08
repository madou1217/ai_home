'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { createNativeStdioProtocolTap } = require('../lib/runtime/native-stdio-protocol-tap');

function harness(t, timeoutMs = 1000) {
  const input = new PassThrough(), output = new PassThrough();
  const tap = createNativeStdioProtocolTap({ input, output, timeoutMs });
  const received = [], forwarded = [], observed = [];
  tap.input.on('data', chunk => received.push(chunk));
  output.on('data', chunk => forwarded.push(chunk));
  tap.on('input', message => observed.push(message));
  t.after(() => { tap.dispose(); input.destroy(); output.destroy(); });
  return { tap, input, received, forwarded, observed };
}

test('native fragmented JSON, authentication callbacks and non-JSON output retain their exact bytes', t => {
  const h = harness(t);
  const request = Buffer.from('{"id":7,"method":"provider/updateAccountConfig","params":{"label":"中文"}}\r\n');
  h.input.write(request.subarray(0, request.length - 6));
  h.input.write(request.subarray(request.length - 6));
  assert.deepEqual(Buffer.concat(h.received), request);
  assert.equal(h.observed[0].method, 'provider/updateAccountConfig');
  const response = Buffer.from('{"id":"native-auth","method":"provider/auth"}\nplain output\r\n');
  h.tap.output.write(response.subarray(0, 12));
  h.tap.output.write(response.subarray(12));
  assert.deepEqual(Buffer.concat(h.forwarded), response);
});

test('only adapter responses are consumed; native IDs and private request callbacks remain visible', async t => {
  const h = harness(t);
  const done = h.tap.request('session/read', { sessionId: 'sess_original' });
  const request = JSON.parse(Buffer.concat(h.received));
  const callback = `${JSON.stringify({ id: request.id, method: 'native/callback' })}\n`;
  h.tap.output.write(callback);
  h.tap.output.write(JSON.stringify({ id: request.id, result: { original: true } }) + '\n');
  h.tap.output.write('{"id":9,"result":{}}\n');
  assert.deepEqual(await done, { original: true });
  assert.equal(Buffer.concat(h.forwarded).toString(), callback + '{"id":9,"result":{}}\n');
});

test('an injected request waits for a native partial frame to finish', async t => {
  const h = harness(t);
  h.input.write('{"id":1,"method":"native/');
  const done = h.tap.request('session/read', { sessionId: 'sess_original' });
  assert.equal(Buffer.concat(h.received).toString(), '{"id":1,"method":"native/');
  h.input.write('request"}\n');
  const frames = Buffer.concat(h.received).toString().trim().split('\n').map(JSON.parse);
  assert.equal(frames[0].method, 'native/request');
  assert.equal(frames[1].method, 'session/read');
  h.tap.output.write(JSON.stringify({ id: frames[1].id, result: {} }) + '\n');
  await done;
});

test('timeouts neither replay requests nor leak late responses into the Desktop', async t => {
  const h = harness(t, 15);
  const done = h.tap.request('session/send', { sessionId: 'sess_original' });
  const request = JSON.parse(Buffer.concat(h.received));
  await assert.rejects(done, { code: 'zcode_desktop_protocol_timeout' });
  h.tap.output.write(JSON.stringify({ id: request.id, result: { accepted: true } }) + '\n');
  assert.equal(h.forwarded.length, 0);
  assert.equal(h.received.length, 1);
});

test('disposing a tap rejects pending RPCs and future injections', async t => {
  const h = harness(t);
  const done = h.tap.request('session/read', {});
  const rejected = assert.rejects(done, { code: 'zcode_desktop_runtime_restarted' });
  h.tap.dispose();
  await rejected;
  await assert.rejects(h.tap.request('session/send', {}), { code: 'zcode_desktop_runtime_restarted' });
});
