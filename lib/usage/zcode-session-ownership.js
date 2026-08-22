'use strict';

// zcode CLI 的会话/用量库（~/.zcode/cli/db/db.sqlite）是跨账号共享的
// （zcode-shared-session-store 把每个账号投影的 cli/ 链回宿主同一份），
// 库内没有账号身份字段。归属策略（诚实降级，宁可不上柱状图也不错记）：
//   - 恰好 1 个 OAuth 计划账号 → 全部 usage 归它（当前现实拓扑，精确）；
//   - 0 个 OAuth 账号 → accountRef 留空（记录仍进模型用量页，不进账号柱状图）；
//   - ≥2 个 OAuth 账号 → 共享库无法区分写入者，accountRef 留空，避免错记/重复记。
// API-key 账号不参与判定：其推理走网关 relay，由网关记账，不落这份本地库。

const { listAccountRefRecords } = require('../server/account-ref-store');
const { readAccountCredentialRecord } = require('../server/account-credential-store');

function isZcodeApiKeyAccount(record) {
  return Boolean(record
    && record.env
    && String(record.env.ZCODE_API_KEY || '').trim());
}

/**
 * 解析 zcode 用量扫描的账号归属。
 * 返回 { accountRef, mode: 'single'|'none'|'ambiguous', oauthAccountCount }。
 */
function resolveZcodeUsageAttribution(options = {}) {
  const fs = options.fs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!fs || !aiHomeDir) {
    return { accountRef: '', mode: 'none', oauthAccountCount: 0 };
  }

  const listAccounts = options.listAccountRefs || listAccountRefRecords;
  const readCredential = options.readCredentialRecord || readAccountCredentialRecord;

  let accounts = [];
  try {
    accounts = listAccounts(fs, aiHomeDir, 'zcode') || [];
  } catch (_error) {
    return { accountRef: '', mode: 'none', oauthAccountCount: 0 };
  }

  const oauthAccounts = [];
  for (const account of accounts) {
    const accountRef = String(account && account.accountRef || '').trim();
    if (!accountRef) continue;
    try {
      const record = readCredential(fs, aiHomeDir, accountRef);
      if (!isZcodeApiKeyAccount(record)) oauthAccounts.push(accountRef);
    } catch (_error) {
      // 凭据读取失败按非 api-key 处理（保持与 quota probe 的宽容度一致）。
      oauthAccounts.push(accountRef);
    }
  }

  if (oauthAccounts.length === 1) {
    return { accountRef: oauthAccounts[0], mode: 'single', oauthAccountCount: 1 };
  }
  return {
    accountRef: '',
    mode: oauthAccounts.length > 1 ? 'ambiguous' : 'none',
    oauthAccountCount: oauthAccounts.length
  };
}

module.exports = {
  resolveZcodeUsageAttribution
};
