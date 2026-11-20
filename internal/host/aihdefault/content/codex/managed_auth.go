package codex

import (
	"fmt"

	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

// 本文件只处理受管 Provider 认证命令的文本事实与替换。可执行文件是否仍然可用、
// 何时在宿主锁下发布，属于 internal/runtime/codexhostauth。
//
// 受管块的声明仍然只由本包的 hostProviderLines 生成；这里读写的是同一份
// [model_providers.aih_server.auth] 命名空间，不复制路径或键名常量。

// ManagedAuthCommand reads the executable declared by the managed provider's
// auth table.
//
// declared reports whether the managed auth namespace exists at all (a table
// header, a dotted assignment or an inline table). A nil error with declared
// true and an empty command means the namespace is present but declares no
// command; callers must treat that as an unrepairable managed block.
func ManagedAuthCommand(current string) (command string, declared bool, err error) {
	statements, err := providerconfigs.ScanTOMLStatements(current)
	if err != nil {
		return "", false, fmt.Errorf("codex_host_auth_command_config_invalid")
	}
	for _, item := range statements {
		path := statementPath(item)
		if !managedAuthPath(path) {
			continue
		}
		declared = true
		if item.Table {
			continue
		}
		switch len(path) {
		case 3: // auth = { ... }
			values, ok := item.Value.(map[string]any)
			if !ok {
				continue
			}
			if value, ok := values["command"].(string); ok {
				command = value
			}
		case 4: // auth.command = "..."
			if path[3] != "command" {
				continue
			}
			value, ok := item.Value.(string)
			if !ok {
				return "", true, fmt.Errorf("codex_host_auth_command_invalid")
			}
			command = value
		}
	}
	return command, declared, nil
}

// PatchManagedAuthCommand replaces only the managed auth command value. Every
// other byte, including the sibling args/refresh metadata and unrelated host
// content, is preserved. changed is false when no managed auth exists or the
// value already equals executable.
//
// Inline tables and a missing command are rejected with closed codes: rewriting
// those layouts would require re-encoding user text, so the caller must fall
// back to an actionable error instead of a partial edit.
func PatchManagedAuthCommand(current, executable string) (next string, changed bool, err error) {
	if !validHostPath(executable) {
		return "", false, fmt.Errorf("codex_host_auth_command_requires_absolute_paths")
	}
	statements, err := providerconfigs.ScanTOMLStatements(current)
	if err != nil {
		return "", false, fmt.Errorf("codex_host_auth_command_config_invalid")
	}
	declared := false
	inline := false
	target := -1
	for index, item := range statements {
		path := statementPath(item)
		if !managedAuthPath(path) {
			continue
		}
		declared = true
		if item.Table {
			continue
		}
		switch len(path) {
		case 3:
			inline = true
		case 4:
			if path[3] == "command" {
				target = index
			}
		}
	}
	if !declared {
		return current, false, nil
	}
	if inline {
		return "", false, fmt.Errorf("codex_host_auth_command_layout_unsupported")
	}
	if target < 0 {
		return "", false, fmt.Errorf("codex_host_auth_command_missing")
	}
	value, ok := statements[target].Value.(string)
	if !ok {
		return "", false, fmt.Errorf("codex_host_auth_command_invalid")
	}
	if value == executable {
		return current, false, nil
	}
	item := statements[target]
	patched := current[:item.ValueStart] + tomlQuote(executable) + current[item.ValueEnd:]
	if _, err := providerconfigs.ScanTOMLStatements(patched); err != nil {
		return "", false, fmt.Errorf("codex_host_auth_command_output_invalid")
	}
	return patched, true, nil
}

// statementPath returns the decoded full path of a table header or assignment.
func statementPath(item providerconfigs.TOMLStatement) []string {
	if item.Table {
		return item.Keys
	}
	return append(append([]string(nil), item.TablePath...), item.Keys...)
}

// managedAuthPath reports whether path addresses the managed provider's auth
// namespace or one of its members.
func managedAuthPath(path []string) bool {
	return len(path) >= 3 && path[0] == "model_providers" && path[1] == DefaultProviderID && path[2] == "auth"
}
