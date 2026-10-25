'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { resolveDesktopMode } = require('../lib/desktop/runtime/desktop-mode');
const { createDesktopLauncher } = require('../lib/desktop/runtime/desktop-launcher');
const desktopProtocol = require('../lib/desktop/runtime/desktop-protocol');
const { createSystemTranslationService } = require('../lib/desktop/translation/service');

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.stdin = {
    writable: true,
    writes: [],
    write(value) { this.writes.push(value); return true; },
    end() { this.writable = false; }
  };
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = (signal) => { child.killed = true; child.killSignal = signal; };
  return child;
}

test('helper mode requires a live parent or server ownership and full-app is explicit', () => {
  assert.equal(resolveDesktopMode({ argv: ['node', 'translation', '--full-app'], parentPid: 0, serverOwned: false }), 'full-app');
  assert.equal(resolveDesktopMode({ argv: ['node', 'translation'], parentPid: process.pid, serverOwned: false }), 'helper');
  assert.equal(resolveDesktopMode({ argv: ['node', 'translation'], parentPid: 0, serverOwned: true }), 'helper');
  assert.equal(resolveDesktopMode({ argv: ['node', 'translation'], parentPid: 0, serverOwned: false }), 'full-app');
});

test('helper launcher stops when its parent exits while full-app starts without a server', async () => {
  const children = [];
  const spawn = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };
  let parentAlive = true;
  const helper = createDesktopLauncher({
    build: async () => '/tmp/aih-helper',
    spawn,
    mode: 'helper',
    config: { parentPid: 77, isParentAlive: () => parentAlive, parentPollMs: 1 }
  });
  await helper.start();
  assert.equal(children.length, 1);
  parentAlive = false;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(children[0].killSignal, 'SIGTERM');

  const app = createDesktopLauncher({ build: async () => '/tmp/aih-full-app', spawn, mode: 'full-app' });
  await app.start();
  assert.equal(children.length, 2);
  assert.equal(app.status().mode, 'full-app');
  app.stop();
  helper.stop();
});

test('launcher stop is atomic and send does not log or leak event data', async () => {
  const child = fakeChild();
  let builds = 0;
  const launcher = createDesktopLauncher({
    build: async () => { builds += 1; return '/tmp/aih-helper'; },
    spawn: () => child,
    mode: 'helper'
  });
  await Promise.all([launcher.start(), launcher.start()]);
  assert.equal(builds, 1);
  launcher.send({ type: 'configure', secret: 'do-not-log', target: 'zh-Hans' });
  assert.equal(child.stdin.writes.length, 1);
  assert.doesNotMatch(child.stdin.writes[0], /do-not-log/);
  assert.match(child.stdin.writes[0], /zh-Hans/);
  launcher.stop();
  launcher.stop();
  assert.equal(child.killSignal, 'SIGTERM');
  assert.equal(child.stdin.writable, false);
});

test('desktop protocol negotiates version and normalizes request generations and errors', () => {
  assert.deepEqual(desktopProtocol.negotiateVersion(1), { ok: true, version: 1 });
  assert.equal(desktopProtocol.negotiateVersion(2).ok, false);
  assert.deepEqual(desktopProtocol.normalizeDesktopEvent({ type: 'translate', id: 'r1', generation: 3, text: 'hello' }), {
    version: 1, type: 'translate', id: 'r1', generation: 3, text: 'hello'
  });
  assert.deepEqual(desktopProtocol.normalizeDesktopEvent({ type: 'cancel', id: 'r1', generation: 3 }), {
    version: 1, type: 'cancel', id: 'r1', generation: 3
  });
  assert.deepEqual(desktopProtocol.normalizeDesktopEvent({ type: 'error', id: 'r1', generation: 3, error: new Error('bad') }), {
    version: 1, type: 'error', id: 'r1', generation: 3, code: 'desktop_error', message: 'bad', retryable: true
  });
  assert.equal(desktopProtocol.normalizeDesktopEvent({ version: 2, type: 'translate', id: 'r1', text: 'hello' }), null);
});

test('full-app preflight detects language locally without an AIH Server', async () => {
  const calls = [];
  const service = createSystemTranslationService({
    fs: {},
    aiHomeDir: '',
    platform: 'linux',
    mode: 'full-app',
    fetch: () => { throw new Error('full-app must not call server detection'); },
    executionPort: {
      translate: async (request, options) => {
        calls.push(request.target);
        options.emit({ type: 'delta', content: '你好' });
        return { ok: true, text: '你好', usage: null, attempts: [] };
      }
    }
  });
  await service.prepareTranslation({ id: 'direct-1', text: 'Hello world', target: 'zh-Hans' });
  assert.deepEqual(calls, ['direct-provider']);
  service.stop();
});
