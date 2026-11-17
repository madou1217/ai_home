#!/usr/bin/env node
'use strict';

// Build-time only. The daemon consumes the embedded result, never Node or the
// SDK at runtime. Keep the filtering identical to wildcard-alias-expansion.js.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const target = path.resolve(__dirname, '../internal/adapters/modelmetadata/aliasdisplay/alias_display_rows.json');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function packageVersion(snapshotPath) {
  for (let dir = path.dirname(snapshotPath); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (value.name === '@opencode-ai/models' && typeof value.version === 'string' && value.version.trim()) {
      return value.version;
    }
  }
  throw new Error('alias-display: SDK version is unavailable');
}

function generate() {
  const snapshotPath = require.resolve('@opencode-ai/models/snapshot');
  const sdk = require('@opencode-ai/models/snapshot');
  const snapshot = sdk.models ? sdk : sdk.default;
  if (!snapshot || !snapshot.models || Array.isArray(snapshot.models)
    || typeof snapshot.models !== 'object' || !Object.keys(snapshot.models).length) {
    throw new Error('alias-display: canonical SDK models are unavailable');
  }
  const generatedAt = String(sdk.generatedAt || snapshot.generatedAt || '').trim();
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('alias-display: SDK generatedAt is unavailable');
  }
  const byId = new Map();
  for (const model of Object.values(snapshot.models)) {
    const fullId = String(model && model.id || '').trim();
    const id = fullId.includes('/') ? fullId.slice(fullId.lastIndexOf('/') + 1) : fullId;
    const releasedAt = Date.parse(String(model && model.release_date || ''));
    if (!id || !Number.isFinite(releasedAt)) continue;
    const output = model && model.modalities && Array.isArray(model.modalities.output) ? model.modalities.output : [];
    if (output.length !== 1 || output[0] !== 'text' || model.tool_call !== true) continue;
    const existing = byId.get(id);
    if (existing && existing.releasedAt >= releasedAt) continue;
    byId.set(id, { id, family: String(model.family || '').trim() || id, releasedAt });
  }
  // Store Node's localeCompare ordering once so Go preserves both ID and family
  // tiebreakers without a platform-dependent locale or an additional dependency.
  const rows = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (!rows.length) throw new Error('alias-display: eligible SDK rows are empty');
  const families = [...new Set(rows.map((row) => row.family))].sort((a, b) => a.localeCompare(b));
  const payload = { families, rows };
  const document = {
    schemaVersion: 1,
    source: {
      package: '@opencode-ai/models',
      sdkVersion: packageVersion(snapshotPath),
      generatedAt,
      sourceHash: sha256(JSON.stringify(snapshot.models)),
      snapshotFileHash: sha256(fs.readFileSync(snapshotPath)),
      policyVersion: 1,
      collation: 'node-localeCompare',
    },
    payloadHash: sha256(JSON.stringify(payload)),
    ...payload,
  };
  const content = `${JSON.stringify(document, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
      throw new Error('alias-display: generated snapshot differs; run node scripts/gen-alias-display.js');
    }
  } else {
    const temporary = `${target}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temporary, content, { flag: 'wx' });
      fs.renameSync(temporary, target);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  console.log(`[alias-display] SDK ${document.source.sdkVersion}, ${rows.length} rows, generatedAt ${generatedAt}, source ${document.source.sourceHash}`);
}

if (process.argv.slice(2).some((arg) => arg !== '--check')) {
  throw new Error('usage: node scripts/gen-alias-display.js [--check]');
}
generate();
