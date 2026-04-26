'use strict';

function createCodexBulkImportService(options = {}) {
  const {
    path,
    fs,
    crypto,
    profilesDir,
    getDefaultParallelism,
    getToolAccountIds,
    ensureDir,
    getProfileDir,
    getToolConfigDir
  } = options;

  function decodeBase64UrlJsonSegment(segment) {
    const text = String(segment || '').trim();
    if (!text) return null;
    try {
      const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      return JSON.parse(Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8'));
    } catch (_error) {
      return null;
    }
  }

  function decodeJwtPayloadUnsafe(jwt) {
    const text = String(jwt || '').trim();
    if (!text) return null;
    const parts = text.split('.');
    if (parts.length < 2) return null;
    return decodeBase64UrlJsonSegment(parts[1]);
  }

  function parseIsoTimestampMs(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const epochMs = Date.parse(text);
    if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
    return epochMs;
  }

  function parseJwtExpiryMs(token) {
    const payload = decodeJwtPayloadUnsafe(token);
    const expSeconds = Number(payload && payload.exp);
    if (!Number.isFinite(expSeconds) || expSeconds <= 0) return null;
    return expSeconds * 1000;
  }

  function extractEmail(explicitEmail, idToken, accessToken) {
    const direct = String(explicitEmail || '').trim().toLowerCase();
    if (direct) return direct;
    const idPayload = decodeJwtPayloadUnsafe(idToken);
    if (idPayload && typeof idPayload.email === 'string' && idPayload.email.trim()) {
      return idPayload.email.trim().toLowerCase();
    }
    const accessPayload = decodeJwtPayloadUnsafe(accessToken);
    if (accessPayload && typeof accessPayload.email === 'string' && accessPayload.email.trim()) {
      return accessPayload.email.trim().toLowerCase();
    }
    const profile = accessPayload && accessPayload['https://api.openai.com/profile'];
    if (profile && typeof profile.email === 'string' && profile.email.trim()) {
      return profile.email.trim().toLowerCase();
    }
    return '';
  }

  function extractExpiryMs(idToken, accessToken) {
    const accessExpiry = parseJwtExpiryMs(accessToken);
    if (Number.isFinite(accessExpiry)) return accessExpiry;
    return parseJwtExpiryMs(idToken);
  }

  function buildIdentityKey(email, accountId) {
    const safeEmail = String(email || '').trim().toLowerCase();
    if (safeEmail) return `email:${safeEmail}`;
    const safeAccountId = String(accountId || '').trim().toLowerCase();
    if (safeAccountId) return `account_id:${safeAccountId}`;
    return '';
  }

  function compareCredentialQuality(left, right) {
    const leftExpiry = Number.isFinite(left && left.expiresAtMs) ? Number(left.expiresAtMs) : -1;
    const rightExpiry = Number.isFinite(right && right.expiresAtMs) ? Number(right.expiresAtMs) : -1;
    if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;

    const leftRefresh = Number.isFinite(left && left.lastRefreshMs) ? Number(left.lastRefreshMs) : -1;
    const rightRefresh = Number.isFinite(right && right.lastRefreshMs) ? Number(right.lastRefreshMs) : -1;
    if (leftRefresh !== rightRefresh) return leftRefresh - rightRefresh;

    const leftAccess = String(left && left.accessToken || '').trim() ? 1 : 0;
    const rightAccess = String(right && right.accessToken || '').trim() ? 1 : 0;
    if (leftAccess !== rightAccess) return leftAccess - rightAccess;

    const leftId = String(left && left.idToken || '').trim() ? 1 : 0;
    const rightId = String(right && right.idToken || '').trim() ? 1 : 0;
    if (leftId !== rightId) return leftId - rightId;

    return 0;
  }

  function parseCodexBulkImportArgs(rawArgs) {
    let sourceDir = 'accounts';
    let parallel = getDefaultParallelism();
    let limit = 0;
    let dryRun = false;

    const tokens = Array.isArray(rawArgs) ? rawArgs.slice() : [];
    for (let i = 0; i < tokens.length; i += 1) {
      const arg = String(tokens[i] || '').trim();
      if (!arg) continue;
      if (arg === '--dry-run') {
        dryRun = true;
        continue;
      }
      if (arg === '--parallel' || arg === '-p') {
        const val = String(tokens[i + 1] || '').trim();
        if (!/^\d+$/.test(val)) throw new Error('Invalid --parallel value');
        parallel = Math.max(1, Math.min(32, Number(val)));
        i += 1;
        continue;
      }
      if (arg === '--limit') {
        const val = String(tokens[i + 1] || '').trim();
        if (!/^\d+$/.test(val)) throw new Error('Invalid --limit value');
        limit = Number(val);
        i += 1;
        continue;
      }
      if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
      sourceDir = arg;
    }

    return { sourceDir, parallel, limit, dryRun };
  }

  function parseCodexRefreshTokenLine(line) {
    const payload = line && typeof line === 'object' ? line : null;
    if (!payload) return null;
    const refreshToken = payload.refresh_token || (payload.tokens && payload.tokens.refresh_token) || '';
    if (!refreshToken.startsWith('rt_')) return null;
    const idToken = String(payload.id_token || (payload.tokens && payload.tokens.id_token) || '').trim();
    const accessToken = String(payload.access_token || (payload.tokens && payload.tokens.access_token) || '').trim();
    const explicitEmail = String(payload.email || '').trim();
    const email = extractEmail(explicitEmail, idToken, accessToken);
    const explicitAccountId = String(payload.account_id || (payload.tokens && payload.tokens.account_id) || '').trim().toLowerCase();
    const accountSlug = explicitAccountId || (email ? email.split('@')[0] : '');
    const identityKey = buildIdentityKey(email, explicitAccountId);
    if (!identityKey) return null;
    return {
      email,
      accountId: explicitAccountId,
      identityKey,
      accountSlug,
      refreshToken,
      idToken,
      accessToken,
      expiresAtMs: extractExpiryMs(idToken, accessToken),
      lastRefreshMs: parseIsoTimestampMs(payload.last_refresh || payload.lastRefresh || '')
    };
  }

  function buildCodexAuthFromRefreshToken(entry) {
    const accountId = entry.accountSlug || `imported-${crypto.randomBytes(6).toString('hex')}`;
    return {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: String(entry.idToken || ''),
        access_token: String(entry.accessToken || ''),
        refresh_token: entry.refreshToken,
        account_id: accountId
      },
      last_refresh: new Date().toISOString()
    };
  }

  function getNextNumericId(cliName) {
    const ids = getToolAccountIds(cliName).map((x) => Number(x)).filter((n) => Number.isFinite(n));
    if (ids.length === 0) return 1;
    return Math.max(...ids) + 1;
  }

  function claimNextNumericId(cliName, importSession = null) {
    let candidate = importSession && Number.isFinite(importSession.nextNumericId)
      ? Math.max(1, Math.floor(importSession.nextNumericId))
      : getNextNumericId(cliName);
    const providerRoot = path.join(profilesDir, cliName);
    ensureDir(providerRoot);
    while (true) {
      const id = String(candidate);
      const profileDir = getProfileDir(cliName, id);
      try {
        fs.mkdirSync(profileDir);
        if (importSession) {
          importSession.nextNumericId = candidate + 1;
        }
        return id;
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          candidate += 1;
          if (importSession) {
            importSession.nextNumericId = candidate;
          }
          continue;
        }
        throw error;
      }
    }
  }

  function collectJsonFilesRecursively(rootDir) {
    const out = [];
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (_error) {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile() && /\.json$/i.test(entry.name)) {
          out.push(fullPath);
        }
      }
    }
    return out.sort();
  }

  function collectExistingCodexAccounts() {
    const out = new Map();
    const codexRoot = path.join(profilesDir, 'codex');
    if (!fs.existsSync(codexRoot)) return out;
    let entries = [];
    try {
      entries = fs.readdirSync(codexRoot, { withFileTypes: true });
    } catch (_error) {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const authPath = path.join(codexRoot, entry.name, '.codex', 'auth.json');
      if (!fs.existsSync(authPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        const candidate = parseCodexRefreshTokenLine(parsed);
        if (!candidate || !candidate.identityKey) continue;
        const existing = out.get(candidate.identityKey);
        if (!existing || compareCredentialQuality(candidate, existing) > 0) {
          out.set(candidate.identityKey, {
            ...candidate,
            id: String(entry.name),
            authPath
          });
        }
      } catch (_error) {}
    }
    return out;
  }

  async function importCodexTokensFromOutput(optionsArg) {
    const onProgress = typeof optionsArg.onProgress === 'function' ? optionsArg.onProgress : null;
    const sourceDir = path.resolve(optionsArg.sourceDir);
    const importSession = optionsArg && typeof optionsArg.importSession === 'object' && optionsArg.importSession
      ? optionsArg.importSession
      : null;
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error(`Source directory not found: ${sourceDir}`);
    }

    const tokenFiles = collectJsonFilesRecursively(sourceDir);
    if (tokenFiles.length === 0) {
      return {
        sourceDir, scannedFiles: 0, parsedLines: 0, imported: 0, duplicates: 0, invalid: 0, dryRun: !!optionsArg.dryRun
      };
    }

    let parsedLines = 0;
    let imported = 0;
    let duplicates = 0;
    let invalid = 0;
    let failed = 0;
    let firstError = '';
    const knownAccountsByIdentity = importSession && importSession.knownAccountsByIdentity instanceof Map
      ? importSession.knownAccountsByIdentity
      : collectExistingCodexAccounts();
    if (importSession && !(importSession.knownAccountsByIdentity instanceof Map)) {
      importSession.knownAccountsByIdentity = knownAccountsByIdentity;
    }
    const maxConcurrency = Math.max(1, Number(optionsArg.parallel) || 8);
    const limit = Math.max(0, Number(optionsArg.limit) || 0);
    const queueByIdentity = new Map();

    const emitProgress = (extra = {}) => {
      if (!onProgress) return;
      onProgress({
        sourceDir,
        totalFiles: tokenFiles.length,
        parsedLines,
        imported,
        duplicates,
        invalid,
        failed,
        dryRun: !!optionsArg.dryRun,
        ...extra
      });
    };

    emitProgress({ scannedFiles: 0, status: 'start' });

    for (let fileIndex = 0; fileIndex < tokenFiles.length; fileIndex += 1) {
      const tokenFile = tokenFiles[fileIndex];
      const scannedFiles = fileIndex + 1;
      if (limit > 0 && parsedLines >= limit) break;
      let parsedJson = null;
      try {
        const content = fs.readFileSync(tokenFile, 'utf8');
        parsedJson = JSON.parse(content);
      } catch (_error) {
        invalid += 1;
        emitProgress({ scannedFiles, status: 'invalid', filePath: tokenFile });
        continue;
      }
      const parsed = parseCodexRefreshTokenLine(parsedJson);
      if (!parsed) {
        invalid += 1;
        emitProgress({ scannedFiles, status: 'invalid', filePath: tokenFile });
        continue;
      }
      parsedLines += 1;
      const currentQueued = queueByIdentity.get(parsed.identityKey);
      if (currentQueued) {
        if (compareCredentialQuality(parsed, currentQueued) > 0) {
          queueByIdentity.set(parsed.identityKey, parsed);
          emitProgress({ scannedFiles, status: 'deduped_source_upgrade', filePath: tokenFile, email: parsed.email || '' });
        } else {
          emitProgress({ scannedFiles, status: 'deduped_source_skip', filePath: tokenFile, email: parsed.email || '' });
        }
        duplicates += 1;
        continue;
      }
      const existingAccount = knownAccountsByIdentity.get(parsed.identityKey);
      if (existingAccount && compareCredentialQuality(parsed, existingAccount) <= 0) {
        duplicates += 1;
        emitProgress({ scannedFiles, status: 'duplicate_identity', filePath: tokenFile, email: parsed.email || '' });
        continue;
      }
      queueByIdentity.set(parsed.identityKey, parsed);
      emitProgress({ scannedFiles, status: 'queued', filePath: tokenFile, email: parsed.email || '' });
    }
    const queue = Array.from(queueByIdentity.values());

    if (optionsArg.dryRun) {
      imported = queue.length;
      emitProgress({ scannedFiles: tokenFiles.length, status: 'done' });
    } else if (queue.length > 0) {
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= queue.length) return;
          const entry = queue[idx];
          try {
            const existingAccount = knownAccountsByIdentity.get(entry.identityKey);
            const id = existingAccount && existingAccount.id
              ? String(existingAccount.id)
              : claimNextNumericId('codex', importSession);
            const codexDir = getToolConfigDir('codex', id);
            ensureDir(codexDir);
            const authPayload = buildCodexAuthFromRefreshToken(entry);
            fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify(authPayload, null, 2));
            knownAccountsByIdentity.set(entry.identityKey, {
              ...entry,
              id,
              authPath: path.join(codexDir, 'auth.json')
            });
            imported += 1;
            emitProgress({
              scannedFiles: tokenFiles.length,
              status: existingAccount && existingAccount.id ? 'updated' : 'imported',
              id,
              email: entry.email || '',
              queuedIndex: idx + 1,
              queueTotal: queue.length
            });
          } catch (error) {
            failed += 1;
            if (!firstError) firstError = error.message;
            emitProgress({ scannedFiles: tokenFiles.length, status: 'failed', error: error.message, queuedIndex: idx + 1, queueTotal: queue.length });
          }
        }
      };
      const workerCount = Math.min(maxConcurrency, queue.length);
      const workers = [];
      for (let i = 0; i < workerCount; i += 1) {
        workers.push(worker());
      }
      await Promise.all(workers);
      emitProgress({ scannedFiles: tokenFiles.length, status: 'done' });
    } else {
      emitProgress({ scannedFiles: tokenFiles.length, status: 'done' });
    }

    return {
      sourceDir,
      scannedFiles: tokenFiles.length,
      parsedLines,
      imported,
      duplicates,
      invalid,
      failed,
      firstError,
      dryRun: !!optionsArg.dryRun
    };
  }

  return {
    parseCodexBulkImportArgs,
    importCodexTokensFromOutput
  };
}

module.exports = {
  createCodexBulkImportService
};
