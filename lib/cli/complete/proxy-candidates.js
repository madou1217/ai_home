'use strict';

// Completion reads only the management catalog: never leases, SSH, probes or
// pool selection. Cross-process snapshots contain public candidates, not keys.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MAX_BYTES = 256 * 1024;
const CACHE_MS = 5000;
const SAFE_VALUE = /^[^\s\x00-\x1f\x7f=]+$/u;
const SAFE_LABEL = /^[\p{L}\p{N}._:@/-]+$/u;

function managementConfig(env, aiHomeDir) {
  let config = null;
  try {
    if (!env.AIH_SERVER_BASE_URL || !env.AIH_SERVER_MANAGEMENT_KEY) {
      config = require('../../server/server-config-store').readServerConfig({ fs, aiHomeDir });
    }
  } catch (_error) { /* env-only remote CLI */ }
  const base = String(env.AIH_SERVER_BASE_URL || `http://127.0.0.1:${Number(config && config.port) || 9527}`).trim();
  const managementKey = String(env.AIH_SERVER_MANAGEMENT_KEY || (!env.AIH_SERVER_BASE_URL && config && config.managementKey) || '').trim();
  if (managementKey.length < 32 || managementKey.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(managementKey)) return null;
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) return null;
  return { baseUrl: parsed.origin, managementKey };
}

function publicCandidates(snapshot) {
  if (!snapshot || snapshot.ok !== true || !Array.isArray(snapshot.candidates)) return [];
  return snapshot.candidates.slice(0, 256).filter((row) => row && row.available === true
    && typeof row.id === 'string' && row.id.length <= 256 && SAFE_VALUE.test(row.id) && !row.id.startsWith('-'))
    .map((row) => ({
      id: row.id,
      name: String(row.name || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160),
      source: String(row.source || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80),
      labelSelectable: row.labelSelectable !== false && typeof row.name === 'string' && row.name.length <= 160
        && snapshot.candidates.filter((other) => other && other.name === row.name).length === 1
    }));
}

function listProxyCandidates(options = {}) {
  const env = options.env || process.env;
  try {
    const config = managementConfig(env, options.aiHomeDir);
    if (!config) return [];
    const fingerprint = crypto.createHash('sha256').update(config.baseUrl).update('\0').update(config.managementKey).digest('hex');
    const cachePath = path.join(options.aiHomeDir, 'run', 'completion', `proxy-${fingerprint}.json`);
    try {
      if (fs.statSync(cachePath).size <= MAX_BYTES) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const age = Date.now() - cached.at;
        if (age >= 0 && age < CACHE_MS) return formatCandidates(publicCandidates(cached));
      }
    } catch (_error) { /* cold or expired snapshot */ }
    // The completion resolver is synchronous. Bound both the network request
    // and its helper's entire lifetime; no credential is put in argv/output.
    const result = spawnSync(process.execPath, [__filename, '--snapshot'], {
      input: JSON.stringify(config), encoding: 'utf8', timeout: 650,
      maxBuffer: MAX_BYTES, windowsHide: true,
      env: { ...env, AIH_SERVER_MANAGEMENT_KEY: '' }
    });
    let candidates = [];
    if (!result.error && result.status === 0) {
      try { candidates = publicCandidates(JSON.parse(result.stdout)); } catch (_error) { /* invalid snapshot */ }
    }
    // A failed refresh caches an empty result, never stale readiness.
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(cachePath, JSON.stringify({ ok: true, at: Date.now(), candidates: candidates.map((row) => ({ ...row, available: true })) }), { mode: 0o600 });
    } catch (_error) { /* cache is optional */ }
    return formatCandidates(candidates);
  } catch (_error) {
    return [];
  }
}

function formatCandidates(rows) {
  const result = rows.map((row) => ({ value: row.id, description: [row.name, row.source].filter(Boolean).join(' · ') || row.id }));
  // Only unique, shell-safe labels are executable selectors. All labels remain
  // visible as descriptions even when they contain spaces or are ambiguous.
  for (const row of rows) {
    if (row.labelSelectable && row.name && row.name !== row.id && SAFE_LABEL.test(row.name)
      && !row.name.startsWith('-') && !row.name.includes('://')
      && !['auto', 'pool'].includes(row.name)
      && !rows.some((other) => other.id === row.name)
      && rows.filter((other) => other.name === row.name).length === 1) {
      result.push({ value: row.name, description: `${row.id}${row.source ? ` · ${row.source}` : ''}` });
    }
  }
  if (rows.length) result.unshift({ value: 'auto', description: '自动选择可用代理（仅本次任务）' });
  return result;
}

function readSnapshot() {
  // This helper has exactly one read-only endpoint and never follows redirects.
  // TLS uses Node's normal certificate verification; no bypass option exists.
  try {
    const config = JSON.parse(fs.readFileSync(0, 'utf8'));
    const address = new URL('/v1/management/proxy-candidates', config.baseUrl);
    const transport = require(address.protocol === 'https:' ? 'node:https' : 'node:http');
    const timer = setTimeout(() => process.exit(0), 400);
    const request = transport.get(address, { headers: { authorization: `Bearer ${config.managementKey}`, accept: 'application/json' } }, (response) => {
      if (response.statusCode !== 200) { response.destroy(); process.exit(0); return; }
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { request.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        try {
          const rows = publicCandidates(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          process.stdout.write(JSON.stringify({ ok: true, candidates: rows.map((row) => ({ ...row, available: true })) }));
        } catch (_error) { /* invalid response: no candidates */ }
      });
      response.on('error', () => process.exit(0));
    });
    request.on('error', () => process.exit(0));
  } catch (_error) { /* no diagnostics or secrets on the completion wire */ }
}

if (require.main === module && process.argv[2] === '--snapshot') readSnapshot();

module.exports = { listProxyCandidates };
