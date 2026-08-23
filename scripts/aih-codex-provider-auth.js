#!/usr/bin/env node
'use strict';

// codex model_providers.<id>.auth 命令表的取 key 入口：向 stdout 输出恰好一个
// bearer token，供 codex 按需调用（refresh_interval_ms 控制缓存）。取值优先级：
// 1) 环境变量 OPENAI_API_KEY 已注入（网关 client key / 调用方显式指定）→ 直通；
// 2) AIH_PROVIDER_ACCOUNT_REF（aih 启动链注入的选中账号）→ 该账号的 key；
// 3) aih 默认 codex 账号 → 其 key（裸跑 codex 的闭环来源）。
// 与 env_key 互斥（codex 0.149 实测：auth 表与 env_key 并存直接拒绝加载配置），
// 因此受管 provider 块只保留 auth 表一种认证形态。

const fs = require('node:fs');
const path = require('node:path');
const { resolveHostHomeDir } = require('../lib/runtime/host-home');
const { readAccountCredentialRecord } = require('../lib/server/account-credential-store');
const { readDefaultAccountRef } = require('../lib/account/default-account-store');

function fail(message) {
  process.stderr.write(`[aih-codex-provider-auth] ${message}\n`);
  process.exit(1);
}

const envKey = String(process.env.OPENAI_API_KEY || '').trim();
function auditLog(tier, detail) {
  try {
    const logDir = path.join(aiHomeDirForLog(), 'run', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'codex-provider-auth.log'),
      `${new Date().toISOString()} tier=${tier} ${detail}\n`);
  } catch (_error) {}
}
function aiHomeDirForLog() {
  const explicit = String(process.env.AIH_HOME_DIR || process.env.AIH_HOME || process.env.AI_HOME || '').trim();
  if (explicit) return explicit;
  const home = resolveHostHomeDir({ env: process.env, platform: process.platform });
  return home ? path.join(home, '.ai_home') : '';
}
if (envKey) {
  auditLog('env-passthrough', 'len=' + envKey.length);
  process.stdout.write(envKey);
  return;
}

const hostHomeDir = resolveHostHomeDir({
  env: process.env,
  platform: process.platform
});
const explicitAiHomeDir = String(
  process.env.AIH_HOME_DIR || process.env.AIH_HOME || process.env.AI_HOME || ''
).trim();
const aiHomeDir = explicitAiHomeDir || (hostHomeDir ? path.join(hostHomeDir, '.ai_home') : '');
if (!aiHomeDir) fail('cannot resolve ai-home directory');

const accountRef = String(process.env.AIH_PROVIDER_ACCOUNT_REF || '').trim()
  || readDefaultAccountRef(fs, aiHomeDir, 'codex');
if (!accountRef) {
  auditLog('fail', 'no account selected');
  fail('no codex account selected (set AIH_PROVIDER_ACCOUNT_REF or aih codex set-default)');
}

const record = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
const accountKey = record && record.env && String(record.env.OPENAI_API_KEY || '').trim();
if (!accountKey) {
  auditLog('fail', 'account has no OPENAI_API_KEY');
  fail(`codex account ${accountRef} has no OPENAI_API_KEY credential`);
}
auditLog(String(process.env.AIH_PROVIDER_ACCOUNT_REF || '').trim() ? 'account-ref' : 'default-account',
  'ref=' + accountRef + ' len=' + accountKey.length);
process.stdout.write(accountKey);
