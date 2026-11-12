'use strict';

// 回归守卫（2026-11-01 真机）：浏览器里已经登录成功、凭据已写进登录沙箱，但进程以
// 非 0 退出（用户 Ctrl-C / CLI 崩溃 / 轮询还没到点），旧逻辑只认
// `exitCode === 0 || completedByWatcher`，直接走失败分支把沙箱连凭据清理掉 —— 账号
// 从此不存在。这里把那条判定钉住：**凭据落地就按完成处理**，能不能用交给登记校验。

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldCompleteLoginOnExit } = require('../lib/cli/services/pty/login-exit-decision');

test('正常退出（码 0）算完成，不调用探针', () => {
  let probed = 0;
  assert.equal(shouldCompleteLoginOnExit({
    isLogin: true, exitCode: 0, completedByWatcher: false,
    probeArtifact: () => { probed += 1; return false; }
  }), true);
  assert.equal(probed, 0);
});

test('轮询器已判定完成（被信号终止，码非 0）算完成', () => {
  assert.equal(shouldCompleteLoginOnExit({
    isLogin: true, exitCode: 143, completedByWatcher: true, probeArtifact: null
  }), true);
});

test('非 0 退出但凭据已落地：仍算完成（本回归的核心）', () => {
  assert.equal(shouldCompleteLoginOnExit({
    isLogin: true, exitCode: 130, completedByWatcher: false,
    probeArtifact: () => true
  }), true);
});

test('非 0 退出且没有凭据：算失败，不登记', () => {
  assert.equal(shouldCompleteLoginOnExit({
    isLogin: true, exitCode: 1, completedByWatcher: false, probeArtifact: () => false
  }), false);
});

test('探针抛错按未完成处理，不把失败登录判成成功', () => {
  assert.equal(shouldCompleteLoginOnExit({
    isLogin: true, exitCode: 1, completedByWatcher: false,
    probeArtifact: () => { throw new Error('EACCES'); }
  }), false);
});

test('非登录会话永远不走登录收尾', () => {
  assert.equal(shouldCompleteLoginOnExit({
    isLogin: false, exitCode: 0, completedByWatcher: true, probeArtifact: () => true
  }), false);
});
