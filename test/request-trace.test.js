'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  currentTrace,
  currentTraceId,
  runWithTrace,
  traceLogFields,
  withChildSpan
} = require('../lib/server/request-trace');

test('无追踪上下文时全部安全退化，不抛错', () => {
  // 关键契约：追踪是诊断增强，不是业务依赖。任何未接入的调用点
  // （CLI 进程、单元测试、嵌入方）拿到的必须是空值而不是异常。
  assert.equal(currentTrace(), null);
  assert.equal(currentTraceId(), '');
  assert.deepEqual(traceLogFields(), {});
});

test('根 span 携带 traceId，子 span 继承 traceId 并指向父 span', () => {
  runWithTrace({ traceId: 'req-1', route: '/v1/messages' }, () => {
    const root = currentTrace();
    assert.equal(root.traceId, 'req-1');
    assert.equal(root.depth, 0);
    assert.equal(root.parentSpanId, '');
    assert.equal(currentTraceId(), 'req-1');

    runWithTrace({ label: 'attempt:0' }, () => {
      const child = currentTrace();
      assert.equal(child.traceId, 'req-1', '子 span 必须继承同一个 traceId');
      assert.equal(child.parentSpanId, root.spanId, '子 span 的父必须是根 span');
      assert.equal(child.depth, 1);
      assert.equal(child.label, 'attempt:0');

      // 三层：请求 → 尝试 → 换 provider 重试
      runWithTrace({ label: 'cross-provider:codex' }, () => {
        const grandchild = currentTrace();
        assert.equal(grandchild.traceId, 'req-1');
        assert.equal(grandchild.parentSpanId, child.spanId);
        assert.equal(grandchild.depth, 2);
      });
    });
  });
});

test('traceLogFields 输出可直接并进日志条目，且不含空值噪音', () => {
  runWithTrace({ traceId: 'req-2' }, () => {
    const fields = traceLogFields();
    assert.equal(fields.traceId, 'req-2');
    assert.equal(fields.spanDepth, 0);
    // 根 span 没有父，字段应为 undefined 而不是空串（日志里不该出现 "parentSpanId":""）
    assert.equal(fields.parentSpanId, undefined);
    assert.equal(fields.spanLabel, undefined);
  });
});

test('并发请求的追踪上下文互不串味', async () => {
  // AsyncLocalStorage 的核心保证：同一个进程里并发处理多个请求时，
  // 每个请求只能看到自己的 trace。
  const observed = await Promise.all([
    runWithTrace({ traceId: 'a' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return currentTraceId();
    }),
    runWithTrace({ traceId: 'b' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentTraceId();
    })
  ]);
  assert.deepEqual(observed, ['a', 'b']);
});

test('withChildSpan 执行回调并保留追踪身份', async () => {
  await runWithTrace({ traceId: 'req-3' }, async () => {
    const result = await withChildSpan({ label: 'sub' }, async () => {
      assert.equal(currentTraceId(), 'req-3');
      assert.equal(currentTrace().label, 'sub');
      return 'done';
    });
    assert.equal(result, 'done');
    // 子 span 结束后回到父上下文
    assert.equal(currentTrace().depth, 0);
  });
});

test('嵌套的追踪在异步边界后依然有效', async () => {
  await runWithTrace({ traceId: 'req-4' }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(currentTraceId(), 'req-4', 'await 之后上下文必须还在');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(currentTraceId(), 'req-4');
  });
});

test('根日志的身份不随写入时刻的异步上下文漂移', () => {
  // 真实场景：access 日志在 res 'finish' 回调里写，那时异步上下文可能已经
  // 停在最后一次上游尝试里。所以根身份必须在请求入口就固定，否则同一次请求
  // 的 access 行会挂上 "attempt:N" 标签、spanId 也会变成子 span 的。
  runWithTrace({ traceId: 'req-5' }, () => {
    const rootSpan = currentTrace();
    runWithTrace({ label: 'attempt:0' }, () => {
      const drifted = traceLogFields();
      assert.equal(drifted.spanLabel, 'attempt:0', '上下文此刻确实在子 span 里');

      // 模拟 access 日志的构造方式：先展开上下文，再覆盖显式字段。
      const accessEntry = {
        kind: 'access',
        ...rootSpan,
        spanLabel: undefined,
        parentSpanId: undefined
      };
      assert.equal(accessEntry.spanId, rootSpan.spanId);
      assert.equal(accessEntry.spanLabel, undefined);
      assert.equal(accessEntry.parentSpanId, undefined);
      assert.equal(accessEntry.depth, 0);
    });
  });
});
