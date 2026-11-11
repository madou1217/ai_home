'use strict';

// 登录 Job 的进度只靠 accounts/watch SSE，不再有短轮询兜底。
// 这里锁住服务端 emitter：job 变化必须变成 auth-job 帧。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  emitAccountsAuthJobEvent,
  emitAccountActivityEvent,
  __private: { getAccountsLiveState }
} = require('../lib/server/webui-account-live');

test('auth-job 状态变化写入 accounts/watch SSE 帧', () => {
  const state = {};
  const live = getAccountsLiveState(state);
  const frames = [];
  live.watchers.add({
    res: {
      destroyed: false,
      writableEnded: false,
      write(chunk) { frames.push(String(chunk)); }
    }
  });

  emitAccountsAuthJobEvent({ state }, {
    id: 'job-1',
    provider: 'codebuddycn',
    status: 'running',
    progress: '等待浏览器授权',
    logs: [],
    createdAt: 1,
    updatedAt: 2
  });
  emitAccountsAuthJobEvent({ state }, {
    id: 'job-1',
    provider: 'codebuddycn',
    status: 'succeeded',
    progress: '登录成功',
    logs: [],
    createdAt: 1,
    updatedAt: 3
  });

  assert.equal(frames.length, 2);
  assert.match(frames[0], /"type":"auth-job"/);
  assert.match(frames[0], /"status":"running"/);
  assert.match(frames[1], /"status":"succeeded"/);
});

test('账号活动快照写入 accounts/watch SSE 帧', () => {
  const state = {};
  const live = getAccountsLiveState(state);
  const frames = [];
  live.watchers.add({
    res: {
      destroyed: false,
      writableEnded: false,
      write(chunk) { frames.push(String(chunk)); }
    }
  });
  emitAccountActivityEvent(state, {
    'codebuddycn:acct_1': { inFlight: 2, rate: 0.5, lastAt: 3 }
  });
  assert.equal(frames.length, 1);
  assert.match(frames[0], /"type":"account-activity"/);
  assert.match(frames[0], /"inFlight":2/);
});
