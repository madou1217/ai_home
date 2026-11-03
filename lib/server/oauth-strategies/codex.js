'use strict';

const { createNativeOauthStrategy } = require('./native-oauth');

const CODEX_STRATEGY = createNativeOauthStrategy(
  {
    logLabel: 'Codex',
    loopbackRedirectUri: 'http://localhost:1455/auth/callback',
    exchangeDep: 'exchangeManualCallbackCodexCode',
    buildAuthorizationUrl: ({ redirectUri, codeChallenge, state, deps }) =>
      deps.buildCodexAuthorizationUrl({ redirectUri, codeChallenge, state })
  },
  {
    // Codex device-code login (oauth-device) still spawns the CLI and needs its
    // sqlite home pointed at the sandbox; browser login never reaches prepareLogin.
    prepareLogin({ profileDir, envOverrides, deps }) {
      if (!deps.resolveCodexSqliteHome) return;
      const sqliteHome = deps.resolveCodexSqliteHome({
        path: deps.path,
        aiHomeDir: deps.aiHomeDir
      });
      if (sqliteHome) envOverrides.CODEX_SQLITE_HOME = sqliteHome;
    },

    buildLoginArgs({ authMode, baseArgs }) {
      const args = Array.isArray(baseArgs) ? baseArgs.slice() : [];
      if (authMode === 'oauth-device' && !args.includes('--device-auth')) {
        args.push('--device-auth');
      }
      return args;
    }
  }
);

module.exports = {
  CODEX_STRATEGY
};
