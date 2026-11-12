'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scheduleAliasShadowCompare } = require('../lib/server/webui-model-alias-routes');

test('影子对账把漂移交给观察者，且不阻塞', async () => {
  const observed = [];
  const deps = {
    goCoreSync: {
      isEnabled: () => true,
      listModelAliases: async () => ({
        ok: true,
        data: { aliases: [{ alias: 'a', target: 'x' }] }
      })
    },
    onAliasShadowResult: (diff) => observed.push(diff)
  };
  scheduleAliasShadowCompare({ deps }, [{ alias: 'a', target: 'y' }]);
  // 不 await：等一个宏任务让 promise 链跑完。
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(observed.length, 1);
  assert.equal(observed[0].equal, false);
  assert.deepEqual(observed[0].changed[0].fields, ['target']);
});

test('Go 未启用时完全不发请求', async () => {
  let called = 0;
  const deps = {
    goCoreSync: {
      isEnabled: () => false,
      listModelAliases: async () => {
        called += 1;
        return { ok: true, data: { aliases: [] } };
      }
    }
  };
  scheduleAliasShadowCompare({ deps }, []);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(called, 0);
});

test('Go 不可用或返回错误时静默跳过', async () => {
  const observed = [];
  const deps = {
    goCoreSync: {
      isEnabled: () => true,
      listModelAliases: async () => ({ ok: false, status: 503 })
    },
    onAliasShadowResult: (diff) => observed.push(diff)
  };
  scheduleAliasShadowCompare({ deps }, [{ alias: 'a', target: 'x' }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(observed, []);
});

test('对账抛异常不影响调用方', async () => {
  const deps = {
    goCoreSync: {
      isEnabled: () => true,
      listModelAliases: async () => {
        throw new Error('boom');
      }
    }
  };
  assert.doesNotThrow(() => scheduleAliasShadowCompare({ deps }, []));
  await new Promise((resolve) => setTimeout(resolve, 10));
});


test('对账结果写进 state 供诊断读取', async () => {
  const state = {};
  const deps = {
    goCoreSync: {
      isEnabled: () => true,
      listModelAliases: async () => ({ ok: true, data: { aliases: [] } })
    }
  };
  scheduleAliasShadowCompare({ deps, state }, [{ alias: 'a', target: 'x' }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(state.aliasShadow, '没有写入 state.aliasShadow');
  assert.equal(state.aliasShadow.equal, false);
  assert.deepEqual(state.aliasShadow.missing, ['a']);
  assert.ok(state.aliasShadow.checkedAt > 0);
});

test('有 logger 时漂移只记一行摘要', async () => {
  const warnings = [];
  const deps = {
    goCoreSync: {
      isEnabled: () => true,
      listModelAliases: async () => ({
        ok: true,
        data: { aliases: [{ alias: 'b', target: 'y' }] }
      })
    },
    logger: { warn: (message) => warnings.push(message) }
  };
  scheduleAliasShadowCompare({ deps }, [{ alias: 'a', target: 'x' }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing=1 extra=1 changed=0/);
});

