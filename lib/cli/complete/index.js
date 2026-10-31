'use strict';

/**
 * 终端集成的**内部入口**（`aih __complete` / `aih __suggest`）。
 *
 * 为什么单独一条轻量路径：完整 CLI 启动约 1.3s（组合根要装配所有命令），
 * 而 TAB 补全必须在一百毫秒内出结果。这里只加载「合同清单 + 命令表 + 纯函数」，
 * 实测约 60~90ms；账号 id 这类需要数据库的位置才惰性加载。
 *
 * 协议（`\x1f` = US，控制字符，命令里不可能出现，因此不用引号转义）：
 *   __complete → 每行 `候选值\x1f说明`
 *   __suggest  → `aih:kind\x1f<aih|command|none>`，随后每行 `aih:cand\x1f显示文本\x1f判据\x1fargv(用 \x1f 分隔)`
 * 输出只走 stdout；任何内部错误都退化成「没有候选」（补全绝不能因为自身故障打断用户），
 * 需要看原因时加 `--debug` 把错误打到 stderr。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { resolveAiHomeDir } = require('../../runtime/aih-home');
const { resolveHostHomeDir } = require('../../runtime/host-home');
const { resolveCompletion } = require('./resolve');
const { collectAihHistory, parseHistoryText } = require('./history');
const { suggestCommand, suggestInsideArgv } = require('./typo');
const { createCorrectionsStore } = require('./corrections');
const { listProviderNames, listTopLevelCommandNames } = require('./command-tree');
const { listProviderSessions } = require('./candidates');
const { AIH_SERVER_PROFILE_ID } = require('../../account/provider-profile-id');

const FIELD_SEPARATOR = '\u001f';
const SUGGEST_KINDS = Object.freeze({ AIH: 'aih', COMMAND: 'command', NONE: 'none' });

function splitOnSeparator(flag, argv) {
  const index = argv.indexOf(flag);
  if (index < 0) return { rest: argv, value: '' };
  const value = argv[index + 1] === undefined ? '' : String(argv[index + 1]);
  return { rest: [...argv.slice(0, index), ...argv.slice(index + 2)], value };
}

function takeFlag(flag, argv) {
  const index = argv.indexOf(flag);
  if (index < 0) return { rest: argv, present: false };
  return { rest: [...argv.slice(0, index), ...argv.slice(index + 1)], present: true };
}

function splitWords(argv) {
  const index = argv.indexOf('--');
  return index < 0 ? argv.slice() : argv.slice(index + 1);
}

/**
 * 历史文件的候选路径：除 `$HISTFILE` 外，还包括各 shell 自己的落盘位置——
 * fish 用 `$XDG_DATA_HOME/fish/fish_history`，PowerShell 用 PSReadLine 的
 * `ConsoleHost_history.txt`（Windows 在 `%APPDATA%` 下，类 Unix 在 `$XDG_DATA_HOME/powershell`）。
 * shell 侧的「活历史」走 stdin，这里只是兜底（例如命令历史还没落盘、或 shell 没喂）。
 */
function listHistoryFileCandidates(options = {}) {
  const env = options.env || process.env;
  const hostHomeDir = resolveHostHomeDir({ env });
  const xdgDataHome = String(env.XDG_DATA_HOME || '').trim() || nodePath.join(hostHomeDir, '.local', 'share');
  const appData = String(env.APPDATA || '').trim();
  const psReadLine = [
    appData ? nodePath.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt') : '',
    nodePath.join(xdgDataHome, 'powershell', 'PSReadLine', 'ConsoleHost_history.txt')
  ].filter(Boolean);
  return [
    String(options.historyFile || '').trim(),
    String(env.HISTFILE || '').trim(),
    nodePath.join(hostHomeDir, '.zsh_history'),
    nodePath.join(hostHomeDir, '.bash_history'),
    nodePath.join(xdgDataHome, 'fish', 'fish_history'),
    ...psReadLine
  ].filter(Boolean);
}

function readHistoryFileText(options = {}) {
  const fsImpl = options.fs || nodeFs;
  for (const file of listHistoryFileCandidates(options)) {
    try {
      if (fsImpl.existsSync(file)) return fsImpl.readFileSync(file, 'utf8');
    } catch (_error) {
      /* 继续下一个候选 */
    }
  }
  return '';
}

/** 读 shell 通过管道喂进来的活历史（只在 stdin 确实是管道时读，避免在终端里挂住）。 */
function readHistoryStdinText(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const stdinIsTty = options.stdinIsTty === undefined
    ? Boolean(process.stdin && process.stdin.isTTY)
    : options.stdinIsTty;
  if (stdinIsTty) return '';
  try {
    return fsImpl.readFileSync(0, 'utf8');
  } catch (_error) {
    return '';
  }
}

function readHistoryText(options = {}) {
  if (String(options.historyFile || '').trim()) return readHistoryFileText(options);
  if (options.readStdin) return readHistoryStdinText(options);
  return readHistoryFileText(options);
}

/**
 * 汇总历史候选：**管道活历史 + HISTFILE 两路合并**。
 *
 * 为什么要合并：`$history` 并不总是有内容——实测把 HISTFILE 写在 .zshrc 里时，zsh 的初始
 * 读取发生在更早的时点，于是历史数组是空的；反过来 HISTFILE 又可能落后于当前会话。
 * 两路都取、HISTFILE 在前、管道在后（后者更新），任一可用都能给出候选。
 */
function loadHistoryEntries(options = {}) {
  const fileCommands = parseHistoryText(readHistoryFileText(options));
  const stdinCommands = options.readStdin ? parseHistoryText(readHistoryStdinText(options)) : [];
  if (!fileCommands.length && !stdinCommands.length) return [];
  return collectAihHistory([...fileCommands, ...stdinCommands]);
}

/** 账号 id 候选是唯一需要数据库的位置：惰性加载，`aih <TAB>` 不付这个开销。 */
function createAccountLister(aiHomeDir) {
  return (provider) => {
    const { listCliAccountRefRecords } = require('../../server/account-ref-store');
    return listCliAccountRefRecords(nodeFs, aiHomeDir, provider, { bestEffort: true });
  };
}

/** `--shell <name>`：决定输出格式（fish 用 TAB 分隔，其余用 \\x1f）。 */
function takeShellOption(argv) {
  let rest = argv.slice();
  const index = rest.indexOf('--shell');
  if (index >= 0) {
    const value = String(rest[index + 1] === undefined ? '' : rest[index + 1]).trim().toLowerCase();
    return { rest: [...rest.slice(0, index), ...rest.slice(index + 2)], shell: value };
  }
  const inline = rest.find((token) => String(token).startsWith('--shell='));
  if (inline) {
    const value = String(inline).slice('--shell='.length).trim().toLowerCase();
    return { rest: rest.filter((token) => token !== inline), shell: value };
  }
  return { rest, shell: '' };
}

/** `--current=<词>`：给无法表达「末尾空参数」的 shell（fish）显式传当前词。 */
function takeCurrentOption(argv) {
  const inline = argv.find((token) => String(token).startsWith('--current='));
  if (!inline) return { rest: argv, current: null };
  return {
    rest: argv.filter((token) => token !== inline),
    current: String(inline).slice('--current='.length)
  };
}

function runCompleteEntry(argv = [], deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fsImpl = deps.fs || nodeFs;
  const env = deps.env || process.env;
  try {
    let rest = argv.slice();
    const plain = takeFlag('--plain', rest);
    rest = plain.rest;
    const shellOption = takeShellOption(rest);
    rest = shellOption.rest;
    const currentOption = takeCurrentOption(rest);
    rest = currentOption.rest;
    const historyFile = splitOnSeparator('--history-file', rest);
    rest = historyFile.rest;
    const stdinHistory = takeFlag('--history-stdin', rest);
    rest = stdinHistory.rest;
    const debug = takeFlag('--debug', rest);
    rest = debug.rest;
    let words = splitWords(rest);
    if (currentOption.current !== null) words = [...words, currentOption.current];
    if (!words.length) return 0;

    const aiHomeDir = resolveAiHomeDir({ env });
    const historyEntries = loadHistoryEntries({
      fs: fsImpl,
      env,
      historyFile: historyFile.value,
      readStdin: stdinHistory.present
    });
    const candidates = resolveCompletion(words, {
      historyEntries,
      listAccounts: createAccountLister(aiHomeDir),
      listSessions: (provider, accountRef) => listProviderSessions(provider, { env, aiHomeDir, accountRef }),
      aihServerProfileId: AIH_SERVER_PROFILE_ID
    });
    const fishFormat = shellOption.shell === 'fish';
    for (const candidate of candidates) {
      if (plain.present) {
        stdout.write(`${candidate.value}\n`);
        continue;
      }
      if (fishFormat) {
        // fish 的动态补全协议就是 `候选<TAB>说明`（组标题 fish 不支持，忽略）。
        stdout.write(`${candidate.value}\t${candidate.description || ''}\n`);
        continue;
      }
      // 字段：候选值 / 说明 / 分组（zsh 按分组给标题，bash 只取第一段）。
      stdout.write(`${candidate.value}${FIELD_SEPARATOR}${candidate.description || ''}${FIELD_SEPARATOR}${candidate.group || ''}\n`);
    }
    return 0;
  } catch (error) {
    if (argv.includes('--debug')) {
      stderr.write(`[aih] __complete failed: ${(error && error.message) || error}\n`);
    }
    return 0;
  }
}

function runSuggestEntry(argv = [], deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const fsImpl = deps.fs || nodeFs;
  const env = deps.env || process.env;
  // kind 行第二段是「被判定的错词」：shell 用它作为 __learn 的键（`ahi` 或 `aih codx` 里的 `codx`）。
  const writeKind = (kind, typo = '') => stdout.write(`aih:kind${FIELD_SEPARATOR}${kind}${FIELD_SEPARATOR}${typo}\n`);
  try {
    let rest = argv.slice();
    const inside = takeFlag('--inside', rest);
    rest = inside.rest;
    const historyFile = splitOnSeparator('--history-file', rest);
    rest = historyFile.rest;
    const stdinHistory = takeFlag('--history-stdin', rest);
    rest = stdinHistory.rest;
    const debug = takeFlag('--debug', rest);
    rest = debug.rest;
    const tokens = splitWords(rest).filter((token) => String(token).trim() !== '');
    if (!tokens.length) {
      writeKind(SUGGEST_KINDS.NONE);
      return 0;
    }

    const aiHomeDir = resolveAiHomeDir({ env });
    const corrections = createCorrectionsStore({ fs: fsImpl, aiHomeDir });
    const aihNames = ['aih', ...listTopLevelCommandNames(), ...listProviderNames()];
    const historyEntries = loadHistoryEntries({
      fs: fsImpl,
      env,
      historyFile: historyFile.value,
      readStdin: stdinHistory.present
    });
    const suggestions = inside.present
      // `aih` 自己没错、错在紧随其后的那个词（provider / 动作名）：只在 aih 自己的命令面里找。
      ? suggestInsideArgv(tokens, {
        universe: [...listTopLevelCommandNames(), ...listProviderNames()],
        learned: corrections.load()
      })
      : suggestCommand(tokens, {
        aihNames,
        historyEntries,
        learned: corrections.load(),
        env,
        fs: fsImpl
      });
    if (!suggestions.length) {
      writeKind(SUGGEST_KINDS.NONE);
      return 0;
    }
    const typoKey = String(suggestions[0].typo || tokens[inside.present ? 1 : 0] || '').trim();
    writeKind(SUGGEST_KINDS.AIH, typoKey);
    for (const entry of suggestions) {
      const argvText = (entry.argv || []).join(FIELD_SEPARATOR);
      stdout.write(`aih:cand${FIELD_SEPARATOR}${entry.value}${FIELD_SEPARATOR}${entry.reason}${FIELD_SEPARATOR}${argvText}\n`);
    }
    return 0;
  } catch (error) {
    if (argv.includes('--debug')) {
      stderr.write(`[aih] __suggest failed: ${(error && error.message) || error}\n`);
    }
    writeKind(SUGGEST_KINDS.NONE);
    return 0;
  }
}

/**
 * 记下一次被用户确认的纠正（shell 片段在真正运行前调用）。
 * 用法：`aih __learn <打错的命令> -- <正确命令 argv...>`；只写文件，不输出任何内容。
 */
function runLearnEntry(argv = [], deps = {}) {
  const stderr = deps.stderr || process.stderr;
  const fsImpl = deps.fs || nodeFs;
  const env = deps.env || process.env;
  try {
    const separator = argv.indexOf('--');
    const typo = String(argv[0] || '').trim();
    const words = separator < 0 ? [] : argv.slice(separator + 1).map((token) => String(token));
    if (!typo || !words.length) return 0;
    const corrections = createCorrectionsStore({ fs: fsImpl, aiHomeDir: resolveAiHomeDir({ env }) });
    corrections.record(typo, words);
    return 0;
  } catch (error) {
    if (argv.includes('--debug')) {
      stderr.write(`[aih] __learn failed: ${(error && error.message) || error}\n`);
    }
    return 0;
  }
}

module.exports = {
  FIELD_SEPARATOR,
  SUGGEST_KINDS,
  createAccountLister,
  loadHistoryEntries,
  readHistoryFileText,
  readHistoryStdinText,
  readHistoryText,
  runCompleteEntry,
  runLearnEntry,
  runSuggestEntry,
  splitOnSeparator,
  splitWords,
  takeCurrentOption,
  takeFlag,
  takeShellOption
};
