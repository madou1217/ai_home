'use strict';

const path = require('node:path');

const AUTH_SUCCESS_PATTERNS = [
  /OAuth:\s*authenticated successfully as\s+([^\s,]+)/i,
  /applyAuthResult:\s*email=([^\s,]+).*?\bauthMethod=([^\s,)]+)/i
];

function parseIsoTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const epochMs = Date.parse(text);
  return Number.isFinite(epochMs) && epochMs > 0 ? epochMs : null;
}

function readAgyOAuthTokenSnapshot(fs, pathImpl, configDir) {
  const tokenPath = pathImpl.join(configDir, 'antigravity-oauth-token');
  if (!fs.existsSync(tokenPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    const token = data && data.token && typeof data.token === 'object'
      ? data.token
      : {};
    const accessToken = String(token.access_token || '').trim();
    const refreshToken = String(token.refresh_token || '').trim();
    if (!accessToken && !refreshToken) return null;
    return {
      source: tokenPath,
      authMode: String(data.auth_method || 'oauth').trim() || 'oauth',
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      tokenExpiresAt: parseIsoTimestampMs(token.expiry),
      tokenExpiry: String(token.expiry || '').trim()
    };
  } catch (_error) {
    return null;
  }
}

function isAgyAccessTokenFresh(metadata, nowMs = Date.now(), skewMs = 0) {
  const expiresAt = Number(metadata && metadata.tokenExpiresAt);
  return Boolean(
    metadata
    && metadata.hasAccessToken
    && Number.isFinite(expiresAt)
    && expiresAt > nowMs + Math.max(0, Number(skewMs) || 0)
  );
}

function hasRecoverableAgyOAuthCredentials(metadata, nowMs = Date.now()) {
  return Boolean(
    metadata
    && (
      isAgyAccessTokenFresh(metadata, nowMs)
      || metadata.hasRefreshToken
    )
  );
}

function extractEmailFromCliLog(fs, pathImpl, configDir, profileDir) {
  // 1. Try reading the email.cache first
  const cachePath = pathImpl.join(configDir, 'email.cache');
  if (fs.existsSync(cachePath)) {
    try {
      const cachedEmail = fs.readFileSync(cachePath, 'utf8').trim();
      if (cachedEmail && cachedEmail.includes('@')) {
        return cachedEmail;
      }
    } catch (_e) {}
  }

  // 2. Try parsing from the symlinked cli.log
  const cliLogPath = pathImpl.join(configDir, 'cli.log');
  if (fs.existsSync(cliLogPath)) {
    try {
      const content = fs.readFileSync(cliLogPath, 'utf8');
      for (const pattern of AUTH_SUCCESS_PATTERNS) {
        const match = content.match(pattern);
        if (match && match[1]) {
          const email = String(match[1]).trim();
          if (email && email.includes('@')) {
            try {
              fs.writeFileSync(cachePath, email, 'utf8');
            } catch (_e) {}
            return email;
          }
        }
      }
    } catch (_e) {}
  }

  // 3. Scan all log files in the log directory
  const logDir = pathImpl.join(configDir, 'log');
  if (fs.existsSync(logDir)) {
    try {
      const files = fs.readdirSync(logDir)
        .filter((f) => f.startsWith('cli-') && f.endsWith('.log'));

      // Sort files by mtime (newest first)
      const filesWithTime = files.map((f) => {
        const fp = pathImpl.join(logDir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(fp).mtimeMs;
        } catch (_err) {}
        return { name: f, path: fp, mtime };
      });
      filesWithTime.sort((a, b) => b.mtime - a.mtime);

      // Check files one by one
      for (const fileObj of filesWithTime) {
        let content = '';
        try {
          content = fs.readFileSync(fileObj.path, 'utf8');
        } catch (_err) {
          continue;
        }
        // Ensure this log file belongs to the current profileDir
        if (profileDir && !content.includes(profileDir)) {
          continue;
        }

        for (const pattern of AUTH_SUCCESS_PATTERNS) {
          const match = content.match(pattern);
          if (match && match[1]) {
            const email = String(match[1]).trim();
            if (email && email.includes('@')) {
              try {
                fs.writeFileSync(cachePath, email, 'utf8');
              } catch (_e) {}
              return email;
            }
          }
        }

        // Fallback email regex matching
        const fallbackMatch = content.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
        if (fallbackMatch && fallbackMatch[1]) {
          const email = fallbackMatch[1].trim();
          try {
            fs.writeFileSync(cachePath, email, 'utf8');
          } catch (_e) {}
          return email;
        }
      }
    } catch (_e) {}
  }

  return '';
}

function readAgyAuthMetadata(fs, pathImpl = path, profileDir) {
  const configDir = pathImpl.join(profileDir, '.gemini', 'antigravity-cli');
  const base = {
    configured: false,
    accountName: 'Unknown',
    email: '',
    authMode: '',
    source: ''
  };
  if (!fs.existsSync(configDir)) return base;

  // Check the isolated OAuth token file
  const oauthSnapshot = readAgyOAuthTokenSnapshot(fs, pathImpl, configDir);
  if (oauthSnapshot) {
    const email = extractEmailFromCliLog(fs, pathImpl, configDir, profileDir);
    return {
      configured: true,
      accountName: email || 'OAuth Configured',
      email: email,
      authMode: oauthSnapshot.authMode,
      source: oauthSnapshot.source,
      hasAccessToken: oauthSnapshot.hasAccessToken,
      hasRefreshToken: oauthSnapshot.hasRefreshToken,
      tokenExpiresAt: oauthSnapshot.tokenExpiresAt,
      tokenExpiry: oauthSnapshot.tokenExpiry,
      tokenFresh: isAgyAccessTokenFresh(oauthSnapshot)
    };
  }

  // Fallback to checking the .aih_env.json file for direct access tokens
  const envPath = pathImpl.join(profileDir, '.aih_env.json');
  if (fs.existsSync(envPath)) {
    try {
      const envData = JSON.parse(fs.readFileSync(envPath, 'utf8'));
      const token = String(envData.AGY_ACCESS_TOKEN || envData.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim();
      if (token) {
        const email = extractEmailFromCliLog(fs, pathImpl, configDir, profileDir);
        return {
          configured: true,
          accountName: email || 'Token Configured',
          email: email,
          authMode: 'access-token',
          source: envPath
        };
      }
    } catch (_error) {
      // ignore
    }
  }

  return base;
}

module.exports = {
  readAgyAuthMetadata,
  readAgyOAuthTokenSnapshot,
  isAgyAccessTokenFresh,
  hasRecoverableAgyOAuthCredentials,
  __private: {
    parseIsoTimestampMs
  }
};
