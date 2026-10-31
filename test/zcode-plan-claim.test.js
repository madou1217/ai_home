'use strict';

// zcode「领臭鸡蛋」的关键回归：
//   1) 判读链 preview → 投放 → balance：preview 缺 data 是上游常态（§4.2 矩阵），
//      空投放要靠 balance 区分「已领到 / 没活动」，三条都不可用才判可重试错误；
//   2) claim 不再前置阿里云验证码：先裸领，只有上游回 3007 才解一次并重试。
// 外加额度探针对「已领取、未生效」套餐的结构化结论（planGroups + 生效时间）。

const test = require('node:test');
const assert = require('node:assert');

const { runZcodePlanClaim } = require('../lib/account/activity-claim/zcode-plan');
const { __private: zcodeProbePrivate } = require('../lib/cli/services/usage/zcode-quota-probe');

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

function createRecord() {
  return {
    provider: 'zcode',
    accountRef: 'acct_test',
    env: {},
    nativeAuth: { credentials: { zcodejwttoken: 'jwt-test' } }
  };
}

function createHarness({ previewJson, claimJson, balanceJson }) {
  const requests = [];
  let claimCalls = 0;
  const balanceBody = balanceJson || { code: 0, data: { plans: [], balances: [] } };
  const fetchWithTimeout = async (url, init) => {
    requests.push({ url: String(url), init });
    const target = String(url);
    if (target.includes('/billing/balance')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(balanceBody) };
    }
    const isPreview = target.includes('/billing/preview');
    const body = isPreview
      ? previewJson
      : (typeof claimJson === 'function' ? claimJson(claimCalls++) : claimJson);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { requests, fetchWithTimeout, claimHeaders: () => requests.filter((r) => r.url.includes('/billing/claim')) };
}

function runClaim(harness, extra = {}) {
  const solveCalls = [];
  return runZcodePlanClaim({
    record: createRecord(),
    fs: createFakeFs(),
    aiHomeDir: '/tmp/aih-zcode-claim-test',
    appVersion: '3.20.0',
    platform: 'darwin',
    arch: 'arm64',
    timeoutMs: 2_000,
    fetchWithTimeout: harness.fetchWithTimeout,
    resolveAccountEgressRequestOptions: async () => ({ ok: true, options: {} }),
    solveCaptcha: async () => { solveCalls.push(1); return 'captcha-param'; },
    ...extra
  }).then((result) => ({ result, solveCalls, harness }));
}

const PREVIEW_WITH_PLAN = {
  code: 0,
  msg: '',
  data: {
    server_time: 1793300000,
    plans: [{
      plan_id: 'zcode-v3-start-plan-1030-wk',
      name: 'ZCODE WEEKEND BUILD',
      priority: 10,
      ends_at: 1793600400,
      entitlements: [{ effective_at: 1793372400 }]
    }]
  }
};

test('preview 缺 data + 投放空 + balance 明确无套餐 → 暂无可领（不再误报故障）', async () => {
  // preview 缺 data 是上游常态（协议文档 §4.2 的版本×平台矩阵），不能单独当故障信号；
  // 判读交给 balance：它明确回答「没有任何套餐」时，空投放就是没活动。
  const harness = createHarness({ previewJson: { code: 0, msg: '' }, claimJson: { code: 0 } });
  const { result } = await runClaim(harness);
  assert.strictEqual(result.status, 'nothing_claimable');
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.balance.ok, true);
  assert.strictEqual(harness.claimHeaders().length, 0);
});

test('preview 缺 data + 投放空 + balance 已有该套餐 → 已领取过（不是失败）', async () => {
  const harness = createHarness({
    previewJson: { code: 0, msg: '' },
    claimJson: { code: 0 },
    balanceJson: {
      code: 0,
      data: {
        server_time: 1793426666,
        plans: [{
          user_plan_id: 'upl_1',
          plan_id: 'zcode-v3-start-plan-1030-wk',
          name: 'ZCODE WEEKEND BUILD',
          priority: 101,
          status: 'active',
          starts_at: 1793372919,
          ends_at: 1793581200
        }],
        balances: []
      }
    }
  });
  const { result } = await runClaim(harness, { actionKinds: zcodeKinds() });
  assert.strictEqual(result.status, 'already_claimed');
  assert.strictEqual(result.plan.planId, 'zcode-v3-start-plan-1030-wk');
  assert.strictEqual(result.planKind, 'weekend_build');
  // 手上持有的套餐不进 result.plans：那是「本次发现的可领项」，进了会让探测把已领的当成可领。
  assert.deepStrictEqual(result.plans, []);
  assert.strictEqual(harness.claimHeaders().length, 0);
});

test('已有套餐但不是要的那一类 → nothing_claimable + 类型不可用', async () => {
  const harness = createHarness({
    previewJson: { code: 0, msg: '' },
    claimJson: { code: 0 },
    balanceJson: {
      code: 0,
      data: {
        plans: [{ plan_id: 'zcode-v3-start-plan-1030-wk', name: 'ZCODE WEEKEND BUILD', status: 'active' }],
        balances: []
      }
    }
  });
  const { result } = await runClaim(harness, {
    actionKinds: zcodeKinds(),
    params: { planKind: 'start_plan' }
  });
  assert.strictEqual(result.status, 'nothing_claimable');
  assert.strictEqual(result.planKind, 'start_plan');
  assert.strictEqual(result.reason, 'plan_kind_unavailable:start_plan');
  assert.strictEqual(result.heldPlans.length, 1);
});

test('preview 429 且 balance 也不可用 → 保留可重试错误（真的看不到）', async () => {
  const requests = [];
  const fetchWithTimeout = async (url) => {
    const target = String(url);
    requests.push(target);
    if (target.includes('/billing/preview')) {
      return { ok: false, status: 429, text: async () => JSON.stringify({ code: 429, msg: 'rate limited' }) };
    }
    if (target.includes('/marketing/touch')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { deliveries: [] } }) };
    }
    return { ok: false, status: 429, text: async () => JSON.stringify({ code: 429, msg: 'rate limited' }) };
  };
  const { result } = await runClaim({ fetchWithTimeout, claimHeaders: () => [] });
  assert.strictEqual(result.status, 'error');
  assert.strictEqual(result.error, 'zcode_preview_failed:429');
  assert.strictEqual(result.balance.ok, false);
});

test('preview 返回空 plans 才是暂无可领', async () => {
  const harness = createHarness({ previewJson: { code: 0, data: { plans: [] } }, claimJson: { code: 0 } });
  const { result } = await runClaim(harness);
  assert.strictEqual(result.status, 'nothing_claimable');
  assert.strictEqual(result.error, undefined);
});

test('领取不再前置验证码：裸领成功且不发 X-Aliyun-Captcha 头', async () => {
  const harness = createHarness({ previewJson: PREVIEW_WITH_PLAN, claimJson: { code: 0, data: {} } });
  const { result, solveCalls } = await runClaim(harness);
  assert.strictEqual(result.status, 'claimed');
  assert.strictEqual(result.plan.planId, 'zcode-v3-start-plan-1030-wk');
  assert.strictEqual(solveCalls.length, 0);
  const [claim] = harness.claimHeaders();
  assert.strictEqual(claim.init.method, 'POST');
  assert.deepStrictEqual(JSON.parse(claim.init.body), { plan_id: 'zcode-v3-start-plan-1030-wk' });
  assert.ok(!('X-Aliyun-Captcha-Verify-Param' in claim.init.headers));
});

test('上游回 3007 时才解一次验证码并重试', async () => {
  const harness = createHarness({
    previewJson: PREVIEW_WITH_PLAN,
    claimJson: (callIndex) => (callIndex === 0
      ? { code: 3007, msg: 'captcha verify failed' }
      : { code: 0, data: {} })
  });
  let claimCount = 0;
  const { result, solveCalls } = await runClaim(harness, {
    // 解算链路依赖 client/configs，这里直接给上游配置。
    fetchWithTimeout: async (url, init) => {
      const target = String(url);
      harness.requests.push({ url: target, init });
      if (target.includes('/client/configs')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            code: 0,
            data: { configs: { captcha: { enabled: true, prefix: 'prefix', region: 'cn', sceneId: 'scene' } } }
          })
        };
      }
      if (target.includes('/billing/preview')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(PREVIEW_WITH_PLAN) };
      }
      const body = claimCount === 0 ? { code: 3007, msg: 'captcha verify failed' } : { code: 0, data: {} };
      claimCount += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
  });
  assert.strictEqual(result.status, 'claimed');
  assert.strictEqual(result.captcha, 'solved');
  assert.strictEqual(solveCalls.length, 1);
  const claims = harness.claimHeaders();
  assert.strictEqual(claims.length, 2);
  assert.strictEqual(claims[1].init.headers['X-Aliyun-Captcha-Verify-Param'], 'captcha-param');
});

test('已领取、未生效的套餐仍产出结构化结论快照', () => {
  const payload = {
    code: 0,
    data: {
      plans: [{
        plan_id: 'zcode-v3-start-plan-1030-wk',
        user_plan_id: 'user-plan-1',
        name: 'ZCODE WEEKEND BUILD',
        priority: 10,
        ends_at: 1793600400,
        entitlements: [{ effective_at: 1793372400 }]
      }],
      balances: []
    }
  };
  const pending = zcodeProbePrivate.buildPendingPlanSnapshot(payload, 1793300000000);
  assert.ok(pending);
  assert.strictEqual(pending.effectiveAtMs, 1793372400000);
  const { snapshot } = pending;
  assert.deepStrictEqual(snapshot.entries, []);
  assert.deepStrictEqual(snapshot.account.planNames, ['ZCODE WEEKEND BUILD']);
  assert.deepStrictEqual(snapshot.account.planIds, ['zcode-v3-start-plan-1030-wk']);
  assert.strictEqual(snapshot.pendingEffectiveAtMs, 1793372400000);
  assert.strictEqual(snapshot.planGroups.length, 1);
  assert.strictEqual(snapshot.planGroups[0].name, 'ZCODE WEEKEND BUILD');
  assert.deepStrictEqual(snapshot.planGroups[0].entries, []);
  assert.strictEqual(snapshot.planGroups[0].effectiveAtMs, 1793372400000);
});

test('有余额桶时不走未生效结论', () => {
  const payload = {
    code: 0,
    data: {
      plans: [{ plan_id: 'p1', user_plan_id: 'u1', name: 'PLAN' }],
      balances: [{ plan_id: 'p1', user_plan_id: 'u1', total_units: 10, remaining_units: 10 }]
    }
  };
  assert.strictEqual(zcodeProbePrivate.buildPendingPlanSnapshot(payload, 1), null);
});

// —— 发现通道：preview 空/缺 data 时，plan_id 来自营销投放（桌面端横幅同源） ——

function createRoutedHarness({ previewJson, touchJson, claimJson, balanceJson }) {
  const requests = [];
  const balanceBody = balanceJson || { code: 0, data: { plans: [], balances: [] } };
  const fetchWithTimeout = async (url, init) => {
    const target = String(url);
    requests.push({ url: target, init });
    let body = claimJson;
    if (target.includes('/billing/preview')) body = previewJson;
    else if (target.includes('/marketing/touch')) body = touchJson;
    else if (target.includes('/billing/balance')) body = balanceBody;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return {
    requests,
    fetchWithTimeout,
    claimHeaders: () => requests.filter((r) => r.url.includes('/billing/claim')),
    touchCalls: () => requests.filter((r) => r.url.includes('/marketing/touch'))
  };
}

function bannerDelivery(planId, extra = {}) {
  return {
    code: 0,
    data: {
      server_time: 1793300000,
      language: 'zh-CN',
      deliveries: [{
        campaign_id: '2101141259813175296',
        priority: 100,
        resource_position: 'banner',
        banner: {
          buttons: [
            { text: { format: 'plaintext', content: 'Close' }, action: { type: 'close' } },
            {
              text: { format: 'plaintext', content: 'Claim' },
              action: { type: 'claim_zcode_plan', args: { plan_id: planId } }
            }
          ]
        },
        ...extra
      }]
    }
  };
}

test('preview 缺 data 时改从营销投放取 plan_id 并领取成功', async () => {
  const harness = createRoutedHarness({
    previewJson: { code: 0, msg: '' },
    touchJson: bannerDelivery('zcode-v3-start-plan-1030-wk'),
    claimJson: { code: 0, data: { plan: { plan_id: 'zcode-v3-start-plan-1030-wk', status: 'active' } } }
  });
  const { result, solveCalls } = await runClaim(harness);
  assert.strictEqual(result.status, 'claimed');
  assert.strictEqual(result.discovery, 'marketing_touch');
  assert.strictEqual(result.plan.planId, 'zcode-v3-start-plan-1030-wk');
  assert.strictEqual(result.marketingTouch.deliveries, 1);
  assert.strictEqual(solveCalls.length, 0);
  const [claim] = harness.claimHeaders();
  assert.deepStrictEqual(JSON.parse(claim.init.body), { plan_id: 'zcode-v3-start-plan-1030-wk' });
  assert.ok(!('X-Aliyun-Captcha-Verify-Param' in claim.init.headers));
});

test('preview 返回空 plans 时同样回落到投放', async () => {
  const harness = createRoutedHarness({
    previewJson: { code: 0, data: { plans: [] } },
    touchJson: bannerDelivery('zcode-v3-start-plan-1030-wk'),
    claimJson: { code: 0, data: { plan: { plan_id: 'zcode-v3-start-plan-1030-wk' } } }
  });
  const { result } = await runClaim(harness);
  assert.strictEqual(result.status, 'claimed');
  assert.strictEqual(result.discovery, 'marketing_touch');
});

test('投放里没有 claim_zcode_plan 动作时不算可领', async () => {
  const harness = createRoutedHarness({
    previewJson: { code: 0, data: { plans: [] } },
    touchJson: {
      code: 0,
      data: {
        server_time: 1793300000,
        language: 'zh-CN',
        deliveries: [{
          campaign_id: 'c1',
          priority: 10,
          resource_position: 'banner',
          banner: { buttons: [{ text: { format: 'plaintext', content: 'Go' }, action: { type: 'open_url', args: { url: 'https://z.ai' } } }] }
        }]
      }
    },
    claimJson: { code: 0 }
  });
  const { result } = await runClaim(harness);
  assert.strictEqual(result.status, 'nothing_claimable');
  assert.strictEqual(result.discovery, 'preview');
  assert.strictEqual(harness.claimHeaders().length, 0);
});

test('投放去重：同位置只取第一条，popup 通道也能取到 plan_id', () => {
  const { collectMarketingClaimPlans } = require('../lib/account/activity-claim/zcode-plan');
  const plans = collectMarketingClaimPlans([
    { campaign_id: 'c1', priority: 10, resource_position: 'banner', banner: { buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: 'plan-a' } } }] } },
    { campaign_id: 'c2', priority: 20, resource_position: 'banner', banner: { buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: 'plan-b' } } }] } },
    { campaign_id: 'c3', priority: 30, resource_position: 'popup', popup: { buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: 'plan-c' } } }] } }
  ]);
  assert.deepStrictEqual(plans.map((p) => p.planId), ['plan-a', 'plan-c']);
  assert.deepStrictEqual(plans.map((p) => p.position), ['banner', 'popup']);
  assert.strictEqual(plans[1].campaignId, 'c3');
});

// ---- 类型化领取：描述符声明 kinds，handler 只做求值 ----

// kinds 从**真实描述符**取，避免测试与描述符各写一份规则而漂移。
function zcodeKinds() {
  const { getProviderCapability } = require('../lib/providers');
  return getProviderCapability('zcode', 'activity').actions[0].kinds;
}

const PREVIEW_TWO_PLANS = {
  code: 0,
  msg: '',
  data: {
    server_time: 1793300000,
    plans: [
      {
        plan_id: 'zcode-v3-start-plan-1030-wk',
        name: 'ZCODE WEEKEND BUILD',
        priority: 10,
        entitlements: []
      },
      {
        plan_id: 'zcode-v3-start-plan-0817',
        name: 'ZCode Start Plan',
        priority: 20,
        entitlements: []
      }
    ]
  }
};

test('指定类型时按类型领，而不是按 priority 领最高的那个', async () => {
  const harness = createHarness({ previewJson: PREVIEW_TWO_PLANS, claimJson: { code: 0 } });
  const { result } = await runClaim(harness, {
    actionKinds: zcodeKinds(),
    params: { planKind: 'weekend_build' }
  });
  assert.strictEqual(result.status, 'claimed');
  assert.strictEqual(result.plan.planId, 'zcode-v3-start-plan-1030-wk');
  assert.strictEqual(result.planKind, 'weekend_build');
  assert.strictEqual(JSON.parse(harness.claimHeaders()[0].init.body).plan_id, 'zcode-v3-start-plan-1030-wk');
});

test('指定类型当前没货 → nothing_claimable（不是故障，定时任务不该报警）', async () => {
  const harness = createHarness({ previewJson: PREVIEW_WITH_PLAN, claimJson: { code: 0 } });
  const { result } = await runClaim(harness, {
    actionKinds: zcodeKinds(),
    params: { planKind: 'start_plan' }
  });
  // 只有周末套餐（-wk），但 start_plan 的前缀规则同样匹配它 —— 首个命中即 weekend_build，
  // 因此 start_plan 这一类当前没有可领项。
  assert.strictEqual(result.status, 'nothing_claimable');
  assert.strictEqual(result.planKind, 'start_plan');
  assert.strictEqual(result.reason, 'plan_kind_unavailable:start_plan');
  assert.strictEqual(harness.claimHeaders().length, 0);
});

test('探测（dryRun）回传类型目录与每个 plan 的类型标注', async () => {
  const harness = createHarness({ previewJson: PREVIEW_TWO_PLANS, claimJson: { code: 0 } });
  const { result } = await runClaim(harness, { actionKinds: zcodeKinds(), dryRun: true });
  assert.strictEqual(result.status, 'dry_run');
  assert.deepStrictEqual(
    result.plans.map((plan) => [plan.planId, plan.planKind]),
    [
      ['zcode-v3-start-plan-1030-wk', 'weekend_build'],
      ['zcode-v3-start-plan-0817', 'start_plan']
    ]
  );
  assert.deepStrictEqual(
    result.availableKinds.map((kind) => [kind.id, kind.claimable]),
    [['weekend_build', true], ['start_plan', true]]
  );
  assert.strictEqual(harness.claimHeaders().length, 0);
});
