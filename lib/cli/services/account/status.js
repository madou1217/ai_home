'use strict';

const { readAgyAuthMetadata } = require('../../../account/agy-auth-metadata');
const { summarizeOpenCodeAuth } = require('../../../account/opencode-auth-metadata');
const { isQoderProvider, summarizeQoderAuth } = require('../../../account/qoder-auth-metadata');
const {
  readAccountCredentialRecord
} = require('../../../server/account-credential-store');
const { readAccountUsageSnapshot } = require('../../../account/usage-snapshot-store');
const { readClaudeOauthCredential } = require('../../../account/claude-credential');
const { readGrokAuthProfile } = require('../../../account/grok-auth-profile');
const { hasUsableKimiOAuth } = require('../../../account/kimi-auth');

function createAccountStatusChecker(deps = {}) {
  const { fs, BufferImpl, aiHomeDir } = deps;

  function hasNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function parseJwtPayload(token) {
    const text = hasNonEmptyString(token) ? token.trim() : '';
    if (!text) return null;
    const parts = text.split('.');
    if (parts.length < 2) return null;
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      const decoded = BufferImpl.from(`${normalized}${padding}`, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function readTokenFromEnvObject(envData, keys) {
    if (!envData || typeof envData !== 'object') return '';
    for (const key of keys) {
      const value = String(envData[key] || '').trim();
      if (value) return value;
    }
    return '';
  }

  function formatTokenAccountName(token) {
    const value = String(token || '').trim();
    if (value.length > 12) {
      return `Access Token: ${value.substring(0, 5)}...${value.substring(value.length - 4)}`;
    }
    return 'Access Token Configured';
  }

  return function checkStatus(cliName, accountRef) {
    let configured = false;
    let accountName = 'Unknown';

    try {
      // API-key / token accounts use app-state.db as their only credential source.
      const credentialRecord = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
      if (!credentialRecord || credentialRecord.provider !== cliName) {
        return { configured: false, accountName: 'Unknown' };
      }
      const dbCreds = credentialRecord && Object.keys(credentialRecord.env).length > 0
        ? credentialRecord.env
        : null;
      const nativeAuth = credentialRecord ? credentialRecord.nativeAuth : {};

      if (cliName === 'agy') {
        return readAgyAuthMetadata({ credentialRecord });
      }

      if (dbCreds) {
        configured = true;
        var credKeys = Object.keys(dbCreds);
        var foundKey = credKeys.find(function (k) {
          return k.indexOf('API_KEY') >= 0 || k.indexOf('AUTH_TOKEN') >= 0;
        });
        if (foundKey && dbCreds[foundKey]) {
          var rawToken = dbCreds[foundKey];
          var label = foundKey.indexOf('AUTH_TOKEN') >= 0 ? 'Auth Token' : 'API Key';
          accountName = rawToken.length > 10
            ? label + ': ' + rawToken.substring(0, 5) + '...' + rawToken.substring(rawToken.length - 4)
            : label + ' Configured';
        } else {
          accountName = 'DB Credential Configured';
        }
        return { configured, accountName, source: 'app-state.db' };
      }

      if (cliName === 'opencode') {
        const authStatus = summarizeOpenCodeAuth(nativeAuth.auth, {
          accountRef
        });
        if (authStatus.configured) {
          return {
            ...authStatus,
            source: 'app-state.db'
          };
        }
      }

      if (isQoderProvider(cliName)) {
        const envToken = dbCreds
          ? String(dbCreds.QODER_PERSONAL_ACCESS_TOKEN || '').trim()
          : '';
        const authStatus = summarizeQoderAuth(cliName, nativeAuth, { envToken });
        if (authStatus.configured) {
          return {
            ...authStatus,
            source: 'app-state.db'
          };
        }
      }

      if (cliName === 'kimi') {
        const credentials = nativeAuth.credentials && typeof nativeAuth.credentials === 'object'
          ? nativeAuth.credentials
          : {};
        // access_token 只有约 15 分钟寿命，过期即被刷新链路替换；只剩 refresh_token
        // 时守护进程照样能续期，所以这里与网关池的「双令牌齐备」判定（hasUsableKimiOAuth）
        // 刻意不同：refresh_token 单独存在也算已配置。
        configured = hasUsableKimiOAuth(credentials)
          || hasNonEmptyString(credentials.refresh_token)
          || hasNonEmptyString(credentials.refreshToken);
        if (configured) {
          accountName = hasNonEmptyString(credentials.email)
            ? credentials.email.trim()
            : 'Kimi Code OAuth';
        }
        return { configured, accountName, source: 'app-state.db' };
      }

      if (cliName === 'kiro') {
        const auth = nativeAuth.auth && typeof nativeAuth.auth === 'object'
          ? nativeAuth.auth
          : {};
        const userInfo = nativeAuth.userInfo && typeof nativeAuth.userInfo === 'object'
          ? nativeAuth.userInfo
          : {};
        configured = hasNonEmptyString(auth.access_token)
          || hasNonEmptyString(auth.refresh_token)
          || hasNonEmptyString(nativeAuth.database);
        if (configured) {
          accountName = hasNonEmptyString(userInfo.email)
            ? userInfo.email.trim()
            : 'Kiro (AWS Builder ID)';
        }
        return { configured, accountName, source: 'app-state.db' };
      }
      if (cliName === 'grok') {
        const auth = nativeAuth.auth && typeof nativeAuth.auth === 'object'
          ? nativeAuth.auth
          : {};
        const profile = readGrokAuthProfile(auth);
        configured = hasNonEmptyString(profile.accessToken) || hasNonEmptyString(profile.refreshToken);
        if (configured) {
          accountName = hasNonEmptyString(profile.email)
            ? profile.email
            : 'Grok OAuth';
        }
        return { configured, accountName, source: 'app-state.db' };
      }
      // Kimi OAuth credentials live in nativeAuth.credentials (the tokens
      // projected into .kimi-code/credentials/kimi-code.json). Missing this
      // branch once made every Kimi OAuth account fall through to
      // configured=false and the launcher falsely reported "no login state".
      // Access tokens expire within minutes, so a stored refresh token alone
      // still counts as logged in; never gate on token expiry here.
      if (cliName === 'kimi') {
        const credentials = nativeAuth.credentials && typeof nativeAuth.credentials === 'object'
          ? nativeAuth.credentials
          : {};
        const accessToken = hasNonEmptyString(credentials.access_token || credentials.accessToken)
          ? String(credentials.access_token || credentials.accessToken).trim()
          : '';
        configured = Boolean(accessToken)
          || hasNonEmptyString(credentials.refresh_token || credentials.refreshToken);
        if (configured) {
          // Derive a per-account label from the token subject: a constant
          // 'Kimi OAuth' would make distinct OAuth accounts look identical
          // (the same duplicate-name trap the claude branch avoids).
          const payload = accessToken ? parseJwtPayload(accessToken) : null;
          const subject = payload && hasNonEmptyString(payload.user_id || payload.sub)
            ? String(payload.user_id || payload.sub).trim()
            : '';
          accountName = subject
            ? `Kimi OAuth: ${subject.slice(0, 4)}...${subject.slice(-4)}`
            : 'Kimi OAuth';
        }
        return { configured, accountName, source: 'app-state.db' };
      }
      if (cliName === 'gemini') {
        const oauth = nativeAuth.oauthCreds;
        const hasOauthToken = !!(
          oauth
          && (
            hasNonEmptyString(oauth.access_token)
            || hasNonEmptyString(oauth.refresh_token)
          )
        );
        if (hasOauthToken) {
          configured = true;
        }

        const data = nativeAuth.googleAccounts;
        if (data && hasNonEmptyString(data.active)) {
          accountName = data.active.trim();
          configured = true;
        }
      } else if (cliName === 'codex') {
        const data = nativeAuth.auth;
        const tokens = data && data.tokens && typeof data.tokens === 'object' ? data.tokens : null;
        const hasAccess = !!(tokens && hasNonEmptyString(tokens.access_token));
        const hasIdToken = !!(tokens && hasNonEmptyString(tokens.id_token));
        configured = hasAccess;

        const idTokenPayload = hasIdToken ? parseJwtPayload(tokens.id_token) : null;
        const accessTokenPayload = hasAccess ? parseJwtPayload(tokens.access_token) : null;
        const profileClaim = accessTokenPayload && accessTokenPayload['https://api.openai.com/profile'];
        if (idTokenPayload && hasNonEmptyString(idTokenPayload.email)) {
          accountName = idTokenPayload.email.trim();
        } else if (profileClaim && hasNonEmptyString(profileClaim.email)) {
          accountName = profileClaim.email.trim();
        }
      } else if (cliName === 'claude') {
        const oauthCredential = readClaudeOauthCredential(nativeAuth, { nowMs: deps.nowMs });
        const { oauth, accessToken } = oauthCredential;
        configured = oauthCredential.configured;
        if (configured) {
          // 优先用真实身份（邮箱 / 账号 UUID），否则退回 token 指纹——绝不能用恒定的
          // 'OAuth Configured'，否则所有 Claude OAuth 账号同名、被误判为重复账号。
          const accountInfo = oauth && (oauth.account || oauth.account_info);
          // The OAuth blob carries no identity; the usage probe stores the email
          // from /api/oauth/profile into the snapshot cache, so prefer that.
          const usageCache = readAccountUsageSnapshot(fs, aiHomeDir, accountRef);
          const cachedAccount = usageCache && usageCache.account && typeof usageCache.account === 'object'
            ? usageCache.account
            : null;
          const cachedEmail = cachedAccount && (cachedAccount.email || cachedAccount.fullName);
          const email = (accountInfo && (accountInfo.emailAddress || accountInfo.email_address || accountInfo.email))
            || cachedEmail;
          const uuid = accountInfo && (accountInfo.uuid || accountInfo.account_uuid);
          if (hasNonEmptyString(email)) {
            accountName = String(email).trim();
          } else if (hasNonEmptyString(uuid)) {
            accountName = `Claude ${String(uuid).trim().slice(0, 8)}`;
          } else {
            accountName = formatTokenAccountName(accessToken || (oauth && (oauth.refreshToken || oauth.refresh_token)));
          }
        }
      }
    } catch (_error) {
      // ignore
    }

    return { configured, accountName };
  };
}

module.exports = {
  createAccountStatusChecker
};
