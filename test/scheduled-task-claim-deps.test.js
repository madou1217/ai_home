'use strict';

// 计划任务的执行依赖回归（2026-11-01 真机发现）：
// 定时触发的活动领取一直全军覆没，运行记录里是「领取 0/N 成功（失败 N：fetch_unavailable）」。
// 根因是**执行依赖没透传**：手动领取走 buildClaimDeps（注入齐全），计划任务这条链
// （webui-scheduled-task-routes → scheduled-task-service → scheduled-task-events → handler）
// 只带了 fs/aiHomeDir，handler 拿不到 fetchWithTimeout，第一步请求就返回 fetch_unavailable。
//
// 这里守两层：
//   1) 服务工厂必须把执行依赖装进 deps（producer 侧）；
//   2) executeScheduledEvent 必须原样透传给 handler（consumer 侧）。
// 第二条用真实的 workbuddy handler 跑一遍，确保它真的发出了 HTTP 请求。

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { executeScheduledEvent } = require('../lib/server/scheduled-task-events');
const { createServiceForCtx } = require('../lib/server/webui-scheduled-task-routes');
const { runWorkbuddyDailyClaim } = require('../lib/account/activity-claim/workbuddy-daily');

function fakeJwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

function workbuddyRecord(provider = 'workbuddycn', issuerHost = 'www.workbuddy.cn') {
  const uid = 'uid-test';
  const iss = `https://${issuerHost}/auth/realms/copilot`;
  const now = Math.floor(Date.now() / 1000);
  return {
    provider,
    accountRef: 'acct_test',
    env: {},
    nativeAuth: {
      credentials: {
        account: { uid },
        auth: {
          accessToken: fakeJwt({ iss, sub: uid, iat: now - 60, exp: now + 3600 }),
          refreshToken: fakeJwt({ iss, sub: uid, iat: now - 60, exp: now + 86400 }),
          domain: issuerHost
        }
      }
    }
  };
}

function makeTmpHome() {
  return nodeFs.mkdtempSync(path.join(os.tmpdir(), 'aih-sched-deps-'));
}

test('计划任务：执行依赖原样透传给 handler（fetchWithTimeout / 出口 / 宿主 home）', async () => {
  const calls = [];
  const fetchWithTimeout = async () => ({ ok: true, status: 200, text: async () => '{}' });
  const resolveAccountEgressRequestOptions = async () => ({ ok: true, options: {} });
  const processObj = { env: {} };
  const usageRefreshes = [];
  const ensureUsageSnapshotAsync = async (provider, accountRef, snapshot, options) => {
    usageRefreshes.push({ provider, accountRef, snapshot, options });
  };
  const outcome = await executeScheduledEvent({
    eventId: 'activity:zcode:trial_plan',
    params: {},
    deps: {
      fs: nodeFs,
      aiHomeDir: makeTmpHome(),
      listAccountCredentialRecords: () => [{ accountRef: 'acct_a', provider: 'zcode' }],
      runActivityClaim: async (input) => {
        calls.push(input);
        return { provider: input.provider, accountRef: input.record.accountRef, status: 'claimed' };
      },
      fetchWithTimeout,
      resolveAccountEgressRequestOptions,
      ensureUsageSnapshotAsync,
      processObj,
      hostHomeDir: '/host/home'
    }
  });

  assert.equal(outcome.status, 'ok');
  // 计划触发的领取同样要触发额度重探（否则界面停在「无套餐」）。
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(usageRefreshes.length, 1);
  assert.deepEqual(
    { provider: usageRefreshes[0].provider, accountRef: usageRefreshes[0].accountRef, force: usageRefreshes[0].options && usageRefreshes[0].options.forceRefresh },
    { provider: 'zcode', accountRef: 'acct_a', force: true }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fetchWithTimeout, fetchWithTimeout);
  assert.equal(calls[0].resolveAccountEgressRequestOptions, resolveAccountEgressRequestOptions);
  assert.equal(calls[0].processObj, processObj);
  assert.equal(calls[0].hostHomeDir, '/host/home');
});

test('计划任务：真实签到 handler 拿到 fetcher，真的打到上游（不再是 fetch_unavailable）', async () => {
  const requests = [];
  const outcome = await executeScheduledEvent({
    eventId: 'activity:workbuddycn:daily_checkin',
    params: {},
    deps: {
      fs: nodeFs,
      aiHomeDir: makeTmpHome(),
      listAccountCredentialRecords: () => [workbuddyRecord()],
      runActivityClaim: runWorkbuddyDailyClaim,
      fetchWithTimeout: async (url) => {
        requests.push(String(url));
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            msg: 'OK',
            data: { active: true, today_checked_in: true, streak_days: 3, daily_credit: 100 }
          })
        };
      },
      resolveAccountEgressRequestOptions: async () => ({ ok: true, options: {} }),
      processObj: { env: {} },
      hostHomeDir: '/host/home'
    }
  });

  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.error, '');
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/v2\/billing\/meter\/checkin-activity-status$/);
  // 今天已领：结论是「已领取过」，不是失败
  assert.match(outcome.summary, /已领取过 1/);
});

test('计划任务服务：工厂把执行依赖装进 deps（缺了它整条链路只会 fetch_unavailable）', async () => {
  const calls = [];
  const service = createServiceForCtx({
    aiHomeDir: makeTmpHome(),
    processObj: { env: {} },
    deps: {
      fs: nodeFs,
      listAccountCredentialRecords: () => [{ accountRef: 'acct_a', provider: 'zcode' }],
      runActivityClaim: async (input) => {
        calls.push(input);
        return { provider: input.provider, accountRef: input.record.accountRef, status: 'claimed' };
      }
    }
  });

  const created = service.upsert({
    name: 'deps 探针',
    eventId: 'activity:zcode:trial_plan',
    eventParams: {},
    schedule: { kind: 'daily', at: '10:00' },
    enabled: true
  });
  assert.equal(created.ok, true);

  await service.runTask(created.task.id, 'manual');
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].fetchWithTimeout, 'function');
  assert.equal(typeof calls[0].resolveAccountEgressRequestOptions, 'function');
  assert.ok(calls[0].processObj);
  assert.ok(calls[0].hostHomeDir);
});

test('计划任务：partial（部分成功）也算终态，不会空转到 task_timeout', { timeout: 8000 }, async () => {
  // 回归：job.status 有 succeeded/partial/failed 三种终态。轮询只认前两种时，
  // 「N 个账号里有的领到、有的过期」这一最常见的批量结果会永远等不到终态，
  // 计划任务 30 分钟后被记成 task_timeout（2026-11-03 真机）。
  const startedAt = Date.now();
  const outcome = await executeScheduledEvent({
    eventId: 'activity:zcode:trial_plan',
    params: {},
    deps: {
      fs: nodeFs,
      aiHomeDir: makeTmpHome(),
      listAccountCredentialRecords: () => [
        { accountRef: 'acct_ok', provider: 'zcode' },
        { accountRef: 'acct_expired', provider: 'zcode' }
      ],
      runActivityClaim: async (input) => (input.record.accountRef === 'acct_ok'
        ? { provider: input.provider, accountRef: 'acct_ok', status: 'claimed' }
        : { provider: input.provider, accountRef: 'acct_expired', status: 'error', error: 'zcode_auth_invalid:401' }),
      fetchWithTimeout: async () => ({ ok: true, status: 200, text: async () => '{}' }),
      resolveAccountEgressRequestOptions: async () => ({ ok: true, options: {} }),
      processObj: { env: {} },
      hostHomeDir: '/host/home'
    }
  });
  assert.ok(Date.now() - startedAt < 5000, '不得等到 30 分钟兜底');
  assert.equal(outcome.status, 'error');
  assert.match(String(outcome.summary), /1\/2/);
  assert.equal(outcome.results.length, 2);
});

