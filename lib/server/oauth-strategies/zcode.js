'use strict';

const { createNativeOauthStrategy } = require('./native-oauth');
const { beginZcodeCliLogin, pollZcodeCliLogin } = require('../zcode-cli-login');
const { ZCODE_OAUTH_CLIENT_ID } = require('../web-account-auth-oauth-urls');

// ZCode 登录有两条**都受上游支持**的路径，区别只在 redirect_uri：
//
//   ① 服务端中介流程（ZCODE_STRATEGY，默认）
//      cli/init 拿官方 authorize_url（redirect_uri 指向 zcode.z.ai 自己的
//      /api/v1/oauth/cli/callback/<provider>），aih 轮询 cli/poll 取回 token。
//      不注册任何本地地址、不需要协议处理器、也不需要本机浏览器 —— 异地/手机授权同样成立。
//
//   ② `zcode://oauth/callback`（ZCODE_SCHEME_STRATEGY）
//      该 client 注册的自定义协议，官方桌面端在用。不经 loopback，浏览器跳转后
//      页面没有反应 —— 用户要把地址栏里的完整回调地址（或 `code#state`）粘贴回来。
//      代价：必须在用户机器注册 zcode:// 的协议处理器，且会与 ZCode Desktop 抢 scheme。
//
// **loopback 不是选项**：Z.ai 收紧了该 client 的 redirect_uri 白名单，任何
// `http://localhost:…` 都会被拒（登录后显示 "Redirect URI not registered for this client"）。
//
// 两条路径的差异收敛成描述符字段，job 管理器里没有 provider 名分支：
//   session.begin / session.poll / applyResult  —— 服务端中介流程的三段协议；
//   manualCallbackOnly + exchangeDep            —— 自定义协议的手填回调路径。
// 区域（zai / bigmodel）由 lib/server/zcode-region.js 决定，与选哪条路径无关。

// 授权入口的镜像域名覆盖：上游 cli/init 不接受区域参数（实测 site/region/origin 都被忽略），
// 所以「把授权页指到 zchat.z.ai」只能在客户端改写 origin。默认空 = 用上游给的原值。
function resolveAuthorizeOrigin(job, deps) {
  if (job && job.zcodeAuthorizeOrigin) return String(job.zcodeAuthorizeOrigin).trim();
  return typeof deps.getZcodeAuthorizeOrigin === 'function'
    ? String(deps.getZcodeAuthorizeOrigin(job) || '').trim()
    : '';
}

function resolveRegionProvider(job, deps) {
  if (typeof deps.getZcodeRegion === 'function') return deps.getZcodeRegion(job);
  return job && job.zcodeRegion;
}

const ZCODE_STRATEGY = createNativeOauthStrategy({
  logLabel: 'ZCode',
  session: {
    begin: ({ job, deps }) => beginZcodeCliLogin({
      request: deps.fetchImpl,
      provider: resolveRegionProvider(job, deps),
      authorizeOrigin: resolveAuthorizeOrigin(job, deps)
    }),
    poll: ({ flow, deps }) => pollZcodeCliLogin(flow, { request: deps.fetchImpl })
  },
  applyResult: ({ job, result, deps }) => deps.writeZcodeOauthCredentials(job, result)
});

// 自定义协议路径：固定用官方注册的 zcode:// 回调，由用户手填回调地址换 code。
const ZCODE_SCHEME_STRATEGY = createNativeOauthStrategy({
  logLabel: 'ZCode（zcode:// 回调）',
  loopbackRedirectUri: 'zcode://oauth/callback',
  manualCallbackOnly: true,
  exchangeDep: 'exchangeZcodeOauthCode',
  buildAuthorizationUrl: ({ redirectUri, state }) => {
    const url = new URL('https://chat.z.ai/api/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', ZCODE_OAUTH_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }
});

// 与 agy 的 AGY_STRATEGIES 同一形态：多策略 provider 用「名字 → 策略」的表，
// 由 resolveLoginStrategy(provider, strategy) 按名取；未知名回落 default。
const ZCODE_STRATEGIES = Object.freeze({
  'cli-flow': ZCODE_STRATEGY,
  'custom-scheme': ZCODE_SCHEME_STRATEGY,
  default: ZCODE_STRATEGY
});

module.exports = {
  ZCODE_STRATEGIES,
  ZCODE_STRATEGY,
  ZCODE_SCHEME_STRATEGY
};
