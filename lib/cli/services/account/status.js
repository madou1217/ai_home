'use strict';

const { readAgyAuthMetadata } = require('../../../account/agy-auth-metadata');

function createAccountStatusChecker(deps = {}) {
  const { fs, path, BufferImpl, cliConfigs } = deps;

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

  function readJsonFileSafe(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function readProfileEnvToken(envPath, keys) {
    const envData = readJsonFileSafe(envPath);
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

  return function checkStatus(cliName, profileDir) {
    let configured = false;
    let accountName = 'Unknown';

    try {
      const envPath = path.join(profileDir, '.aih_env.json');
      if (cliName === 'agy') {
        const token = readProfileEnvToken(envPath, ['AGY_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']);
        if (token) {
          const logStatus = readAgyAuthMetadata(fs, path, profileDir);
          return {
            configured: true,
            accountName: logStatus.configured && logStatus.accountName !== 'Unknown'
              ? logStatus.accountName
              : formatTokenAccountName(token),
            authMode: logStatus.authMode || 'access-token',
            source: logStatus.source || envPath
          };
        }
        return readAgyAuthMetadata(fs, path, profileDir);
      }

      if (fs.existsSync(envPath)) {
        configured = true;
        try {
          const envData = JSON.parse(fs.readFileSync(envPath, 'utf8'));
          const keyField = Object.keys(envData).find((k) => k.includes('API_KEY'));
          if (keyField && envData[keyField]) {
            const k = envData[keyField];
            if (k.length > 10) {
              accountName = `API Key: ${k.substring(0, 5)}...${k.substring(k.length - 4)}`;
            } else {
              accountName = 'API Key Configured';
            }
          } else {
            accountName = 'API Key Configured';
          }
        } catch (_error) {
          accountName = 'API Key Configured';
        }
        return { configured, accountName };
      }

      const hiddenDir = cliConfigs[cliName] ? cliConfigs[cliName].globalDir : `.${cliName}`;
      const p = path.join(profileDir, hiddenDir);
      if (!fs.existsSync(p)) {
        return { configured, accountName };
      }

      if (cliName === 'gemini') {
        const oauthPath = path.join(p, 'oauth_creds.json');
        const oauth = readJsonFileSafe(oauthPath);
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

        const accPath = path.join(p, 'google_accounts.json');
        const data = readJsonFileSafe(accPath);
        if (data && hasNonEmptyString(data.active)) {
          accountName = data.active.trim();
          configured = true;
        }
      } else if (cliName === 'codex') {
        const authPath = path.join(p, 'auth.json');
        const data = readJsonFileSafe(authPath);
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
        const credentialsPath = path.join(p, '.credentials.json');
        const credentials = readJsonFileSafe(credentialsPath);
        const oauth = credentials && (credentials.claudeAiOauth || credentials.claude_ai_oauth);
        const hasOauthToken = !!(
          oauth
          && (
            hasNonEmptyString(oauth.accessToken)
            || hasNonEmptyString(oauth.access_token)
          )
        );
        const settingsPath = path.join(p, 'settings.json');
        const settings = readJsonFileSafe(settingsPath);
        const settingsToken = settings && settings.env && hasNonEmptyString(settings.env.ANTHROPIC_AUTH_TOKEN)
          ? settings.env.ANTHROPIC_AUTH_TOKEN.trim()
          : '';
        configured = hasOauthToken || !!settingsToken;
        if (hasOauthToken) {
          accountName = 'OAuth Configured';
        } else if (settingsToken) {
          accountName = 'Token Configured';
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
