'use strict';

// 账号活动领取（Qoder 每日签到 / ZCode 套餐）的协议级单测。
//
// 这里锁住的是「上游接口事实」而不是实现细节：
//   * Qoder 只对 actionType=CLAIM_BENEFIT 且 claimStatus=CLAIMABLE 的活动发 claim；
//   * 缺设备身份必须 fail-closed（上游此时会返回 campaigns: []，静默会误判成「没活动」）；
//   * ZCode 的活动窗口外必须收敛成 nothing_claimable，不能去解验证码；
//   * ZCode 验证码两个头（param + region）必须同时下发，否则上游恒 3007。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildClaimPath,
  runQoderDailyClaim,
  summarizeCampaign
} = require('../lib/account/activity-claim/qoder-daily');
const {
  buildZcodePlanUrl,
  runZcodePlanClaim
} = require('../lib/account/activity-claim/zcode-plan');
const {
  getActivityAction,
  listActivityActions,
  listActivityProviders,
  runActivityClaim
} = require('../lib/account/activity-claim');

const AI_HOME = '/tmp/aih-test-home';
const EGRESS_STUB = async () => ({ ok: true, options: {} });

function createFakeFs(files = {}) {
  return {
    readFileSync(file) {
      for (const [suffix, content] of Object.entries(files)) {
        if (String(file).endsWith(suffix)) {
          return typeof content === 'string' ? content : JSON.stringify(content);
        }
      }
      const error = new Error(`ENOENT: ${file}`);
      error.code = 'ENOENT';
      throw error;
    }
  };
}

function createFetchStub(handler) {
  const calls = [];
  const fetchWithTimeout = async (url, init = {}, timeout, egressOptions) => {
    calls.push({ url: String(url), init, timeout, egressOptions });
    const reply = await handler({ url: String(url), init, index: calls.length - 1 });
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return {
      ok: reply.ok !== false,
      status: reply.status || 200,
      text: async () => body
    };
  };
  return { calls, fetchWithTimeout };
}

const QODER_UMID = {
  info: {
    machineToken: 'machine-token',
    machineCode: 'machine-code',
    machineType: 'DESKTOP'
  }
};

function qoderRecord(overrides = {}) {
  return {
    accountRef: 'acct_qoder_test',
    provider: 'qoder',
    env: { QODER_PERSONAL_ACCESS_TOKEN: 'qoder-token' },
    nativeAuth: { machineId: 'machine-id-1' },
    ...overrides
  };
}

function qoderCampaign(overrides = {}) {
  return {
    campaignId: 'camp-1',
    campaignKey: 'act-20261020-910',
    actionType: 'CLAIM_BENEFIT',
    claimStatus: 'CLAIMABLE',
    benefit: { kind: 'CREDITS', amount: 100, validity: { days: 30 } },
    ...overrides
  };
}

test('qoder daily claim only claims CLAIM_BENEFIT + CLAIMABLE campaigns', async () => {
  const fetchStub = createFetchStub(({ url }) => {
    if (url.includes('/me/campaigns')) {
      return {
        body: {
          campaigns: [
            qoderCampaign(),
            qoderCampaign({ campaignId: 'camp-promo', campaignKey: 'promo-1', actionType: 'VIEW_PAGE' }),
            qoderCampaign({ campaignId: 'camp-done', campaignKey: 'act-old', claimStatus: 'CLAIMED' })
          ]
        }
      };
    }
    return { body: { success: true, data: { grantId: 'grant-1' } } };
  });

  const result = await runQoderDailyClaim({
    provider: 'qoder',
    record: qoderRecord(),
    fs: createFakeFs({ 'umid-cache.json': QODER_UMID }),
    aiHomeDir: AI_HOME,
    hostHomeDir: '/home/tester',
    processObj: { env: {} },
    resolveAccountEgressRequestOptions: EGRESS_STUB,
    fetchWithTimeout: fetchStub.fetchWithTimeout
  });

  assert.equal(result.status, 'claimed');
  assert.equal(result.credits, 100);
  assert.equal(result.campaigns.length, 2, 'promo campaigns are not benefit campaigns');
  assert.deepEqual(result.claimed.map((item) => item.campaignId), ['camp-1']);

  const posts = fetchStub.calls.filter((call) => call.init.method === 'POST');
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/me/campaigns/camp-1/claim'));
  assert.equal(posts[0].init.body, '{}');
  assert.equal(posts[0].init.headers.origin, 'https://openapi.qoder.sh');
  assert.equal(posts[0].init.headers['Cosy-ClientType'], '10');
  assert.equal(posts[0].init.headers['Cosy-MachineId'], 'machine-id-1');
  assert.equal(posts[0].init.headers['Cosy-MachineToken'], 'machine-token');
});

test('qoder daily claim is idempotent: no POST when today is already claimed', async () => {
  const fetchStub = createFetchStub(() => ({
    body: { campaigns: [qoderCampaign({ claimStatus: 'CLAIMED' })] }
  }));

  const result = await runQoderDailyClaim({
    provider: 'qoder',
    record: qoderRecord(),
    fs: createFakeFs({ 'umid-cache.json': QODER_UMID }),
    aiHomeDir: AI_HOME,
    hostHomeDir: '/home/tester',
    processObj: { env: {} },
    resolveAccountEgressRequestOptions: EGRESS_STUB,
    fetchWithTimeout: fetchStub.fetchWithTimeout
  });

  assert.equal(result.status, 'already_claimed');
  assert.equal(result.claimed.length, 0);
  assert.equal(fetchStub.calls.filter((call) => call.init.method === 'POST').length, 0);
});

test('qoder daily claim fails closed when device identity headers are missing', async () => {
  const fetchStub = createFetchStub(() => ({ body: { campaigns: [] } }));

  const result = await runQoderDailyClaim({
    provider: 'qoder',
    // 没有 nativeAuth.machineId，也没有 umid-cache.json
    record: qoderRecord({ nativeAuth: {} }),
    fs: createFakeFs({}),
    aiHomeDir: AI_HOME,
    hostHomeDir: '/home/tester',
    processObj: { env: {} },
    resolveAccountEgressRequestOptions: EGRESS_STUB,
    fetchWithTimeout: fetchStub.fetchWithTimeout
  });

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'qoder_device_identity_missing');
  assert.equal(fetchStub.calls.length, 0, 'must not query upstream without identity');
});

test('qoder dry run reports claimable campaigns without claiming', async () => {
  const fetchStub = createFetchStub(() => ({ body: { campaigns: [qoderCampaign()] } }));

  const result = await runQoderDailyClaim({
    provider: 'qodercn',
    record: qoderRecord({ provider: 'qodercn' }),
    fs: createFakeFs({ 'umid-cache.json': QODER_UMID }),
    aiHomeDir: AI_HOME,
    hostHomeDir: '/home/tester',
    processObj: { env: {} },
    dryRun: true,
    resolveAccountEgressRequestOptions: EGRESS_STUB,
    fetchWithTimeout: fetchStub.fetchWithTimeout
  });

  assert.equal(result.status, 'dry_run');
  assert.deepEqual(result.claimable.map((item) => item.campaignId), ['camp-1']);
  assert.equal(fetchStub.calls.length, 1);
  assert.ok(fetchStub.calls[0].url.startsWith('https://openapi.qoder.com.cn'));
});

test('qoder campaign summary keeps credits and validity', () => {
  assert.deepEqual(summarizeCampaign(qoderCampaign()), {
    campaignId: 'camp-1',
    campaignKey: 'act-20261020-910',
    actionType: 'CLAIM_BENEFIT',
    claimStatus: 'CLAIMABLE',
    benefitKind: 'CREDITS',
    credits: 100,
    validDays: 30
  });
});

test('qoder claim path encodes the campaign id', () => {
  assert.equal(buildClaimPath('a/b'), '/sash/api/v1/me/campaigns/a%2Fb/claim');
});

function zcodeRecord(overrides = {}) {
  return {
    accountRef: 'acct_zcode_test',
    provider: 'zcode',
    env: {},
    nativeAuth: { credentials: { zcodejwttoken: 'jwt-token' } },
    ...overrides
  };
}

const ZCODE_CAPTCHA_CONFIG = {
  code: 0,
  data: { configs: { captcha: { enabled: true, prefix: 'prefix-1', region: 'cn', sceneId: 'scene-1' } } }
};

test('zcode plan claim is nothing_claimable outside the activity window (no captcha work)', async () => {
  let solveCalls = 0;
  const fetchStub = createFetchStub(() => ({ body: { code: 0, data: { plans: [] } } }));

  const result = await runZcodePlanClaim({
    record: zcodeRecord(),
    fs: createFakeFs({}),
    aiHomeDir: AI_HOME,
    hostHomeDir: '/home/tester',
    processObj: { env: {}, platform: 'darwin', arch: 'arm64' },
    appVersion: '3.15.3',
    resolveAccountEgressRequestOptions: EGRESS_STUB,
    fetchWithTimeout: fetchStub.fetchWithTimeout,
    solveCaptcha: async () => {
      solveCalls += 1;
      return 'captcha-param';
    }
  });

  assert.equal(result.status, 'nothing_claimable');
  assert.equal(solveCalls, 0);
  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].init.headers['X-Platform'], 'darwin-arm64');
  assert.match(fetchStub.calls[0].url, /app_version=3\.15\.3/);
});

test('zcode plan claim sends captcha param + region headers and the real plan id', async () => {
  const plan = {
    plan_id: 'zcode-v3-start-plan-1010',
    name: 'Weekend Trial',
    priority: 10
  };
  const fetchStub = createFetchStub(({ url }) => {
    if (url.includes('/billing/preview')) return { body: { code: 0, data: { plans: [plan] } } };
    if (url.includes('/client/configs')) return { body: ZCODE_CAPTCHA_CONFIG };
    return { body: { code: 0, data: { message: 'ok' } } };
  });

  const result = await runZcodePlanClaim({
    record: zcodeRecord(),
    fs: createFakeFs({}),
    aiHomeDir: AI_HOME,
    hostHomeDir: '/home/tester',
    processObj: { env: {}, platform: 'darwin', arch: 'arm64' },
    appVersion: '3.15.3',
    resolveAccountEgressRequestOptions: EGRESS_STUB,
    fetchWithTimeout: fetchStub.fetchWithTimeout,
    solveCaptcha: async (input) => {
      assert.equal(input.sceneId, 'scene-1');
      assert.equal(input.prefix, 'prefix-1');
      return 'captcha-param-xyz';
    }
  });

  assert.equal(result.status, 'claimed');
  assert.equal(result.plan.planId, 'zcode-v3-start-plan-1010');

  const post = fetchStub.calls.find((call) => call.init.method === 'POST');
  assert.ok(post.url.includes('/billing/claim'));
  assert.equal(post.init.body, JSON.stringify({ plan_id: 'zcode-v3-start-plan-1010' }));
  assert.equal(post.init.headers['X-Aliyun-Captcha-Verify-Param'], 'captcha-param-xyz');
  assert.equal(post.init.headers['X-Aliyun-Captcha-Verify-Region'], 'cn');
  assert.equal(post.init.headers['X-ZCode-App-Version'], '3.15.3');
});

test('zcode captcha rejection (3007) surfaces as zcode_captcha_rejected', async () => {
  const fetchStub = createFetchStub(({ url }) => {
    if (url.includes('/billing/preview')) {
      return { body: { code: 0, data: { plans: [{ plan_id: 'plan-1', name: 'P', priority: 1 }] } } };
    }
    if (url.includes('/client/configs')) return { body: ZCODE_CAPTCHA_CONFIG };
    return { body: { code: 3007, msg: 'captcha verify failed' } };
  });

  const result = await runZcodePlanClaim({
    record: zcodeRecord(),
    fs: createFakeFs({}),
    aiHomeDir: AI_HOME,
    hostHomeDir: '/home/tester',
    processObj: { env: {}, platform: 'darwin', arch: 'arm64' },
    appVersion: '3.15.3',
    resolveAccountEgressRequestOptions: EGRESS_STUB,
    fetchWithTimeout: fetchStub.fetchWithTimeout,
    solveCaptcha: async () => 'captcha-param'
  });

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'zcode_captcha_rejected');
  assert.equal(result.code, 3007);
  assert.equal(result.message, 'captcha verify failed');
});

test('zcode api-key accounts are not_applicable instead of failed', async () => {
  const result = await runZcodePlanClaim({
    record: zcodeRecord({
      env: { ZCODE_API_KEY: 'sk-test' },
      nativeAuth: {}
    }),
    fs: createFakeFs({}),
    aiHomeDir: AI_HOME,
    processObj: { env: {} },
    resolveAccountEgressRequestOptions: EGRESS_STUB
  });

  assert.equal(result.status, 'not_applicable');
});

test('zcode preview url carries app version and platform', () => {
  const url = buildZcodePlanUrl(
    'https://zcode.z.ai/api/v1/zcode-plan/billing/preview',
    '3.15.3',
    'darwin',
    'arm64'
  );
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('app_version'), '3.15.3');
  assert.equal(parsed.searchParams.get('platform'), 'darwin-arm64');
});

test('activity 能力从 provider 描述符派生（不在本模块维护 provider 名单）', () => {
  assert.deepEqual(listActivityProviders().sort(), ['qoder', 'qodercn', 'zcode']);
  assert.deepEqual(listActivityActions('qoder'), [{
    id: 'daily_checkin',
    label: '每日签到',
    description: '每天 10:00 (UTC+8) 重置，领取 100 Credits'
  }]);
  assert.deepEqual(listActivityActions('codex'), []);
  assert.equal(getActivityAction('QODER', 'daily_checkin').handler, 'qoder-daily-checkin');
  assert.equal(getActivityAction('qoder', 'nope'), null);
});

test('runActivityClaim fail-closed：未知 provider / 动作 / handler 都有明确错误码', async () => {
  const unsupported = await runActivityClaim({ provider: 'codex', record: { accountRef: 'acct_x' } });
  assert.equal(unsupported.status, 'error');
  assert.equal(unsupported.error, 'activity_unsupported:codex');

  const unknownAction = await runActivityClaim({
    provider: 'qoder',
    actionId: 'nope',
    record: { accountRef: 'acct_x' }
  });
  assert.equal(unknownAction.error, 'activity_action_unknown:qoder:nope');
});
