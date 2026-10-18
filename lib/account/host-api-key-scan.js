'use strict';

// 宿主 API Key 账号的**扫描入库**：只读凭据端口模块声明的 provider 专属槽位（hostApiKeySlots），
// 绝不读通用环境变量。
//
// 身份 = buildApiKeyIdentity（密钥 + 基础地址），与手工 / 标准格式导入同源，所以同一把 key
// 不会被扫成第二个账号；身份本身含密钥，「同身份」就是「同一把 key」，库里已有就不动。
// 写入语义与 OAuth 扫描一致：respectDeletion（墓碑）、只新增、aih 自写（网关地址 / client key /
// 钉选头）一律拒绝、损坏文件跳过并给出原因。

const nodePath = require('node:path');

const { MAX_ARTIFACT_BYTES } = require('./host-auth-scan');
const { isApiKeyTombstoned, listProviderApiKeyEnvNames } = require('./api-key-tombstone');

function parseDotenv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, '');
    }
    out[match[1]] = value;
  }
  return out;
}

const SLOT_PARSERS = Object.freeze({
  json: (text) => {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  },
  dotenv: parseDotenv
});

/** 声明了宿主 API Key 槽位的 provider（凭据端口注册表倒排，不维护名单）。 */
function listHostApiKeyStrategies() {
  const { CREDENTIAL_STRATEGIES, getProviderCredentialStrategy } = require('./provider-credentials');
  return CREDENTIAL_STRATEGIES
    .filter((strategy) => Array.isArray(strategy.hostApiKeySlots) && strategy.hostApiKeySlots.length > 0
      && typeof strategy.importApiKeyEnv === 'function')
    .map((strategy) => getProviderCredentialStrategy(strategy.id));
}

function readSlot(fs, file, format) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return { reason: error && error.code === 'ENOENT' ? 'absent' : 'host_credential_file_unreadable' };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { reason: 'host_credential_file_unsupported' };
  if (stat.size > MAX_ARTIFACT_BYTES) return { reason: 'host_credential_file_too_large' };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_error) {
    return { reason: 'host_credential_file_unreadable' };
  }
  const parser = SLOT_PARSERS[format];
  if (!parser) return { reason: 'host_api_key_slot_format_unsupported' };
  try {
    return { text, doc: parser(text) };
  } catch (_error) {
    return { reason: 'host_credential_file_corrupt' };
  }
}

/**
 * 库里已存同一把 API Key 的账号。变量名 = 合同 apiKeyEnv ∪ 凭据端口在每种凭据类型下实际
 * 写出的密钥变量（见 api-key-tombstone 的 listProviderApiKeyEnvNames），因此 claude 的
 * ANTHROPIC_AUTH_TOKEN 账号也比得到。读库失败按「没有」处理：后续身份登记仍会兜住同身份的重复。
 */
function findAccountWithApiKey(store, fs, aiHomeDir, provider, apiKey) {
  if (!apiKey) return '';
  const keyNames = listProviderApiKeyEnvNames(provider);
  if (keyNames.length === 0) return '';
  let records;
  try {
    records = store.listAccountCredentialRecords(fs, aiHomeDir, provider);
  } catch (_error) {
    return '';
  }
  const match = (records || []).find((record) => {
    const env = record && record.env && typeof record.env === 'object' ? record.env : {};
    return keyNames.some((name) => String(env[name] || '').trim() === apiKey);
  });
  return match ? String(match.accountRef || '') : '';
}

/** 一个槽位 → 一次入库尝试。返回形状与 scanHostAuthProjection 一致。 */
function scanHostApiKeySlot(strategy, slot, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const provider = strategy.id;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim();
  if (!hostHomeDir) return { status: 'absent', reason: 'host_home_unavailable', provider };
  const file = nodePath.join(hostHomeDir, ...slot.path);
  const guard = deps.guard;
  const pathReason = guard ? guard.rejectsPath(file) : '';
  if (pathReason) return { status: 'skipped', reason: pathReason, provider };
  const read = readSlot(fs, file, slot.format);
  if (read.reason === 'absent') return { status: 'absent', reason: 'host_api_key_missing', provider };
  if (read.reason) return { status: 'skipped', reason: read.reason, provider };
  let selected = null;
  try {
    selected = slot.select(read.doc);
  } catch (_error) {
    return { status: 'skipped', reason: 'host_credential_file_corrupt', provider };
  }
  if (!selected || !String(selected.apiKey || '').trim()) {
    return { status: 'absent', reason: 'host_api_key_missing', provider };
  }
  const guardReason = guard
    ? guard.rejectsApiKey({ apiKey: selected.apiKey, baseUrl: selected.baseUrl, rawText: read.text })
    : '';
  if (guardReason) return { status: 'skipped', reason: guardReason, provider };
  if (!aiHomeDir) return { status: 'skipped', reason: 'ai_home_dir_missing', provider };

  const env = strategy.importApiKeyEnv({
    apiKey: String(selected.apiKey).trim(),
    baseUrl: String(selected.baseUrl || '').trim(),
    credentialType: selected.credentialType || 'api-key'
  });
  const { buildApiKeyIdentity } = require('./transfer-core');
  const { normalizeIdentitySeed } = require('./account-identity');
  const identitySeed = normalizeIdentitySeed(buildApiKeyIdentity(provider, { config: env }));
  if (!identitySeed) return { status: 'skipped', reason: 'stable_identity_unavailable', provider };

  const store = require('../server/account-credential-store');
  // 同一把 key 已在库里（不论基础地址）就不再登记：宿主槽位不一定带基础地址
  // （codex 的 auth.json 只存 OPENAI_API_KEY，基础地址在 config.toml），而身份含基础地址，
  // 只按身份去重会把 `set-default` 写回宿主的中转站 key 扫成一个指向默认官方地址的新账号——
  // 既是重复账号，又会把第三方 key 发给它从未打算去的主机。
  const existingRef = findAccountWithApiKey(store, fs, aiHomeDir, provider, String(selected.apiKey).trim());
  if (existingRef) {
    return { status: 'unchanged', reason: 'existing_account_same_api_key', provider, accountRef: existingRef };
  }

  // 用户删过这把 key（不论当时的基础地址/凭据类型）：后台扫描不得把它登记回来。
  // 身份墓碑含基础地址，宿主槽位可能拼不出同一身份（codex auth.json 没有基础地址），
  // 只靠身份墓碑会把删掉的中转 key 以默认官方地址重新登记。
  if (isApiKeyTombstoned(fs, aiHomeDir, provider, String(selected.apiKey).trim())) {
    return { status: 'skipped', reason: 'account_deleted_by_user', provider };
  }

  const { registerAccountIdentity } = require('./account-registration');
  let registration;
  try {
    registration = registerAccountIdentity(fs, aiHomeDir, { provider, identitySeed, respectDeletion: true });
  } catch (error) {
    return {
      status: 'skipped',
      reason: error && error.code === 'account_deleted_by_user' ? 'account_deleted_by_user' : 'account_ref_registration_failed',
      provider
    };
  }
  const accountRef = registration.accountRef;
  const current = store.readAccountCredentials(fs, aiHomeDir, accountRef);
  if (!registration.created && current && Object.keys(current).length > 0) {
    return { status: 'unchanged', reason: 'existing_account_unchanged', provider, accountRef };
  }
  store.writeAccountCredentials(fs, aiHomeDir, accountRef, env);
  return {
    status: 'registered',
    reason: registration.created ? 'created' : 'existing_account',
    provider,
    accountRef,
    cliAccountId: String(registration.cliAccountId || ''),
    created: registration.created === true
  };
}

/** 扫描某 provider 声明的全部宿主 API Key 槽位。 */
function scanHostApiKeys(strategy, deps = {}) {
  return (strategy.hostApiKeySlots || []).map((slot) => scanHostApiKeySlot(strategy, slot, deps));
}

module.exports = { listHostApiKeyStrategies, parseDotenv, scanHostApiKeySlot, scanHostApiKeys };
