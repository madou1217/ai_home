#!/usr/bin/env node
'use strict';

// 把 Go 的静态账号（codex/claude api_key、claude auth_token）重新键到 Node 的
// account_ref，并同步重算 credential_ref（Go 静态指纹已改为 Node 的 16 位公式）。
//
// 为什么需要显式映射而不是重新派生：Node 的 account_ref 在注册时铸一次，之后改
// URL/Key 不会变；从当前凭据反推不出历史 ref。映射来源优先是 go-account-sync 的
// links（Node ref ↔ Go ref），其次按 provider+secret+base URL 匹配。
//
// 默认 dry-run；加 --apply 才写库。写库前要求服务已停止（脚本会检查 19550/9527），
// 并自动备份实际修改的 canonical SQLite 到 <aiHome>/backups/rekey-<timestamp>/。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { getBusinessDatabasePath } = require('../lib/server/business-database');
const { resolveAiHomeDir } = require('../lib/runtime/aih-home');

const DEFAULTS = Object.freeze({
  aiHomeDir: resolveAiHomeDir()
});

const STATIC_TABLES = Object.freeze([
  'accounts',
  'account_credentials',
  'account_profiles',
  'account_models',
  'account_usage',
  'account_defaults',
  'account_runtime_state',
  'account_outcomes',
  'usage_ledger'
]);

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--skip-server-check') args.skipServerCheck = true;
    else if (arg === '--go-db') args.goDb = argv[++i];
    else if (arg === '--node-db') args.nodeDb = argv[++i];
    else if (arg === '--ai-home') args.aiHomeDir = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function deriveAccountRef(seed) {
  return `acct_${sha256Hex(`unique:${seed}`).slice(0, 20)}`;
}

function deriveCredentialRef(seed) {
  return `cred_${sha256Hex(`unique:${seed}`).slice(0, 20)}`;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function staticSeed(provider, kind, secret, baseUrl) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedKind = kind === 'auth_token' ? 'auth_token' : 'api_key';
  return `${normalizedKind}:${normalizedProvider}:${normalizeBaseUrl(baseUrl)}:${sha256Hex(secret).slice(0, 16)}`;
}

function parseObject(text) {
  try {
    const value = JSON.parse(String(text || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_error) {
    return {};
  }
}

function listStaticAccounts(db) {
  const rows = db.prepare(`
    SELECT a.account_ref, a.provider_id, a.cli_account_id, a.enabled,
           a.created_at_ms, a.updated_at_ms,
           c.credential_ref, c.auth_kind, c.auth_mode, c.format_version,
           c.credential_json, c.updated_at_ms AS credential_updated_at_ms
    FROM accounts a
    JOIN account_credentials c ON c.account_ref = a.account_ref
    WHERE a.provider_id IN ('codex', 'claude')
      AND c.auth_kind IN ('api_key', 'auth_token')
    ORDER BY a.provider_id, a.account_ref
  `).all();
  return rows.map((row) => {
    const credential = parseObject(row.credential_json);
    const secret = row.auth_kind === 'auth_token'
      ? String(credential.auth_token || '')
      : String(credential.api_key || '');
    return {
      accountRef: String(row.account_ref),
      provider: String(row.provider_id),
      kind: String(row.auth_kind),
      baseUrl: String(credential.base_url || ''),
      secret,
      credential
    };
  });
}

function readSyncLinks(db) {
  const row = db.prepare("SELECT value FROM app_kv WHERE key = 'go-account-sync:state'").get();
  if (!row) return { links: {}, raw: null };
  return { links: parseObject(row.value).links || {}, raw: parseObject(row.value) };
}

function nodeStaticRecords(db, legacySource = false) {
  const credentialTable = legacySource ? 'account_credentials' : 'compat_account_credentials';
  const rows = db.prepare(`
    SELECT r.account_ref, r.provider, c.env_json
    FROM account_refs r
    LEFT JOIN ${credentialTable} c ON c.account_ref = r.account_ref
    WHERE r.provider IN ('codex', 'claude')
  `).all();
  return rows.map((row) => {
    const env = parseObject(row.env_json);
    return {
      accountRef: String(row.account_ref),
      provider: String(row.provider),
      env
    };
  });
}

function nodeSecretFor(record, provider, kind) {
  if (provider === 'codex') return String(record.env.OPENAI_API_KEY || '').trim();
  return kind === 'auth_token'
    ? String(record.env.ANTHROPIC_AUTH_TOKEN || '').trim()
    : String(record.env.ANTHROPIC_API_KEY || '').trim();
}

function nodeBaseFor(record, provider) {
  return String(provider === 'codex' ? record.env.OPENAI_BASE_URL : record.env.ANTHROPIC_BASE_URL || '').trim();
}

function buildPlan(goDb, nodeDb, legacySource = false) {
  const staticAccounts = listStaticAccounts(goDb);
  const { links } = readSyncLinks(nodeDb);
  const nodeRecords = nodeStaticRecords(nodeDb, legacySource);
  const nodeByRef = new Map(nodeRecords.map((record) => [record.accountRef, record]));
  const nodeRefByGoRef = new Map();
  for (const [nodeRef, link] of Object.entries(links)) {
    if (link && link.goRef) nodeRefByGoRef.set(String(link.goRef), nodeRef);
  }

  const plan = [];
  for (const account of staticAccounts) {
    let target = nodeRefByGoRef.get(account.accountRef) || '';
    if (!target) {
      const match = nodeRecords.find((record) => record.provider === account.provider
        && nodeSecretFor(record, account.provider, account.kind) === account.secret
        && normalizeBaseUrl(nodeBaseFor(record, account.provider)) === normalizeBaseUrl(account.baseUrl));
      target = match ? match.accountRef : '';
    }
    if (!target) {
      plan.push({ ...account, targetRef: '', reason: 'no_node_match' });
      continue;
    }
    const targetRecord = nodeByRef.get(target);
    if (!targetRecord) {
      plan.push({ ...account, targetRef: target, reason: 'target_missing' });
      continue;
    }
    const newSeed = staticSeed(account.provider, account.kind, account.secret, account.baseUrl);
    plan.push({
      ...account,
      targetRef: target,
      targetAccountRef: deriveAccountRef(newSeed),
      newCredentialRef: deriveCredentialRef(newSeed),
      reason: target === account.accountRef ? 'already_unified' : 'rekey'
    });
  }
  return plan;
}

function canonicalReferenceTables(db) {
  const tables = new Set(STATIC_TABLES);
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    const name = String(row.name).replace(/"/g, '""');
    const refs = db.prepare(`PRAGMA foreign_key_list("${name}")`).all();
    if (refs.some((ref) => ref.table === 'accounts' && ref.from === 'account_ref' && ref.to === 'account_ref')) {
      tables.add(String(row.name));
    }
  }
  return Array.from(tables);
}

function updateSyncLinks(db, rekey) {
  // 兼容投影的账号 ref 保持不变；只更新 canonical 库中的旧 Go ref 映射。
  const { raw } = readSyncLinks(db);
  if (!raw || !raw.links) return;
  let changed = false;
  for (const entry of rekey) {
    for (const link of Object.values(raw.links)) {
      if (link && link.goRef === entry.accountRef) {
        link.goRef = entry.targetRef;
        changed = true;
      }
    }
  }
  if (changed) {
    db.prepare('UPDATE app_kv SET value = ?, updated_at = ? WHERE key = ?')
      .run(JSON.stringify(raw), Date.now(), 'go-account-sync:state');
  }
}

function applyPlan(goDb, nodeDb, plan) {
  const rekey = plan.filter((entry) => entry.reason === 'rekey');
  if (rekey.length === 0) return { rekey: 0, rows: {} };
  const rows = {};
  const tables = canonicalReferenceTables(goDb);
  goDb.exec('PRAGMA foreign_keys = OFF');
  goDb.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of rekey) {
      for (const table of tables) {
        if (table === 'accounts') {
          const result = goDb.prepare('UPDATE accounts SET account_ref = ? WHERE account_ref = ?')
            .run(entry.targetRef, entry.accountRef);
          rows[table] = (rows[table] || 0) + Number(result.changes || 0);
          continue;
        }
        if (table === 'account_credentials') {
          const result = goDb.prepare(`
            UPDATE account_credentials
            SET account_ref = ?, credential_ref = ?
            WHERE account_ref = ?
          `).run(entry.targetRef, entry.newCredentialRef, entry.accountRef);
          rows[table] = (rows[table] || 0) + Number(result.changes || 0);
          continue;
        }
        const result = goDb.prepare(`UPDATE "${table.replace(/"/g, '""')}" SET account_ref = ? WHERE account_ref = ?`)
          .run(entry.targetRef, entry.accountRef);
        rows[table] = (rows[table] || 0) + Number(result.changes || 0);
      }
    }
    updateSyncLinks(goDb, rekey);
    if (goDb.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('rekey would leave foreign-key violations');
    }
    goDb.exec('COMMIT');
  } catch (error) {
    try { goDb.exec('ROLLBACK'); } catch (_rollbackError) {}
    throw error;
  } finally {
    goDb.exec('PRAGMA foreign_keys = ON');
  }

  return { rekey: rekey.length, rows };
}

function backup(aiHomeDir, databasePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(aiHomeDir, 'backups', `rekey-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${path.join(dir, 'aih.db').replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return dir;
}

function assertServerStopped() {
  for (const port of [9527, 19550]) {
    const result = require('node:child_process').spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (String(result.stdout || '').trim()) {
      throw new Error(`port ${port} is still listening; stop aih server before --apply`);
    }
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: node scripts/rekey-static-account-refs.js [--apply] [--ai-home DIR] [--go-db FILE] [--node-db OFFLINE_SOURCE]');
    return 0;
  }
  const aiHomeDir = args.aiHomeDir || DEFAULTS.aiHomeDir;
  const goDbPath = fs.realpathSync(args.goDb || getBusinessDatabasePath(aiHomeDir));
  const nodeDbPath = args.nodeDb ? fs.realpathSync(args.nodeDb) : goDbPath;
  if (args.apply && !args.skipServerCheck) assertServerStopped();
  const goDb = new DatabaseSync(goDbPath, { readOnly: !args.apply });
  let nodeDb;
  try {
    nodeDb = nodeDbPath === goDbPath ? goDb : new DatabaseSync(nodeDbPath, { readOnly: true });
    // 只有显式指定的离线源才允许读取迁移前的凭据 schema。
    const legacySource = nodeDb !== goDb && !nodeDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='compat_account_credentials'").get();
    const plan = buildPlan(goDb, nodeDb, legacySource);
    for (const entry of plan) {
      console.log([
        entry.provider,
        entry.kind,
        entry.accountRef,
        '->',
        entry.targetRef || '(none)',
        entry.reason,
        entry.reason === 'rekey' ? `cred=${entry.newCredentialRef}` : ''
      ].join(' '));
    }
    if (!args.apply) {
      console.log(`dry-run: ${plan.filter((entry) => entry.reason === 'rekey').length} account(s) would be rekeyed`);
      return 0;
    }
    const backupDir = backup(aiHomeDir, goDbPath);
    console.log(`backup: ${backupDir}`);
    const result = applyPlan(goDb, nodeDb, plan);
    console.log(`applied: ${result.rekey} account(s); rows=${JSON.stringify(result.rows)}`);
    return 0;
  } finally {
    if (nodeDb && nodeDb !== goDb) nodeDb.close();
    goDb.close();
  }
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`rekey failed: ${error && error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildPlan,
  applyPlan,
  staticSeed,
  deriveAccountRef,
  deriveCredentialRef
};
