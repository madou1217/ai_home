'use strict';

const { DEFAULT_STRATEGY } = require('./base');

/**
 * createNativeOauthStrategy: aih builds the authorization URL, runs its own
 * loopback server, and exchanges the code itself. On the same machine the
 * browser hits the loopback and it auto-completes; remote sessions paste the
 * callback URL, which aih forwards to that server. Used by Codex, Claude, ZCode.
 */
function createNativeOauthStrategy(nativeOauth, extra = {}) {
  return {
    nativeOauth,
    prepareLogin: extra.prepareLogin || DEFAULT_STRATEGY.prepareLogin,
    buildLoginArgs: extra.buildLoginArgs || DEFAULT_STRATEGY.buildLoginArgs,
    updateProgress: extra.updateProgress || DEFAULT_STRATEGY.updateProgress,

    async submitCallback({ job, rawInput, deps }) {
      if (!job._manualCallbackOauth) {
        return { ok: false, code: 'callback_not_supported', job };
      }
      deps.appendJobLog(job, '收到浏览器 OAuth 回调提交。');
      const pasted = deps.parseBrowserCallbackInput(rawInput, job.redirectUri);
      if (!pasted) {
        deps.appendJobLog(job, '回调地址解析失败。');
        return { ok: false, code: 'invalid_callback_url', job };
      }
      if (!deps.isSameCallbackEndpoint(pasted, job.redirectUri)) {
        deps.appendJobLog(job, '回调地址 endpoint 与当前授权任务不一致。');
        return { ok: false, code: 'invalid_callback_redirect', job };
      }
      const state = String(pasted.searchParams.get('state') || '');
      if (job.oauthState && state !== job.oauthState) {
        deps.appendJobLog(job, '回调 state 校验失败。');
        return { ok: false, code: 'invalid_callback_state', job };
      }
      deps.appendJobLog(job, '回调 state 校验通过。');
      const errorParam = deps.normalizeString(
        pasted.searchParams.get('error') || pasted.searchParams.get('error_description')
      );
      if (errorParam) {
        job.error = errorParam;
        deps.appendJobLog(job, `OAuth provider 返回错误：${deps.compactLogText(errorParam)}`);
        deps.finalizeJob(job, 'failed', errorParam, 1);
        return { ok: false, code: 'oauth_provider_error', job };
      }
      if (!deps.normalizeString(pasted.searchParams.get('code'))) {
        deps.appendJobLog(job, '回调缺少 code 参数。');
      }
      return deps[nativeOauth.exchangeDep](job, pasted.searchParams.get('code'), job.redirectUri);
    }
  };
}

module.exports = {
  createNativeOauthStrategy
};
