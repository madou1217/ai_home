'use strict';

/**
 * zsh 侧终端集成片段（`aih shell apply` 写进 ~/.zshrc 的受管块内容）。
 *
 * 三件事，各自独立可关：
 * 1. TAB 补全：`_aih_complete` 把「已敲下的词 + shell 的**活历史**」喂给 `aih __complete`，
 *    再把候选交给 `compadd`（带说明）。历史用 `$history` 而不是 `$HISTFILE`，
 *    因为 zsh 默认只在退出时落盘，读文件会漏掉当前会话。
 * 2. 命令打错：链式包装 `command_not_found_handler`（先把已有实现改名保存，仍然兜底调用），
 *    打印候选、**必须确认**才运行，`e` 只把纠正后的命令放进历史让用户自己编辑。
 * 3. `aih` 自己的错字：用同名 shell 函数包一层，只在 aih 以退出码 2（未知命令）结束时
 *    走同一套「确认后运行」流程，其余情况完全透明（原样返回退出码）。
 *
 * 不变量：
 * - 只在交互式 + 两端都是 TTY 时介入，脚本/管道里的行为与没装集成完全一致。
 * - 绝不 eval 候选：纠正后的命令以 argv 数组（`\x1f` 分隔）传回，直接按词执行。
 */

const { shellQuote } = require('../toolkit/environment/plan-builders');

const ZSH_BLOCK_NAME = 'shell';

/** 判据 → 给用户看的一句话（与 lib/cli/complete/typo.js 的 reason 词汇表一致）。 */
const REASON_LABELS = Object.freeze({
  learned: '你确认过',
  case: '大小写',
  transposition: '两个字母写反了',
  typo: '打错字符',
  abbrev: '少写了字母',
  prefix: '前缀匹配',
  history: '历史里用过'
});

function buildReasonCase() {
  return Object.entries(REASON_LABELS)
    .map(([reason, label]) => `    ${reason}) _aih_reason='${label}' ;;`)
    .join('\n');
}

function buildZshSnippet(options = {}) {
  const aihBinPath = String(options.aihBinPath || 'aih');
  const completion = options.completion !== false;
  const typo = options.typo !== false;
  const wrapper = options.wrapper !== false;
  const historyTail = Math.max(200, Number(options.historyTail) || 1000);
  const lines = [];
  lines.push('# aih 终端集成：TAB 补全 + 命令打错时的纠正建议。');
  lines.push('# 由 `aih shell apply` 生成，请勿手改；调整用 `aih shell apply <选项>`，移除用 `aih shell remove`。');
  lines.push(`typeset -g AIH_SHELL_BIN=${shellQuote(aihBinPath)}`);
  lines.push('typeset -g AIH_SHELL_TYPO=' + (typo ? '1' : '0'));
  lines.push('typeset -g AIH_SHELL_WRAPPER=' + (wrapper ? '1' : '0'));
  lines.push(`typeset -g AIH_SHELL_HISTORY_TAIL=${historyTail}`);
  lines.push('');
  lines.push('_aih_shell_ready() {');
  lines.push('  [[ -n "$AIH_SHELL_BIN" && -x "$AIH_SHELL_BIN" ]] && return 0');
  lines.push('  AIH_SHELL_BIN="${commands[aih]:-}"');
  lines.push('  [[ -n "$AIH_SHELL_BIN" ]]');
  lines.push('}');
  lines.push('');
  lines.push('_aih_shell_history() {');
  lines.push('  local -a _aih_hist');
  lines.push('  _aih_hist=("${(@)history[-${AIH_SHELL_HISTORY_TAIL},-1]}")');
  lines.push('  (( ${#_aih_hist} )) && print -rl -- "${(@)_aih_hist}"');
  lines.push('}');
  lines.push('');
  lines.push('_aih_shell_reason_label() {');
  lines.push('  local _aih_reason="${1:-}"');
  lines.push('  case "$_aih_reason" in');
  lines.push(buildReasonCase());
  lines.push("    *) _aih_reason='拼写接近' ;;");
  lines.push('  esac');
  lines.push('  print -r -- "$_aih_reason"');
  lines.push('}');
  lines.push('');
  lines.push('_aih_shell_split_argv() {');
  lines.push('  # 参数以 \\x1f 分隔回传：不 eval、不重新解析引号，直接按词执行。');
  lines.push('  local _aih_ifs="$IFS"');
  lines.push("  IFS=$'\\x1f'");
  lines.push('  _aih_reply=(${=1})');
  lines.push('  IFS="$_aih_ifs"');
  lines.push('}');
  lines.push('');
  if (completion) lines.push(...buildZshCompletion());
  if (typo) lines.push(...buildZshTypoHandler());
  if (wrapper) lines.push(...buildZshWrapper());
  return `${lines.join('\n')}\n`;
}

/** TAB 补全：候选来自 `aih __complete`（含历史候选），说明用 `compadd -d` 展示。 */
function buildZshCompletion() {
  return [
    '# ---- TAB 补全 ----',
    'if ! (( $+functions[compdef] )); then',
    '  autoload -Uz compinit && compinit -C',
    'fi',
    '',
    '# 把一行协议（值\\x1f说明\\x1f分组）拆到 _aih_p_value / _aih_p_desc / _aih_p_group。',
    '_aih_parse_line() {',
    "  local _aih_rest=\"${1#*$'\\x1f'}\"",
    "  _aih_p_value=\"${1%%$'\\x1f'*}\"",
    '  if [[ "$_aih_rest" == "$1" ]]; then',
    '    _aih_p_desc=""; _aih_p_group=""',
    '    return',
    '  fi',
    "  _aih_p_desc=\"${_aih_rest%%$'\\x1f'*}\"",
    "  _aih_p_group=\"${_aih_rest#*$'\\x1f'}\"",
    '  [[ "$_aih_p_group" == "$_aih_rest" ]] && _aih_p_group=""',
    '}',
    '',
    '_aih_complete() {',
    '  local _aih_at_command_position=0',
    '  (( CURRENT <= 2 )) && _aih_at_command_position=1',
    '  if ! _aih_shell_ready; then',
    '    # 命令位不给文件候选：aih 的第一个参数是命令 / provider / 账号，不是路径。',
    '    # 返回 0（而不是 1）就是「已处理、没有候选」，zsh 因此不会退回文件名补全',
    '    # （否则 `aih cl<TAB>` 会把当前目录的 CLAUDE.md 端上来）。',
    '    (( _aih_at_command_position )) && return 0',
    '    return 1',
    '  fi',
    '  local -a _aih_words',
    '  if (( CURRENT <= 1 )); then',
    "    _aih_words=('')",
    '  else',
    '    _aih_words=("${(@)words[2,CURRENT]}")',
    '  fi',
    '  local _aih_out',
    '  _aih_out="$(_aih_shell_history | "$AIH_SHELL_BIN" __complete --history-stdin -- "${_aih_words[@]}" 2>/dev/null)"',
    '  if [[ -z "$_aih_out" ]]; then',
    '    (( _aih_at_command_position )) && return 0',
    '    return 1',
    '  fi',
    '  local -a _aih_lines _aih_groups _aih_values _aih_descs _aih_multi _aih_multi_descs',
    '  local _aih_line _aih_group _aih_display _aih_group_index _aih_entry',
    '  local _aih_p_value _aih_p_desc _aih_p_group',
    '  _aih_lines=("${(@f)_aih_out}")',
    '  # 第一遍：按出现顺序收集分组名（列表里因此能带上分组标题）。',
    '  for _aih_line in "${(@)_aih_lines}"; do',
    '    [[ -z "$_aih_line" ]] && continue',
    '    _aih_parse_line "$_aih_line"',
    '    _aih_group="$_aih_p_group"',
    '    [[ -z "$_aih_group" ]] && _aih_group="其它"',
    '    (( ${_aih_groups[(Ie)$_aih_group]} )) || _aih_groups+=("$_aih_group")',
    '  done',
    '  for _aih_group in "${(@)_aih_groups}"; do',
    '    _aih_values=(); _aih_descs=(); _aih_multi=(); _aih_multi_descs=()',
    '    for _aih_line in "${(@)_aih_lines}"; do',
    '      [[ -z "$_aih_line" ]] && continue',
    '      _aih_parse_line "$_aih_line"',
    '      _aih_group_index="$_aih_p_group"',
    '      [[ -z "$_aih_group_index" ]] && _aih_group_index="其它"',
    '      [[ "$_aih_group_index" == "$_aih_group" ]] || continue',
    '      # compadd -d 的语义是「用这段文字**代替**匹配本身显示」，所以显示串里必须自带候选值，',
    '      # 否则列表只剩说明、看不出补的是什么（实测过）。',
    '      if [[ -n "$_aih_p_desc" ]]; then',
    '        _aih_display="${_aih_p_value}  ${_aih_p_desc}"',
    '      else',
    '        _aih_display="$_aih_p_value"',
    '      fi',
    '      if [[ "$_aih_p_value" == *[[:space:]]* ]]; then',
    '        _aih_multi+=("$_aih_p_value")',
    '        _aih_multi_descs+=("$_aih_display")',
    '      else',
    '        _aih_values+=("$_aih_p_value")',
    '        _aih_descs+=("$_aih_display")',
    '      fi',
    '    done',
    '    # 单词候选按常规插入（自动加空格）；多词候选原样插入且不加空格，',
    '    # 于是一条历史命令可以一次补完整行（fish 式）。',
    '    # 会话候选是「按时间倒序挑一个」的场景：用 -V（不做字典序重排，保持我们的新→旧顺序），',
    '    # 并把 compstate[insert] 设为 menu —— 一次 TAB 就进入菜单选择，↑/↓ 直接挑（见 zshcompwid）。',
    '    if [[ "$_aih_group" == "会话" ]]; then',
    '      compstate[insert]=menu',
    '      (( ${#_aih_values} )) && compadd -V "$_aih_group" -X "$_aih_group" -d _aih_descs -- "${_aih_values[@]}"',
    "      (( ${#_aih_multi} )) && compadd -V \"$_aih_group\" -X \"$_aih_group\" -Q -S '' -d _aih_multi_descs -- \"${_aih_multi[@]}\"",
    '      continue',
    '    fi',
    '    (( ${#_aih_values} )) && compadd -J "$_aih_group" -X "$_aih_group" -d _aih_descs -- "${_aih_values[@]}"',
    "    (( ${#_aih_multi} )) && compadd -J \"$_aih_group\" -X \"$_aih_group\" -Q -S '' -d _aih_multi_descs -- \"${_aih_multi[@]}\"",
    '  done',
    '  return 0',
    '}',
    'compdef _aih_complete aih',
    ''
  ];
}

/** 拼写纠正：包装 command_not_found_handler，先保存用户原有的实现并在兜底时调用它。 */
function buildZshTypoHandler() {
  return [
    '# ---- 命令打错时的纠正建议 ----',
    'if (( $+functions[command_not_found_handler] )) && ! (( $+functions[_aih_prev_command_not_found_handler] )); then',
    '  functions[_aih_prev_command_not_found_handler]="$functions[command_not_found_handler]"',
    'fi',
    '',
    '_aih_shell_fallback_not_found() {',
    '  if (( $+functions[_aih_prev_command_not_found_handler] )); then',
    '    _aih_prev_command_not_found_handler "$@"',
    '    return $?',
    '  fi',
    '  print -u2 -- "zsh: command not found: $1"',
    '  return 127',
    '}',
    '',
    '# 两个入口共用同一套「列候选 → 确认 → 运行/放进历史」流程：',
    '#   _aih_shell_typo_offer        命令本身不存在（ahi、gti）',
    '#   _aih_shell_typo_offer_inside aih 存在但紧随其后的词写错（aih codx）',
    '# 参数：提示语 / 显示用的命令行 / 其余原样交给 __suggest。返回 0 = 已处理。',
    '_aih_shell_typo_offer_impl() {',
    '  local _aih_msg="$1" _aih_head="$2"',
    '  shift 2',
    '  _aih_shell_ready || return 1',
    '  local _aih_out',
    '  _aih_out="$(_aih_shell_history | "$AIH_SHELL_BIN" __suggest --history-stdin -- "$@" 2>/dev/null)"',
    '  [[ -z "$_aih_out" ]] && return 1',
    '  local -a _aih_lines',
    '  _aih_lines=("${(@f)_aih_out}")',
    '  local _aih_kind_line="${_aih_lines[1]}"',
    "  local _aih_typo_key=\"${_aih_kind_line##*$'\\x1f'}\"",
    "  [[ \"${_aih_kind_line#*$'\\x1f'}\" == 'none'* ]] && return 1",
    '  [[ -z "$_aih_typo_key" ]] && _aih_typo_key="$_aih_head"',
    '  local -a _aih_displays _aih_argvs _aih_reasons',
    '  local _aih_line _aih_rest _aih_display _aih_reason _aih_argv_text',
    '  for _aih_line in "${(@)_aih_lines[2,-1]}"; do',
    "    [[ \"$_aih_line\" == aih:cand$'\\x1f'* ]] || continue",
    "    _aih_rest=\"${_aih_line#aih:cand$'\\x1f'}\"",
    "    _aih_display=\"${_aih_rest%%$'\\x1f'*}\"",
    "    _aih_rest=\"${_aih_rest#*$'\\x1f'}\"",
    "    _aih_reason=\"${_aih_rest%%$'\\x1f'*}\"",
    "    _aih_argv_text=\"${_aih_rest#*$'\\x1f'}\"",
    '    _aih_displays+=("$_aih_display")',
    '    _aih_argvs+=("$_aih_argv_text")',
    '    _aih_reasons+=("$_aih_reason")',
    '  done',
    '  (( ${#_aih_displays} )) || return 1',
    '  print -u2 -- ""',
    '  print -u2 -- "\\033[33m[aih]\\033[0m ${_aih_msg}，你是不是想运行："',
    '  local _aih_i',
    '  for (( _aih_i=1; _aih_i<=${#_aih_displays}; _aih_i++ )); do',
    '    print -u2 -- "  ${_aih_i}) ${_aih_displays[_aih_i]}  \\033[90m（$(_aih_shell_reason_label "${_aih_reasons[_aih_i]}")）\\033[0m"',
    '  done',
    '  local _aih_answer',
    '  print -n -u2 -- "选择序号运行 [1-${#_aih_displays}]（回车=取消，e=放进历史自己编辑）："',
    '  read -r _aih_answer || return 1',
    '  local -a _aih_argv',
    '  if [[ "$_aih_answer" == [eE] ]]; then',
    '    print -s -- "${_aih_displays[1]}"',
    '    print -u2 -- "已放入历史：${_aih_displays[1]}（按 ↑ 编辑后回车运行）"',
    '    return 0',
    '  fi',
    '  [[ "$_aih_answer" == <-> ]] || return 0',
    '  (( _aih_answer >= 1 && _aih_answer <= ${#_aih_displays} )) || return 0',
    '  _aih_shell_split_argv "${_aih_argvs[_aih_answer]}"',
    '  _aih_argv=("${(@)_aih_reply}")',
    '  (( ${#_aih_argv} )) || return 0',
    '  "$AIH_SHELL_BIN" __learn "$_aih_typo_key" -- "${_aih_argv[@]}" >/dev/null 2>&1',
    '  print -u2 -- "\\033[90m[aih] 运行：${_aih_displays[_aih_answer]}\\033[0m"',
    '  "${_aih_argv[@]}"',
    '  return 0',
    '}',
    '',
    '_aih_shell_typo_offer() {',
    '  _aih_shell_typo_offer_impl "没有 ${(q)1} 这个命令" "$1" "$@"',
    '}',
    '',
    '_aih_shell_typo_offer_inside() {',
    '  # 错的是紧随 `aih` 之后的那个词：把完整命令行交给 __suggest --inside。',
    '  _aih_shell_typo_offer_impl "aih 不认识 ${(q)1}" "aih ${1:-}" --inside aih "$@"',
    '}',
    '',
    'command_not_found_handler() {',
    '  if [[ -o interactive ]] && [[ -t 0 && -t 1 ]] && (( AIH_SHELL_TYPO )); then',
    '    _aih_shell_typo_offer "$@" && return 0',
    '  fi',
    '  _aih_shell_fallback_not_found "$@"',
    '}',
    ''
  ];
}

/** `aih` 自己的错字：同名函数只在退出码 2（未知命令）时接话，其余完全透明。
 *  传给纠错流程的是**完整命令行**（`aih` + 原参数），因为错的是紧随其后的那个词（如 `aih codx`）。 */
function buildZshWrapper() {
  return [
    '# ---- aih 自身命令打错（如 ahi / aih codx）----',
    'aih() {',
    '  command aih "$@"',
    '  local _aih_rc=$?',
    '  if (( _aih_rc == 2 )) && (( AIH_SHELL_WRAPPER )) && [[ -o interactive ]] && [[ -t 0 && -t 1 ]]; then',
    '    _aih_shell_typo_offer_inside "$@"',
    '  fi',
    '  return $_aih_rc',
    '}',
    ''
  ];
}

module.exports = {
  REASON_LABELS,
  ZSH_BLOCK_NAME,
  buildZshCompletion,
  buildZshSnippet,
  buildZshTypoHandler,
  buildZshWrapper
};
