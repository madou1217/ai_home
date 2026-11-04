'use strict';

// 回归守卫：解验证码必须有**硬上界**。
//
// 2026-11-03 真机：CDP 的 send/Runtime.evaluate 没有内建超时，浏览器卡死时
// 计划任务整条链停在 30 分钟 MAX_RUN_MS（记录 error=task_timeout），
// 后续 tick 还会被 in_flight 挡住。这里用一个永不吐 DevTools 地址的假浏览器
// 证明 solveAliyunCaptcha 会在 timeoutMs 附近抛 captcha_timeout 并杀掉子进程。

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { solveAliyunCaptcha } = require('../lib/account/activity-claim/aliyun-captcha');

function createFakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killedWith = '';
  child.kill = (signal) => { child.killedWith = String(signal || ''); return true; };
  return child;
}

function createFakeFs(tmpdir) {
  return {
    existsSync: () => true,
    mkdtempSync: () => tmpdir,
    rmSync: () => {}
  };
}

test('解算浏览器卡死时按 timeoutMs 抛 captcha_timeout 并杀进程', async () => {
  const child = createFakeChild();
  const startedAt = Date.now();
  const error = await solveAliyunCaptcha({
    sceneId: 'scene-test',
    prefix: 'prefix-test',
    region: 'cn',
    timeoutMs: 1200,
    executablePath: '/bin/echo',
    fs: createFakeFs('/tmp/aih-captcha-test'),
    spawnImpl: () => child
  }).then(() => null, (err) => err);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(error, '应当抛错，而不是一直等待');
  assert.match(String(error.message), /^captcha_timeout:1200$/, `错误码应为 captcha_timeout，实际 ${error.message}`);
  assert.equal(child.killedWith, 'SIGKILL', '超时后必须杀掉浏览器进程');
  assert.ok(elapsedMs < 4000, `应在 deadline 附近返回，实际 ${elapsedMs}ms`);
});

test('缺 sceneId/prefix 仍然立即失败（不启动浏览器）', async () => {
  let spawned = false;
  const error = await solveAliyunCaptcha({
    sceneId: '',
    prefix: '',
    timeoutMs: 1200,
    spawnImpl: () => { spawned = true; return createFakeChild(); }
  }).then(() => null, (err) => err);
  assert.ok(error);
  assert.match(String(error.message), /^captcha_config_missing/);
  assert.equal(spawned, false);
});

