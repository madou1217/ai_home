'use strict';

/**
 * fish 侧终端集成片段（`aih shell apply` 写进 ~/.config/fish/config.fish 的受管块）。
 *
 * 与 zsh/bash 版语义一致（补全 + 打错纠正 + 自学习），但用 fish 自己的机制：
 * - 补全：`complete -c aih -f -a '(__aih_complete_candidates)'` 动态取候选，
 *   输出 `候选<TAB>说明`（fish 原生协议，见 `__complete --shell fish`）。
 * - 打错：**覆盖 `fish_command_not_found`**（fish 的官方钩子），先把 fish 自带的
 *   「did you mean」实现复制成 `__aih_shell_prev_not_found`，没有候选时原样兜底。
 * - `e` = 用 `commandline -r` **直接把纠正后的命令放回命令行**（fish 能做到，比 zsh 更直接）。
 * - `aih` 自身的错字：同名函数只在退出码 2 时接话。
 *
 * fish 语法要点（踩过的坑）：双引号内 `(...)` 不做命令替换，必须用 `$(...)` 或先 `set`；
 * `\x1f` 只有在 `printf` 的格式串里才会被解释成控制字符。
 */

const { shellQuote } = require('../toolkit/environment/plan-builders');

/** fish 用单引号字符串，内部单引号需转义为 \'（fish 的转义规则）。 */
function fishQuote(value) {
  return `'${String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function buildFishSnippet(options = {}) {
  const aihBinPath = String(options.aihBinPath || 'aih');
  const completion = options.completion !== false;
  const typo = options.typo !== false;
  const wrapper = options.wrapper !== false;
  const historyTail = Math.max(200, Number(options.historyTail) || 1000);
  const lines = [];
  lines.push('# aih 终端集成：TAB 补全 + 命令打错时的纠正建议。');
  lines.push('# 由 `aih shell apply` 生成，请勿手改；调整用 `aih shell apply <选项>`，移除用 `aih shell remove`。');
  lines.push(`set -g AIH_SHELL_BIN ${fishQuote(aihBinPath)}`);
  lines.push(`set -g AIH_SHELL_TYPO ${typo ? '1' : '0'}`);
  lines.push(`set -g AIH_SHELL_WRAPPER ${wrapper ? '1' : '0'}`);
  lines.push(`set -g AIH_SHELL_HISTORY_TAIL ${historyTail}`);
  lines.push("set -g _AIH_SHELL_US (printf '\\x1f')");
  lines.push('');
  lines.push('function __aih_shell_ready');
  lines.push('    test -n "$AIH_SHELL_BIN"; and test -x "$AIH_SHELL_BIN"; and return 0');
  lines.push('    set -g AIH_SHELL_BIN (command -v aih)');
  lines.push('    test -n "$AIH_SHELL_BIN"');
  lines.push('end');
  lines.push('');
  lines.push('function __aih_shell_history');
  lines.push('    history --max=$AIH_SHELL_HISTORY_TAIL 2>/dev/null');
  lines.push('end');
  lines.push('');
  lines.push('function __aih_shell_reason_label');
  lines.push('    switch "$argv[1]"');
  lines.push("        case learned; echo '你确认过'");
  lines.push("        case case; echo '大小写'");
  lines.push("        case transposition; echo '两个字母写反了'");
  lines.push("        case typo; echo '打错字符'");
  lines.push("        case abbrev; echo '少写了字母'");
  lines.push("        case prefix; echo '前缀匹配'");
  lines.push("        case history; echo '历史里用过'");
  lines.push("        case '*'; echo '拼写接近'");
  lines.push('    end');
  lines.push('end');
  lines.push('');
  if (completion) lines.push(...buildFishCompletion());
  if (typo) lines.push(...buildFishTypoHandler());
  if (wrapper) lines.push(...buildFishWrapper());
  return `${lines.join('\n')}\n`;
}

function buildFishCompletion() {
  return [
    '# ---- TAB 补全 ----',
    '# 候选由 aih 给出（`候选<TAB>说明`，fish 原生格式），历史用 fish 自己的活历史。',
    'function __aih_complete_candidates',
    '    __aih_shell_ready; or return 0',
    '    set -l prior (commandline -opc)',
    '    test (count $prior) -ge 1; and set -e prior[1]',
    '    set -l current (commandline -ct)',
    '    __aih_shell_history | "$AIH_SHELL_BIN" __complete --shell fish --history-stdin "--current=$current" -- $prior',
    'end',
    'complete -c aih -f -a \'(__aih_complete_candidates)\'',
    ''
  ];
}

function buildFishTypoHandler() {
  return [
    '# ---- 命令打错时的纠正建议 ----',
    '# fish 的官方钩子：覆盖 fish_command_not_found，并把 fish 自带的实现留作兜底。',
    'if functions -q fish_command_not_found; and not functions -q __aih_shell_prev_not_found',
    '    functions -c fish_command_not_found __aih_shell_prev_not_found',
    'end',
    '',
    'function __aih_shell_default_not_found',
    '    if functions -q __aih_shell_prev_not_found',
    '        __aih_shell_prev_not_found $argv',
    '        return $status',
    '    end',
    "    printf 'fish: Unknown command: %s\\n' \"$argv[1]\" >&2",
    '    return 127',
    'end',
    '',
    '# 参数：提示语 / 显示用的命令行 / 其余原样交给 __suggest。返回 0 = 已处理。',
    'function __aih_shell_typo_offer_impl',
    '    set -l msg "$argv[1]"',
    '    set -l head "$argv[2]"',
    '    set -l rest $argv[3..-1]',
    '    __aih_shell_ready; or return 1',
    '    set -l out (__aih_shell_history | "$AIH_SHELL_BIN" __suggest --history-stdin -- $rest 2>/dev/null)',
    '    test (count $out) -ge 1; or return 1',
    '    set -l kind_parts (string split "$_AIH_SHELL_US" -- "$out[1]")',
    '    test "$kind_parts[2]" != none; or return 1',
    '    set -l typo_key "$kind_parts[3]"',
    '    test -n "$typo_key"; or set typo_key "$head"',
    '    set -l displays',
    '    set -l reasons',
    '    set -l argvs',
    '    for line in $out[2..-1]',
    '        set -l parts (string split "$_AIH_SHELL_US" -- "$line")',
    '        test "$parts[1]" = aih:cand; or continue',
    '        set -a displays "$parts[2]"',
    '        set -a reasons "$parts[3]"',
    '        set -a argvs "$parts[4]"',
    '    end',
    '    test (count $displays) -ge 1; or return 1',
    '    printf "\\n[aih] %s，你是不是想运行：\\n" "$msg" >&2',
    '    for i in (seq (count $displays))',
    '        printf "  %d) %s  (%s)\\n" $i "$displays[$i]" (__aih_shell_reason_label "$reasons[$i]") >&2',
    '    end',
    '    printf "选择序号运行 [1-%d]（回车=取消，e=放到命令行自己编辑）：" (count $displays) >&2',
    '    read -l answer',
    '    test -n "$answer"; or return 0',
    '    if test "$answer" = e; or test "$answer" = E',
    '        commandline -r -- "$displays[1]"',
    '        commandline -f repaint',
    '        return 0',
    '    end',
    '    string match -qr \'^\\d+$\' -- "$answer"; or return 0',
    '    test "$answer" -ge 1; and test "$answer" -le (count $displays); or return 0',
    '    set -l words (string split "$_AIH_SHELL_US" -- "$argvs[$answer]")',
    '    test (count $words) -ge 1; or return 0',
    '    "$AIH_SHELL_BIN" __learn "$typo_key" -- $words >/dev/null 2>&1',
    '    printf "[aih] 运行：%s\\n" "$displays[$answer]" >&2',
    '    command $words[1] $words[2..-1]',
    '    return 0',
    'end',
    '',
    'function __aih_shell_typo_offer',
    '    __aih_shell_typo_offer_impl "没有 $argv[1] 这个命令" "$argv[1]" $argv',
    'end',
    '',
    'function __aih_shell_typo_offer_inside',
    '    __aih_shell_typo_offer_impl "aih 不认识 $argv[1]" "aih $argv[1]" --inside aih $argv',
    'end',
    '',
    'function fish_command_not_found',
    '    # 注意：fish 会**捕获** command-not-found 处理器的 stdout（用来拼错误信息），',
    '    # 所以在处理器里 `isatty stdout` 恒为假；判「有没有终端」要看 stderr。',
    '    if test "$AIH_SHELL_TYPO" = 1; and isatty stdin; and isatty stderr',
    '        __aih_shell_typo_offer $argv; and return 0',
    '    end',
    '    __aih_shell_default_not_found $argv',
    'end',
    ''
  ];
}

function buildFishWrapper() {
  return [
    '# ---- aih 自身命令打错（如 ahi / aih codx）----',
    'function aih --wraps aih --description \'aih（终端集成：打错时接话）\'',
    '    command aih $argv',
    '    set -l rc $status',
    '    if test "$rc" = 2; and test "$AIH_SHELL_WRAPPER" = 1; and isatty stdin; and isatty stderr',
    '        __aih_shell_typo_offer_inside $argv',
    '    end',
    '    return $rc',
    'end',
    ''
  ];
}

module.exports = {
  buildFishCompletion,
  buildFishSnippet,
  buildFishTypoHandler,
  buildFishWrapper,
  fishQuote
};
