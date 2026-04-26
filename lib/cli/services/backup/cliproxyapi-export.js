'use strict';

function createCliproxyapiExportService(options = {}) {
  const {
    fs,
    path,
    aiHomeDir,
    hostHomeDir,
    BufferImpl = Buffer
  } = options;

  function decodeBase64UrlJsonSegment(segment) {
    const text = String(segment || '').trim();
    if (!text) return null;
    try {
      const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      return JSON.parse(BufferImpl.from(`${normalized}${padding}`, 'base64').toString('utf8'));
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

  function readJsonFileSafe(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  function stripInlineYamlComment(text) {
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (ch === quote && text[i - 1] !== '\\') quote = '';
        continue;
      }
      if (ch === '\'' || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === '#') return text.slice(0, i).trim();
    }
    return text.trim();
  }

  function normalizeYamlScalar(text) {
    const raw = stripInlineYamlComment(String(text || '').trim());
    if (!raw) return '';
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('\'') && raw.endsWith('\''))) {
      return raw.slice(1, -1);
    }
    return raw;
  }

  function expandUserPath(targetPath, baseDir) {
    const text = String(targetPath || '').trim();
    if (!text) return '';
    if (text === '~') return hostHomeDir;
    if (text.startsWith('~/') || text.startsWith('~\\')) {
      return path.join(hostHomeDir, text.slice(2));
    }
    if (path.isAbsolute(text)) return text;
    return path.resolve(baseDir, text);
  }

  function resolveCliproxyapiConfigPath() {
    const candidates = [
      path.join(hostHomeDir, '.cli-proxy-api', 'config.yaml'),
      path.join(hostHomeDir, '.cli-proxy-api', 'config.yml')
    ];
    return candidates.find((candidate) => {
      try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
      } catch (_error) {
        return false;
      }
    }) || '';
  }

  function resolveCliproxyapiAuthDir() {
    const configPath = resolveCliproxyapiConfigPath();
    if (!configPath) {
      return {
        configPath: '',
        authDir: path.join(hostHomeDir, '.cli-proxy-api')
      };
    }

    const yamlText = fs.readFileSync(configPath, 'utf8');
    const lines = yamlText.split(/\r?\n/);
    const baseDir = path.dirname(configPath);
    for (const line of lines) {
      if (!/^\s*auth-dir\s*:/.test(line)) continue;
      const rawValue = line.replace(/^\s*auth-dir\s*:\s*/, '');
      const normalized = normalizeYamlScalar(rawValue);
      return {
        configPath,
        authDir: expandUserPath(normalized, baseDir) || path.join(hostHomeDir, '.cli-proxy-api')
      };
    }

    return {
      configPath,
      authDir: path.join(hostHomeDir, '.cli-proxy-api')
    };
  }

  function toIsoFromUnixSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    return new Date(seconds * 1000).toISOString();
  }

  function toEpochMs(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const epochMs = Date.parse(text);
    if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
    return epochMs;
  }

  function extractEmail(idToken, accessToken) {
    const idPayload = decodeJwtPayloadUnsafe(idToken);
    if (idPayload && typeof idPayload.email === 'string' && idPayload.email.trim()) {
      return idPayload.email.trim();
    }
    const accessPayload = decodeJwtPayloadUnsafe(accessToken);
    if (!accessPayload || typeof accessPayload !== 'object') return '';
    if (typeof accessPayload.email === 'string' && accessPayload.email.trim()) {
      return accessPayload.email.trim();
    }
    const profile = accessPayload['https://api.openai.com/profile'];
    if (profile && typeof profile.email === 'string' && profile.email.trim()) {
      return profile.email.trim();
    }
    return '';
  }

  function extractExpireIso(idToken, accessToken) {
    const accessPayload = decodeJwtPayloadUnsafe(accessToken);
    if (accessPayload && accessPayload.exp) {
      return toIsoFromUnixSeconds(accessPayload.exp);
    }
    const idPayload = decodeJwtPayloadUnsafe(idToken);
    if (idPayload && idPayload.exp) {
      return toIsoFromUnixSeconds(idPayload.exp);
    }
    return '';
  }

  function buildCliproxyapiCodexAuth(authJson) {
    if (!authJson || typeof authJson !== 'object') return null;
    const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
    if (!tokens) return null;

    const refreshToken = String(tokens.refresh_token || '').trim();
    if (!refreshToken.startsWith('rt_')) return null;

    const idToken = String(tokens.id_token || '').trim();
    const accessToken = String(tokens.access_token || '').trim();
    const accountId = String(tokens.account_id || '').trim();
    const lastRefresh = String(authJson.last_refresh || '').trim() || new Date().toISOString();
    const email = extractEmail(idToken, accessToken);
    if (!email) return null;
    const payload = {
      type: 'codex',
      email,
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountId,
      last_refresh: lastRefresh
    };
    const expired = extractExpireIso(idToken, accessToken);
    if (expired) payload.expired = expired;
    return payload;
  }

  function buildIdentityKey(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const email = String(payload.email || '').trim().toLowerCase();
    if (email) return `email:${email}`;
    const accountId = String(payload.account_id || '').trim().toLowerCase();
    if (accountId) return `account_id:${accountId}`;
    return '';
  }

  function extractCredentialQuality(payload) {
    if (!payload || typeof payload !== 'object') {
      return { expiresAtMs: -1, lastRefreshMs: -1, hasAccessToken: 0, hasIdToken: 0 };
    }
    return {
      expiresAtMs: Number(toEpochMs(payload.expired)),
      lastRefreshMs: Number(toEpochMs(payload.last_refresh)),
      hasAccessToken: String(payload.access_token || '').trim() ? 1 : 0,
      hasIdToken: String(payload.id_token || '').trim() ? 1 : 0
    };
  }

  function compareCredentialQuality(left, right) {
    const leftQuality = extractCredentialQuality(left);
    const rightQuality = extractCredentialQuality(right);
    if (leftQuality.expiresAtMs !== rightQuality.expiresAtMs) {
      return leftQuality.expiresAtMs - rightQuality.expiresAtMs;
    }
    if (leftQuality.lastRefreshMs !== rightQuality.lastRefreshMs) {
      return leftQuality.lastRefreshMs - rightQuality.lastRefreshMs;
    }
    if (leftQuality.hasAccessToken !== rightQuality.hasAccessToken) {
      return leftQuality.hasAccessToken - rightQuality.hasAccessToken;
    }
    if (leftQuality.hasIdToken !== rightQuality.hasIdToken) {
      return leftQuality.hasIdToken - rightQuality.hasIdToken;
    }
    return 0;
  }

  function isManagedCodexExportFile(fileName) {
    return /^codex-aih-\d+\.json$/i.test(String(fileName || '').trim());
  }

  function sanitizeEmailFileStem(email) {
    return String(email || '')
      .trim()
      .toLowerCase()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '');
  }

  function buildCanonicalFileName(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const emailStem = sanitizeEmailFileStem(payload.email);
    if (!emailStem) return '';
    return `${emailStem}.json`;
  }

  function buildAiHomeCodexAuthFromCliproxyapi(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const refreshToken = String(payload.refresh_token || '').trim();
    if (!refreshToken.startsWith('rt_')) return null;
    const idToken = String(payload.id_token || '').trim();
    const accessToken = String(payload.access_token || '').trim();
    const accountId = String(payload.account_id || '').trim();
    const email = String(payload.email || extractEmail(idToken, accessToken)).trim();
    if (!email) return null;
    return {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: refreshToken,
        account_id: accountId || email.split('@')[0]
      },
      last_refresh: String(payload.last_refresh || '').trim() || new Date().toISOString()
    };
  }

  function isCodexAuthPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (String(payload.type || '').trim().toLowerCase() === 'codex') return true;
    const refreshToken = String(payload.refresh_token || '').trim();
    return refreshToken.startsWith('rt_');
  }

  function listExistingAuthFiles(authDir) {
    try {
      return fs.readdirSync(authDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.json$/i.test(String(entry.name || '')))
        .map((entry) => {
          const fileName = String(entry.name);
          const filePath = path.join(authDir, fileName);
          const payload = readJsonFileSafe(filePath);
          return {
            fileName,
            filePath,
            payload,
            identityKey: buildIdentityKey(payload),
            quality: extractCredentialQuality(payload),
            isCodex: isCodexAuthPayload(payload),
            isManaged: isManagedCodexExportFile(fileName)
          };
        });
    } catch (_error) {
      return [];
    }
  }

  function listCodexAccountIds() {
    const providerDir = path.join(aiHomeDir, 'profiles', 'codex');
    try {
      return fs.readdirSync(providerDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(String(entry.name || '')))
        .map((entry) => String(entry.name))
        .sort((a, b) => Number(a) - Number(b));
    } catch (_error) {
      return [];
    }
  }

  function collectExistingAiHomeCodexAccounts() {
    const accounts = new Map();
    const providerDir = path.join(aiHomeDir, 'profiles', 'codex');
    const ids = listCodexAccountIds();
    ids.forEach((id) => {
      const authPath = path.join(providerDir, id, '.codex', 'auth.json');
      const authJson = readJsonFileSafe(authPath);
      const payload = buildCliproxyapiCodexAuth(authJson);
      if (!payload) return;
      const identityKey = buildIdentityKey(payload);
      if (!identityKey) return;
      const existing = accounts.get(identityKey);
      if (!existing || compareCredentialQuality(payload, existing.payload) > 0) {
        accounts.set(identityKey, {
          id,
          authPath,
          payload
        });
      }
    });
    return accounts;
  }

  function getNextCodexAccountId() {
    const ids = listCodexAccountIds()
      .map((item) => Number(item))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (ids.length === 0) return 1;
    return Math.max(...ids) + 1;
  }

  function claimNextCodexAccountId() {
    let candidate = getNextCodexAccountId();
    fs.mkdirSync(path.join(aiHomeDir, 'profiles', 'codex'), { recursive: true });
    while (true) {
      const id = String(candidate);
      const profileDir = path.join(aiHomeDir, 'profiles', 'codex', id);
      try {
        fs.mkdirSync(profileDir);
        return id;
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          candidate += 1;
          continue;
        }
        throw error;
      }
    }
  }

  function exportCliproxyapiCodexAuths(options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const authDirOverride = String(options.authDirOverride || '').trim();
    const resolved = authDirOverride
      ? { configPath: '', authDir: authDirOverride }
      : resolveCliproxyapiAuthDir();
    fs.mkdirSync(resolved.authDir, { recursive: true });

    const existingFiles = listExistingAuthFiles(resolved.authDir);
    const existingByIdentity = new Map();
    existingFiles.forEach((entry) => {
      if (!entry.isCodex || !entry.identityKey) return;
      const bucket = existingByIdentity.get(entry.identityKey) || [];
      bucket.push(entry);
      existingByIdentity.set(entry.identityKey, bucket);
    });

    const ids = listCodexAccountIds();
    let exported = 0;
    let skippedMissing = 0;
    let skippedInvalid = 0;
    let dedupedSource = 0;
    let dedupedTarget = 0;
    const files = [];
    const sourceBestByIdentity = new Map();
    const keptTargets = new Set();
    let applyProcessed = 0;

    function emitProgress(extra = {}) {
      if (!onProgress) return;
      onProgress({
        provider: 'codex',
        total: ids.length,
        scanned: Number(extra.scanned != null ? extra.scanned : 0),
        exported,
        skippedMissing,
        skippedInvalid,
        dedupedSource,
        dedupedTarget,
        ...extra
      });
    }

    emitProgress({ scanned: 0, status: 'start' });

    ids.forEach((id, index) => {
      const scanned = index + 1;
      const authPath = path.join(aiHomeDir, 'profiles', 'codex', id, '.codex', 'auth.json');
      if (!fs.existsSync(authPath)) {
        skippedMissing += 1;
        emitProgress({ scanned, id, status: 'missing' });
        return;
      }
      const authJson = readJsonFileSafe(authPath);
      const payload = buildCliproxyapiCodexAuth(authJson);
      if (!payload) {
        skippedInvalid += 1;
        emitProgress({ scanned, id, status: 'invalid' });
        return;
      }
      const identityKey = buildIdentityKey(payload);
      if (!identityKey) {
        skippedInvalid += 1;
        emitProgress({ scanned, id, status: 'invalid' });
        return;
      }
      const existingSource = sourceBestByIdentity.get(identityKey);
      if (existingSource) {
        if (compareCredentialQuality(payload, existingSource.payload) > 0) {
          sourceBestByIdentity.set(identityKey, { id, payload });
          dedupedSource += 1;
          emitProgress({ scanned, id, email: payload.email, status: 'deduped_source_upgrade' });
        } else {
          dedupedSource += 1;
          emitProgress({ scanned, id, email: payload.email, status: 'deduped_source' });
        }
        return;
      }
      sourceBestByIdentity.set(identityKey, { id, payload });
    });

    const applyTotal = sourceBestByIdentity.size;
    emitProgress({ scanned: ids.length, phase: 'apply', applyProcessed: 0, applyTotal, status: 'apply_start' });

    Array.from(sourceBestByIdentity.entries()).forEach(([identityKey, sourceEntry], index) => {
      const { id, payload } = sourceEntry;
      const existingMatches = identityKey ? (existingByIdentity.get(identityKey) || []) : [];
      const fileName = buildCanonicalFileName(payload);
      applyProcessed = index + 1;
      if (!fileName) {
        skippedInvalid += 1;
        emitProgress({
          scanned: ids.length,
          id,
          status: 'invalid',
          phase: 'apply',
          applyProcessed,
          applyTotal
        });
        return;
      }
      const bestExisting = existingMatches.reduce((best, entry) => {
        if (!best) return entry;
        return compareCredentialQuality(entry.payload, best.payload) > 0 ? entry : best;
      }, null);
      if (bestExisting && compareCredentialQuality(bestExisting.payload, payload) >= 0) {
        keptTargets.add(bestExisting.fileName);
        existingMatches.forEach((entry) => {
          if (entry.fileName === bestExisting.fileName) return;
          try {
            fs.unlinkSync(entry.filePath);
            dedupedTarget += 1;
          } catch (_error) {}
        });
        if (applyProcessed === applyTotal || applyProcessed % 250 === 0) {
          emitProgress({
            scanned: ids.length,
            id,
            email: payload.email,
            fileName: bestExisting.fileName,
            status: 'deduped_target_keep',
            phase: 'apply',
            applyProcessed,
            applyTotal
          });
        }
        return;
      }
      const outPath = path.join(resolved.authDir, fileName);
      fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
      exported += 1;
      keptTargets.add(fileName);
      files.push({ id, outPath, email: payload.email, identityKey });
      emitProgress({
        scanned: ids.length,
        id,
        email: payload.email,
        fileName,
        status: 'exported',
        phase: 'apply',
        applyProcessed,
        applyTotal
      });

      existingMatches.forEach((entry) => {
        if (entry.fileName === fileName) return;
        try {
          fs.unlinkSync(entry.filePath);
          dedupedTarget += 1;
        } catch (_error) {}
      });
    });

    existingFiles.forEach((entry) => {
      if (!entry.isManaged || !entry.isCodex || !entry.identityKey) return;
      if (!sourceBestByIdentity.has(entry.identityKey)) return;
      if (keptTargets.has(entry.fileName)) return;
      try {
        fs.unlinkSync(entry.filePath);
        dedupedTarget += 1;
      } catch (_error) {}
    });

    emitProgress({ scanned: ids.length, status: 'done', phase: 'apply', applyProcessed: applyTotal, applyTotal });

    return {
      provider: 'codex',
      configPath: resolved.configPath,
      authDir: resolved.authDir,
      scanned: ids.length,
      exported,
      skippedMissing,
      skippedInvalid,
      dedupedSource,
      dedupedTarget,
      files
    };
  }

  function importCliproxyapiCodexAuths(options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const dryRun = !!options.dryRun;
    const resolved = resolveCliproxyapiAuthDir();
    const existingFiles = listExistingAuthFiles(resolved.authDir)
      .filter((entry) => entry.isCodex);
    const existingAiHomeAccounts = collectExistingAiHomeCodexAccounts();
    let imported = 0;
    let duplicates = 0;
    let invalid = 0;
    let failed = 0;
    const importedIds = [];
    const queuedByIdentity = new Map();

    function emitProgress(extra = {}) {
      if (!onProgress) return;
      onProgress({
        provider: 'codex',
        total: existingFiles.length,
        scanned: Number(extra.scanned != null ? extra.scanned : 0),
        imported,
        duplicates,
        invalid,
        failed,
        dryRun,
        ...extra
      });
    }

    emitProgress({ scanned: 0, status: 'start' });

    existingFiles.forEach((entry, index) => {
      const scanned = index + 1;
      const authJson = buildAiHomeCodexAuthFromCliproxyapi(entry.payload);
      if (!authJson) {
        invalid += 1;
        emitProgress({ scanned, fileName: entry.fileName, status: 'invalid' });
        return;
      }
      const identityPayload = buildCliproxyapiCodexAuth(authJson);
      const identityKey = buildIdentityKey(identityPayload);
      if (!identityKey) {
        invalid += 1;
        emitProgress({ scanned, fileName: entry.fileName, status: 'invalid' });
        return;
      }
      const queued = queuedByIdentity.get(identityKey);
      if (queued) {
        if (compareCredentialQuality(identityPayload, queued.identityPayload) > 0) {
          queuedByIdentity.set(identityKey, { entry, authJson, identityPayload });
          duplicates += 1;
          emitProgress({ scanned, fileName: entry.fileName, email: identityPayload.email, status: 'deduped_source_upgrade' });
        } else {
          duplicates += 1;
          emitProgress({ scanned, fileName: entry.fileName, email: identityPayload.email, status: 'deduped_source' });
        }
        return;
      }
      const existing = existingAiHomeAccounts.get(identityKey);
      if (existing && compareCredentialQuality(identityPayload, existing.payload) <= 0) {
        duplicates += 1;
        emitProgress({ scanned, fileName: entry.fileName, email: identityPayload.email, status: 'duplicate' });
        return;
      }
      queuedByIdentity.set(identityKey, { entry, authJson, identityPayload });
    });

    Array.from(queuedByIdentity.values()).forEach((queuedEntry) => {
      const { entry, authJson, identityPayload } = queuedEntry;
      const existing = existingAiHomeAccounts.get(buildIdentityKey(identityPayload));
      if (!dryRun) {
        try {
          const newId = existing && existing.id ? String(existing.id) : claimNextCodexAccountId();
          const targetDir = path.join(aiHomeDir, 'profiles', 'codex', newId, '.codex');
          fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(path.join(targetDir, 'auth.json'), `${JSON.stringify(authJson, null, 2)}\n`);
          existingAiHomeAccounts.set(buildIdentityKey(identityPayload), {
            id: newId,
            authPath: path.join(targetDir, 'auth.json'),
            payload: identityPayload
          });
          importedIds.push(newId);
          imported += 1;
          emitProgress({
            scanned: existingFiles.length,
            id: newId,
            fileName: entry.fileName,
            email: identityPayload.email,
            status: existing && existing.id ? 'updated' : 'imported'
          });
        } catch (_error) {
          failed += 1;
          emitProgress({ scanned: existingFiles.length, fileName: entry.fileName, email: identityPayload.email, status: 'failed' });
        }
        return;
      }
      const newId = existing && existing.id ? String(existing.id) : `dry-run-${imported + 1}`;
      existingAiHomeAccounts.set(buildIdentityKey(identityPayload), {
        id: newId,
        authPath: '',
        payload: identityPayload
      });
      importedIds.push(newId);
      imported += 1;
      emitProgress({
        scanned: existingFiles.length,
        id: newId,
        fileName: entry.fileName,
        email: identityPayload.email,
        status: existing && existing.id ? 'updated' : 'imported'
      });
    });

    emitProgress({ scanned: existingFiles.length, status: 'done' });

    return {
      provider: 'codex',
      configPath: resolved.configPath,
      authDir: resolved.authDir,
      scanned: existingFiles.length,
      imported,
      duplicates,
      invalid,
      failed,
      dryRun,
      importedIds
    };
  }

  return {
    exportCliproxyapiCodexAuths,
    importCliproxyapiCodexAuths
  };
}

module.exports = {
  createCliproxyapiExportService
};
