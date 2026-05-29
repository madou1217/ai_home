'use strict';

const AUTH_SUCCESS_PATTERNS = [
  /OAuth:\s*authenticated successfully as\s+([^\s,]+)/i,
  /applyAuthResult:\s*email=([^\s,]+).*?\bauthMethod=([^\s,)]+)/i
];
const KEYRING_AUTH_PATTERN = /ChainedAuth:\s*authenticated via keyring\b/i;
const LOGGED_OUT_PATTERN = /(?:not logged into Antigravity|You are not logged into Antigravity)/i;

function normalizeEmail(value) {
  const text = String(value || '').trim();
  if (!text || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return '';
  return text;
}

function listAgyLogFiles(fs, path, configDir) {
  const logDir = path.join(configDir, 'log');
  if (!fs.existsSync(logDir)) return [];
  try {
    return fs.readdirSync(logDir)
      .filter((name) => /\.log$/i.test(String(name || '')))
      .map((name) => {
        const filePath = path.join(logDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = Number(fs.statSync(filePath).mtimeMs) || 0;
        } catch (_error) {}
        return { filePath, mtimeMs };
      })
      .sort((a, b) => {
        if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
        return a.filePath.localeCompare(b.filePath);
      });
  } catch (_error) {
    return [];
  }
}

function parseAgyAuthEvent(line) {
  const text = String(line || '');
  if (!text) return null;
  if (LOGGED_OUT_PATTERN.test(text)) {
    return { type: 'logged_out' };
  }
  for (const pattern of AUTH_SUCCESS_PATTERNS) {
    const match = text.match(pattern);
    const email = normalizeEmail(match && match[1]);
    if (email) {
      return {
        type: 'authenticated',
        email,
        authMethod: String(match && match[2] || '').trim().toLowerCase()
      };
    }
  }
  if (KEYRING_AUTH_PATTERN.test(text)) {
    return { type: 'keyring_authenticated' };
  }
  return null;
}

function readAgyAuthMetadata(fs, path, profileDir) {
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  const base = {
    configured: false,
    accountName: 'Unknown',
    email: '',
    authMode: '',
    source: ''
  };
  if (!fs.existsSync(configDir)) return base;

  let latest = null;
  for (const item of listAgyLogFiles(fs, path, configDir)) {
    let content = '';
    try {
      content = fs.readFileSync(item.filePath, 'utf8');
    } catch (_error) {
      continue;
    }
    String(content || '').split(/\r?\n/).forEach((line) => {
      const event = parseAgyAuthEvent(line);
      if (!event) return;
      latest = {
        ...event,
        source: item.filePath
      };
    });
  }

  if (!latest || latest.type === 'logged_out') return base;
  if (latest.type === 'authenticated') {
    return {
      configured: true,
      accountName: latest.email,
      email: latest.email,
      authMode: latest.authMethod || 'keyring-oauth',
      source: latest.source
    };
  }
  if (latest.type === 'keyring_authenticated') {
    return {
      configured: true,
      accountName: 'Keyring OAuth Configured',
      email: '',
      authMode: 'keyring-oauth',
      source: latest.source
    };
  }
  return base;
}

module.exports = {
  readAgyAuthMetadata,
  __private: {
    parseAgyAuthEvent,
    listAgyLogFiles
  }
};
