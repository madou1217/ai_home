'use strict';

const { createNativeOauthStrategy } = require('./native-oauth');

const CLAUDE_STRATEGY = createNativeOauthStrategy({
  logLabel: 'Claude',
  // Claude accepts any localhost loopback redirect; a fixed high port keeps the
  // server stable and distinct from codex's 1455.
  loopbackRedirectUri: 'http://localhost:54545/callback',
  exchangeDep: 'exchangeClaudeOauthCode',
  buildAuthorizationUrl: ({ redirectUri, codeChallenge, state, deps }) =>
    deps.buildClaudeAuthorizationUrl({ redirectUri, codeChallenge, state })
});

module.exports = {
  CLAUDE_STRATEGY
};
