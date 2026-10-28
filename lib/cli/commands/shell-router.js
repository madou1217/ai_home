'use strict';

/**
 * `aih shell`：终端集成的入口（补全 / 拼写纠正 / rc 片段管理）。
 *
 * 动作刻意与 `aih edge` 对齐——`status` 看现状、`plan` 只打印、`apply` 才写、`remove` 摘掉：
 * 用户对「先看再改」的节奏已经有肌肉记忆，不需要再学一套。
 *
 * 边界：目前只覆盖 zsh / bash（POSIX）。PowerShell / fish 没有实现，
 * 这里明确回 `unsupported_shell`，不假装支持。
 */

const nodeOs = require('node:os');
const { createShellIntegrationService } = require('../services/shell/shell-integration');
const { createCorrectionsStore } = require('../complete/corrections');
const { detectShell, SUPPORTED_SHELLS } = require('../services/shell/shell-snippet');

const SHELL_HELP = `用法：
  aih shell status  [--json]
  aih shell plan    [选项]
  aih shell apply   [选项] [--dry-run]
  aih shell remove  [选项]
  aih shell snippet [选项]
  aih shell typo    [list|forget <打错的命令>] [--json]

作用：
  TAB 补全    aih <TAB> 列命令；aih co<TAB> → codex；aih codex <TAB> 列该 CLI 的动作与账号；
              并给出你自己用过的那几条命令（来自 shell 的活历史）
  拼写纠正    命令打错时（如 ahi）列出最接近的候选，确认后才运行；e = 放进历史自己编辑
  自学习      你确认过的纠正会被记住，下次同一个错法排第一

选项：
  --shell <zsh|bash>     目标 shell（默认按 $SHELL 判断）
  --rc-file <路径>       写到指定文件而不是默认 rc（默认 ~/.zshrc 或 ~/.bashrc）
  --no-completion        不装 TAB 补全
  --no-typo              不装命令打错的纠正建议
  --no-wrapper           不给 aih 加同名 shell 函数（少了 aih 自身错字的纠正入口）
  --dry-run              apply 时只打印将要写入的内容
  --json                 以 JSON 输出

装完要生效：新开一个终端，或执行 source ~/.zshrc。移除：aih shell remove。`;

const SHELL_ACTIONS = Object.freeze(['status', 'plan', 'apply', 'remove', 'snippet', 'typo']);

function parseShellArgs(argv = []) {
  const options = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const next = () => argv[++index];
    if (arg === '--shell') options.shell = String(next() || '').trim().toLowerCase();
    else if (arg.startsWith('--shell=')) options.shell = arg.slice('--shell='.length).trim().toLowerCase();
    else if (arg === '--rc-file') options.rcFile = String(next() || '');
    else if (arg.startsWith('--rc-file=')) options.rcFile = arg.slice('--rc-file='.length);
    else if (arg === '--no-completion') options.completion = false;
    else if (arg === '--no-typo') options.typo = false;
    else if (arg === '--no-wrapper') options.wrapper = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--forget') options.forget = String(next() || '');
    else if (arg === '-h' || arg === '--help') options.help = true;
    else options.positional.push(arg);
  }
  return options;
}

/** 生成片段时用的 aih 绝对路径：用当前进程的真实入口，避免 PATH 上的另一份安装。
 *  刻意过一遍 realpath：`aih`（PATH 上的软链）与 `node <repo>/bin/ai-home.js` 必须得到
 *  同一个字符串，否则 `aih shell status` 会一直报「内容与当前参数不一致」。
 *  片段里的 `_aih_shell_ready` 仍有 PATH 兜底，所以路径变了也不会失效。 */
function resolveAihBinPath(deps = {}) {
  const processObj = deps.processObj || process;
  const fsImpl = deps.fs || require('node:fs');
  const explicit = String(deps.aihBinPath || '').trim();
  if (explicit) return explicit;
  const entry = String((processObj.argv && processObj.argv[1]) || '').trim();
  if (!entry) return 'aih';
  try {
    return fsImpl.realpathSync(entry);
  } catch (_error) {
    return entry;
  }
}

function printStatus(log, status) {
  log(`\x1b[36mAIH Shell\x1b[0m - 终端集成`);
  if (!status.ok) {
    log(`  shell          \x1b[33m未识别（支持：${SUPPORTED_SHELLS.join(' / ')}）\x1b[0m`);
    log('  \x1b[90m显式指定：aih shell apply --shell zsh\x1b[0m');
    return;
  }
  const mark = (value) => (value ? '\x1b[32m已装\x1b[0m' : '\x1b[33m未装\x1b[0m');
  log(`  shell          ${status.shell}`);
  log(`  rc 文件        ${status.rcFile}${status.rcExists ? '' : ' \x1b[90m(不存在，apply 会创建)\x1b[0m'}`);
  log(`  集成状态       ${mark(status.installed)}${status.installed && !status.upToDate ? ' \x1b[33m(内容与当前参数不一致，可重新 apply)\x1b[0m' : ''}`);
  log(`  aih 路径       ${status.aihBinPath}`);
  log(`  功能           TAB 补全 ${status.features.completion ? '开' : '关'} / 拼写纠正 ${status.features.typo ? '开' : '关'} / aih 包装函数 ${status.features.wrapper ? '开' : '关'}`);
}

function printPlan(log, plan) {
  if (!plan.ok) {
    log(`\x1b[33m[aih] 未识别的 shell（支持：${SUPPORTED_SHELLS.join(' / ')}）。用 --shell 显式指定。\x1b[0m`);
    return;
  }
  log(`\x1b[36m[aih] 将要写入\x1b[0m ${plan.rcFile}（只替换 \`# >>> aih:shell >>>\` 标记之间的内容，其余原样保留）`);
  if (plan.installed) log('\x1b[90m（该文件里已有一个 aih:shell 块，会被整体替换）\x1b[0m');
  log('');
  log(plan.content.trimEnd());
}

function runTypoAction(args, deps, log, error) {
  const store = createCorrectionsStore({
    fs: deps.fs,
    aiHomeDir: deps.aiHomeDir
  });
  if (args.forget) {
    const removed = store.forget(args.forget);
    if (args.json) log(JSON.stringify({ ok: true, forgotten: args.forget, removed }, null, 1));
    else log(removed ? `已遗忘纠正：${args.forget}` : `没有 ${args.forget} 的纠正记录`);
    return 0;
  }
  const entries = store.list();
  if (args.json) {
    log(JSON.stringify({ ok: true, file: store.filePath, corrections: entries }, null, 1));
    return 0;
  }
  if (!entries.length) {
    log('\x1b[90m还没有学习到任何纠正。命令打错时选择候选运行，就会记下来。\x1b[0m');
    return 0;
  }
  log(`\x1b[36m已学习的纠正\x1b[0m \x1b[90m(${store.filePath})\x1b[0m`);
  for (const entry of entries) log(`  ${entry.typo}  →  ${entry.command}`);
  log('\x1b[90m遗忘一条：aih shell typo --forget <打错的命令>\x1b[0m');
  return 0;
}

/** 返回进程退出码；deps 可注入 fs / env / processObj / aihBinPath / aiHomeDir。 */
function runShellCommand(argv = [], deps = {}) {
  const consoleImpl = deps.consoleImpl || console;
  const log = (line = '') => consoleImpl.log(line);
  const error = (line = '') => consoleImpl.error(line);
  const fs = deps.fs || require('node:fs');
  const env = deps.env || process.env;
  const processObj = deps.processObj || process;
  const args = parseShellArgs(argv);
  const [action] = args.positional;

  if (args.help || !action) {
    log(SHELL_HELP);
    return args.help ? 0 : 1;
  }
  if (!SHELL_ACTIONS.includes(action)) {
    log(`\x1b[33m[aih] 未识别的动作 '${action}'，以下是可用用法：\x1b[0m`);
    log(SHELL_HELP);
    return 1;
  }

  if (action === 'typo') return runTypoAction(args, { fs, aiHomeDir: deps.aiHomeDir }, log, error);

  const service = deps.service || createShellIntegrationService({
    fs,
    env,
    homeDir: String(deps.hostHomeDir || nodeOs.homedir())
  });
  const serviceOptions = {
    shell: args.shell || '',
    rcFile: args.rcFile || '',
    aihBinPath: resolveAihBinPath({ ...deps, processObj }),
    completion: args.completion !== false,
    typo: args.typo !== false,
    wrapper: args.wrapper !== false
  };

  if (action === 'status') {
    const status = service.status(serviceOptions);
    if (args.json) log(JSON.stringify(status, null, 1));
    else printStatus(log, status);
    return status.ok ? 0 : 1;
  }

  if (action === 'snippet') {
    const result = service.snippet(serviceOptions);
    if (!result.ok) {
      error(`\x1b[31m[aih] 未识别的 shell（支持：${SUPPORTED_SHELLS.join(' / ')}）\x1b[0m`);
      return 1;
    }
    log(result.content.trimEnd());
    return 0;
  }

  if (action === 'plan' || (action === 'apply' && args.dryRun)) {
    const plan = service.plan(serviceOptions);
    if (args.json) log(JSON.stringify(plan, null, 1));
    else {
      printPlan(log, plan);
      if (action === 'apply') log('\n\x1b[90m（dry-run：没有写入任何文件）\x1b[0m');
    }
    return plan.ok ? 0 : 1;
  }

  if (action === 'apply') {
    const result = service.apply(serviceOptions);
    if (args.json) log(JSON.stringify(result, null, 1));
    else if (result.ok) {
      if (!result.changed) log('\x1b[32m[aih] 已是最新，无需改动。\x1b[0m');
      else {
        log(`\x1b[32m[aih] 已写入\x1b[0m ${result.rcFile}${result.rcCreated ? ' \x1b[90m(新建)\x1b[0m' : ''}`);
        if (result.backupPath) log(`\x1b[90m备份：${result.backupPath}\x1b[0m`);
        log(`\x1b[90m生效：新开终端，或执行 ${result.reloadHint}\x1b[0m`);
      }
    } else {
      error(`\x1b[31m[aih] 写入失败：${result.error}${result.detail ? `\n${result.detail}` : ''}\x1b[0m`);
    }
    return result.ok ? 0 : 1;
  }

  const removed = service.remove(serviceOptions);
  if (args.json) log(JSON.stringify(removed, null, 1));
  else if (removed.ok && removed.removed) log(`\x1b[32m[aih] 已移除\x1b[0m ${removed.rcFile}`);
  else if (removed.ok) log('\x1b[90m没有找到 aih 写入的片段，无需移除。\x1b[0m');
  else error(`\x1b[31m[aih] 移除失败：${removed.error}\x1b[0m`);
  return removed.ok ? 0 : 1;
}

module.exports = {
  SHELL_ACTIONS,
  SHELL_HELP,
  parseShellArgs,
  resolveAihBinPath,
  runShellCommand
};
