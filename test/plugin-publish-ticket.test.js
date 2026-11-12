'use strict';

// P2 发布票据：prepare 持有单发布锁，commit 之后才 activate；并发/TTL/discard 都必须释放锁。
// 这里用 fake supervisor 锁住代次状态机，不启动真实 Plugin Host。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPluginRuntimeService } = require('../lib/plugins/control/runtime-service');

function pluginFixture(instanceId = 'echo') {
  return {
    instanceId,
    entryPath: '/tmp/echo/index.js',
    configuration: {},
    manifest: {
      pluginId: instanceId,
      version: '1.0.0',
      entry: 'index.js',
      contributes: [
        { id: `${instanceId}.reply`, capability: 'gateway.request' }
      ]
    }
  };
}

function createFakeSupervisor(options = {}) {
  const calls = [];
  return {
    calls,
    async call(method, payload) {
      calls.push({ method, payload });
      if (method === 'prepare') return { value: { state: 'prepared', contributions: [{ id: 'echo.reply' }] } };
      if (method === 'activate') {
        if (options.activateError) throw options.activateError;
        return { value: { state: 'active' } };
      }
      if (method === 'dispose') return { value: { state: 'disposed' } };
      if (method === 'invoke') return { value: null };
      throw new Error(`unexpected host call: ${method}`);
    },
    status: () => ({ running: true, pid: 4321 }),
    async stop() {}
  };
}

function createRuntime(options = {}) {
  const supervisor = options.supervisor || createFakeSupervisor(options);
  const runtime = createPluginRuntimeService({
    aiHomeDir: '/tmp/plugin-ticket-test',
    desiredPlugins: () => [],
    supervisorFactory: () => supervisor,
    ticketTtlMs: options.ticketTtlMs,
    log: () => {}
  });
  return { runtime, supervisor };
}

test('prepare 只准备候选并持有票据，activate 后才切换活跃代次', async () => {
  const { runtime, supervisor } = createRuntime();
  const prepared = await runtime.prepare([pluginFixture()]);
  assert.ok(prepared.ticket);
  assert.equal(prepared.generation, 1);
  assert.equal(runtime.status().activeGeneration, 0);
  assert.deepEqual(supervisor.calls.map((item) => item.method), ['prepare']);

  const activated = await runtime.activate(prepared.ticket, 7);
  assert.equal(activated.state, 'active');
  assert.equal(activated.generation, 1);
  assert.equal(activated.revision, 7);
  assert.equal(runtime.status().activeGeneration, 1);
  assert.ok(supervisor.calls.some((item) => item.method === 'activate' && item.payload.retainPrevious === true));
});

test('并发 prepare 得到 plugin_publish_busy，discard 后可以重新发布', async () => {
  const { runtime } = createRuntime();
  const first = await runtime.prepare([pluginFixture()]);
  await assert.rejects(
    () => runtime.prepare([pluginFixture()]),
    (error) => error && error.code === 'plugin_publish_busy'
  );
  await runtime.discard(first.ticket, 'test');
  const second = await runtime.prepare([pluginFixture()]);
  assert.ok(second.ticket);
  assert.equal(second.generation, 2);
  await runtime.discard(second.ticket, 'test');
});

test('票据 TTL 到期自动 dispose 候选并释放发布锁', async () => {
  const { runtime, supervisor } = createRuntime({ ticketTtlMs: 10 });
  const prepared = await runtime.prepare([pluginFixture()]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(
    () => runtime.activate(prepared.ticket, 1),
    (error) => error && error.code === 'plugin_ticket_expired'
  );
  assert.ok(supervisor.calls.some((item) => item.method === 'dispose' && item.payload.generation === prepared.generation));
  const again = await runtime.prepare([pluginFixture()]);
  assert.ok(again.ticket);
  await runtime.discard(again.ticket, 'test');
});

test('未知票据与重复 activate 返回明确错误', async () => {
  const { runtime } = createRuntime();
  await assert.rejects(
    () => runtime.activate('missing-ticket', 1),
    (error) => error && error.code === 'plugin_ticket_unknown'
  );
  const prepared = await runtime.prepare([pluginFixture()]);
  await runtime.activate(prepared.ticket, 2);
  await assert.rejects(
    () => runtime.activate(prepared.ticket, 2),
    (error) => error && error.code === 'plugin_ticket_unknown'
  );
});

test('空集合也要票据：activate 返回 idle 且不启动宿主', async () => {
  const { runtime, supervisor } = createRuntime();
  const prepared = await runtime.prepare([]);
  assert.equal(prepared.generation, 0);
  const result = await runtime.activate(prepared.ticket, 5);
  assert.equal(result.state, 'idle');
  assert.equal(result.generation, 0);
  assert.equal(result.revision, 5);
  assert.equal(supervisor.calls.filter((item) => item.method === 'prepare').length, 0);
});

test('activate 失败会卸载候选并释放发布锁', async () => {
  const supervisor = createFakeSupervisor({ activateError: new Error('activate exploded') });
  const { runtime } = createRuntime({ supervisor });
  const prepared = await runtime.prepare([pluginFixture()]);
  await assert.rejects(() => runtime.activate(prepared.ticket, 3), /activate exploded/);
  assert.ok(supervisor.calls.some((item) => item.method === 'dispose' && item.payload.generation === prepared.generation));
  const again = await runtime.prepare([pluginFixture()]);
  assert.ok(again.ticket);
  await runtime.discard(again.ticket, 'test');
});

test('publish 兼容恢复路径：prepare→activate，commit 失败时丢弃候选', async () => {
  const { runtime, supervisor } = createRuntime();
  const result = await runtime.publish([pluginFixture()], null);
  assert.equal(result.state, 'active');
  assert.equal(runtime.status().activeGeneration, 1);
  assert.equal(supervisor.calls.filter((item) => item.method === 'prepare').length, 1);

  await assert.rejects(
    () => runtime.publish([pluginFixture()], async () => { throw new Error('cas failed'); }),
    /cas failed/
  );
  assert.ok(supervisor.calls.some((item) => item.method === 'dispose' && item.payload.generation === 2));
  // 锁已释放：下一次 prepare 不会 busy。
  const next = await runtime.prepare([pluginFixture()]);
  assert.ok(next.ticket);
  await runtime.discard(next.ticket, 'test');
});
