'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSessionHookEnabled,
  wasHookInstalled,
  ensureHookSurvived
} = require('../lib/server/provider-cli-upgrade/hook-survival');

// 开关是这一切的前提：关着就什么都不做，连读配置都不读。
test('开关关着时既不判定也不恢复', () => {
  let diagnoseCalls = 0;
  const diagnose = () => { diagnoseCalls += 1; return { supported: true, installed: true }; };
  const install = () => { throw new Error('不该被调用'); };

  assert.equal(isSessionHookEnabled('claude', { readSettings: () => ({ sessionHook: false }) }), false);
  assert.equal(wasHookInstalled('claude', { readSettings: () => ({ sessionHook: false }), diagnose }), false);
  assert.equal(diagnoseCalls, 0, '关着的时候连配置都不该读');

  const result = ensureHookSurvived('claude', {
    readSettings: () => ({ sessionHook: false }),
    diagnose,
    install,
    upgradeBefore: false
  });
  assert.equal(result.checked, false);
  assert.equal(result.detail, 'hook_not_enabled_before');
});

test('读不到设置时按「没开」处理，不去改用户配置', () => {
  // readSettings 抛错 = 设置文件损坏/不可读，此时改用户全局配置风险更大。
  assert.equal(isSessionHookEnabled('claude', { readSettings: () => { throw new Error('boom'); } }), false);
  assert.equal(isSessionHookEnabled('claude', {}), false);
});

// 升级前装着、升级后还在 = 只核对，不写入。
test('Hook 还在时不写配置', () => {
  const result = ensureHookSurvived('claude', {
    diagnose: () => ({ supported: true, installed: true }),
    install: () => { throw new Error('不该被调用'); },
    upgradeBefore: true
  });
  assert.deepEqual(result, { checked: true, restored: false, ok: true, detail: 'hook_alive' });
});

test('Hook 掉了就装回去，并报告确实做了写入', () => {
  let diagnosed = 0;
  const result = ensureHookSurvived('claude', {
    diagnose: () => { diagnosed += 1; return { supported: true, installed: false }; },
    install: () => ({ ok: true, changed: true }),
    upgradeBefore: true
  });
  assert.deepEqual(result, { checked: true, restored: true, ok: true, detail: 'hook_restored' });
  assert.equal(diagnosed, 1);
});

test('装不回去要如实报错，不能吞成成功', () => {
  const failed = ensureHookSurvived('claude', {
    diagnose: () => ({ supported: true, installed: false }),
    install: () => ({ ok: false, error: 'write_denied' }),
    upgradeBefore: true
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.detail, 'hook_restore_failed:write_denied');

  const threw = ensureHookSurvived('claude', {
    diagnose: () => ({ supported: true, installed: false }),
    install: () => { throw new Error('EACCES'); },
    upgradeBefore: true
  });
  assert.equal(threw.ok, false);
  assert.match(threw.detail, /hook_restore_error:EACCES/);
});

// 不支持 Hook 的 provider（kiro/zcode 等）不该因为「没装上」被判失败。
test('provider 不支持 Hook 时安静跳过', () => {
  const result = ensureHookSurvived('kiro', {
    diagnose: () => ({ supported: false, installed: false }),
    install: () => { throw new Error('不该被调用'); },
    upgradeBefore: true
  });
  assert.equal(result.checked, false);
  assert.equal(result.ok, true);
  assert.equal(result.detail, 'hook_unsupported');
});

test('缺诊断或安装任一实现时不做核对', () => {
  assert.equal(ensureHookSurvived('claude', { upgradeBefore: true }).detail, 'hook_deps_unavailable');
  assert.equal(
    ensureHookSurvived('claude', { diagnose: () => ({ installed: true }), upgradeBefore: true }).detail,
    'hook_deps_unavailable'
  );
});
