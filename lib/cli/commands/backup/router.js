'use strict';

// `aih export` / `aih import`：本机原生格式（lib/account/native-account-transfer.js）。
// 与 WebUI 账号页「导出 / 导入」产出和接受的是同一份 JSON，两边可以互导。
//
// 旧的 zip/AES 打包、CLIProxyAPI、Antigravity Manager、sub2api、目录布局导入已移除（2026-10-31）。

const {
  buildNativeExportDocument,
  importNativeAccounts,
  nativeExportFileName
} = require('../../../account/native-account-transfer');
const { readNodeAccounts } = require('../../../account/go-bridge/node-account-reader');
const { providerCatalog } = require('../../../provider-catalog');

const BACKUP_HELP = `\x1b[36mAIH Backup\x1b[0m - 账号导出 / 导入（本机原生格式，WebUI 同格式）

\x1b[33mUsage:\x1b[0m
  aih export [file.json]                      \x1b[90m导出全部账号\x1b[0m
  aih export <选择器...> [file.json]           \x1b[90m导出部分账号\x1b[0m
  aih <cli> export [id...] [file.json]        \x1b[90m导出某个 provider 的全部账号 / 指定编号\x1b[0m
  aih import <file.json...> [--dry-run]       \x1b[90m导入（同一身份更新，新身份新增，不会重复）\x1b[0m
  aih <cli> import <file.json...>             \x1b[90m只导入文件中该 provider 的账号\x1b[0m

\x1b[33m选择器:\x1b[0m
  codex            \x1b[90m某个 provider 的全部账号\x1b[0m
  codex:1,3        \x1b[90m按 CLI 编号（aih codex 1 里的 1）\x1b[0m
  acct_0123…       \x1b[90m按账号引用（WebUI 账号详情里可见）\x1b[0m

\x1b[33m注意:\x1b[0m 导出文件包含明文凭据（access/refresh token、API key），请妥善保管。`;

function printBackupHelp({ consoleImpl = console, processImpl = process } = {}) {
  consoleImpl.log(BACKUP_HELP);
  processImpl.exit(0);
  return true;
}

function isHelpToken(token) {
  return token === '--help' || token === '-h' || token === 'help';
}

/**
 * 把选择器解析成 accountRefs。返回 { accountRefs, providers, unknown }。
 * 整个 provider 的选择器放进 providers（交给导出端过滤）；带编号的、按引用的都落成 accountRefs。
 */
function resolveSelectors(selectors, accounts) {
  const providers = [];
  const accountRefs = [];
  const unknown = [];
  for (const raw of selectors) {
    const selector = String(raw || '').trim();
    if (/^acct_[a-f0-9]{20}$/i.test(selector)) {
      const ref = selector.toLowerCase();
      if (accounts.some((account) => account.accountRef === ref)) accountRefs.push(ref);
      else unknown.push(selector);
      continue;
    }
    const [providerToken, idsToken] = selector.toLowerCase().split(':', 2);
    const provider = providerCatalog.normalize(providerToken);
    if (!provider || !providerCatalog.ids.includes(provider)) {
      unknown.push(selector);
      continue;
    }
    if (!idsToken) {
      providers.push(provider);
      continue;
    }
    for (const id of idsToken.split(',').map((value) => value.trim()).filter(Boolean)) {
      const match = accounts.find((account) => account.provider === provider && account.cliAccountId === id);
      if (match) accountRefs.push(match.accountRef);
      else unknown.push(`${provider}:${id}`);
    }
  }
  return { providers, accountRefs, unknown };
}

function splitTargetFile(tokens) {
  const last = tokens[tokens.length - 1];
  if (last && /\.json$/i.test(last)) return { targetFile: last, selectors: tokens.slice(0, -1) };
  return { targetFile: '', selectors: tokens };
}

function runExport(tokens, deps) {
  const { fs, path, aiHomeDir, consoleImpl } = deps;
  const { targetFile, selectors } = splitTargetFile(tokens);
  const accounts = readNodeAccounts(aiHomeDir, { fs }).accounts;
  const resolved = resolveSelectors(selectors, accounts);
  if (resolved.unknown.length > 0) {
    throw new Error(`找不到账号或 provider：${resolved.unknown.join(', ')}（用 aih ls 查看）`);
  }
  // 「codex codex:1」这种混用：只要 provider 整体被选中，其编号选择器已经包含在内。
  const accountRefs = resolved.providers.length > 0
    ? [...new Set([...resolved.accountRefs.filter((ref) => !resolved.providers
      .includes(accounts.find((account) => account.accountRef === ref).provider)),
    ...accounts.filter((account) => resolved.providers.includes(account.provider)).map((account) => account.accountRef)])]
    : resolved.accountRefs;
  const filtered = selectors.length > 0;
  const built = buildNativeExportDocument({ fs, aiHomeDir, accountRefs: filtered ? accountRefs : [] });
  if (filtered && accountRefs.length === 0) throw new Error('选择器没有匹配到任何账号');
  const fileName = targetFile || nativeExportFileName({
    accountRefs, providers: resolved.providers, accounts: built.document.accounts
  });
  const outPath = path.resolve(fileName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // 0600：文件里是明文凭据。
  fs.writeFileSync(outPath, `${JSON.stringify(built.document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(outPath, 0o600); } catch (_error) {}
  consoleImpl.log(`\x1b[32m[aih]\x1b[0m 已导出 ${built.exported} 个账号 → ${outPath}`);
  for (const item of built.skipped) {
    consoleImpl.log(`\x1b[33m[aih]\x1b[0m 跳过 ${item.provider || ''} ${item.accountRef}：${item.reason === 'credentials_missing' ? '没有凭据' : item.reason}`);
  }
  consoleImpl.log('\x1b[90m[aih] 文件包含明文凭据，请妥善保管。\x1b[0m');
  return built.exported > 0 ? 0 : 1;
}

function filterDocumentByProvider(text, provider) {
  if (!provider) return text;
  try {
    const parsed = JSON.parse(String(text).replace(/^﻿/, ''));
    if (parsed && Array.isArray(parsed.accounts)) {
      return JSON.stringify({ ...parsed, accounts: parsed.accounts.filter((account) => account && account.provider === provider) });
    }
  } catch (_error) {
    // 交给导入器给出统一的格式错误。
  }
  return text;
}

const STATUS_TEXT = Object.freeze({ created: '新增', updated: '更新', unchanged: '未变', invalid: '无效', failed: '失败', planned: '将导入' });

function runImport(tokens, deps, provider = '') {
  const { fs, path, aiHomeDir, consoleImpl } = deps;
  const dryRun = tokens.includes('--dry-run');
  const files = tokens.filter((token) => token !== '--dry-run');
  if (files.length === 0) throw new Error('请指定要导入的文件：aih import <file.json>');
  let failed = 0;
  for (const file of files) {
    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
      consoleImpl.error(`\x1b[31m[aih]\x1b[0m 文件不存在：${filePath}`);
      failed += 1;
      continue;
    }
    const input = filterDocumentByProvider(fs.readFileSync(filePath, 'utf8'), provider);
    const result = importNativeAccounts({ fs, aiHomeDir, input, dryRun });
    if (!result.ok) {
      consoleImpl.error(`\x1b[31m[aih]\x1b[0m ${filePath}：${result.error === 'unsupported_import_format' ? '不是 aih 账号导出文件' : result.error}`);
      failed += 1;
      continue;
    }
    const s = result.summary;
    consoleImpl.log(`\x1b[32m[aih]\x1b[0m ${path.basename(filePath)}：共 ${s.total}，新增 ${s.created}，更新 ${s.updated}，未变 ${s.unchanged}，无效 ${s.invalid}，失败 ${s.failed}${dryRun ? '（演练，未写入）' : ''}`);
    for (const entry of result.accounts) {
      if (entry.status === 'unchanged') continue;
      const where = entry.accountRef ? ` → ${entry.accountRef}${entry.cliAccountId ? ` (aih ${entry.provider} ${entry.cliAccountId})` : ''}` : '';
      consoleImpl.log(`  ${STATUS_TEXT[entry.status] || entry.status} ${entry.provider}${where}${entry.reason ? `  ${entry.reason}` : ''}`);
    }
    if (s.failed > 0) failed += 1;
  }
  return failed > 0 ? 1 : 0;
}

/**
 * 路由入口（root router 与 `aih <cli> export|import` 共用）。
 * args[0] 是 cmd；provider 作用域的调用由 root router 改写为 ['export', '__provider__', provider, ...]。
 */
async function runBackupCommand(cmd, args, deps = {}) {
  if (cmd === 'backup') return printBackupHelp(deps);
  if (cmd !== 'export' && cmd !== 'import') return false;
  const consoleImpl = deps.consoleImpl || console;
  const processImpl = deps.processImpl || process;
  const context = { ...deps, consoleImpl, fs: deps.fs || require('node:fs'), path: deps.path || require('node:path') };
  let tokens = (Array.isArray(args) ? args.slice(1) : []).map((item) => String(item || '').trim()).filter(Boolean);
  if (tokens.some(isHelpToken)) return printBackupHelp({ consoleImpl, processImpl });

  let provider = '';
  if (tokens[0] === '__provider__') {
    provider = providerCatalog.normalize(tokens[1]);
    tokens = tokens.slice(2);
    // `aih codex export 1 3 out.json` → 选择器 codex:1,3；不带编号 = 整个 provider。
    if (cmd === 'export') {
      const { targetFile, selectors } = splitTargetFile(tokens);
      const ids = selectors.filter((token) => /^\d+$/.test(token));
      tokens = [ids.length > 0 ? `${provider}:${ids.join(',')}` : provider, ...(targetFile ? [targetFile] : [])];
    }
  }

  let exitCode = 0;
  try {
    exitCode = cmd === 'export' ? runExport(tokens, context) : runImport(tokens, context, provider);
  } catch (error) {
    consoleImpl.error(`\x1b[31m[aih] ${cmd === 'export' ? '导出' : '导入'}失败：${error.message}\x1b[0m`);
    exitCode = 1;
  }
  processImpl.exit(exitCode);
  return true;
}

module.exports = {
  BACKUP_HELP,
  printBackupHelp,
  resolveSelectors,
  runBackupCommand
};
