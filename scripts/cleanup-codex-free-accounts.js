#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveHostHomeDir } = require('../lib/runtime/host-home');
const { createAccountStatusChecker } = require('../lib/cli/services/account/status');
const {
  USAGE_SNAPSHOT_SCHEMA_VERSION,
  USAGE_SOURCE_CODEX
} = require('../lib/cli/config/constants');

const CODEx_CONFIG = { codex: { globalDir: '.codex' } };
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const out = {
    apply: false,
    json: false,
    homeDir: '',
    profilesDir: '',
    cliproxyapiAuthDir: '',
    resetDays: 5
  };

  const items = Array.isArray(argv) ? argv.slice(2) : [];
  for (let i = 0; i < items.length; i += 1) {
    const token = String(items[i] || '').trim();
    if (!token) continue;
    if (token === '--apply') {
      out.apply = true;
      continue;
    }
    if (token === '--json') {
      out.json = true;
      continue;
    }
    if (token === '--home') {
      out.homeDir = String(items[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token === '--profiles-dir') {
      out.profilesDir = String(items[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token === '--cliproxyapi-auth-dir') {
      out.cliproxyapiAuthDir = String(items[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token === '--reset-days') {
      out.resetDays = Number(items[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`unknown_arg:${token}`);
  }

  if (!Number.isFinite(out.resetDays) || out.resetDays <= 0) {
    throw new Error('invalid_reset_days');
  }
  return out;
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
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

function extractCodexIdentity(authJson) {
  const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object'
    ? authJson.tokens
    : null;
  if (!tokens) return { email: '', accountId: '' };
  const idPayload = decodeJwtPayloadUnsafe(tokens.id_token);
  const accessPayload = decodeJwtPayloadUnsafe(tokens.access_token);
  const email = String(
    (idPayload && idPayload.email)
    || (accessPayload && accessPayload.email)
    || (accessPayload && accessPayload['https://api.openai.com/profile'] && accessPayload['https://api.openai.com/profile'].email)
    || ''
  ).trim().toLowerCase();
  const accountId = String(tokens.account_id || '').trim().toLowerCase();
  return { email, accountId };
}

function parseDurationMsFromResetIn(resetInText) {
  const text = String(resetInText || '').trim().toLowerCase();
  if (!text || text === 'unknown' || text === 'soon' || text === 'mock') return null;
  const re = /(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)/g;
  let totalMs = 0;
  let matched = false;
  let m = null;
  while ((m = re.exec(text)) !== null) {
    matched = true;
    const value = Number(m[1]);
    const unit = String(m[2] || '');
    if (!Number.isFinite(value) || value < 0) continue;
    if (unit.startsWith('d')) totalMs += value * DAY_MS;
    else if (unit.startsWith('h')) totalMs += value * 60 * 60 * 1000;
    else if (unit.startsWith('m')) totalMs += value * 60 * 1000;
    else if (unit.startsWith('s')) totalMs += value * 1000;
  }
  if (!matched || totalMs <= 0) return null;
  return totalMs;
}

function deriveResetAtMsFromEntry(entry, capturedAt) {
  const direct = Number(entry && entry.resetAtMs);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const base = Number(capturedAt);
  if (!Number.isFinite(base) || base <= 0) return null;
  const fromText = parseDurationMsFromResetIn(entry && entry.resetIn);
  if (!Number.isFinite(fromText) || fromText <= 0) return null;
  return base + fromText;
}

function isTrustedCodexUsageSnapshot(snapshot) {
  return !!(
    snapshot
    && snapshot.schemaVersion === USAGE_SNAPSHOT_SCHEMA_VERSION
    && snapshot.kind === 'codex_oauth_status'
    && snapshot.source === USAGE_SOURCE_CODEX
    && Number.isFinite(Number(snapshot.capturedAt))
    && Array.isArray(snapshot.entries)
  );
}

function isFreeOauthAccount(profileDir) {
  return !fs.existsSync(path.join(profileDir, '.aih_env.json'));
}

function checkAuthFailure(checkStatus, profileDir) {
  const status = checkStatus('codex', profileDir);
  return !status.configured;
}

function checkLongResetExhausted(usagePath, resetDays) {
  const snapshot = readJsonFileSafe(usagePath);
  if (!isTrustedCodexUsageSnapshot(snapshot)) return false;
  const entries = snapshot.entries
    .map((entry) => ({
      remainingPct: Number(entry && entry.remainingPct),
      resetAtMs: deriveResetAtMsFromEntry(entry, snapshot.capturedAt)
    }))
    .filter((entry) => Number.isFinite(entry.remainingPct));
  if (entries.length === 0) return false;
  const minRemaining = Math.min(...entries.map((entry) => entry.remainingPct));
  if (minRemaining > 0) return false;
  const farthestResetAtMs = Math.max(...entries.map((entry) => Number(entry.resetAtMs) || -1));
  if (!Number.isFinite(farthestResetAtMs) || farthestResetAtMs <= 0) return false;
  return farthestResetAtMs - Date.now() > resetDays * DAY_MS;
}

function resolveCliproxyapiAuthDir(homeDir, explicitAuthDir) {
  if (explicitAuthDir) return explicitAuthDir;
  const configCandidates = [
    path.join(homeDir, '.cli-proxy-api', 'config.yaml'),
    path.join(homeDir, '.cli-proxy-api', 'config.yml')
  ];
  const configPath = configCandidates.find((candidate) => fs.existsSync(candidate)) || '';
  if (!configPath) return path.join(homeDir, '.cli-proxy-api');
  const lines = String(fs.readFileSync(configPath, 'utf8') || '').split(/\r?\n/);
  for (const line of lines) {
    if (!/^\s*auth-dir\s*:/.test(line)) continue;
    const raw = line.replace(/^\s*auth-dir\s*:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
    if (raw === '~') return homeDir;
    if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homeDir, raw.slice(2));
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(path.dirname(configPath), raw);
  }
  return path.join(homeDir, '.cli-proxy-api');
}

function listNumericDirs(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a) - Number(b));
}

function collectCliproxyapiMatches(authDir, identities) {
  if (!fs.existsSync(authDir)) return [];
  const wantedEmails = new Set(identities.map((item) => item.email).filter(Boolean));
  const wantedAccountIds = new Set(identities.map((item) => item.accountId).filter(Boolean));
  if (wantedEmails.size === 0 && wantedAccountIds.size === 0) return [];

  return fs.readdirSync(authDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(authDir, entry.name);
      const payload = readJsonFileSafe(filePath);
      return { filePath, payload };
    })
    .filter((entry) => entry.payload && String(entry.payload.type || '').trim().toLowerCase() === 'codex')
    .filter((entry) => {
      const email = String(entry.payload.email || '').trim().toLowerCase();
      const accountId = String(entry.payload.account_id || '').trim().toLowerCase();
      return wantedEmails.has(email) || wantedAccountIds.has(accountId);
    })
    .map((entry) => entry.filePath);
}

function main() {
  const args = parseArgs(process.argv);
  const homeDir = args.homeDir || resolveHostHomeDir({ env: process.env, platform: process.platform });
  const profilesDir = args.profilesDir || path.join(homeDir, '.ai_home', 'profiles');
  const codexProfilesDir = path.join(profilesDir, 'codex');
  const cliproxyapiAuthDir = resolveCliproxyapiAuthDir(homeDir, args.cliproxyapiAuthDir);
  const checkStatus = createAccountStatusChecker({
    fs,
    path,
    BufferImpl: Buffer,
    cliConfigs: CODEx_CONFIG
  });

  const candidates = [];
  const identities = [];
  listNumericDirs(codexProfilesDir).forEach((id) => {
    const profileDir = path.join(codexProfilesDir, id);
    if (!isFreeOauthAccount(profileDir)) return;

    const reasons = [];
    if (checkAuthFailure(checkStatus, profileDir)) reasons.push('auth_failed');
    const usagePath = path.join(profileDir, '.aih_usage.json');
    if (checkLongResetExhausted(usagePath, args.resetDays)) reasons.push(`remaining_0_reset_gt_${args.resetDays}d`);
    if (reasons.length === 0) return;

    const authPath = path.join(profileDir, '.codex', 'auth.json');
    const identity = extractCodexIdentity(readJsonFileSafe(authPath));
    identities.push(identity);
    candidates.push({
      id,
      profileDir,
      reasons,
      email: identity.email || '',
      accountId: identity.accountId || ''
    });
  });

  const cliproxyapiMatches = collectCliproxyapiMatches(cliproxyapiAuthDir, identities);
  const summary = {
    apply: args.apply,
    homeDir,
    profilesDir: codexProfilesDir,
    cliproxyapiAuthDir,
    candidates,
    cliproxyapiMatches
  };

  if (args.apply) {
    candidates.forEach((item) => {
      if (fs.existsSync(item.profileDir)) fs.rmSync(item.profileDir, { recursive: true, force: true });
    });
    cliproxyapiMatches.forEach((filePath) => {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  console.log(`[cleanup] mode=${args.apply ? 'apply' : 'dry-run'}`);
  console.log(`[cleanup] codex_candidates=${candidates.length}`);
  candidates.forEach((item) => {
    const identity = item.email || item.accountId || 'unknown';
    console.log(`  - codex#${item.id} ${identity} reasons=${item.reasons.join(',')}`);
  });
  console.log(`[cleanup] cliproxyapi_matches=${cliproxyapiMatches.length}`);
  cliproxyapiMatches.forEach((filePath) => console.log(`  - ${filePath}`));
}

try {
  main();
} catch (error) {
  console.error(`[cleanup] ${error.message}`);
  process.exit(1);
}
