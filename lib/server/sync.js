'use strict';

const path = require('path');

function parseJsonFileSafe(filePath, fs) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function normalizeManagementBase(url) {
  const base = String(url || '').trim();
  if (!base) throw new Error('Empty management URL');
  return base.replace(/\/+$/, '');
}

function buildServerCodexUploadPayload(authJson) {
  if (!authJson || typeof authJson !== 'object') return null;
  const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  if (!tokens) return null;
  const refreshToken = String(tokens.refresh_token || '').trim();
  if (!refreshToken.startsWith('rt_')) return null;
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

async function syncCodexAccountsToServer(options, deps) {
  const {
    fs,
    getToolAccountIds,
    getToolConfigDir,
    fetchImpl
  } = deps;

  const base = normalizeManagementBase(options.managementUrl || '');
  const key = String(options.key || '').trim();
  if (!key) {
    throw new Error('Missing management key. Use --key or env AIH_SERVER_MANAGEMENT_KEY.');
  }
  const ids = getToolAccountIds('codex');
  const targetIds = options.limit && options.limit > 0 ? ids.slice(0, options.limit) : ids;
  const maxConcurrency = Math.max(1, Math.min(32, Number(options.parallel) || 8));
  const prefix = String(options.namePrefix || 'aih-codex-').trim() || 'aih-codex-';

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
      if (idx >= targetIds.length) return;
      const id = String(targetIds[idx]);
      scanned += 1;
      const authPath = path.join(getToolConfigDir('codex', id), 'auth.json');
      const authJson = parseJsonFileSafe(authPath, fs);
      const payload = buildServerCodexUploadPayload(authJson);
      if (!payload) {
        skippedInvalid += 1;
        continue;
      }
      eligible += 1;
      if (options.dryRun) continue;

      const name = `${prefix}${id}.json`;
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

  const workerCount = Math.min(maxConcurrency, Math.max(1, targetIds.length));
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
