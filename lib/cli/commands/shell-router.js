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
const { createShellIntegrationService, resolveShellBinary } = require('../services/shell/shell-integration');
const { checkShellSyntax } = require('../services/shell/shell-syntax-check');
const { createCorrectionsStore } = require('../complete/corrections');
const { detectShell, SUPPORTED_SHELLS } = require('../services/shell/shell-snippet');

const SHELL_HELP = `用法：
  aih shell status  [--json]
  aih shell plan    [选项]
  aih shell apply   [选项] [--dry-run] [--all]
  aih shell remove  [选项] [--all]
  aih shell snippet [选项]
  aih shell doctor  [--json]
  aih shell typo    [list|forget <打错的命令>] [--json]

作用：
  TAB 补全    aih <TAB> 列命令；aih co<TAB> → codex；aih codex <TAB> 列该 CLI 的动作与账号；
              并给出你自己用过的那几条命令（来自 shell 的活历史）
  拼写纠正    命令打错时（如 ahi）列出最接近的候选，确认后才运行；e = 放到命令行自己编辑
  自学习      你确认过的纠正会被记住，下次同一个错法排第一

支持的 shell：zsh / bash / fish / PowerShell（PS 5.1 与 7.x）

选项：
  --shell <zsh|bash|fish|powershell>  目标 shell（默认按「父进程 → PSModulePath → $SHELL」判断）
  --rc-file <路径>       写到指定文件而不是默认 rc
  --all                  对每个「已安装或已有 rc」的 shell 都执行一次
  --no-completion        不装 TAB 补全
  --no-typo              不装命令打错的纠正建议
  --no-wrapper           不给 aih 加同名 shell 函数（少了 aih 自身错字的纠正入口）
  --dry-run              apply 时只打印将要写入的内容
  --json                 以 JSON 输出

装完要生效：新开终端，或 source 对应 rc（fish：exec fish）。移除：aih shell remove。`;

const SHELL_ACTIONS = Object.freeze(['status', 'plan', 'apply', 'remove', 'snippet', 'doctor', 'typo']);

function parseShellArgs(argv = []) {
  const options = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const next = () => argv[++index];
    if (arg === '--shell') options.shell = String(next() || '').trim().toLowerCase();
    else if (arg.startsWith('--shell=')) options.shell = arg.slice('--shell='.length).trim().toLowerCase();
    else if (arg === '--rc-file') options.rcFile = String(next() || '');
    else if (arg.startsWith('--rc-file=')) options.rcFile = arg.slice('--rc-file='.length);
    else if (arg === '--all') options.all = true;
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

function printStatus(log, status, allStatus = []) {
  log(`\x1b[36mAIH Shell\x1b[0m - 终端集成`);
  if (!status.ok) {
    log(`  当前 shell     \x1b[33m未识别（支持：${SUPPORTED_SHELLS.join(' / ')}）\x1b[0m`);
    log('  \x1b[90m显式指定：aih shell apply --shell zsh\x1b[0m');
  } else {
    log(`  当前 shell     ${status.shell}`);
    log(`  aih 路径       ${status.aihBinPath}`);
    log(`  功能           TAB 补全 ${status.features.completion ? '开' : '关'} / 拼写纠正 ${status.features.typo ? '开' : '关'} / aih 包装函数 ${status.features.wrapper ? '开' : '关'}`);
  }
  if (allStatus.length) {
    log('');
    log('\x1b[90m各 shell 状态：\x1b[0m');
    for (const entry of allStatus) {
      const current = entry.shell === status.shell ? '\x1b[36m← 当前\x1b[0m' : '';
      const state = entry.installed
        ? (entry.upToDate ? '\x1b[32m已装\x1b[0m' : '\x1b[33m已装（内容与当前参数不一致，可重新 apply）\x1b[0m')
        : (entry.rcExists ? '\x1b[90m未装\x1b[0m' : '\x1b[90m未装（rc 不存在）\x1b[0m');
      log(`  ${entry.shell.padEnd(11)} ${state.padEnd(8)} ${entry.rcFile} ${current}`);
    }
  }
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

/**
 * `aih shell doctor`：把「装是装了、但真能用吗」一次问清。
 * 检查项：① 片段语法（交给真 shell 的解析器）② 目标 rc 是否装了且最新
 * ③ 片段里烘的 aih 路径存在且可执行 ④ 补全入口真能给出候选 ⑤ 纠正入口真能给出候选。
 */
function runDoctor(service, serviceOptions, context = {}) {
  const fs = context.deps.fs || require('node:fs');
  const spawnSync = context.deps.spawnSync || require('node:child_process').spawnSync;
  const status = service.status(serviceOptions);
  const checks = [];
  const push = (name, ok, detail = '') => checks.push({ name, ok, detail });

  push('shell 识别', status.ok, status.ok ? status.shell : '未识别（用 --shell 指定）');

  const targets = service.statusAll(serviceOptions).filter((entry) => entry.installed);
  if (!targets.length) push('rc 片段', false, '没有任何 shell 装了 aih 片段（先 aih shell apply）');
  for (const entry of targets) {
    push(`${entry.shell} 片段已装`, true, entry.rcFile);
    push(`${entry.shell} 片段最新`, entry.upToDate, entry.upToDate ? '' : '内容与当前参数不一致，可重新 apply');
  }

  const binPath = status.aihBinPath || '';
  let binOk = false;
  try {
    binOk = Boolean(binPath) && fs.existsSync(binPath);
  } catch (_error) {
    binOk = false;
  }
  push('aih 路径可用', binOk, binPath);

  if (binOk) {
    const complete = spawnSync(binPath, ['__complete', '--plain', '--', ''], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const completeLines = String((complete && complete.stdout) || '').trim().split('\n').filter(Boolean);
    push('补全入口', completeLines.length > 0, `${completeLines.length} 个候选`);
    const suggest = spawnSync(binPath, ['__suggest', '--inside', '--', 'aih', 'codx'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const suggestOk = /aih:cand/.test(String((suggest && suggest.stdout) || ''));
    push('纠正入口', suggestOk, suggestOk ? 'aih codx → aih codex' : '没有返回候选');
  }

  return {
    ok: checks.every((check) => check.ok),
    shell: status.shell,
    rcFile: status.rcFile,
    aihBinPath: binPath,
    checks
  };
}

function printDoctor(log, report) {
  log('\x1b[36mAIH Shell Doctor\x1b[0m');
  for (const check of report.checks) {
    const mark = check.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
    log(`  ${mark} ${check.name}${check.detail ? `  \x1b[90m${check.detail}\x1b[0m` : ''}`);
  }
  log(report.ok ? '\x1b[32m全部通过。\x1b[0m' : '\x1b[33m有未通过的检查项，见上。\x1b[0m');
}

/** 返回进程退出码；deps 可注入 fs / env / processObj / aihBinPath / aiHomeDir。 */
function runShellCommand(argv = [], deps = {}) {
  const consoleImpl = deps.consoleImpl || console;
  const log = (line = '') => consoleImpl.log(line);
  const error = (line = '') => consoleImpl.error(line);
  const fs = deps.fs || require('node:fs');
  const env = deps.env || process.env;
  const processObj = deps.processObj || process;
  const spawnSync = deps.spawnSync || require('node:child_process').spawnSync;
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
    homeDir: String(deps.hostHomeDir || '')
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
    const allStatus = typeof service.statusAll === 'function' ? service.statusAll(serviceOptions) : [];
    if (args.json) log(JSON.stringify({ ...status, shells: allStatus }, null, 1));
    else printStatus(log, status, allStatus);
    return status.ok ? 0 : 1;
  }

  if (action === 'doctor') {
    const report = runDoctor(service, serviceOptions, { env, log, deps });
    if (args.json) log(JSON.stringify(report, null, 1));
    else printDoctor(log, report);
    return report.ok ? 0 : 1;
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
    const targets = args.all
      ? SUPPORTED_SHELLS
      : [serviceOptions.shell || detectShell({ env })].filter(Boolean);
    if (!targets.length) {
      error(`\x1b[31m[aih] 未识别的 shell（支持：${SUPPORTED_SHELLS.join(' / ')}）。用 --shell 显式指定。\x1b[0m`);
      return 1;
    }
    let failed = false;
    const results = [];
    for (const shell of targets) {
      const options = { ...serviceOptions, shell };
      if (args.all) {
        const info = service.describeShell(shell, options);
        if (!info.shellAvailable && !info.rcExists) {
          results.push({ shell, ok: true, skipped: true, reason: 'shell_not_installed' });
          continue;
        }
      }
      // 写之前先让该 shell 自己验一遍语法：宁可拒绝写入，也不给用户一个打不开的 rc。
      const syntax = checkShellSyntax(shell, service.snippet(options).content || '', {
        binary: resolveShellBinary(shell, { fs, env }),
        fs,
        spawnSync,
        env
      });
      if (!syntax.ok) {
        failed = true;
        results.push({ shell, ok: false, error: 'snippet_syntax_invalid', detail: syntax.detail });
        continue;
      }
      const result = service.apply(args.dryRun ? { ...options, dryRun: true } : options);
      if (!result.ok) failed = true;
      results.push({ shell, ...result });
    }
    if (args.json) log(JSON.stringify({ ok: !failed, results }, null, 1));
    else {
      for (const result of results) {
        if (result.skipped) {
          log(`\x1b[90m[aih] ${result.shell}：跳过（本机没装这个 shell）\x1b[0m`);
          continue;
        }
        if (!result.ok) {
          error(`\x1b[31m[aih] ${result.shell} 写入失败：${result.error}${result.detail ? `\n${result.detail}` : ''}\x1b[0m`);
          continue;
        }
        if (args.dryRun) {
          log(`\x1b[90m[aih] ${result.shell}：dry-run，未写入 ${result.rcFile}\x1b[0m`);
          continue;
        }
        if (!result.changed) {
          log(`\x1b[32m[aih] ${result.shell}\x1b[0m 已是最新，无需改动。`);
          continue;
        }
        log(`\x1b[32m[aih] ${result.shell} 已写入\x1b[0m ${result.rcFile}${result.rcCreated ? ' \x1b[90m(新建)\x1b[0m' : ''}`);
        if (result.backupPath) log(`\x1b[90m备份：${result.backupPath}\x1b[0m`);
        log(`\x1b[90m生效：新开终端，或执行 ${result.reloadHint}\x1b[0m`);
      }
    }
    return failed ? 1 : 0;
  }

  if (args.all) {
    const results = SUPPORTED_SHELLS.map((shell) => ({ shell, ...service.remove({ ...serviceOptions, shell }) }));
    if (args.json) log(JSON.stringify({ ok: true, results }, null, 1));
    else {
      for (const result of results) {
        if (result.removed) log(`\x1b[32m[aih] ${result.shell} 已移除\x1b[0m ${result.rcFile}`);
      }
    }
    return 0;
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
  printDoctor,
  resolveAihBinPath,
  runDoctor,
  runShellCommand
};
