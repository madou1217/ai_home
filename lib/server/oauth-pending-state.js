'use strict';

const OAUTH_PENDING_FALLBACK_STALE_MS = 5 * 60 * 1000;

// 交互式浏览器登录（oauth-browser）的作业存活窗口。
// 5 分钟的兜底 TTL 是给「机器自己跑完」的流程用的；浏览器登录的耗时在人身上：
// 2026-10-30 实测一次 codebuddy 登录作业，CLI 在 20:18:40 起来、20:23:49 被判 expired，
// 而人在网页上注册（收邮箱验证码、设密码）根本来不及 —— 作业一过期，CLI 进程就被收掉，
// 网页那边登录成功了也没有任何东西能接住。这里给交互式登录一条独立的长窗口。
const OAUTH_BROWSER_JOB_TTL_MS = 20 * 60 * 1000;

function normalizeAuthMode(value) {
  return String(value || '').trim().toLowerCase();
}

function isOauthAuthMode(value) {
  const authMode = normalizeAuthMode(value);
  return authMode === 'oauth'
    || authMode === 'oauth-browser'
    || authMode === 'oauth-device'
    || authMode === 'device'
    || authMode === 'device-code';
}

function resolveOauthPendingState(values = {}) {
  const configured = Boolean(values.configured);
  const apiKeyMode = Boolean(values.apiKeyMode);
  const authMode = normalizeAuthMode(values.authMode);
  const pending = Boolean(!configured && !apiKeyMode && isOauthAuthMode(authMode));
  if (!pending) {
    return {
      pending: false,
      stale: false,
      ageMs: 0,
      staleMs: OAUTH_PENDING_FALLBACK_STALE_MS
    };
  }

  const nowMs = Number.isFinite(values.nowMs) ? values.nowMs : Date.now();
  const updatedAt = Number(values.updatedAt) || 0;
  const staleMs = Number.isFinite(values.staleMs) && values.staleMs > 0
    ? values.staleMs
    : OAUTH_PENDING_FALLBACK_STALE_MS;
  const ageMs = updatedAt > 0 ? Math.max(0, nowMs - updatedAt) : staleMs;

  return {
    pending: true,
    stale: ageMs >= staleMs,
    ageMs,
    staleMs
  };
}

/**
 * 作业截止时间。调用方显式给 staleMs 就用它；没给则按认证方式选默认窗口：
 * 交互式浏览器登录用人身耗时的窗口，其余仍走 5 分钟兜底。
 */
function resolveOauthJobDeadline(job, staleMs) {
  if (!job) return 0;
  const expiresAt = Number(job.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt;
  const createdAt = Number(job.createdAt) || 0;
  if (!createdAt) return 0;
  const fallbackTtl = normalizeAuthMode(job.authMode) === 'oauth-browser'
    ? OAUTH_BROWSER_JOB_TTL_MS
    : OAUTH_PENDING_FALLBACK_STALE_MS;
  const ttl = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : fallbackTtl;
  return createdAt + ttl;
}

module.exports = {
  OAUTH_BROWSER_JOB_TTL_MS,
  OAUTH_PENDING_FALLBACK_STALE_MS,
  isOauthAuthMode,
  resolveOauthPendingState,
  resolveOauthJobDeadline
};
