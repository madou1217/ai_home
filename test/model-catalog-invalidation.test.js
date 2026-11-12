'use strict';

// 回归守卫（2026-10-25 真机）：模型目录被「收窄」而不是「清空」。
//
// 事故形态：一个账号的认证失效事件触发 invalidateWebUiModelsCache(state)，它把
// byProvider/byAccount 一起抹掉（并且因为调用点没有 deps，还把空缓存落盘）。路由唯一的
// 证据就是 byProvider（capability-router 的 resolveProviderByModel 只读它），于是
// resolveProviderByModel 对所有 provider 返回 null，请求落到按客户端协议的兜底路由上 ——
// 裸名 `deepseek-v4.1-flash` 被交给 opencode 池，产出误导性的
// `no available opencode account can serve model deepseek-v4.1-flash`，
// 而真正持有该裸名的 workbuddy / codebuddy 账号从未被考虑。
//
// 本测试钉住三件事：
//   1. 认证失效的失效动作只丢掉那个账号的目录，其余账号的目录与 provider 并集都还在；
//   2. provider 并集按存活账号重算（不能留陈旧并集，也不能变成空集）；
//   3. 收窄后落盘的是**收窄后的目录**，不是空缓存 —— 否则进程重启后路由证据彻底消失。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  invalidateWebUiModelsCache,
  invalidateWebUiModelsCacheKeepingAccountCatalogs,
  readPersistedWebUiModelsCache,
  writePersistedWebUiModelsCache
} = require('../lib/server/webui-model-cache');

function makeState() {
  return {
    accounts: {
      workbuddy: [
        { provider: 'workbuddy', accountRef: 'acct_wb000000000000000001' },
        { provider: 'workbuddy', accountRef: 'acct_wb000000000000000002' }
      ],
      codebuddy: [
        { provider: 'codebuddy', accountRef: 'acct_cb000000000000000001' }
      ]
    },
    webUiModelsCache: {
      updatedAt: 1792900000000,
      byProvider: {
        workbuddy: ['deepseek-v4.1-flash', 'glm-5.3'],
        codebuddy: ['deepseek-v4.1-flash']
      },
      byAccount: {
        acct_wb000000000000000001: ['deepseek-v4.1-flash', 'glm-5.3'],
        acct_wb000000000000000002: ['deepseek-v4.1-flash'],
        acct_cb000000000000000001: ['deepseek-v4.1-flash']
      },
      errorsByAccount: {},
      incompleteByAccount: {},
      accountUpdatedAt: {},
      accountSource: {},
      accountScanned: {},
      contextLimits: {},
      labels: {},
      signature: 'sig',
      source: 'remote',
      sourceCount: 3,
      scannedAccounts: 3,
      firstError: ''
    }
  };
}

test('auth-invalid invalidation keeps the other accounts catalogs and recomputes provider union', () => {
  const state = makeState();

  // 只有第一个 workbuddy 账号认证失效。
  invalidateWebUiModelsCacheKeepingAccountCatalogs(state, {}, ['acct_wb000000000000000001']);

  const cache = state.webUiModelsCache;
  // 失效账号的目录没了。
  assert.equal(cache.byAccount.acct_wb000000000000000001, undefined);
  // 其余账号的目录都还在 —— 这是「收窄」与「清空」的分界。
  assert.deepEqual(cache.byAccount.acct_wb000000000000000002, ['deepseek-v4.1-flash']);
  assert.deepEqual(cache.byAccount.acct_cb000000000000000001, ['deepseek-v4.1-flash']);
  // provider 并集按存活账号重算：workbuddy 仍认 deepseek-v4.1-flash（第二个账号持有），
  // glm-5.3 只由失效账号持有，必须随之消失。
  assert.deepEqual(cache.byProvider.workbuddy, ['deepseek-v4.1-flash']);
  assert.deepEqual(cache.byProvider.codebuddy, ['deepseek-v4.1-flash']);
  // 路由证据必须仍然可用（byProvider 非空）。
  assert.equal(Object.keys(cache.byProvider).length > 0, true);
});

test('narrowing invalidation persists the narrowed catalogs, not an empty cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-cache-'));
  try {
    const state = makeState();
    const deps = { aiHomeDir: root, fs };

    // 先落一份好目录，模拟进程启动时磁盘上已有的状态。
    writePersistedWebUiModelsCache(deps, state.webUiModelsCache);
    assert.deepEqual(readPersistedWebUiModelsCache(deps).byProvider.workbuddy, ['deepseek-v4.1-flash', 'glm-5.3']);

    // 收窄后落盘的必须是**收窄后的目录**：把空缓存写进磁盘会让进程重启后
    // 路由证据彻底消失，届时要靠一次成功探测才能恢复。
    invalidateWebUiModelsCacheKeepingAccountCatalogs(state, deps, ['acct_wb000000000000000001']);

    const persisted = readPersistedWebUiModelsCache(deps);
    assert.deepEqual(persisted.byProvider.workbuddy, ['deepseek-v4.1-flash']);
    assert.deepEqual(persisted.byProvider.codebuddy, ['deepseek-v4.1-flash']);
    assert.deepEqual(persisted.byAccount.acct_wb000000000000000002, ['deepseek-v4.1-flash']);
    assert.equal(persisted.byAccount.acct_wb000000000000000001, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account-removal invalidation narrows to the live pool instead of clearing everything', () => {
  const state = makeState();
  // 账号池里已经没有 workbuddy 的第一个账号了（例如被删除）。
  state.accounts.workbuddy = [{ provider: 'workbuddy', accountRef: 'acct_wb000000000000000002' }];

  invalidateWebUiModelsCacheKeepingAccountCatalogs(state, {});

  const cache = state.webUiModelsCache;
  assert.equal(cache.byAccount.acct_wb000000000000000001, undefined);
  assert.deepEqual(cache.byAccount.acct_wb000000000000000002, ['deepseek-v4.1-flash']);
  assert.deepEqual(cache.byProvider.workbuddy, ['deepseek-v4.1-flash']);
  assert.deepEqual(cache.byProvider.codebuddy, ['deepseek-v4.1-flash']);
});
