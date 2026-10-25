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

function fakeChild(autoReady = true) {
  const child = new EventEmitter();
  child.killed = false;
  child.stdin = {
    writable: true,
    writes: [],
    write(value) { this.writes.push(value); return true; },
    end() { this.writable = false; }
  };
  child.stderr = new EventEmitter();
  child.stdout = new PassThrough();
  if (autoReady) process.nextTick(() => child.stdout.write('{"version":1,"type":"ready"}\n'));
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
  assert.equal(child.stdin.writes.length, 2);
  assert.doesNotMatch(child.stdin.writes[1], /do-not-log/);
  assert.match(child.stdin.writes[1], /zh-Hans/);
  launcher.stop();
  launcher.stop();
  assert.equal(child.killSignal, 'SIGTERM');
  assert.equal(child.stdin.writable, false);
});

test('launcher suppresses stale child events by generation', async () => {
  const child = fakeChild(false);
  child.stdout = new PassThrough();
  const events = [];
  const launcher = createDesktopLauncher({ build: async () => '/tmp/aih-helper', spawn: () => child, mode: 'helper' });
  launcher.on('event', (event) => events.push(event));
  const started = launcher.start();
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write('{"version":1,"type":"ready"}\n');
  await started;
  child.stdout.write(`${JSON.stringify({ version: 1, type: 'status', generation: 4, trusted: true })}\n`);
  child.stdout.write(`${JSON.stringify({ version: 1, type: 'status', generation: 3, trusted: false })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const statuses = events.filter((event) => event.type === 'status');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].trusted, true);
  launcher.stop({ permanent: true });
});

test('launcher performs versioned hello/ready handshake and rejects mismatched children', async () => {
  const child = fakeChild(false);
  child.stdout = new PassThrough();
  const statuses = [];
  const launcher = createDesktopLauncher({ build: async () => '/tmp/aih-helper', spawn: () => child, mode: 'helper' });
  launcher.on('status', (status) => statuses.push(status));
  const started = launcher.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(child.stdin.writes[0], /"type":"hello"/);
  child.stdout.write('{"version":1,"type":"ready"}\n');
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launcher.status().handshake, true);
  assert.equal(statuses.includes('running'), true);
  const incompatible = fakeChild(false);
  incompatible.stdout = new PassThrough();
  const second = createDesktopLauncher({ build: async () => '/tmp/aih-helper', spawn: () => incompatible, mode: 'helper' });
  const secondStart = second.start();
  await new Promise((resolve) => setImmediate(resolve));
  incompatible.stdout.write('{"version":2,"type":"ready"}\n');
  await secondStart;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.status().status, 'stopping');
  assert.equal(incompatible.killSignal, 'SIGTERM');
  launcher.stop({ permanent: true });
  second.stop({ permanent: true });
});

test('handshake timeout terminates helper and uses bounded restart policy', async () => {
  const children = [];
  const launcher = createDesktopLauncher({
    build: async () => '/tmp/aih-helper',
    spawn: () => {
      const child = fakeChild(false);
      const kill = child.kill;
      child.kill = (signal) => { kill(signal); child.emit('exit', null, signal); };
      children.push(child);
      return child;
    },
    mode: 'helper',
    config: { handshakeTimeoutMs: 10, restartDelayMs: 1, maxRestarts: 1 }
  });
  const started = await launcher.start();
  assert.equal(started, false);
  assert.equal(children[0].killSignal, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(children.length, 2);
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

test('desktop protocol passes strict Chat JSONL identities through the translation launcher', () => {
  assert.deepEqual(desktopProtocol.normalizeDesktopEvent({
    type: 'chat.open', requestId: 'request-1', generation: 2, target: { kind: 'aih-server', secret: 'drop-me' }
  }), {
    version: 1, type: 'chat.open', requestId: 'request-1', generation: 2,
    target: { kind: 'aih-server' }
  });
  assert.deepEqual(desktopProtocol.normalizeDesktopEvent({
    type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-1',
    generation: 3, text: 'hello'
  }), {
    version: 1, type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-1',
    generation: 3, text: 'hello'
  });
  assert.deepEqual(desktopProtocol.normalizeDesktopEvent({
    type: 'chat.event', requestId: 'request-1', sessionId: 'session-1', event: {
      schema: 'aih.chat.event.v1', eventId: 'event-1', sessionId: 'session-1', seq: 4, type: 'turn.started', at: 10,
      source: { provider: 'codex', runtimeId: 'runtime-1' }, payload: { safe: true, secret: 'drop-me' }, unknown: 'drop-me'
    }
  }), {
    version: 1, type: 'chat.event', requestId: 'request-1', sessionId: 'session-1',
    event: {
      schema: 'aih.chat.event.v1', eventId: 'event-1', sessionId: 'session-1', seq: 4, type: 'turn.started', at: 10,
      source: { provider: 'codex', runtimeId: 'runtime-1' }, payload: { safe: true }
    }
  });
  assert.deepEqual(desktopProtocol.normalizeDesktopEvent({
    type: 'chat.error', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-1', code: 'runtime_failed', message: 'retry'
  }), {
    version: 1, type: 'chat.error', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-1',
    code: 'runtime_failed', message: 'retry'
  });
  assert.equal(desktopProtocol.normalizeDesktopEvent({ type: 'chat.submit', requestId: 'r', sessionId: 's', text: 'missing command' }), null);
  assert.equal(desktopProtocol.normalizeDesktopEvent({ type: 'chat.event', requestId: 'r', sessionId: 's', event: 'not-an-object' }), null);
  assert.equal(desktopProtocol.normalizeDesktopEvent({ type: 'chat.open', requestId: 'r', target: { secret: 'drop-me' } }), null);
  assert.equal(desktopProtocol.normalizeDesktopEvent({ type: 'chat.error', requestId: 'r' }), null);
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
  assert.equal(receivedOptions.executionTarget, undefined);
  assert.equal(persisted, true);
  assert.equal(result.text, '你好');
  assert.equal(events[0].type, 'host-translate');
  assert.equal(events[1].type, 'done');
  host.stop();
});

test('standalone host preserves an explicitly persisted execution target across recreation', async () => {
  const targets = [];
  const factory = (options) => {
    targets.push(options.executionTarget || 'persisted');
    return { async setEnabled() {}, getStatus() { return {}; }, sendEvent() {}, async translate() { return { ok: true, text: '' }; }, stop() {} };
  };
  const first = createFullAppHost({ serviceFactory: factory, executionTarget: 'aih-server', platform: 'linux', fsImpl: {}, aiHomeDir: '/tmp/aih-persisted' });
  await first.start();
  first.stop();
  const second = createFullAppHost({ serviceFactory: factory, executionTarget: 'direct-provider', platform: 'linux', fsImpl: {}, aiHomeDir: '/tmp/aih-persisted' });
  await second.start();
  second.stop();
  assert.deepEqual(targets, ['aih-server', 'direct-provider']);
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

test('launcher queues re-enable until a running child finishes stopping', async () => {
  const children = [];
  const launcher = createDesktopLauncher({
    build: async () => '/tmp/aih-helper',
    spawn: () => { const child = fakeChild(); children.push(child); return child; },
    mode: 'helper'
  });
  await launcher.start();
  launcher.stop();
  const restarted = launcher.start();
  assert.equal(children.length, 1);
  children[0].emit('exit', 0, 'SIGTERM');
  await restarted;
  assert.equal(children.length, 2);
  launcher.stop({ permanent: true });
});

test('real full-app service protocol sends host request and never falls back to AIH Server', async () => {
  const child = fakeChild();
  const serverCalls = [];
  const directCalls = [];
  const service = createSystemTranslationService({
    fs: {},
    aiHomeDir: '',
    platform: 'darwin',
    mode: 'full-app',
    build: async () => '/tmp/aih-full-app',
    spawn: () => child,
    directExecutor: async (request) => {
      directCalls.push(request.target);
      return { ok: false, attempts: [{ attempt: 1, ok: false }], error: { code: 'translation_network_error', message: 'direct failed', retryable: true } };
    },
    serverExecutor: async () => { serverCalls.push(true); return { ok: true, text: 'server result', attempts: [] }; }
  });
  await service.start();
  service.sendEvent({ type: 'host-translate', id: 'host-1', text: 'Hello', target: 'zh-Hans' });
  const result = await service.translate({ id: 'host-1', text: 'Hello', target: 'zh-Hans', targetPolicy: 'explicit' });
  assert.equal(result.ok, false);
  assert.deepEqual(directCalls, ['direct-provider']);
  assert.deepEqual(serverCalls, []);
  assert.match(child.stdin.writes.join(''), /host-translate/);
  service.stop();
});

test('full-app Chat reports an actionable runtime-unavailable error without a bridge', async () => {
  const child = fakeChild();
  const service = createSystemTranslationService({
    fs: {},
    aiHomeDir: '',
    platform: 'darwin',
    mode: 'full-app',
    build: async () => '/tmp/aih-full-app',
    spawn: () => child
  });
  await service.start();
  child.stdout.write(JSON.stringify({
    version: 1,
    type: 'chat.open',
    requestId: 'full-app-chat-1',
    generation: 2,
    target: { kind: 'aih-server' }
  }) + '\n');
  await new Promise((resolve) => setImmediate(resolve));
  const writes = child.stdin.writes.map((value) => JSON.parse(value));
  const error = writes.find((event) => event.type === 'chat.error');
  assert.deepEqual(error, {
    version: 1,
    type: 'chat.error',
    requestId: 'full-app-chat-1',
    generation: 2,
    code: 'chat_runtime_unavailable',
    message: '当前桌面模式没有可用的 Chat Runtime，请连接 AIH Server 后重试'
  });
  service.stop();
});

test('service reconfigures and restores focus after helper auto-restart', async () => {
  const children = [];
  const service = createSystemTranslationService({
    fs: require('node:fs'),
    aiHomeDir: `/tmp/aih-desktop-restart-${process.pid}`,
    platform: 'darwin',
    mode: 'helper',
    build: async () => '/tmp/aih-helper',
    spawn: () => { const child = fakeChild(); children.push(child); return child; }
  });
  await service.setEnabled(true);
  assert.equal(children.length, 1);
  children[0].emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(children.length, 2);
  const writes = children[1].stdin.writes.join('');
  assert.match(writes, /"type":"configure"/);
  assert.match(writes, /"type":"webui-focus"/);
  service.stop();
});
