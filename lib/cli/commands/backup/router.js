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
const {
  addBackupTarget,
  readBackupConfig,
  readBackupState,
  removeBackupTarget,
  setBackupTargetEnabled,
  updateBackupSettings
} = require('../../../account/backup/remote-backup-config');
const {
  inspectRemoteBackup,
  restoreRemoteBackup,
  runRemoteBackup
} = require('../../../account/backup/remote-backup-service');

const BACKUP_HELP = `\x1b[36mAIH Backup\x1b[0m - 账号导出 / 导入 / 远程自动备份

\x1b[33mUsage:\x1b[0m
  aih export [file.json]                      \x1b[90m导出全部账号\x1b[0m
  aih export <选择器...> [file.json]           \x1b[90m导出部分账号\x1b[0m
  aih <cli> export [id...] [file.json]        \x1b[90m导出某个 provider 的全部账号 / 指定编号\x1b[0m
  aih import <file.json...> [--dry-run]       \x1b[90m导入（同一身份更新，新身份新增，不会重复）\x1b[0m
  aih <cli> import <file.json...>             \x1b[90m只导入文件中该 provider 的账号\x1b[0m

\x1b[33m远程自动备份（SSH，可加多个目标）:\x1b[0m
  aih backup add <user@host> [选项]            \x1b[90m添加目标（--name/--key/--port/--remote-dir/--password-env）\x1b[0m
  aih backup list                             \x1b[90m列出目标与最近一次结果\x1b[0m
  aih backup remove <id|user@host>            \x1b[90m删除目标（远端已有文件保留）\x1b[0m
  aih backup enable|disable [id|user@host]    \x1b[90m启用 / 暂停目标\x1b[0m
  aih backup run [id...] [--full]             \x1b[90m立即备份（默认只传变化的账号）\x1b[0m
  aih backup status [--remote]                \x1b[90m本地状态；--remote 读取远端清单\x1b[0m
  aih backup test <id|user@host>              \x1b[90m测试 SSH 连接并读取远端清单\x1b[0m
  aih backup restore <id|user@host> [--dry-run] \x1b[90m从远端恢复（同身份更新、不重复）\x1b[0m
  aih backup config [--interval 360] [--debounce 30] [--enabled on|off]
  aih backup show                             \x1b[90m打印当前配置（不含密码）\x1b[0m

\x1b[33m自动触发:\x1b[0m 账号新增 / 导入（含同身份换凭据）/ 删除 / 启停后自动备份；token 刷新按 interval 周期补备份。
          自动任务由 aih server 进程执行；server 没跑时用 aih backup run 手动跑。

\x1b[33m选择器:\x1b[0m
  codex            \x1b[90m某个 provider 的全部账号\x1b[0m
  codex:1,3        \x1b[90m按 CLI 编号（aih codex 1 里的 1）\x1b[0m
  acct_0123…       \x1b[90m按账号引用（WebUI 账号详情里可见）\x1b[0m

\x1b[33m注意:\x1b[0m 导出文件 / 远端账号文件包含明文凭据（access/refresh token、API key），请妥善保管。`;

function printBackupHelp({ consoleImpl = console, processImpl = process, exit = true } = {}) {
  consoleImpl.log(BACKUP_HELP);
  if (exit) processImpl.exit(0);
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

// --- 远程备份子命令 ------------------------------------------------------

const BACKUP_FLAGS_WITH_VALUE = new Set([
  '--name', '--port', '--key', '--remote-dir', '--password-env', '--strategy',
  '--interval', '--debounce', '--enabled'
]);
const BACKUP_BOOLEAN_FLAGS = new Set(['--full', '--dry-run', '--remote']);

function parseBackupTokens(tokens) {
  const positionals = [];
  const flags = {};
  const list = Array.isArray(tokens) ? tokens.slice() : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] || '').trim();
    if (!token) continue;
    if (BACKUP_FLAGS_WITH_VALUE.has(token)) {
      const value = list[index + 1];
      if (value === undefined || String(value).startsWith('--')) throw new Error(`${token} 需要一个值`);
      flags[token.slice(2)] = String(value);
      index += 1;
      continue;
    }
    if (BACKUP_BOOLEAN_FLAGS.has(token)) {
      flags[token.slice(2)] = true;
      continue;
    }
    if (token.startsWith('--')) throw new Error(`未知选项：${token}`);
    positionals.push(token);
  }
  return { positionals, flags };
}

function formatTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function targetLabel(target) {
  return `${target.username}@${target.host}:${target.port}`;
}

function printBackupStatus(config, state, consoleImpl) {
  if (config.targets.length === 0) {
    consoleImpl.log('\x1b[90m[aih] 还没有远程备份目标。用 aih backup add <user@host> 添加。\x1b[0m');
    return;
  }
  consoleImpl.log(`\x1b[36m[aih]\x1b[0m 自动备份：${config.enabled ? '开启' : '暂停'}，周期 ${config.intervalMinutes} 分钟，去抖 ${config.debounceSeconds}s`);
  for (const target of config.targets) {
    const entry = state.targets && state.targets[target.id] ? state.targets[target.id] : {};
    const stateText = !target.enabled
      ? '\x1b[90m已暂停\x1b[0m'
      : entry.lastError
        ? `\x1b[31m失败\x1b[0m ${entry.lastError}`
        : entry.lastOkAt
          ? `\x1b[32m正常\x1b[0m 上传 ${entry.uploaded || 0} / 未变 ${entry.unchanged || 0}，revision ${entry.revision || 0}`
          : '\x1b[90m尚未备份\x1b[0m';
    consoleImpl.log(`  ${target.id.padEnd(20)} ${target.strategy} ${targetLabel(target).padEnd(28)} ${target.remoteDir}`);
    consoleImpl.log(`  ${''.padEnd(20)} 上次成功 ${formatTimestamp(entry.lastOkAt)}  ${stateText}`);
  }
}

function runBackupAdd(tokens, deps) {
  const { positionals, flags } = parseBackupTokens(tokens);
  if (positionals.length === 0) throw new Error('用法：aih backup add <user@host> [--name <id>] [--key <path>]');
  const { target } = addBackupTarget({
    fs: deps.fs,
    aiHomeDir: deps.aiHomeDir,
    target: {
      address: positionals[0],
      id: flags.name,
      port: flags.port,
      identityFile: flags.key,
      remoteDir: flags['remote-dir'],
      passwordEnv: flags['password-env'],
      strategy: flags.strategy
    }
  });
  deps.consoleImpl.log(`\x1b[32m[aih]\x1b[0m 已添加备份目标 ${target.id} → ${targetLabel(target)}:${target.remoteDir}`);
  deps.consoleImpl.log(`\x1b[90m[aih] server 运行时会自动备份；先验证连通性可执行 aih backup test ${target.id}\x1b[0m`);
  return 0;
}

function runBackupList(tokens, deps) {
  const config = readBackupConfig({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
  const state = readBackupState({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
  printBackupStatus(config, state, deps.consoleImpl);
  return 0;
}

function runBackupRemove(tokens, deps) {
  const { positionals } = parseBackupTokens(tokens);
  if (positionals.length === 0) throw new Error('用法：aih backup remove <id|user@host>');
  const { target } = removeBackupTarget({ fs: deps.fs, aiHomeDir: deps.aiHomeDir, selector: positionals[0] });
  deps.consoleImpl.log(`\x1b[32m[aih]\x1b[0m 已删除备份目标 ${target.id}（远端已有文件保留）`);
  return 0;
}

function runBackupSetEnabled(tokens, deps, enabled) {
  const { positionals } = parseBackupTokens(tokens);
  const selector = positionals[0] || '';
  if (!selector) throw new Error(`用法：aih backup ${enabled ? 'enable' : 'disable'} <id|user@host>`);
  const { target } = setBackupTargetEnabled({
    fs: deps.fs, aiHomeDir: deps.aiHomeDir, selector, enabled
  });
  deps.consoleImpl.log(`\x1b[32m[aih]\x1b[0m ${target.id} 已${enabled ? '启用' : '暂停'}`);
  return 0;
}

function runBackupConfig(tokens, deps) {
  const { flags } = parseBackupTokens(tokens);
  const patch = {};
  if (flags.interval !== undefined) patch.intervalMinutes = Number(flags.interval);
  if (flags.debounce !== undefined) patch.debounceSeconds = Number(flags.debounce);
  if (flags.enabled !== undefined) {
    const value = String(flags.enabled).toLowerCase();
    if (!['on', 'off', 'true', 'false', '1', '0'].includes(value)) throw new Error('--enabled 只接受 on / off');
    patch.enabled = value === 'on' || value === 'true' || value === '1';
  }
  if (Object.keys(patch).length === 0) {
    const config = readBackupConfig({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
    deps.consoleImpl.log(`自动备份：${config.enabled ? '开启' : '暂停'}，周期 ${config.intervalMinutes} 分钟，去抖 ${config.debounceSeconds}s`);
    return 0;
  }
  const config = updateBackupSettings({ fs: deps.fs, aiHomeDir: deps.aiHomeDir, ...patch });
  deps.consoleImpl.log(`\x1b[32m[aih]\x1b[0m 自动备份：${config.enabled ? '开启' : '暂停'}，周期 ${config.intervalMinutes} 分钟，去抖 ${config.debounceSeconds}s`);
  return 0;
}

function runBackupShow(tokens, deps) {
  const config = readBackupConfig({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
  const state = readBackupState({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
  deps.consoleImpl.log(JSON.stringify({ config, state }, null, 2));
  return 0;
}

async function runBackupRun(tokens, deps) {
  const { positionals, flags } = parseBackupTokens(tokens);
  const result = await runRemoteBackup({
    fs: deps.fs,
    aiHomeDir: deps.aiHomeDir,
    targetIds: positionals,
    full: Boolean(flags.full),
    env: deps.processImpl && deps.processImpl.env,
    logger: {
      info: (message) => deps.consoleImpl.log(`\x1b[36m[aih:backup]\x1b[0m ${message}`),
      warn: (message) => deps.consoleImpl.error(`\x1b[33m[aih:backup]\x1b[0m ${message}`)
    }
  });
  if (result.reason === 'no_targets') {
    deps.consoleImpl.log('\x1b[90m[aih] 没有启用的备份目标。用 aih backup add <user@host> 添加。\x1b[0m');
    return 0;
  }
  for (const item of result.targets) {
    if (item.ok) {
      deps.consoleImpl.log(`\x1b[32m[aih]\x1b[0m ${item.targetId}：上传 ${item.uploaded}，未变 ${item.unchanged}，删除标记 ${item.deleted}，revision ${item.revision}`);
    } else {
      deps.consoleImpl.error(`\x1b[31m[aih]\x1b[0m ${item.targetId}：${item.error}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function runBackupStatus(tokens, deps) {
  const { flags } = parseBackupTokens(tokens);
  const config = readBackupConfig({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
  const state = readBackupState({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
  printBackupStatus(config, state, deps.consoleImpl);
  if (flags.remote) {
    for (const target of config.targets) {
      try {
        const result = await inspectRemoteBackup({
          fs: deps.fs,
          aiHomeDir: deps.aiHomeDir,
          config,
          targetId: target.id,
          env: deps.processImpl && deps.processImpl.env
        });
        if (!result.manifest) {
          deps.consoleImpl.log(`  ${target.id}: 远端还没有备份清单`);
          continue;
        }
        const accounts = Object.values(result.manifest.accounts || {});
        const active = accounts.filter((entry) => !entry.deleted).length;
        deps.consoleImpl.log(`  ${target.id}: 远端 revision ${result.manifest.revision}，账号 ${active}，删除标记 ${accounts.length - active}，清单 ${result.bytes} 字节`);
      } catch (error) {
        deps.consoleImpl.error(`\x1b[31m[aih]\x1b[0m ${target.id}: ${error.message}`);
      }
    }
  }
  return 0;
}

async function runBackupTest(tokens, deps) {
  const { positionals } = parseBackupTokens(tokens);
  if (positionals.length === 0) throw new Error('用法：aih backup test <id|user@host>');
  const result = await inspectRemoteBackup({
    fs: deps.fs,
    aiHomeDir: deps.aiHomeDir,
    targetId: positionals[0],
    env: deps.processImpl && deps.processImpl.env
  });
  deps.consoleImpl.log(`\x1b[32m[aih]\x1b[0m ${result.targetId} 连接成功`);
  if (!result.manifest) {
    deps.consoleImpl.log('\x1b[90m[aih] 远端还没有备份清单（第一次 run 后生成）\x1b[0m');
  } else {
    const accounts = Object.values(result.manifest.accounts || {});
    deps.consoleImpl.log(`\x1b[90m[aih] 远端 revision ${result.manifest.revision}，账号 ${accounts.filter((entry) => !entry.deleted).length}\x1b[0m`);
  }
  return 0;
}

async function runBackupRestore(tokens, deps) {
  const { positionals, flags } = parseBackupTokens(tokens);
  if (positionals.length === 0) throw new Error('用法：aih backup restore <id|user@host> [--dry-run]');
  const result = await restoreRemoteBackup({
    fs: deps.fs,
    aiHomeDir: deps.aiHomeDir,
    targetId: positionals[0],
    dryRun: Boolean(flags['dry-run']),
    env: deps.processImpl && deps.processImpl.env
  });
  if (!result.ok) {
    deps.consoleImpl.error(`\x1b[31m[aih]\x1b[0m 恢复失败：${result.error}`);
    return 1;
  }
  const s = result.summary;
  deps.consoleImpl.log(`\x1b[32m[aih]\x1b[0m 从 ${result.targetId} 恢复：共 ${s.total}，新增 ${s.created}，更新 ${s.updated}，未变 ${s.unchanged}，无效 ${s.invalid}，失败 ${s.failed}${result.dryRun ? '（演练，未写入）' : ''}`);
  for (const entry of result.accounts) {
    if (entry.status === 'unchanged') continue;
    deps.consoleImpl.log(`  ${STATUS_TEXT[entry.status] || entry.status} ${entry.provider}${entry.accountRef ? ` → ${entry.accountRef}` : ''}${entry.reason ? `  ${entry.reason}` : ''}`);
  }
  if (result.missing.length > 0) {
    deps.consoleImpl.error(`\x1b[33m[aih]\x1b[0m 远端缺少 ${result.missing.length} 个账号文件：${result.missing.join(', ')}`);
  }
  return s.failed > 0 ? 1 : 0;
}

async function runBackupSubcommand(tokens, deps) {
  const list = Array.isArray(tokens) ? tokens.map((item) => String(item || '').trim()).filter(Boolean) : [];
  if (list.length === 0 || isHelpToken(list[0])) {
    printBackupHelp({ consoleImpl: deps.consoleImpl, processImpl: deps.processImpl, exit: false });
    if (list.length === 0) {
      const config = readBackupConfig({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
      const state = readBackupState({ fs: deps.fs, aiHomeDir: deps.aiHomeDir });
      printBackupStatus(config, state, deps.consoleImpl);
    }
    return 0;
  }
  const command = list[0].toLowerCase();
  const rest = list.slice(1);
  if (rest.some(isHelpToken)) {
    printBackupHelp({ consoleImpl: deps.consoleImpl, processImpl: deps.processImpl, exit: false });
    return 0;
  }
  if (command === 'add') return runBackupAdd(rest, deps);
  if (command === 'list' || command === 'ls') return runBackupList(rest, deps);
  if (command === 'remove' || command === 'rm') return runBackupRemove(rest, deps);
  if (command === 'enable') return runBackupSetEnabled(rest, deps, true);
  if (command === 'disable') return runBackupSetEnabled(rest, deps, false);
  if (command === 'run') return runBackupRun(rest, deps);
  if (command === 'status') return runBackupStatus(rest, deps);
  if (command === 'test') return runBackupTest(rest, deps);
  if (command === 'restore') return runBackupRestore(rest, deps);
  if (command === 'config') return runBackupConfig(rest, deps);
  if (command === 'show') return runBackupShow(rest, deps);
  throw new Error(`未知的 backup 子命令：${command}（用 aih backup --help 查看）`);
}

/**
 * 路由入口（root router 与 `aih <cli> export|import` 共用）。
 * args[0] 是 cmd；provider 作用域的调用由 root router 改写为 ['export', '__provider__', provider, ...]。
 */
async function runBackupCommand(cmd, args, deps = {}) {
  if (cmd === 'backup') {
    const context = {
      ...deps,
      consoleImpl: deps.consoleImpl || console,
      processImpl: deps.processImpl || process,
      fs: deps.fs || require('node:fs'),
      path: deps.path || require('node:path')
    };
    let exitCode = 0;
    try {
      exitCode = await runBackupSubcommand(Array.isArray(args) ? args.slice(1) : [], context);
    } catch (error) {
      context.consoleImpl.error(`\x1b[31m[aih] backup 失败：${error.message}\x1b[0m`);
      exitCode = 1;
    }
    context.processImpl.exit(exitCode);
    return true;
  }
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
  runBackupCommand,
  runBackupSubcommand
};
