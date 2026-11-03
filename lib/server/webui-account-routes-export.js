'use strict';

// 账号导出：本机原生格式（lib/account/native-account-transfer.js）。
// GET /v0/webui/accounts/export                     全部账号
// GET /v0/webui/accounts/export?provider=codex      某个 provider（可重复 / 逗号分隔）
// GET /v0/webui/accounts/export?accountRef=acct_…   单个或多个账号（可重复 / 逗号分隔）
// 旧的 format=antigravity / cliproxyapi / sub2api 已移除，明确返回 400，不再静默兜底。

const { buildNativeExportDocument, nativeExportFileName } = require('../account/native-account-transfer');

function readListParam(url, name) {
  if (!url || !url.searchParams) return [];
  return url.searchParams.getAll(name)
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildWebExport({ fs, aiHomeDir, url }) {
  const format = String(url && url.searchParams && url.searchParams.get('format') || '').trim().toLowerCase();
  if (format && format !== 'aih' && format !== 'native') return { error: 'unsupported_export_format' };
  const accountRefs = readListParam(url, 'accountRef');
  const providers = readListParam(url, 'provider');
  const built = buildNativeExportDocument({ fs, aiHomeDir, accountRefs, providers });
  if (accountRefs.length > 0 && built.exported === 0) return { error: 'account_not_found', skipped: built.skipped };
  return {
    document: built.document,
    fileName: nativeExportFileName({ accountRefs, providers, accounts: built.document.accounts }),
    exported: built.exported,
    skipped: built.skipped
  };
}

module.exports = { buildWebExport };
