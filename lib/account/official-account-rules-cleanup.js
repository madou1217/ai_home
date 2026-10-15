'use strict';

// 一次性迁移：清掉「官方上游 / OAuth 账号」上不该存在的账号级调度规则。
//
// ## 会改哪些数据
//
// 只动账号凭据表 `account_credentials.env_json` 里的两个键：
//   · `AIH_UPSTREAM_ERROR_RULES`      账号直接配置的上游错误识别规则
//   · `AIH_UPSTREAM_ERROR_GROUP_IDS`  该账号挂载的异常映射分组
// 其它键（API key / base URL / OAuth 相关 env）、`native_auth_json`、账号状态、用量快照
// 一律不碰；规则内容在写入前先备份成 JSON 文件，可人工恢复。
//
// ## 为什么必须改
//
// 2026-10-15 起「编辑调度规则」只对**第三方/自建上游的 API Key 账号**开放（官方端点返回
// 厂商标准错误码，内置启发式已覆盖，没有可对齐的东西，见 official-upstream-endpoint）。
// 于是此前配在 OAuth 账号、或指向官方地址的 API Key 账号上的规则变成了**死配置**：
//   · 界面上再也没有入口可以编辑或清空它们；
//   · 它们仍在运行态求值、并被推进 Go 的规则投影（`upstream-error-rules-projection`），
//     徒增「配置存在但永不命中」的排查噪音。
// 迁移就是把这类账号的这两个键删掉，让「能配规则 = 规则有意义」重新成立。
//
// ## 边界
//
//   · 第三方/自建上游的 API Key 账号**原样保留**（规则在那里是有效的）。
//   · 判定复用 `isCustomUpstreamAccount`（唯一事实来源），不另写一套主机名规则。
//   · 幂等：再跑一次不会有任何账号被列入计划。
//   · 默认只演练；`apply` 才写库，且先写备份文件。

const path = require('node:path');
const {
  listAccountCredentialRecords,
  writeAccountCredentials
} = require('../server/account-credential-store');
const { readProviderBaseUrl } = require('./provider-credential-env');
const { isCustomUpstreamAccount, readUpstreamHost } = require('./official-upstream-endpoint');
const { detectStoredApiKeyMode } = require('../server/webui-account-routes-state');

const ERROR_RULES_ENV_KEY = 'AIH_UPSTREAM_ERROR_RULES';
const ERROR_RULE_GROUP_IDS_ENV_KEY = 'AIH_UPSTREAM_ERROR_GROUP_IDS';
const BACKUP_DIR_NAME = 'migrations';

function readJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function describeReason(apiKeyMode, baseUrl) {
  if (!apiKeyMode) return 'oauth_login';
  const host = readUpstreamHost(baseUrl);
  return host ? `official_host:${host}` : 'official_default_endpoint';
}

/**
 * 只读演练：列出「哪些账号的规则要被清掉、哪些保留」。
 * 不写任何东西，可安全地对真实库反复运行。
 */
function planOfficialAccountRulesCleanup(options = {}) {
  const fs = options.fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!fs || !aiHomeDir) throw new Error('official_account_rules_cleanup_missing_ai_home_dir');
  const accountStateIndex = options.accountStateIndex || null;
  const records = listAccountCredentialRecords(fs, aiHomeDir);
  const planned = [];
  const kept = [];
  let accountsWithRules = 0;
  for (const record of records) {
    const env = record && record.env && typeof record.env === 'object' ? record.env : {};
    const rules = readJsonArray(env[ERROR_RULES_ENV_KEY]);
    const groupIds = readJsonArray(env[ERROR_RULE_GROUP_IDS_ENV_KEY]);
    if (rules.length < 1 && groupIds.length < 1) continue;
    accountsWithRules += 1;
    const provider = String(record.provider || '').trim().toLowerCase();
    const baseUrl = readProviderBaseUrl(provider, env);
    const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
      ? accountStateIndex.getAccountState(record.accountRef)
      : null;
    const apiKeyMode = detectStoredApiKeyMode(
      { fs, aiHomeDir, deps: { aiHomeDir } },
      provider,
      record.accountRef,
      stateRow
    );
    const entry = {
      provider,
      accountRef: record.accountRef,
      ruleCount: rules.length,
      groupIds,
      apiKeyMode,
      baseUrlHost: readUpstreamHost(baseUrl)
    };
    if (isCustomUpstreamAccount({ provider, apiKeyMode, baseUrl })) {
      kept.push(entry);
      continue;
    }
    planned.push({ ...entry, reason: describeReason(apiKeyMode, baseUrl) });
  }
  return {
    aiHomeDir,
    scannedAccounts: records.length,
    accountsWithRules,
    planned,
    kept
  };
}

/**
 * 执行清理：把计划里每个账号的两个键删掉（其余 env 原样保留），并先写一份备份。
 * 幂等：计划为空的账号不会产生任何写入。
 */
function applyOfficialAccountRulesCleanup(options = {}) {
  const fs = options.fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!fs || !aiHomeDir) throw new Error('official_account_rules_cleanup_missing_ai_home_dir');
  const plan = options.plan || planOfficialAccountRulesCleanup({
    fs,
    aiHomeDir,
    accountStateIndex: options.accountStateIndex
  });
  const nowMs = Number(options.nowMs) > 0 ? Number(options.nowMs) : Date.now();
  const applied = [];
  const failed = [];
  let backupFile = '';
  if (plan.planned.length > 0) {
    // 备份要能人工恢复，所以存的是被删掉的原始值（含规则全文与分组 id）。
    const recordsByProvider = new Map();
    const readEnv = (provider, accountRef) => {
      if (!recordsByProvider.has(provider)) {
        recordsByProvider.set(provider, listAccountCredentialRecords(fs, aiHomeDir, provider));
      }
      const record = recordsByProvider.get(provider).find((candidate) => candidate.accountRef === accountRef);
      return record ? record.env || {} : {};
    };
    backupFile = path.join(aiHomeDir, 'run', BACKUP_DIR_NAME, `${nowMs}-official-account-error-rules.json`);
    const backup = {
      createdAt: nowMs,
      reason: '调度规则只对第三方/自建上游的 API Key 账号开放（见 lib/account/official-upstream-endpoint.js）',
      accounts: plan.planned.map((entry) => ({
        provider: entry.provider,
        accountRef: entry.accountRef,
        reason: entry.reason,
        [ERROR_RULES_ENV_KEY]: readJsonArray(readEnv(entry.provider, entry.accountRef)[ERROR_RULES_ENV_KEY]),
        [ERROR_RULE_GROUP_IDS_ENV_KEY]: entry.groupIds
      }))
    };
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), { mode: 0o600 });
  }
  for (const entry of plan.planned) {
    try {
      const record = listAccountCredentialRecords(fs, aiHomeDir, entry.provider)
        .find((candidate) => candidate.accountRef === entry.accountRef);
      if (!record) {
        failed.push({ ...entry, error: 'credential_record_missing' });
        continue;
      }
      const nextEnv = { ...record.env };
      delete nextEnv[ERROR_RULES_ENV_KEY];
      delete nextEnv[ERROR_RULE_GROUP_IDS_ENV_KEY];
      const written = writeAccountCredentials(fs, aiHomeDir, entry.accountRef, nextEnv, {
        preserveCredentialTimestamp: true
      });
      if (!written) {
        failed.push({ ...entry, error: 'write_failed' });
        continue;
      }
      applied.push(entry);
    } catch (error) {
      failed.push({ ...entry, error: String((error && error.message) || error || 'unknown') });
    }
  }
  return { ...plan, applied, failed, backupFile };
}

module.exports = {
  ERROR_RULES_ENV_KEY,
  ERROR_RULE_GROUP_IDS_ENV_KEY,
  applyOfficialAccountRulesCleanup,
  planOfficialAccountRulesCleanup
};

