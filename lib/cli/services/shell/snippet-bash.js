'use strict';

/**
 * bash 侧终端集成片段。与 zsh 版语义完全一致（见 snippet-zsh.js 的说明），
 * 只是换用 bash 的机制：
 * - 补全用 `complete -F`，候选走 `COMPREPLY`（bash 不支持候选说明，因此只给值）。
 * - 历史用 `history` 内建（补全函数在当前 shell 里跑，能拿到活历史）。
 * - 打错纠正包装 `command_not_found_handle`，并把用户原有的实现改名保存后继续兜底。
 * - 修正后的命令同样以 argv 数组回传（`\x1f` 分隔），不 eval。
 *
 * 兼容性：只用 bash 3.2（macOS 自带）也支持的语法——不用 `mapfile`、不用关联数组。
 */

const { shellQuote } = require('../toolkit/environment/plan-builders');

function buildBashSnippet(options = {}) {
  const aihBinPath = String(options.aihBinPath || 'aih');
  const completion = options.completion !== false;
  const typo = options.typo !== false;
  const wrapper = options.wrapper !== false;
  const historyTail = Math.max(200, Number(options.historyTail) || 1000);
  const lines = [];
  lines.push('# aih 终端集成：TAB 补全 + 命令打错时的纠正建议。');
  lines.push('# 由 `aih shell apply` 生成，请勿手改；调整用 `aih shell apply <选项>`，移除用 `aih shell remove`。');
  lines.push(`AIH_SHELL_BIN=${shellQuote(aihBinPath)}`);
  lines.push(`AIH_SHELL_TYPO=${typo ? '1' : '0'}`);
  lines.push(`AIH_SHELL_WRAPPER=${wrapper ? '1' : '0'}`);
  lines.push(`AIH_SHELL_HISTORY_TAIL=${historyTail}`);
  lines.push('');
  lines.push('_aih_shell_ready() {');
  lines.push('  if [ -n "$AIH_SHELL_BIN" ] && [ -x "$AIH_SHELL_BIN" ]; then return 0; fi');
  lines.push('  AIH_SHELL_BIN="$(command -v aih 2>/dev/null)"');
  lines.push('  [ -n "$AIH_SHELL_BIN" ]');
  lines.push('}');
  lines.push('');
  lines.push('_aih_shell_history() {');
  lines.push('  history "$AIH_SHELL_HISTORY_TAIL" 2>/dev/null');
  lines.push('}');
  lines.push('');
  lines.push('_aih_shell_reason_label() {');
  lines.push('  case "${1:-}" in');
  lines.push("    learned) printf '%s' '你确认过' ;;");
  lines.push("    case) printf '%s' '大小写' ;;");
  lines.push("    transposition) printf '%s' '两个字母写反了' ;;");
  lines.push("    typo) printf '%s' '打错字符' ;;");
  lines.push("    abbrev) printf '%s' '少写了字母' ;;");
  lines.push("    prefix) printf '%s' '前缀匹配' ;;");
  lines.push("    history) printf '%s' '历史里用过' ;;");
  lines.push("    *) printf '%s' '拼写接近' ;;");
  lines.push('  esac');
  lines.push('}');
  lines.push('');
  if (completion) lines.push(...buildBashCompletion());
  if (typo) lines.push(...buildBashTypoHandler());
  if (wrapper) lines.push(...buildBashWrapper());
  return `${lines.join('\n')}\n`;
}

function buildBashCompletion() {
  return [
    '# ---- TAB 补全 ----',
    '_aih_complete() {',
    '  _aih_shell_ready || return 1',
    '  local _aih_cur _aih_i _aih_line _aih_out',
    '  local -a _aih_words',
    '  COMPREPLY=()',
    '  for (( _aih_i=1; _aih_i<=COMP_CWORD; _aih_i++ )); do',
    '    _aih_words+=("${COMP_WORDS[_aih_i]}")',
    '  done',
    '  [ "${#_aih_words[@]}" -eq 0 ] && _aih_words=("")',
    '  _aih_out="$(_aih_shell_history | "$AIH_SHELL_BIN" __complete --history-stdin -- "${_aih_words[@]}" 2>/dev/null)"',
    '  while IFS= read -r _aih_line; do',
    '    [ -z "$_aih_line" ] && continue',
    "    COMPREPLY+=(\"${_aih_line%%$'\\x1f'*}\")",
    '  done <<< "$_aih_out"',
    '  return 0',
    '}',
    'complete -F _aih_complete aih',
    ''
  ];
}

function buildBashTypoHandler() {
  return [
    '# ---- 命令打错时的纠正建议 ----',
    'if declare -F command_not_found_handle >/dev/null 2>&1 && ! declare -F _aih_prev_command_not_found_handle >/dev/null 2>&1; then',
    "  eval \"$(declare -f command_not_found_handle | sed '1s/command_not_found_handle/_aih_prev_command_not_found_handle/')\"",
    'fi',
    '',
    '_aih_shell_fallback_not_found() {',
    '  if declare -F _aih_prev_command_not_found_handle >/dev/null 2>&1; then',
    '    _aih_prev_command_not_found_handle "$@"',
    '    return $?',
    '  fi',
    '  printf "%s\\n" "bash: $1: command not found" >&2',
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
    '  local _aih_out _aih_kind_line _aih_typo_key _aih_line _aih_display _aih_reason _aih_argv_text _aih_answer',
    '  local -a _aih_displays _aih_argvs _aih_reasons _aih_argv',
    '  _aih_out="$(_aih_shell_history | "$AIH_SHELL_BIN" __suggest --history-stdin -- "$@" 2>/dev/null)"',
    '  [ -z "$_aih_out" ] && return 1',
    "  _aih_kind_line=\"${_aih_out%%$'\\n'*}\"",
    "  _aih_typo_key=\"${_aih_kind_line##*$'\\x1f'}\"",
    "  case \"${_aih_kind_line#*$'\\x1f'}\" in none*) return 1 ;; esac",
    '  [ -z "$_aih_typo_key" ] && _aih_typo_key="$_aih_head"',
    '  while IFS= read -r _aih_line; do',
    "    case \"$_aih_line\" in aih:cand$'\\x1f'*) ;; *) continue ;; esac",
    "    _aih_line=\"${_aih_line#aih:cand$'\\x1f'}\"",
    "    _aih_display=\"${_aih_line%%$'\\x1f'*}\"",
    "    _aih_line=\"${_aih_line#*$'\\x1f'}\"",
    "    _aih_reason=\"${_aih_line%%$'\\x1f'*}\"",
    "    _aih_argv_text=\"${_aih_line#*$'\\x1f'}\"",
    '    _aih_displays+=("$_aih_display")',
    '    _aih_argvs+=("$_aih_argv_text")',
    '    _aih_reasons+=("$_aih_reason")',
    '  done <<< "$_aih_out"',
    '  [ "${#_aih_displays[@]}" -eq 0 ] && return 1',
    '  printf "\\n" >&2',
    '  printf "[aih] %s，你是不是想运行：\\n" "$_aih_msg" >&2',
    '  local _aih_i',
    '  for (( _aih_i=0; _aih_i<${#_aih_displays[@]}; _aih_i++ )); do',
    '    printf "  %s) %s  (%s)\\n" "$(( _aih_i + 1 ))" "${_aih_displays[_aih_i]}" "$(_aih_shell_reason_label "${_aih_reasons[_aih_i]}")" >&2',
    '  done',
    '  printf "选择序号运行 [1-%s]（回车=取消，e=放进历史自己编辑）：" "${#_aih_displays[@]}" >&2',
    '  read -r _aih_answer || return 1',
    '  if [ "$_aih_answer" = "e" ] || [ "$_aih_answer" = "E" ]; then',
    '    history -s -- "${_aih_displays[0]}"',
    '    printf "已放入历史：%s（按 ↑ 编辑后回车运行）\\n" "${_aih_displays[0]}" >&2',
    '    return 0',
    '  fi',
    '  case "$_aih_answer" in ""|*[!0-9]*) return 0 ;; esac',
    '  [ "$_aih_answer" -ge 1 ] && [ "$_aih_answer" -le "${#_aih_displays[@]}" ] || return 0',
    "  IFS=$'\\x1f' read -r -a _aih_argv <<< \"${_aih_argvs[$(( _aih_answer - 1 ))]}\"",
    '  [ "${#_aih_argv[@]}" -eq 0 ] && return 0',
    '  "$AIH_SHELL_BIN" __learn "$_aih_typo_key" -- "${_aih_argv[@]}" >/dev/null 2>&1',
    '  printf "[aih] 运行：%s\\n" "${_aih_displays[$(( _aih_answer - 1 ))]}" >&2',
    '  "${_aih_argv[@]}"',
    '  return 0',
    '}',
    '',
    '_aih_shell_typo_offer() {',
    '  _aih_shell_typo_offer_impl "没有 $1 这个命令" "$1" "$@"',
    '}',
    '',
    '_aih_shell_typo_offer_inside() {',
    '  # 错的是紧随 `aih` 之后的那个词：把完整命令行交给 __suggest --inside。',
    '  _aih_shell_typo_offer_impl "aih 不认识 ${1:-}" "aih ${1:-}" --inside aih "$@"',
    '}',
    '',
    'command_not_found_handle() {',
    '  if [ -t 0 ] && [ -t 1 ] && [ "${AIH_SHELL_TYPO:-0}" = "1" ]; then',
    '    _aih_shell_typo_offer "$@" && return 0',
    '  fi',
    '  _aih_shell_fallback_not_found "$@"',
    '}',
    ''
  ];
}

function buildBashWrapper() {
  return [
    '# ---- aih 自身命令打错（如 ahi / aih codx）----',
    'aih() {',
    '  command aih "$@"',
    '  local _aih_rc=$?',
    '  if [ "$_aih_rc" = "2" ] && [ "${AIH_SHELL_WRAPPER:-0}" = "1" ] && [ -t 0 ] && [ -t 1 ]; then',
    '    _aih_shell_typo_offer_inside "$@"',
    '  fi',
    '  return $_aih_rc',
    '}',
    ''
  ];
}

module.exports = {
  buildBashCompletion,
  buildBashSnippet,
  buildBashTypoHandler,
  buildBashWrapper
};
