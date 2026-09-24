'use strict';

// Node -> Go 账号迁移（P1）：plan（演练 + 账本）/ apply（导入）/ verify（逐账号核对）。
//
// - plan 只读 app-state.db，把全部账号导入一个临时 AIH_HOME 下的一次性 Go Server。
//   Go 自己的校验与身份派生给出真实结论和真实 accountRef，账本因此不依赖 JS 对 Go 的猜测；
//   真实 aih.db 与 app-state.db 均不被写入。
// - apply 要求 Node 账号自 plan 以来未变（源指纹一致），按账本导入真实 AIH_HOME，
//   并同步启停状态与 Provider 默认账号；任一账号的 Go accountRef 与账本不一致即中止。
// - verify 只读 aih.db，逐账号核对凭据、工作区、启停、默认账号与数量。

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const { readNodeAccounts } = require('./node-account-reader');
const { translateNodeAccount } = require('./go-import-translator');
const { createGoManagementClient } = require('./go-management-client');
const { readGoAccounts } = require('./go-account-store-reader');
const { startGoServerProcess } = require('./go-server-process');

const LEDGER_SCHEMA_VERSION = 1;
const LEDGER_RELATIVE_PATH = nodePath.join('migration', 'go-account-ledger.json');

const RESOLUTION = Object.freeze({
  sameRef: 'same_ref',
  rekeyed: 'rekeyed',
  merged: 'merged_into_existing',
  unsupported: 'unsupported_in_go',
  rejected: 'rejected_by_go'
});

function ledgerPath(aiHomeDir) {
  return nodePath.join(aiHomeDir, LEDGER_RELATIVE_PATH);
}

function writeLedger(aiHomeDir, ledger) {
  const file = ledgerPath(aiHomeDir);
  fs.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

function readLedger(aiHomeDir) {
  return JSON.parse(fs.readFileSync(ledgerPath(aiHomeDir), 'utf8'));
}

// 把一次导入的 HTTP 结果归类为账本条目。静态凭据创建（Claude Auth Token）在同身份已存在时
// 返回 409 且不带 accountRef：此时用 JS 复刻的 Go 身份（契约向量守卫）点查确认，确认存在才采用。
async function resolveImportOutcome(client, plan, result, seenGoRefs) {
  let goRef = result.ok && result.data && result.data.account_ref ? String(result.data.account_ref) : '';
  if (!goRef && result.status === 409 && result.errorCode === 'account_conflict' && plan.predictedGoRef) {
    const existing = await client.getAccount(plan.predictedGoRef);
    if (existing.ok && existing.data && existing.data.provider_id === plan.provider) goRef = plan.predictedGoRef;
  }
  if (!goRef) return { goRef: '', resolution: RESOLUTION.rejected, reason: result.errorCode || `http_${result.status}` };
  if (seenGoRefs.has(goRef)) {
    return { goRef, resolution: RESOLUTION.merged, reason: `same Go identity as ${seenGoRefs.get(goRef)}` };
  }
  return { goRef, resolution: goRef === plan.nodeRef ? RESOLUTION.sameRef : RESOLUTION.rekeyed, reason: '' };
}

async function importAll(client, plans) {
  const entries = [];
  const seenGoRefs = new Map();
  for (const plan of plans) {
    const base = {
      old_account_ref: plan.nodeRef,
      provider: plan.provider,
      cli_account_id: plan.cliAccountId,
      enabled: plan.status !== 'down'
    };
    if (plan.kind !== 'import') {
      entries.push({ ...base, new_account_ref: '', resolution: RESOLUTION.unsupported, reason: plan.reason });
      continue;
    }
    const result = await client.send(plan.request);
    const outcome = await resolveImportOutcome(client, plan, result, seenGoRefs);
    if (outcome.goRef && !seenGoRefs.has(outcome.goRef)) seenGoRefs.set(outcome.goRef, plan.nodeRef);
    entries.push({
      ...base,
      new_account_ref: outcome.goRef,
      resolution: outcome.resolution,
      reason: outcome.reason,
      auth_class: plan.authClass,
      predicted_account_ref: plan.predictedGoRef || '',
      prediction_matches: Boolean(outcome.goRef) && outcome.goRef === plan.predictedGoRef,
      lossy_fields: plan.lossy,
      workspace: plan.workspace
    });
  }
  return entries;
}

function buildPlans(source, options) {
  const exportedAt = (options.now || new Date()).toISOString();
  return source.accounts.map((record) => ({
    ...translateNodeAccount(record, { exportedAt }),
    cliAccountId: record.cliAccountId,
    status: record.status
  }));
}

function summarize(entries) {
  const summary = { total: entries.length };
  for (const value of Object.values(RESOLUTION)) summary[value] = 0;
  for (const entry of entries) summary[entry.resolution] += 1;
  return summary;
}

function mapDefaults(sourceDefaults, entries) {
  const byNodeRef = new Map(entries.map((entry) => [entry.old_account_ref, entry]));
  const defaults = {};
  for (const [provider, nodeRef] of Object.entries(sourceDefaults)) {
    const entry = byNodeRef.get(nodeRef);
    defaults[provider] = {
      old_account_ref: nodeRef,
      new_account_ref: entry && entry.new_account_ref ? entry.new_account_ref : '',
      migratable: Boolean(entry && entry.new_account_ref && entry.enabled)
    };
  }
  return defaults;
}

async function withGoServer(options, callback) {
  if (options.goUrl) {
    return callback(createGoManagementClient({ baseUrl: options.goUrl, managementKey: options.goManagementKey, fetchImpl: options.fetchImpl }));
  }
  const server = await startGoServerProcess({ binaryPath: options.goBinary, aiHomeDir: options.goHome, env: options.goEnv });
  try {
    return await callback(createGoManagementClient({ baseUrl: server.baseUrl, managementKey: server.managementKey, fetchImpl: options.fetchImpl }));
  } finally {
    await server.stop();
  }
}

/** plan：只读演练，写出账本；不写真实 aih.db / app-state.db。 */
async function planAccountMigration(options = {}) {
  const aiHomeDir = options.aiHomeDir;
  const source = readNodeAccounts(aiHomeDir);
  const plans = buildPlans(source, options);
  const scratchHome = fs.mkdtempSync(nodePath.join(options.scratchDir || os.tmpdir(), 'aih-go-migration-plan-'));
  let entries;
  try {
    entries = await withGoServer({ ...options, goUrl: '', goHome: scratchHome }, (client) => importAll(client, plans));
  } finally {
    fs.rmSync(scratchHome, { recursive: true, force: true });
  }
  const ledger = {
    schema_version: LEDGER_SCHEMA_VERSION,
    kind: 'node-to-go-account-migration',
    generated_at: (options.now || new Date()).toISOString(),
    source_fingerprint: source.fingerprint,
    summary: summarize(entries),
    defaults: mapDefaults(source.defaults, entries),
    entries
  };
  const file = options.writeLedger === false ? '' : writeLedger(aiHomeDir, ledger);
  return { ledger, file };
}

/** apply：Node 账号自 plan 以来未变时，按账本导入真实 AIH_HOME 并同步启停与默认账号。 */
async function applyAccountMigration(options = {}) {
  const aiHomeDir = options.aiHomeDir;
  const ledger = options.ledger || readLedger(aiHomeDir);
  const source = readNodeAccounts(aiHomeDir);
  if (source.fingerprint !== ledger.source_fingerprint) {
    const error = new Error('Node accounts changed since the ledger was planned; run plan again');
    error.code = 'ledger_stale';
    throw error;
  }
  const plans = buildPlans(source, options);
  return withGoServer({ ...options, goHome: aiHomeDir }, async (client) => {
    const entries = await importAll(client, plans);
    const expected = new Map(ledger.entries.map((entry) => [entry.old_account_ref, entry.new_account_ref]));
    const drift = entries.filter((entry) => entry.new_account_ref !== (expected.get(entry.old_account_ref) || ''));
    if (drift.length > 0) {
      const error = new Error(`Go account refs differ from the ledger for ${drift.length} account(s)`);
      error.code = 'ledger_ref_drift';
      error.drift = drift.map((entry) => entry.old_account_ref);
      throw error;
    }
    const failures = [];
    const primaryEntries = entries.filter((entry) => entry.new_account_ref && entry.resolution !== RESOLUTION.merged);
    for (const entry of primaryEntries) {
      const result = await client.setEnabled(entry.new_account_ref, entry.enabled);
      if (!result.ok) failures.push({ account_ref: entry.new_account_ref, step: 'enabled', error: result.errorCode });
    }
    for (const [provider, target] of Object.entries(ledger.defaults || {})) {
      if (!target.migratable) continue;
      const result = await client.setProviderDefault(provider, target.new_account_ref);
      if (!result.ok) failures.push({ provider, step: 'default', error: result.errorCode });
    }
    return { summary: summarize(entries), failures, entries };
  });
}

function equalJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
  }
  return value;
}

// 按认证类型核对 Go 持久化的凭据与 Node 源凭据逐字段一致。
function credentialMismatches(plan, goAccount) {
  const credential = goAccount.credential || {};
  const secrets = plan.secrets || {};
  const problems = [];
  const expectField = (field, expected) => {
    if ((credential[field] || '') !== (expected || '')) problems.push(field);
  };
  if (plan.provider === 'codex' && plan.authClass === 'oauth') {
    expectField('access_token', secrets.accessToken);
    expectField('refresh_token', secrets.refreshToken);
    expectField('id_token', secrets.idToken);
    expectField('explicit_account_id', plan.workspace && plan.workspace.upstreamAccountId);
    if ((goAccount.profile.account_id || '') !== (plan.workspace && plan.workspace.workspaceId)) problems.push('workspace');
  } else if (plan.authClass === 'api_key') {
    expectField('api_key', secrets.apiKey);
    expectField('base_url', secrets.baseUrl);
  } else if (plan.authClass === 'auth_token') {
    expectField('auth_token', secrets.authToken);
    expectField('base_url', secrets.baseUrl);
  } else if (plan.provider === 'claude' && plan.authClass === 'oauth') {
    expectField('access_token', secrets.accessToken);
    expectField('refresh_token', secrets.refreshToken);
  } else if (plan.provider === 'agy') {
    const token = (secrets.nativeAuth && secrets.nativeAuth.oauthToken && secrets.nativeAuth.oauthToken.token) || {};
    expectField('access_token', token.access_token);
    expectField('refresh_token', token.refresh_token);
  } else if (plan.authClass === 'native') {
    if (!equalJson(credential.native_auth_json, secrets.nativeAuth)) problems.push('native_auth_json');
  }
  return problems;
}

/** verify：只读核对 aih.db 与 Node 源账号；返回 {ok, problems, counts}。 */
function verifyAccountMigration(options = {}) {
  const aiHomeDir = options.aiHomeDir;
  const ledger = options.ledger || readLedger(aiHomeDir);
  const source = readNodeAccounts(aiHomeDir);
  const plans = new Map(buildPlans(source, options).map((plan) => [plan.nodeRef, plan]));
  const go = readGoAccounts(aiHomeDir);
  const goByRef = new Map(go.accounts.map((account) => [account.accountRef, account]));
  const problems = [];
  const migrated = ledger.entries.filter((entry) => entry.new_account_ref);
  const expectedGoRefs = new Set(migrated.map((entry) => entry.new_account_ref));

  for (const entry of migrated) {
    const goAccount = goByRef.get(entry.new_account_ref);
    const plan = plans.get(entry.old_account_ref);
    if (!goAccount) { problems.push({ account_ref: entry.new_account_ref, problem: 'missing_in_go' }); continue; }
    if (!plan || plan.kind !== 'import') { problems.push({ account_ref: entry.old_account_ref, problem: 'missing_in_node' }); continue; }
    if (goAccount.provider !== entry.provider) problems.push({ account_ref: entry.new_account_ref, problem: 'provider' });
    if (entry.resolution !== RESOLUTION.merged) {
      if (goAccount.enabled !== entry.enabled) problems.push({ account_ref: entry.new_account_ref, problem: 'enabled' });
      for (const field of credentialMismatches(plan, goAccount)) {
        problems.push({ account_ref: entry.new_account_ref, problem: `credential:${field}` });
      }
    }
  }
  for (const [provider, target] of Object.entries(ledger.defaults || {})) {
    if (target.migratable && go.defaults[provider] !== target.new_account_ref) problems.push({ provider, problem: 'default' });
  }
  const extraInGo = go.accounts.filter((account) => !expectedGoRefs.has(account.accountRef)).map((account) => account.accountRef);
  const counts = {
    node_accounts: source.accounts.length,
    ledger_migrated: migrated.length,
    unique_go_accounts_expected: expectedGoRefs.size,
    go_accounts_present: go.accounts.filter((account) => expectedGoRefs.has(account.accountRef)).length,
    go_accounts_total: go.accounts.length,
    go_only_accounts: extraInGo.length
  };
  if (counts.go_accounts_present !== counts.unique_go_accounts_expected) problems.push({ problem: 'count_mismatch', counts });
  if (source.fingerprint !== ledger.source_fingerprint) problems.push({ problem: 'node_changed_since_plan' });
  return { ok: problems.length === 0, problems, counts, go_only_accounts: extraInGo };
}

module.exports = {
  LEDGER_RELATIVE_PATH,
  RESOLUTION,
  applyAccountMigration,
  planAccountMigration,
  readLedger,
  verifyAccountMigration
};
