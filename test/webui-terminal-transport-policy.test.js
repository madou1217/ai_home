'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  defaultWebTerminalSessionKey,
  isSameMachineRequest,
  resolveTerminalTransport
} = require('../lib/server/webui-terminal-transport-policy');

const desktop = { platform: 'darwin', env: {} };
const headless = { platform: 'linux', env: {} };

function req(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

test('same-machine browser on a desktop server keeps the native terminal', () => {
  assert.equal(isSameMachineRequest(req('127.0.0.1')), true);
  assert.equal(isSameMachineRequest(req('::ffff:127.0.0.1')), true);
  assert.equal(resolveTerminalTransport({ req: req('127.0.0.1'), requested: 'native', processObj: desktop }), 'native');
  assert.equal(resolveTerminalTransport({ req: req('::1'), requested: '', processObj: desktop }), 'native');
});

test('a local user may still choose the web terminal explicitly', () => {
  assert.equal(resolveTerminalTransport({ req: req('127.0.0.1'), requested: 'webui', processObj: desktop }), 'webui');
});

test('LAN and public clients always get the web terminal, even if they ask for native', () => {
  for (const address of ['192.168.31.8', '10.0.0.5', '54.178.88.80', '::ffff:192.168.1.2']) {
    assert.equal(resolveTerminalTransport({ req: req(address), requested: 'native', processObj: desktop }), 'webui', address);
  }
});

test('proxied requests count as remote even when the socket is loopback', () => {
  // cloudflared / reverse proxies and server-to-server relays connect from 127.0.0.1.
  for (const headers of [
    { 'x-forwarded-for': '203.0.113.9' },
    { 'cf-connecting-ip': '203.0.113.9' },
    { 'x-real-ip': '203.0.113.9' },
    { forwarded: 'for=203.0.113.9' },
    { 'x-aih-server-id': 'aws' }
  ]) {
    assert.equal(isSameMachineRequest(req('127.0.0.1', headers)), false, JSON.stringify(headers));
    assert.equal(resolveTerminalTransport({ req: req('127.0.0.1', headers), requested: 'native', processObj: desktop }), 'webui');
  }
});

test('a headless server never opens native terminals', () => {
  assert.equal(resolveTerminalTransport({ req: req('127.0.0.1'), requested: 'native', processObj: headless }), 'webui');
  assert.equal(resolveTerminalTransport({
    req: req('127.0.0.1'), requested: 'native', processObj: { platform: 'linux', env: { DISPLAY: ':0' } }
  }), 'native');
});

test('missing request info fails closed to the web terminal', () => {
  assert.equal(resolveTerminalTransport({ req: undefined, requested: 'native', processObj: desktop }), 'webui');
  assert.equal(resolveTerminalTransport({ req: { headers: {} }, requested: 'native', processObj: desktop }), 'webui');
});

test('server-generated session keys are unique and printable', () => {
  let n = 0;
  const randomBytes = () => Buffer.from([n++, 1, 2, 3, 4, 5, 6, 7]);
  const a = defaultWebTerminalSessionKey({ accountRef: 'acct_1', harness: 'codex', workdir: '/home/u/my proj', randomBytes });
  const b = defaultWebTerminalSessionKey({ accountRef: 'acct_1', harness: 'codex', workdir: '/home/u/my proj', randomBytes });
  assert.notEqual(a, b);
  assert.match(a, /^account-cli:[\x21-\x7e]+$/);
  assert.ok(a.length <= 'account-cli:'.length + 150);
});

test('every native-terminal launch route consults the transport policy', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', file), 'utf8');
  // open-app (账号页 CLI)、Toolkit 应用启动、Toolkit「唤起终端」三条入口都必须经过同一策略。
  for (const file of ['webui-account-routes.js', 'webui-toolkit-routes.js', 'webui-client-terminal-routes.js']) {
    assert.match(read(file), /resolveTerminalTransport\(/, file);
  }
  assert.match(read('webui-client-terminal-routes.js'), /web_terminal_required/);
});
