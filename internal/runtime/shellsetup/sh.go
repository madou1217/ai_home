package shellsetup

import (
	"fmt"
	"strconv"
	"strings"
)

// shSnippet 生成可被 POSIX sh 解析的片段。
//
// POSIX sh 本身没有可编程补全接口：如果 /bin/sh 实际是 bash/zsh（macOS 就是
// bash 3.2），启动时直接加载对应片段，TAB 行为与原生 shell 完全一致；纯
// dash/ash 则安装手动入口，并在 doctor 里如实报告限制。
func shSnippet(options SnippetOptions) string {
	delegateFlags := make([]string, 0, 3)
	if !options.Completion {
		delegateFlags = append(delegateFlags, "--no-completion")
	}
	if !options.Typo {
		delegateFlags = append(delegateFlags, "--no-typo")
	}
	if !options.Wrapper {
		delegateFlags = append(delegateFlags, "--no-wrapper")
	}
	flags := strings.Join(delegateFlags, " ")
	if flags != "" {
		flags = " " + flags
	}
	body := `AIH_SHELL_BIN='__AIH_SHELL_BIN__'
AIH_SHELL_COMPLETION=__AIH_COMPLETION__
AIH_SHELL_TYPO=__AIH_TYPO__
AIH_SHELL_WRAPPER=__AIH_WRAPPER__
AIH_SHELL_HISTORY_TAIL=__AIH_HISTORY_TAIL__

_aih_sh_ready() {
  if [ -n "$AIH_SHELL_BIN" ] && [ -x "$AIH_SHELL_BIN" ]; then return 0; fi
  AIH_SHELL_BIN="$(command -v aih 2>/dev/null)"
  [ -n "$AIH_SHELL_BIN" ]
}

_aih_sh_delegate() {
  _aih_sh_ready || return 1
  if [ -n "__DOLLAR__{BASH_VERSION:-}" ]; then
    eval "$("$AIH_SHELL_BIN" shell snippet --shell bash__AIH_DELEGATE_FLAGS__ 2>/dev/null)"
    return $?
  fi
  if [ -n "__DOLLAR__{ZSH_VERSION:-}" ]; then
    eval "$("$AIH_SHELL_BIN" shell snippet --shell zsh__AIH_DELEGATE_FLAGS__ 2>/dev/null)"
    return $?
  fi
  return 1
}

if [ "__DOLLAR__{AIH_SHELL_COMPLETION:-0}" = "1" ]; then
  _aih_sh_delegate || {
    # 纯 POSIX sh（dash/ash）没有编程补全接口；保留手动查询入口。
    aih_complete() {
      _aih_sh_ready || return 0
      if [ "$#" -gt 0 ] && [ "$1" = "aih" ]; then
        shift
      fi
      if [ "$#" -eq 0 ]; then
        set -- ""
      fi
      "$AIH_SHELL_BIN" __complete -- "$@"
    }
    if [ -t 0 ] && [ -t 1 ]; then
      printf '%s\n' '[aih] 当前 sh 不支持 TAB 补全（dash/ash 无编程补全）；可用 aih_complete <词...> 查候选。' >&2
    fi
  }
fi
`
	completion := "0"
	if options.Completion {
		completion = "1"
	}
	replacements := map[string]string{
		"__AIH_COMPLETION__":     completion,
		"__AIH_TYPO__":           boolFlag(options.Typo),
		"__AIH_WRAPPER__":        boolFlag(options.Wrapper),
		"__AIH_HISTORY_TAIL__":   strconv.Itoa(options.HistoryTail),
		"__AIH_DELEGATE_FLAGS__": flags,
	}
	for token, value := range replacements {
		body = strings.ReplaceAll(body, token, value)
	}
	body = strings.ReplaceAll(body, "__DOLLAR__", "$")
	body = strings.ReplaceAll(body, binToken, escapeSingleQuotes("sh", options.AihBinPath))
	header := fmt.Sprintf("%s{\"completion\":%t,\"typo\":%t,\"wrapper\":%t,\"historyTail\":%d}\n",
		optionsPrefix, options.Completion, options.Typo, options.Wrapper, options.HistoryTail)
	return header + body
}

func boolFlag(value bool) string {
	if value {
		return "1"
	}
	return "0"
}
