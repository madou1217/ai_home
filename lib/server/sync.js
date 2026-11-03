'use strict';

const { normalizeCodexRefreshToken } = require('../account/codex-auth-metadata');
const { listAccountCredentialRecords } = require('./account-credential-store');

function buildServerCodexUploadPayload(authJson) {
  if (!authJson || typeof authJson !== 'object') return null;
  const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  if (!tokens) return null;
  const refreshToken = normalizeCodexRefreshToken(tokens.refresh_token);
  if (!refreshToken) return null;
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: String(tokens.id_token || ''),
      access_token: String(tokens.access_token || ''),
      refresh_token: refreshToken,
      account_id: String(tokens.account_id || '')
    },
    last_refresh: String(authJson.last_refresh || new Date().toISOString())
  };
}

async function syncCodexAccountsToServer(options, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const fs = deps.fs || require('node:fs');
  const aiHomeDir = String(deps.aiHomeDir || '').trim();

  const base = String(options.managementUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Empty management URL');
  const key = String(options.key || '').trim();
  if (!key) {
    throw new Error('Missing management key. Use --key or env AIH_SERVER_MANAGEMENT_KEY.');
  }
  if (!aiHomeDir) throw new Error('Missing AIH home directory.');
  const records = listAccountCredentialRecords(fs, aiHomeDir, 'codex');
  const limit = Math.max(0, Number(options.limit) || 0);
  const targetRecords = limit > 0 ? records.slice(0, limit) : records;
  const maxConcurrency = Math.max(1, Math.min(32, Number(options.parallel) || 8));
  const prefix = String(options.namePrefix || 'aih-codex-');

  let cursor = 0;
  let scanned = 0;
  let eligible = 0;
  let uploaded = 0;
  let skippedInvalid = 0;
  let failed = 0;
  let firstError = '';

  const worker = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= targetRecords.length) return;
      const record = targetRecords[idx];
      scanned += 1;
      const authJson = record && record.nativeAuth && record.nativeAuth.auth;
      const payload = buildServerCodexUploadPayload(authJson);
      if (!payload) {
        skippedInvalid += 1;
        continue;
      }
      eligible += 1;
      if (options.dryRun) continue;

      const name = `${prefix}${record.accountRef}.json`;
      const url = `${base}/auth-files?name=${encodeURIComponent(name)}`;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          failed += 1;
          const body = await res.text().catch(() => '');
          if (!firstError) firstError = `HTTP ${res.status} ${body.slice(0, 200)}`.trim();
          continue;
        }
        uploaded += 1;
      } catch (e) {
        failed += 1;
        if (!firstError) firstError = String((e && e.message) || e);
      }
    }
  };

  const workerCount = Math.min(maxConcurrency, Math.max(1, targetRecords.length));
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return {
    managementUrl: base,
    scanned,
    eligible,
    uploaded: options.dryRun ? eligible : uploaded,
    skippedInvalid,
    failed,
    firstError,
    dryRun: !!options.dryRun
  };
}

module.exports = {
  syncCodexAccountsToServer
};
