'use strict';

const {
  buildApiKeyIdentity,
  buildOAuthIdentity,
  extractApiKeyConfig,
  extractOAuthEmail,
  flattenImportRecords,
  normalizeCodexAuthPayload
} = require('../../../account/transfer-core');
const {
  listAccountCredentialRecords,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../../../server/account-credential-store');
const { registerAccountIdentity } = require('../../../account/account-registration');
const { normalizeIdentitySeed } = require('../../../account/account-identity');
const { getPublicAccountRef } = require('../../../server/account-ref-store');

function createCodexBulkImportService(options = {}) {
  const {
    path,
    fs,
    aiHomeDir,
    getDefaultParallelism,
    accountArtifactHooks
  } = options;

  function buildRegistrationIdentity(rawIdentity) {
    const identitySeed = normalizeIdentitySeed(rawIdentity);
    if (!identitySeed) return null;
    return {
      identitySeed,
      accountRef: getPublicAccountRef(`unique:${identitySeed}`)
    };
  }

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

  function extractExpiryMs(idToken, accessToken) {
    const accessExpiry = parseJwtExpiryMs(accessToken);
    if (Number.isFinite(accessExpiry)) return accessExpiry;
    return parseJwtExpiryMs(idToken);
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
    const authJson = normalizeCodexAuthPayload(payload);
    const identity = buildRegistrationIdentity(buildOAuthIdentity('codex', authJson));
    if (!identity) return null;
    const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : {};
    const idToken = String(tokens.id_token || '').trim();
    const accessToken = String(tokens.access_token || '').trim();
    const refreshToken = String(tokens.refresh_token || '').trim();
    const upstreamAccountId = String(tokens.account_id || '').trim();
    return {
      email: extractOAuthEmail('codex', authJson),
      upstreamAccountId,
      ...identity,
      refreshToken,
      idToken,
      accessToken,
      expiresAtMs: extractExpiryMs(idToken, accessToken),
      lastRefreshMs: parseIsoTimestampMs(payload.last_refresh || payload.lastRefresh || '')
    };
  }

  function parseCodexApiKeyRecord(line) {
    const payload = line && typeof line === 'object' ? line : null;
    if (!payload) return null;
    const config = extractApiKeyConfig('codex', payload);
    const identity = buildRegistrationIdentity(buildApiKeyIdentity('codex', config));
    if (!identity) return null;
    return {
      credentialKind: 'api-key',
      ...identity,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      label: String(payload.name || payload.label || payload.prefix || '').trim()
    };
  }

  function parseCodexImportRecord(line) {
    const apiKeyRecord = parseCodexApiKeyRecord(line);
    if (apiKeyRecord) return apiKeyRecord;
    const oauthRecord = parseCodexRefreshTokenLine(line);
    return oauthRecord ? { ...oauthRecord, credentialKind: 'oauth' } : null;
  }

  function buildCodexAuthFromRefreshToken(entry) {
    const authJson = {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: String(entry.idToken || ''),
        access_token: String(entry.accessToken || ''),
        refresh_token: entry.refreshToken,
        account_id: String(entry.upstreamAccountId || '')
      },
      last_refresh: new Date().toISOString()
    };
    if (entry.email) authJson.email = entry.email;
    return authJson;
  }

  function buildCodexEnvFromApiKey(entry) {
    const env = {
      OPENAI_API_KEY: String(entry.apiKey || '').trim()
    };
    const baseUrl = String(entry.baseUrl || '').trim();
    if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
    return env;
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
    const records = listAccountCredentialRecords(fs, aiHomeDir, 'codex');
    for (const record of records) {
      const authPath = 'app-state.db';
      try {
        const parsed = record.nativeAuth && record.nativeAuth.auth;
        if (parsed) {
          const candidate = parseCodexRefreshTokenLine(parsed);
          if (candidate) {
            const existing = out.get(record.accountRef);
            if (!existing || compareCredentialQuality(candidate, existing) > 0) {
              out.set(record.accountRef, {
                ...candidate,
                credentialKind: 'oauth',
                accountRef: record.accountRef,
                authPath
              });
            }
          }
        }
      } catch (_error) {}

      try {
        const credentialInput = {
          config: record.env,
          auth: {}
        };
        const config = extractApiKeyConfig('codex', credentialInput);
        if (config.apiKey && !out.has(record.accountRef)) {
          out.set(record.accountRef, {
            credentialKind: 'api-key',
            accountRef: record.accountRef,
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            authPath: ''
          });
        }
      } catch (_error) {}
    }
    return out;
  }

  function notifyAuthArtifactsChanged(accountRef, before, source, reason) {
    if (!before || !accountArtifactHooks || typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged !== 'function') return;
    accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
      provider: 'codex',
      accountRef,
      before,
      source,
      reason
    });
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
    const knownAccountsByRef = importSession && importSession.knownAccountsByRef instanceof Map
      ? importSession.knownAccountsByRef
      : collectExistingCodexAccounts();
    if (importSession && !(importSession.knownAccountsByRef instanceof Map)) {
      importSession.knownAccountsByRef = knownAccountsByRef;
    }
    const maxConcurrency = Math.max(1, Number(optionsArg.parallel) || 8);
    const limit = Math.max(0, Number(optionsArg.limit) || 0);
    const queueByAccountRef = new Map();

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
      const records = flattenImportRecords(parsedJson);
      if (records.length === 0) {
        invalid += 1;
        emitProgress({ scannedFiles, status: 'invalid', filePath: tokenFile });
        continue;
      }
      let parsedAny = false;
      records.forEach((record) => {
        if (limit > 0 && parsedLines >= limit) return;
        const parsed = parseCodexImportRecord(record);
        if (!parsed) {
          invalid += 1;
          emitProgress({ scannedFiles, status: 'invalid', filePath: tokenFile });
          return;
        }
        parsedAny = true;
        parsedLines += 1;
        const currentQueued = queueByAccountRef.get(parsed.accountRef);
        if (currentQueued) {
          if (parsed.credentialKind === 'oauth' && compareCredentialQuality(parsed, currentQueued) > 0) {
            queueByAccountRef.set(parsed.accountRef, parsed);
            emitProgress({ scannedFiles, status: 'deduped_source_upgrade', filePath: tokenFile, email: parsed.email || '' });
          } else {
            emitProgress({ scannedFiles, status: 'deduped_source_skip', filePath: tokenFile, email: parsed.email || parsed.label || '' });
          }
          duplicates += 1;
          return;
        }
        const existingAccount = knownAccountsByRef.get(parsed.accountRef);
        if (existingAccount) {
          duplicates += 1;
          emitProgress({
            scannedFiles,
            status: parsed.credentialKind === 'api-key' ? 'duplicate_api_key' : 'duplicate_identity',
            filePath: tokenFile,
            email: parsed.email || parsed.label || ''
          });
          return;
        }
        queueByAccountRef.set(parsed.accountRef, parsed);
        emitProgress({ scannedFiles, status: 'queued', filePath: tokenFile, email: parsed.email || parsed.label || '' });
      });
      if (!parsedAny && records.length > 0) {
        emitProgress({ scannedFiles, status: 'invalid', filePath: tokenFile });
      }
    }
    const queue = Array.from(queueByAccountRef.values());

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
            const registration = registerAccountIdentity(fs, aiHomeDir, {
              provider: 'codex',
              identitySeed: entry.identitySeed
            });
            if (registration.accountRef !== entry.accountRef) {
              throw new Error('account_ref_registration_mismatch');
            }
            const { accountRef, cliAccountId } = registration;
            const authSnapshotBefore = accountArtifactHooks
              && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
              ? accountArtifactHooks.snapshotAccountAuthArtifacts('codex', accountRef)
              : null;
            if (entry.credentialKind === 'api-key') {
              writeAccountCredentials(fs, aiHomeDir, accountRef, buildCodexEnvFromApiKey(entry));
            } else {
              const authPayload = buildCodexAuthFromRefreshToken(entry);
              writeAccountNativeAuth(fs, aiHomeDir, accountRef, { auth: authPayload });
            }
            notifyAuthArtifactsChanged(accountRef, authSnapshotBefore, 'codex_bulk_import', 'imported_credentials_updated');
            knownAccountsByRef.set(accountRef, {
              ...entry,
              accountRef,
              cliAccountId,
              authPath: 'app-state.db'
            });
            imported += 1;
            emitProgress({
              scannedFiles: tokenFiles.length,
              status: entry.credentialKind === 'api-key' ? 'imported_api_key' : 'imported',
              id: cliAccountId,
              cliAccountId,
              accountRef,
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
