'use strict';

// 回归守卫（2026-10-30 真机）：codebuddy 登录作业在 20:18:40 起来、20:23:49 被判 expired，
// 正好卡在 5 分钟的兜底 TTL 上。浏览器登录的耗时在人身上（注册、收邮箱验证码、设密码），
// 5 分钟不够用；作业一过期 CLI 就被收掉，网页那边登录成功了也没东西能接住。
//
// 现在交互式浏览器登录走独立的长窗口，其余认证方式仍走 5 分钟兜底。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OAUTH_BROWSER_JOB_TTL_MS,
  OAUTH_PENDING_FALLBACK_STALE_MS,
  resolveOauthJobDeadline
} = require('../lib/server/oauth-pending-state');

const CREATED_AT = 1_700_000_000_000;

test('交互式浏览器登录的作业窗口长于 5 分钟兜底', () => {
  assert.ok(OAUTH_BROWSER_JOB_TTL_MS > OAUTH_PENDING_FALLBACK_STALE_MS);
  const job = { authMode: 'oauth-browser', createdAt: CREATED_AT };
  assert.equal(resolveOauthJobDeadline(job), CREATED_AT + OAUTH_BROWSER_JOB_TTL_MS);
  // 真机那次的时间点：作业起来 5 分钟后已经过期，现在必须还活着。
  const fiveMinutesLater = CREATED_AT + OAUTH_PENDING_FALLBACK_STALE_MS + 1000;
  assert.ok(resolveOauthJobDeadline(job) > fiveMinutesLater);
});

test('设备码/其它认证方式仍走 5 分钟兜底', () => {
  for (const authMode of ['oauth-device', 'oauth', '', undefined]) {
    const job = { authMode, createdAt: CREATED_AT };
    assert.equal(
      resolveOauthJobDeadline(job),
      CREATED_AT + OAUTH_PENDING_FALLBACK_STALE_MS,
      `authMode=${String(authMode)} 不应被延长`
    );
  }
});

test('显式 expiresAt 优先；显式 staleMs 覆盖默认窗口', () => {
  const explicit = { authMode: 'oauth-browser', createdAt: CREATED_AT, expiresAt: CREATED_AT + 1000 };
  assert.equal(resolveOauthJobDeadline(explicit), CREATED_AT + 1000);

  const overridden = { authMode: 'oauth-browser', createdAt: CREATED_AT };
  assert.equal(resolveOauthJobDeadline(overridden, 60_000), CREATED_AT + 60_000);

  assert.equal(resolveOauthJobDeadline(null), 0);
  assert.equal(resolveOauthJobDeadline({ authMode: 'oauth-browser' }), 0);
});
