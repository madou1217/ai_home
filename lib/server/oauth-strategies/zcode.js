'use strict';

const { createNativeOauthStrategy } = require('./native-oauth');

// ZCode 没有面向用户的 CLI/TUI；aih 驱动 ZCode Desktop 的 OAuth flow —
// chat.z.ai authorize accepts a loopback redirect_uri, which gives same-machine
// auto-capture plus the paste fallback.
// No PKCE: the desktop client sends only redirect_uri/response_type/client_id/state.
const ZCODE_STRATEGY = createNativeOauthStrategy({
  logLabel: 'ZCode',
  loopbackRedirectUri: 'http://localhost:18653/oauth/callback',
  exchangeDep: 'exchangeZcodeOauthCode',
  buildAuthorizationUrl: ({ redirectUri, state, deps }) =>
    deps.buildZcodeAuthorizationUrl({ redirectUri, state })
});

module.exports = {
  ZCODE_STRATEGY
};
