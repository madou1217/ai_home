'use strict';

function createAccountStatusChecker(deps = {}) {
  const { fs, path, BufferImpl, cliConfigs } = deps;

  function readJsonFileSafe(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  return function checkStatus(cliName, profileDir) {
    let configured = false;
    let accountName = 'Unknown';

    try {
      const envPath = path.join(profileDir, '.aih_env.json');
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

      if (fs.existsSync(p)) {
        const files = fs.readdirSync(p);
        if (files.length > 0) {
          configured = true;
        }

        if (cliName === 'gemini') {
          const accPath = path.join(p, 'google_accounts.json');
          if (fs.existsSync(accPath)) {
            const data = JSON.parse(fs.readFileSync(accPath, 'utf8'));
            if (data.active) accountName = data.active;
          }
        } else if (cliName === 'codex') {
          const authPath = path.join(p, 'auth.json');
          if (fs.existsSync(authPath)) {
            const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            const tokens = data && data.tokens && typeof data.tokens === 'object' ? data.tokens : null;
            const hasAccess = !!(tokens && typeof tokens.access_token === 'string' && tokens.access_token.trim());
            const hasIdToken = !!(tokens && typeof tokens.id_token === 'string' && tokens.id_token.trim());
            configured = hasAccess || hasIdToken;
            if (hasIdToken) {
              try {
                const payload = data.tokens.id_token.split('.')[1];
                const decoded = BufferImpl.from(payload, 'base64').toString('utf8');
                const jwtData = JSON.parse(decoded);
                if (jwtData.email) accountName = jwtData.email;
              } catch (_error) {}
            }
          } else {
            configured = false;
          }
        } else if (cliName === 'claude') {
          const credentialsPath = path.join(p, '.credentials.json');
          const credentials = readJsonFileSafe(credentialsPath);
          const oauth = credentials && (credentials.claudeAiOauth || credentials.claude_ai_oauth);
          const hasOauthToken = !!(oauth && (oauth.accessToken || oauth.access_token));
          const settingsPath = path.join(p, 'settings.json');
          const settings = readJsonFileSafe(settingsPath);
          const settingsToken = settings && settings.env && typeof settings.env.ANTHROPIC_AUTH_TOKEN === 'string'
            ? settings.env.ANTHROPIC_AUTH_TOKEN.trim()
            : '';
          if (hasOauthToken) {
            accountName = 'OAuth Configured';
          } else if (settingsToken) {
            accountName = 'Token Configured';
          } else if (fs.existsSync(settingsPath)) {
            accountName = 'Config Present';
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
