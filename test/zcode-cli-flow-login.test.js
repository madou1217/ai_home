'use strict';

// 回归守卫（2026-11-03 真机）：WebUI 选「ZCode 登录（BigModel 国内站 · 官方 CLI 流程）」，
// 用户在 bigmodel.cn 完成授权、cli/poll 返回 ready 的那一刻，aih server 直接退出。
//
// 两个事实要分清：
//   1. cli-flow 本来就不回调本机 —— redirect_uri 指向 zcode.z.ai 自己的
//      /api/v1/oauth/cli/callback/bigmodel，aih 靠 cli/poll 取结果。
//      用户看到的 `...?authCode=...&state=...` 是官方回调页，不是错误。
//   2. 真正的故障在收尾：createSessionFlowDriver 收到的 deps 只有「日志 + 收尾」
//      六件套，applyResult 里 deps.writeZcodeOauthCredentials 是 undefined →
//      TypeError → 定时器回调里的 unhandledRejection → 整个进程退出。
//
// 第一个用例从 createAuthJobManager 的真实入口跑到 applyResult：旧接线会在测试进程里
// 抛 unhandledRejection（用例红），新接线会把 credentials.json 写出来。
// 第二个用例守住「收尾异常不能逃出定时器」这条底线。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAuthJobManager, serializeAuthJob } = require('../lib/server/web-account-auth');
const { createSessionFlowDriver } = require('../lib/server/zcode-cli-login');
const { decryptZcodeCredentialValue } = require('../lib/account/zcode-credential');

function jsonResponse(payload, status = 200) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => payload
  };
}

function createFetchStub() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url || '');
    calls.push({ url: target, method: String(init.method || 'GET').toUpperCase() });
    if (target.endsWith('/api/v1/oauth/cli/init')) {
      const provider = JSON.parse(String(init.body || '{}')).provider === 'bigmodel' ? 'bigmodel' : 'zai';
      return jsonResponse({
        code: 0,
        data: {
          flow_id: `flow-${provider}-1`,
          authorize_url: provider === 'bigmodel'
            ? 'https://bigmodel.cn/login?appId=zcode&redirect=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fbigmodel&state=state-1'
            : 'https://chat.z.ai/api/oauth/authorize?client_id=client_x&redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fzai&state=state-1',
          expires_at: Math.floor(Date.now() / 1000) + 300,
          poll_interval_sec: 1
        }
      });
    }
    if (target.includes('/api/v1/oauth/cli/poll/')) {
      const provider = target.includes('flow-bigmodel') ? 'bigmodel' : 'zai';
      return jsonResponse({
        code: 0,
        data: {
          status: 'ready',
          token: 'zcode-jwt-1',
          [provider]: { access_token: `oauth-${provider}-1`, refresh_token: `refresh-${provider}-1` },
          user: { user_id: 'user-1', name: '测试账号' }
        }
      });
    }
    if (target === 'https://api.z.ai/api/auth/z/login') {
      return jsonResponse({ code: 200, success: true, data: { access_token: 'business-pat-1', expires_in: 3600 } });
    }
    // 项目定位键是附加产物：取不到就不写，登录照常成功。
    return jsonResponse({ code: 404, msg: 'not_found' }, 404);
  };
  return { fetchImpl, calls };
}

function createTempAiHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-cli-flow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function waitForTerminalJob(manager, jobId, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      const job = manager.getJob(jobId);
      if (job && job.status !== 'running') { resolve(job); return; }
      if (Date.now() - startedAt > timeoutMs) { reject(new Error(`job_timeout status=${job && job.status}`)); return; }
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('bigmodel cli-flow：poll 返回 ready 后必须写出 credentials.json，且不能把进程打挂', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { fetchImpl, calls } = createFetchStub();
  const manager = createAuthJobManager({
    fs,
    aiHomeDir,
    fetchImpl,
    // 只验证「写盘这一步拿到了依赖」：写盘后的账号状态识别在这里主动判失败，
    // 避免把测试耦合到账号入库（registerProviderAuthProjection）。
    verifyOauthJobCompleted: () => ({ ok: false, code: 'test_stop_after_write' }),
    onJobChanged: () => {},
    onOauthJobFinished: () => {}
  });

  const started = manager.startOauthJob('zcode', 'oauth-browser', {
    authStrategy: 'bigmodel:cli-flow',
    jobId: 'zcode-cli-flow-test'
  });
  assert.equal(started.authStrategy, 'bigmodel:cli-flow');

  const job = await waitForTerminalJob(manager, 'zcode-cli-flow-test');
  const credentialsPath = path.join(job.configDir, 'v2', 'credentials.json');

  // 前端靠这个标志隐藏「粘贴回调」入口：cli-flow 没有本机回调，
  // 旧界面却照样渲染输入框，用户才会以为「回调不到我们系统」。
  assert.equal(serializeAuthJob(job).sessionFlow, true);

  assert.match(String(job.logs || ''), /credentials\.json 已写入/, 'applyResult 必须真正跑到凭据写盘');
  assert.ok(fs.existsSync(credentialsPath), 'credentials.json 必须落在 job.configDir/v2 下');
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  assert.ok(Object.keys(credentials).some((key) => key === 'oauth:bigmodel:access_token'), '必须写 bigmodel 区域的 access_token 键');
  assert.ok(Object.keys(credentials).some((key) => key === 'zcodejwttoken'), '必须写 zcode JWT 键');

  // bigmodel **不做** z.ai 业务 token 换取（官方 CLI 同款：family === 'zai' 才换）。
  // 之前无条件换取 → 必然 code=500「z.ai用户信息异常」→ 日志误报「4 小时后要重新登录」。
  assert.equal(
    calls.filter((call) => call.url === 'https://api.z.ai/api/auth/z/login').length,
    0,
    'bigmodel 不应请求 z.ai 业务 token 端点'
  );
  assert.doesNotMatch(String(job.logs || ''), /业务 token 换取失败/);
  assert.match(String(job.logs || ''), /BigModel access_token \+ ZCode JWT/);
  // 落盘的必须是原始 access_token（没有被不存在的业务 token 覆盖）。
  assert.equal(decryptZcodeCredentialValue(credentials['oauth:bigmodel:access_token']), 'oauth-bigmodel-1');
  // user_info 必须是桌面端 `loadUserProfile` 认识的形状（id/username/displayName），
  // 不能是上游原样 `{user_id,name}`：bigmodel 没有旧格式兜底，原样写会让桌面端
  // 判定「未登录」，打开就要求重新登录（2026-11-03 真机）。
  const userInfo = JSON.parse(decryptZcodeCredentialValue(credentials['oauth:bigmodel:user_info']));
  assert.equal(userInfo.id, 'user-1');
  assert.equal(userInfo.username, '测试账号');
  assert.equal(userInfo.displayName, '测试账号');
  assert.equal(userInfo.rawProfile.zcodeProfileSchemaVersion, 2);

  assert.equal(job.status, 'failed');
  assert.match(String(job.error || ''), /test_stop_after_write/);
});

test('zai cli-flow：业务 token 换取仍然生效（bigmodel 的例外不能扩散到 zai）', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { fetchImpl, calls } = createFetchStub();
  const manager = createAuthJobManager({
    fs,
    aiHomeDir,
    fetchImpl,
    verifyOauthJobCompleted: () => ({ ok: false, code: 'test_stop_after_write' }),
    onJobChanged: () => {},
    onOauthJobFinished: () => {}
  });

  manager.startOauthJob('zcode', 'oauth-browser', {
    authStrategy: 'zai:cli-flow',
    jobId: 'zcode-zai-cli-flow-test'
  });
  const job = await waitForTerminalJob(manager, 'zcode-zai-cli-flow-test');
  const credentials = JSON.parse(fs.readFileSync(path.join(job.configDir, 'v2', 'credentials.json'), 'utf8'));

  assert.equal(
    calls.filter((call) => call.url === 'https://api.z.ai/api/auth/z/login').length,
    1,
    'zai 必须换一次业务 token'
  );
  assert.match(String(job.logs || ''), /业务 token（长期）/);
  assert.equal(decryptZcodeCredentialValue(credentials['oauth:zai:access_token']), 'business-pat-1');
  assert.equal(job.status, 'failed');
});

test('session 轮询驱动：applyResult 抛错必须收口成作业失败，不能逃成 unhandledRejection', async () => {
  let finalized = null;
  const driver = createSessionFlowDriver({
    appendJobLog: () => {},
    setAuthProgressState: () => {},
    finalizeJob: (job, status, message) => {
      job.status = status;
      job.error = message;
      finalized = { status, message };
    },
    notifyAuthJobChanged: () => {},
    states: {},
    fetchImpl: async () => jsonResponse({})
  });

  const job = {
    id: 'job-1',
    status: 'running',
    logs: '',
    pollIntervalMs: 1000,
    _cancelRequested: false
  };
  const strategy = {
    session: {
      begin: async () => ({
        authorizeUrl: 'https://bigmodel.cn/login?state=state-1',
        state: 'state-1',
        expiresAtMs: Date.now() + 60_000,
        pollIntervalMs: 1000
      }),
      poll: async () => ({ status: 'ready', tokenSet: {} })
    },
    applyResult: async () => {
      throw new Error('apply_result_boom');
    }
  };

  driver.begin(job, strategy);
  const startedAt = Date.now();
  while (!finalized && Date.now() - startedAt < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.ok(finalized, 'applyResult 抛错后必须调用 finalizeJob 收尾');
  assert.equal(finalized.status, 'failed');
  assert.match(finalized.message, /收尾失败/);
  assert.equal(job.status, 'failed');
});
