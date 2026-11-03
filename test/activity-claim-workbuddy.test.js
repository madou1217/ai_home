'use strict';

// WorkBuddy 每日签到的关键回归：
//   1) 真领之前必须先查活动状态 —— 不活跃 / 今天已领就不发领取请求（领取消耗当天机会）；
//   2) 业务码 1001 是「已领过」而不是失败，定时任务一天多跑几次不会把任务染红；
//   3) 领取结果在信封的 data 里（桌面端 CloudAccountRepo 读 e.credit 是它自己的 bug）。

const test = require('node:test');
const assert = require('node:assert');

const {
  runWorkbuddyDailyClaim,
  readCheckinState,
  buildWorkbuddyCheckinHeaders
} = require('../lib/account/activity-claim/workbuddy-daily');

function createFakeFs() {
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  return {
    existsSync: () => false,
    statSync: enoent,
    readFileSync: enoent,
    readdirSync: () => [],
    writeFileSync: () => {},
    mkdirSync: () => {}
  };
}

// 共享凭据的读取是**校验型**的：realm（issuer）、uid=sub、refreshToken 都在检查范围内，
// 所以夹具必须是真的可解码 JWT —— 假字符串会以 unrecognized_credential_realm 被拒。
function fakeJwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

function createRecord(extra = {}) {
  const uid = 'uid-test';
  const iss = 'https://www.workbuddy.ai/auth/realms/copilot';
  const now = Math.floor(Date.now() / 1000);
  return {
    provider: 'workbuddy',
    accountRef: 'acct_test',
    env: {},
    nativeAuth: {
      credentials: {
        account: { uid },
        auth: {
          accessToken: fakeJwt({ iss, sub: uid, iat: now - 60, exp: now + 3600 }),
          refreshToken: fakeJwt({ iss, sub: uid, iat: now - 60, exp: now + 86400 }),
          domain: 'www.workbuddy.ai'
        }
      }
    },
    ...extra
  };
}

const ACTIVE_STATE = {
  code: 0,
  msg: 'OK',
  data: {
    active: true,
    today_checked_in: false,
    streak_days: 5,
    daily_credit: 100,
    total_credits: 500,
    activity_name: 'Buddy应用',
    theme_name: 'Buddy加油站',
    start_time: '2026-09-30 00:00:00',
    end_time: '2026-12-31 23:59:59',
    checkin_dates: ['2026-10-31', '2026-10-29']
  }
};

function createHarness({ statusJson = ACTIVE_STATE, statusHttp, claimJson = { code: 0, msg: 'OK', data: { credit: 100, streak_days: 6, is_streak_day: false } }, claimHttp } = {}) {
  const requests = [];
  const fetchWithTimeout = async (url, init) => {
    const target = String(url);
    requests.push({ url: target, init });
    const isClaim = target.endsWith('/daily-checkin');
    const http = isClaim ? (claimHttp || { status: 200 }) : (statusHttp || { status: 200 });
    const body = isClaim ? claimJson : statusJson;
    return {
      ok: http.ok === undefined ? true : http.ok,
      status: http.status || 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    };
  };
  return {
    requests,
    fetchWithTimeout,
    statusRequests: () => requests.filter((r) => r.url.endsWith('/checkin-activity-status')),
    claimRequests: () => requests.filter((r) => r.url.endsWith('/daily-checkin'))
  };
}

function runClaim(harness, extra = {}) {
  return runWorkbuddyDailyClaim({
    record: createRecord(),
    fs: createFakeFs(),
    aiHomeDir: '/tmp/aih-workbuddy-claim-test',
    timeoutMs: 2_000,
    fetchWithTimeout: harness.fetchWithTimeout,
    resolveAccountEgressRequestOptions: async () => ({ ok: true, options: {} }),
    ...extra
  });
}

test('只读探测：活动开启且今天没领 → dry_run，且不发送领取请求', async () => {
  const harness = createHarness();
  const result = await runClaim(harness, { dryRun: true });

  assert.equal(result.status, 'dry_run');
  assert.equal(result.claimable.length, 1);
  assert.equal(result.claimable[0].credits, 100);
  assert.equal(result.activity.theme, 'Buddy加油站');
  assert.equal(harness.claimRequests().length, 0);
  assert.equal(harness.statusRequests().length, 1);
});

test('活动未开启：nothing_claimable，不盲发领取', async () => {
  const harness = createHarness({
    statusJson: { code: 0, msg: 'OK', data: { active: false, today_checked_in: false } }
  });
  const result = await runClaim(harness);

  assert.equal(result.status, 'nothing_claimable');
  assert.equal(result.message, '签到活动未开启');
  assert.equal(harness.claimRequests().length, 0);
});

test('今天已领：already_claimed，不重复领取', async () => {
  const harness = createHarness({
    statusJson: { code: 0, msg: 'OK', data: { active: true, today_checked_in: true, streak_days: 5 } }
  });
  const result = await runClaim(harness);

  assert.equal(result.status, 'already_claimed');
  assert.equal(result.streakDays, 5);
  assert.equal(harness.claimRequests().length, 0);
});

test('领取成功：积分取自信封 data（不是信封顶层）', async () => {
  const harness = createHarness();
  const result = await runClaim(harness);

  assert.equal(result.status, 'claimed');
  assert.equal(result.credits, 100);
  assert.equal(result.streakDays, 6);
  assert.equal(result.isStreakDay, false);
  const claim = harness.claimRequests()[0];
  assert.equal(claim.init.method, 'POST');
  assert.equal(claim.init.body, '{}');
});

test('业务码 1001 = 已领过（不是失败）；1002/1003 归暂无可领', async () => {
  const already = await runClaim(createHarness({ claimJson: { code: 1001, msg: 'already claimed' } }));
  assert.equal(already.status, 'already_claimed');

  const notEligible = await runClaim(createHarness({ claimJson: { code: 1002, msg: 'not eligible' } }));
  assert.equal(notEligible.status, 'nothing_claimable');
  assert.equal(notEligible.message, 'not eligible');

  const ended = await runClaim(createHarness({ claimJson: { code: 1003, msg: 'event ended' } }));
  assert.equal(ended.status, 'nothing_claimable');
  assert.equal(ended.message, 'event ended');
});

test('未知业务码 fail-closed：error + 机器码', async () => {
  const result = await runClaim(createHarness({ claimJson: { code: 9999, msg: 'boom' } }));

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'workbuddy_checkin_biz_9999');
  assert.equal(result.message, 'boom');
});

test('凭据失效：401 判成 auth 失败，不带业务结论', async () => {
  const result = await runClaim(createHarness({ statusHttp: { status: 401, ok: false }, statusJson: '' }));

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'workbuddy_auth_invalid:401');
  assert.equal(result.auth, true);
});

test('缺凭据：fail-closed，不请求上游', async () => {
  const harness = createHarness();
  const result = await runClaim(harness, { record: createRecord({ nativeAuth: {} }) });

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'workbuddy_credential_missing');
  assert.equal(result.auth, true);
  assert.equal(harness.requests.length, 0);
});

test('请求头与桌面端同形：身份、归属域、真实 UA', () => {
  const headers = buildWorkbuddyCheckinHeaders({
    credential: { accessToken: 't', uid: 'u', domain: 'www.workbuddy.ai' },
    record: { nativeAuth: { credentials: { account: { uid: 'u' } } } }
  });

  assert.equal(headers.Authorization, 'Bearer t');
  assert.equal(headers['X-User-Id'], 'u');
  assert.equal(headers['X-Domain'], 'www.workbuddy.ai');
  assert.ok(headers['User-Agent']);
  assert.equal(headers['X-Enterprise-Id'], undefined);
});

test('企业账号补 X-Enterprise-Id / X-Tenant-Id（桌面端 buildHeaders 同一分支）', () => {
  const headers = buildWorkbuddyCheckinHeaders({
    credential: { accessToken: 't', uid: 'u', domain: 'www.workbuddy.cn' },
    record: { nativeAuth: { credentials: { account: { uid: 'u', enterpriseId: 'ent-1' } } } }
  });

  assert.equal(headers['X-Enterprise-Id'], 'ent-1');
  assert.equal(headers['X-Tenant-Id'], 'ent-1');
});

test('状态解析：snake_case → 结构化状态，缺字段不抛异常', () => {
  const state = readCheckinState({ code: 0, data: { active: true, daily_credit: '100', checkin_dates: null } });

  assert.equal(state.active, true);
  assert.equal(state.todayCheckedIn, false);
  assert.equal(state.dailyCredit, 100);
  assert.deepEqual(state.checkinDates, []);
  assert.equal(readCheckinState(null).active, false);
});
