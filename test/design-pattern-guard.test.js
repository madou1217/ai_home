'use strict';

// 设计守卫：三类跨文件不变量。
//
// audit 提到多处注释引用 test/design-pattern-guard.test.js 但文件不存在；这里把它们
// 真正落地，防止「真值源 / 能力清单 / 命名唯一性」只靠口头约定：
//   1. 额度归属表 GO_QUOTA_OWNERS ↔ 每个 descriptor 的 quota.supported 双向一致；
//   2. goCoreSync 门面的 FACADE_METHODS 必须都存在于真实 createGoCoreHost 的返回值；
//   3. lib/providers/defs 下 provider id 与策略 id 不允许重复。
//
// 全程只 require 模块、构造内存对象，不启动 Go 服务、不写文件、不读用户目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GO_QUOTA_OWNERS, goOwnedQuota, isGoOwnedQuota } = require('../lib/providers/quota-ownership');
const { FACADE_METHODS, createGoCoreSyncFacade } = require('../lib/server/go-core-sync-facade');
const { createGoCoreHost } = require('../lib/server/go-core-host');

const DEFS_DIR = path.join(__dirname, '..', 'lib', 'providers', 'defs');

// 只收真正的 provider descriptor：defs 目录下还有 config-*.js 这类辅助模块。
function loadDescriptors() {
  const entries = [];
  for (const name of fs.readdirSync(DEFS_DIR).sort()) {
    if (!name.endsWith('.js')) continue;
    const descriptor = require(path.join(DEFS_DIR, name));
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) continue;
    if (typeof descriptor.id !== 'string' || !descriptor.id.trim()) continue;
    entries.push({ file: name, descriptor });
  }
  return entries;
}

test('额度归属表与 descriptor 的 quota.supported 双向一致', () => {
  const entries = loadDescriptors();
  assert.ok(entries.length > 0, 'defs 目录没有加载到任何 descriptor');
  const byId = new Map(entries.map((entry) => [entry.descriptor.id, entry]));
  const tableIds = Object.keys(GO_QUOTA_OWNERS);
  assert.ok(tableIds.length > 0, 'GO_QUOTA_OWNERS 不能为空');

  // 正向：表里登记 = Go 采集。descriptor 必须 supported:false，且内容由 goOwnedQuota
  // 派生（逐字段 deepEqual，避免有人手写一份「看起来一样」的 reason 绕过真值源）。
  for (const providerID of tableIds) {
    const entry = byId.get(providerID);
    assert.ok(entry, providerID + ' 在 GO_QUOTA_OWNERS 里登记，但 defs 下没有对应 descriptor');
    const quota = entry.descriptor.capabilities && entry.descriptor.capabilities.quota;
    assert.ok(quota && typeof quota === 'object', providerID + ' 缺少 capabilities.quota');
    assert.equal(quota.supported, false, providerID + ' 已由 Go 采集，descriptor 必须 supported:false');
    assert.deepEqual(
      quota,
      goOwnedQuota(providerID),
      providerID + ' 的 quota 必须由 goOwnedQuota() 派生，不能手写 supported/reason'
    );
    assert.match(quota.reason, /Go 采集/, providerID + ' 的 reason 必须说明额度由 Go 采集');
    assert.equal(isGoOwnedQuota(providerID), true);
  }

  // 反向：supported:true 的 Provider 绝不能在表里；supported:false 必须给出 reason，
  // 其中只有「声称 Go 采集」的才要求登记（opencode 这类「上游没有额度接口」是另一种语义）。
  for (const { file, descriptor } of entries) {
    const providerID = descriptor.id;
    const quota = descriptor.capabilities && descriptor.capabilities.quota;
    assert.ok(quota && typeof quota === 'object', file + ' 缺少 capabilities.quota');
    assert.equal(typeof quota.supported, 'boolean', file + ' 的 quota.supported 必须是布尔值');
    assert.equal(
      isGoOwnedQuota(providerID),
      Object.prototype.hasOwnProperty.call(GO_QUOTA_OWNERS, providerID),
      providerID + ' 的 isGoOwnedQuota() 与表不一致'
    );

    if (quota.supported === true) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(GO_QUOTA_OWNERS, providerID),
        false,
        providerID + ' 声明 supported:true，却同时出现在 GO_QUOTA_OWNERS 里'
      );
      continue;
    }

    const reason = String(quota.reason || '').trim();
    assert.ok(reason, providerID + ' 的 supported:false 必须给出 reason');
    if (/Go 采集/.test(reason)) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(GO_QUOTA_OWNERS, providerID),
        true,
        providerID + ' 声称由 Go 采集但不在 GO_QUOTA_OWNERS 里：请登记归属，不要手写 false'
      );
    }
  }
});

test('FACADE_METHODS 全部存在于真实 createGoCoreHost 返回值', () => {
  let supervisorStarted = false;
  // 只装配宿主对象：注入不落盘的监督器与转发器，enabled:false 让宿主不启动子进程、
  // 不建账号同步、不挂定时器。这里验证的是「构造根与门面清单的接线」，不是运行行为。
  const host = createGoCoreHost({
    settings: { enabled: false, accountSync: false, routes: [] },
    manifest: { entries: [] },
    log: { log() {}, error() {} },
    createGoCoreSupervisor: () => ({
      status: () => ({ state: 'disabled', endpoint: '' }),
      start: async () => {
        supervisorStarted = true;
        return { state: 'disabled', endpoint: '' };
      },
      stop: async () => {}
    }),
    createGoCoreGatewayForwarder: () => ({
      tryHandleHttp: () => false,
      tryHandleUpgrade: () => false
    })
  });

  assert.equal(supervisorStarted, false, '构造宿主不能启动监督器');
  for (const name of FACADE_METHODS) {
    assert.equal(
      typeof host[name],
      'function',
      'createGoCoreHost 缺少门面方法 ' + name + '()；WebUI 的编辑会静默推不到 Go'
    );
  }

  // 装配不抛错，并且暴露面严格等于清单（多一个少一个都算漂移）。
  const facade = createGoCoreSyncFacade(host);
  assert.deepEqual(Object.keys(facade), [...FACADE_METHODS]);
  assert.equal(Object.isFrozen(facade), true);
});

test('defs 下 provider id 与策略 id 均无重复', () => {
  const entries = loadDescriptors();
  assert.ok(entries.length > 0, 'defs 目录没有加载到任何 descriptor');

  const providerIds = new Map();
  const strategyIds = new Map();

  for (const { file, descriptor } of entries) {
    const providerID = descriptor.id.trim();
    const previousProvider = providerIds.get(providerID);
    assert.equal(
      previousProvider,
      undefined,
      file + ' 与 ' + previousProvider + ' 重复定义 provider id: ' + providerID
    );
    providerIds.set(providerID, file);

    const capabilities = descriptor.capabilities || {};
    for (const [capability, value] of Object.entries(capabilities)) {
      if (!value || !Array.isArray(value.strategies)) continue;
      const localIds = new Set();
      for (const strategy of value.strategies) {
        const strategyId = strategy && typeof strategy.id === 'string' ? strategy.id.trim() : '';
        assert.ok(strategyId, file + ' 的 ' + capability + ' 策略缺少 id');
        assert.equal(
          localIds.has(strategyId),
          false,
          providerID + '.' + capability + ' 内重复策略 id: ' + strategyId
        );
        localIds.add(strategyId);

        const previous = strategyIds.get(strategyId);
        assert.equal(
          previous,
          undefined,
          '策略 id "' + strategyId + '" 在 ' + previous + ' 与 ' +
            providerID + '.' + capability + '（' + file + '）重复'
        );
        strategyIds.set(strategyId, providerID + '.' + capability + '（' + file + '）');
      }
    }
  }

  // activity.actions 的 id 是动作名，不是策略 id：qoder 与 qodercn 有意共用
  // daily_checkin（同一签到接口的区域主机不同），因此不纳入全局唯一性检查。
  assert.ok(strategyIds.size > 0, '没有收集到任何策略 id，守卫没有实际覆盖');
});
