'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { resolveDesktopMode } = require('../lib/desktop/runtime/desktop-mode');
const { createDesktopLauncher } = require('../lib/desktop/runtime/desktop-launcher');
const desktopProtocol = require('../lib/desktop/runtime/desktop-protocol');
const { createSystemTranslationService } = require('../lib/desktop/translation/service');
const { createFullAppHost } = require('../lib/desktop/runtime/full-app-host');
const { normalizeTranslationSettings } = require('../lib/account/translation-settings-store');

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

test('launcher suppresses stale child events by generation', async () => {
  const child = fakeChild();
  child.stdout = new PassThrough();
  const events = [];
  const launcher = createDesktopLauncher({ build: async () => '/tmp/aih-helper', spawn: () => child, mode: 'helper' });
  launcher.on('event', (event) => events.push(event));
  await launcher.start();
  child.stdout.write(`${JSON.stringify({ version: 1, type: 'status', generation: 4, trusted: true })}\n`);
  child.stdout.write(`${JSON.stringify({ version: 1, type: 'status', generation: 3, trusted: false })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].trusted, true);
  launcher.stop({ permanent: true });
});

test('full-app launcher does not restart after an unexpected exit', async () => {
  const children = [];
  const launcher = createDesktopLauncher({
    build: async () => '/tmp/aih-full-app',
    spawn: () => { const child = fakeChild(); children.push(child); return child; },
    mode: 'full-app',
    config: { restartDelayMs: 1 }
  });
  await launcher.start();
  children[0].emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(children.length, 1);
  launcher.stop({ permanent: true });
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
  assert.equal(desktopProtocol.normalizeDesktopEvent({ type: 'translate', text: 'hello' }), null);
  assert.equal(desktopProtocol.normalizeDesktopEvent({ type: 'translate', id: 'r1', text: 'x'.repeat(8001) }), null);
  assert.equal(desktopProtocol.normalizeDesktopEvent({ type: 'translate', id: 'r1', generation: -1, text: 'hello' }), null);
  const nested = desktopProtocol.normalizeDesktopEvent({ type: 'settings', action: 'save', patch: { nested: { token: 'x'.repeat(5000) } } });
  assert.ok(nested.patch.nested.token.length <= 400);
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

test('standalone full-app host consumes native events and returns a direct result without a server', async () => {
  const events = [];
  let persisted = false;
  let receivedOptions;
  const host = createFullAppHost({
    aiHomeDir: '/tmp/aih-test-full-app',
    platform: 'darwin',
    fsImpl: {},
    serviceFactory: (options) => {
      receivedOptions = options;
      return {
        async setEnabled() { persisted = true; },
        getStatus() { return { executionTarget: 'direct-provider' }; },
        sendEvent(event) { events.push(event); },
        async translate(request) {
          events.push({ type: 'done', id: request.id, text: '你好' });
          return { ok: true, text: '你好', attempts: [] };
        },
        stop() {}
      };
    }
  });
  await host.start();
  const result = await host.translate('Hello world', 'zh-Hans');
  assert.equal(receivedOptions.mode, 'full-app');
  assert.equal(receivedOptions.executionTarget, 'direct-provider');
  assert.equal(persisted, true);
  assert.equal(result.text, '你好');
  assert.equal(events[0].type, 'host-translate');
  assert.equal(events[1].type, 'done');
  host.stop();
});

test('execution target survives the existing translation settings normalizer', () => {
  assert.equal(normalizeTranslationSettings({ executionTarget: 'direct-provider' }).executionTarget, 'direct-provider');
  assert.equal(normalizeTranslationSettings({ executionTarget: 'unknown' }).executionTarget, 'aih-server');
});

test('launcher schedules a fresh start when disable races with a pending build', async () => {
  const children = [];
  let resolveBuild;
  let builds = 0;
  const launcher = createDesktopLauncher({
    build: () => {
      builds += 1;
      if (builds === 1) return new Promise((resolve) => { resolveBuild = resolve; });
      return Promise.resolve('/tmp/aih-helper');
    },
    spawn: () => { const child = fakeChild(); children.push(child); return child; },
    mode: 'helper'
  });
  const pending = launcher.start();
  launcher.stop();
  launcher.start();
  resolveBuild('/tmp/aih-helper');
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(builds, 2);
  assert.equal(children.length, 1);
  launcher.stop({ permanent: true });
});
