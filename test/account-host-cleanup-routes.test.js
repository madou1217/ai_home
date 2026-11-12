'use strict';

// /v0/management/internal/account-host-cleanup 的鉴权与响应合同。
//
// 这道门只允许回环 + （Node Management Key 或 Go Core 引导密钥）：Go 删除事务
// 用自己的引导密钥回调，远端即使拿到其中一把也不能让本机杀会话。清理语义本身
// 由 account-host-cleanup.test.js 覆盖，这里只验证「谁能进、进来后返回什么」。

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { handleAccountHostCleanupRequest, ACCOUNT_HOST_CLEANUP_PATH } = require('../lib/server/account-host-cleanup-routes');

const MANAGEMENT_KEY = 'node-management-key';
const GO_CORE_KEY = 'go-core-bootstrap-key';
const ACCOUNT_REF = 'acct_0123456789abcdef0123';

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createContext(options = {}) {
  const writes = [];
  const body = options.body === undefined
    ? { provider: 'codebuddy', accountRef: ACCOUNT_REF, phase: 'verify' }
    : options.body;
  const headers = options.authorization === null
    ? {}
    : { authorization: `Bearer ${options.authorization === undefined ? MANAGEMENT_KEY : options.authorization}` };
  return {
    writes,
    ctx: {
      method: options.method || 'POST',
      pathname: options.pathname || ACCOUNT_HOST_CLEANUP_PATH,
      req: Object.assign(Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), {
        url: options.pathname || ACCOUNT_HOST_CLEANUP_PATH,
        headers,
        socket: { remoteAddress: options.remoteAddress || '127.0.0.1' }
      }),
      res: {},
      requiredManagementKey: options.requiredManagementKey === undefined
        ? MANAGEMENT_KEY
        : options.requiredManagementKey,
      aiHomeDir: '/tmp/aih-home',
      deps: {
        writeJson: (_res, status, payload) => writes.push({ status, payload }),
        readRequestBody,
        goCoreManagementKey: options.goCoreManagementKey
          || (() => GO_CORE_KEY),
        // 默认注入桩，别让路由测试碰到本机真实 tmux。
        accountHostCleanupService: options.service || createService()
      }
    }
  };
}

function createService(overrides = {}) {
  return {
    verify: overrides.verify || (() => ({ ok: true, provider: 'codebuddy', accountRef: ACCOUNT_REF, blockers: [], reaped: 0, sockets: [] })),
    cleanup: overrides.cleanup || (() => ({ ok: true, provider: 'codebuddy', accountRef: ACCOUNT_REF, results: [] }))
  };
}

const verifyBlockedError = () => {
  const error = new Error('无法确认宿主会话已经退出');
  error.code = 'account_host_state_unknown';
  return error;
};

test('非回环对端直接 403，连密钥都不看', async () => {
  const { writes, ctx } = createContext({ remoteAddress: '10.0.0.8' });
  assert.equal(await handleAccountHostCleanupRequest(ctx), true);
  assert.equal(writes[0].status, 403);
  assert.equal(writes[0].payload.error, 'account_host_cleanup_loopback_required');
});

test('回环但密钥不对：401', async () => {
  const { writes, ctx } = createContext({ authorization: 'wrong-key' });
  assert.equal(await handleAccountHostCleanupRequest(ctx), true);
  assert.equal(writes[0].status, 401);
});

test('Go Core 引导密钥在回环上可用（与 Server 的 Key 不是同一把）', async () => {
  const { writes, ctx } = createContext({ authorization: GO_CORE_KEY });
  assert.equal(await handleAccountHostCleanupRequest(ctx), true);
  assert.equal(writes[0].status, 200);
  assert.equal(writes[0].payload.ok, true);
  // 字段名是 Go 适配器 accounthostcleanup 的解码合同，改名会让宿主清理静默失效。
  assert.deepEqual(
    Object.keys(writes[0].payload).sort(),
    ['accountRef', 'ok', 'phase', 'provider', 'reaped', 'sockets']
  );
});

test('cleanup 响应字段与 Go 解码合同一致', async () => {
  const { writes, ctx } = createContext({
    body: { provider: 'workbuddycn', accountRef: ACCOUNT_REF, phase: 'cleanup' },
    service: createService({
      cleanup: () => ({
        ok: true,
        provider: 'workbuddycn',
        accountRef: ACCOUNT_REF,
        results: [{ socket: 'aih-workbuddycn-' + ACCOUNT_REF, action: 'killed', sessions: ['s-main'], removed: 1 }]
      })
    })
  });
  assert.equal(await handleAccountHostCleanupRequest(ctx), true);
  assert.equal(writes[0].status, 200);
  assert.deepEqual(
    Object.keys(writes[0].payload).sort(),
    ['accountRef', 'degraded', 'ok', 'phase', 'provider', 'results']
  );
});

test('phase 非法：400', async () => {
  const { writes, ctx } = createContext({ body: { provider: 'codebuddy', accountRef: ACCOUNT_REF, phase: 'drop' } });
  assert.equal(await handleAccountHostCleanupRequest(ctx), true);
  assert.equal(writes[0].status, 400);
  assert.equal(writes[0].payload.error, 'invalid_phase');
});

test('非本路径不拦截', async () => {
  const { ctx } = createContext({ pathname: '/v0/management/accounts' });
  assert.equal(await handleAccountHostCleanupRequest(ctx), false);
});

test('verify 发现活会话：409 + occupants', async () => {
  const { writes, ctx } = createContext({
    service: createService({
      verify: () => ({
        ok: false,
        provider: 'codebuddy',
        accountRef: ACCOUNT_REF,
        reaped: 0,
        sockets: ['aih-codebuddy-' + ACCOUNT_REF],
        blockers: [{ kind: 'persistent_session', session: 's-main', socket: 'aih-codebuddy-' + ACCOUNT_REF }]
      })
    })
  });
  assert.equal(await handleAccountHostCleanupRequest(ctx), true);
  assert.equal(writes[0].status, 409);
  assert.equal(writes[0].payload.error, 'account_runtime_active');
  assert.equal(writes[0].payload.blockers.length, 1);
});

test('verify 探测不确定：503（不是 409）', async () => {
  const { writes, ctx } = createContext({
    service: createService({ verify: () => { throw verifyBlockedError(); } })
  });
  assert.equal(await handleAccountHostCleanupRequest(ctx), true);
  assert.equal(writes[0].status, 503);
  assert.equal(writes[0].payload.error, 'account_host_state_unknown');
});

test('cleanup 没收干净：200 + degraded，账号事实不会因此被判失败', async () => {
  const { writes, ctx } = createContext({
    body: { provider: 'codebuddy', accountRef: ACCOUNT_REF, phase: 'cleanup' },
    service: createService({
      cleanup: () => ({
        ok: false,
        provider: 'codebuddy',
        accountRef: ACCOUNT_REF,
        results: [{ socket: 'aih-codebuddy-' + ACCOUNT_REF, action: 'kill_failed', sessions: ['s-main'], removed: 0 }]
      })
    })
  });
  assert.equal(await handleAccountHostCleanupRequest(ctx), true);
  assert.equal(writes[0].status, 200);
  assert.equal(writes[0].payload.degraded, true);
  assert.equal(writes[0].payload.results[0].action, 'kill_failed');
});

test('cleanup 收干净：200 + degraded=false', async () => {
  const { writes, ctx } = createContext({
    body: { provider: 'codebuddy', accountRef: ACCOUNT_REF, phase: 'cleanup' },
    service: createService()
  });
  assert.equal(await handleAccountHostCleanupRequest(ctx), true);
  assert.equal(writes[0].status, 200);
  assert.equal(writes[0].payload.degraded, false);
});

test('GET 只回 405', async () => {
  const { writes, ctx } = createContext({ method: 'GET' });
  assert.equal(await handleAccountHostCleanupRequest(ctx), true);
  assert.equal(writes[0].status, 405);
});
