// Package codexhostauth keeps the host Codex provider's managed auth command
// callable across CLI upgrades and repository moves.
//
// The managed block's text grammar and declaration stay in
// internal/host/aihdefault/content/codex. This package owns the file-level
// policy: which config governs a launch, when a declared command is no longer
// runnable, and how to repair it atomically (or fail with an actionable error).
package codexhostauth

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	codexconfig "github.com/madou1217/ai_home/internal/host/aihdefault/content/codex"
	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
)

// Result describes one self-heal attempt. It never contains credentials.
type Result struct {
	ConfigPath      string
	PreviousCommand string
	Command         string
	Changed         bool
}

// ConfigPath returns the Codex config that governs a CLI launch: an explicit
// CODEX_HOME wins, otherwise <hostHomeDir>/.codex/config.toml. lookupEnv may be
// nil to ignore the environment (server-side projection owners).
func ConfigPath(hostHomeDir string, lookupEnv func(string) (string, bool)) string {
	if lookupEnv != nil {
		if home, ok := lookupEnv("CODEX_HOME"); ok && strings.TrimSpace(home) != "" {
			return absolute(filepath.Join(strings.TrimSpace(home), "config.toml"))
		}
	}
	hostHome := strings.TrimSpace(hostHomeDir)
	if hostHome == "" {
		return ""
	}
	return absolute(filepath.Join(hostHome, providerroot.ConfigDir("codex"), "config.toml"))
}

// SiblingCLI returns the CLI executable able to serve `codex gateway-auth` that
// ships next to binary (the release layout places aih-go beside aih-server).
func SiblingCLI(binary string) (string, error) {
	name := "aih-go"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	target := filepath.Join(filepath.Dir(binary), name)
	if !runnableExecutable(target) {
		return "", fmt.Errorf("codex_host_auth_cli_unavailable: 未找到可执行的 CLI %s", target)
	}
	return target, nil
}

// Ensure re-points the managed provider auth command at executable when the
// command declared in configPath is no longer runnable (missing, relative, not
// a regular file or not executable). It is a no-op when the config file or the
// managed auth namespace is absent, or when the declared command is runnable:
// valid but different paths are never rewritten.
//
// The repair only replaces the command value span, keeping the existing args
// and every unrelated/unedited byte. Publication reuses the shared host lock
// and the atomic Codex preference writer.
func Ensure(configPath, executable string) (Result, error) {
	result := Result{ConfigPath: configPath}
	if strings.TrimSpace(configPath) == "" {
		return result, nil
	}
	raw, err := os.ReadFile(configPath)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, fmt.Errorf("codex_host_auth_config_unreadable: 无法读取 %s: %w", configPath, err)
	}
	command, declared, inspectErr := codexconfig.ManagedAuthCommand(string(raw))
	if inspectErr != nil {
		if !declared {
			return result, fmt.Errorf("codex_host_auth_config_unreadable: 无法解析 %s 的受管认证段: %v", configPath, inspectErr)
		}
		return result, unrepairable(configPath, inspectErr)
	}
	if !declared {
		return result, nil
	}
	result.Command = command
	if runnableExecutable(command) {
		return result, nil
	}
	if !runnableExecutable(executable) {
		return result, fmt.Errorf("codex_host_auth_cli_unavailable: 受管 Codex 认证命令 %q 已失效，当前也没有可用的 aih CLI 可以接管；请重新安装 aih 后运行 aih codex set-default .aih-server 重写 %s", command, configPath)
	}
	changed := false
	err = codexpreferences.UpdateDocument(filepath.Dir(configPath), func(current string) (string, error) {
		next, patched, patchErr := codexconfig.PatchManagedAuthCommand(current, executable)
		if patchErr != nil {
			return "", patchErr
		}
		changed = patched
		return next, nil
	})
	if err != nil {
		return result, unrepairable(configPath, err)
	}
	if changed {
		result.Changed = true
		result.PreviousCommand = command
		result.Command = executable
		return result, nil
	}
	// Another writer may have repaired (or removed) the managed block between the
	// preflight read and the lock. Re-read so callers report the effective state.
	final, err := os.ReadFile(configPath)
	if err != nil {
		return result, fmt.Errorf("codex_host_auth_config_unreadable: 无法读取 %s: %w", configPath, err)
	}
	command, declared, inspectErr = codexconfig.ManagedAuthCommand(string(final))
	if inspectErr != nil {
		return result, unrepairable(configPath, inspectErr)
	}
	if !declared {
		return result, unrepairable(configPath, fmt.Errorf("codex_host_auth_command_missing"))
	}
	if !runnableExecutable(command) {
		return result, unrepairable(configPath, fmt.Errorf("codex_host_auth_command_still_invalid"))
	}
	result.Command = command
	return result, nil
}

// unrepairable turns a closed layout/IO error into actionable diagnostics. The
// explicit set-default path rewrites the whole managed block from current facts.
func unrepairable(configPath string, cause error) error {
	detail := "受管认证段无法安全改写"
	if cause != nil {
		detail = cause.Error()
	}
	return fmt.Errorf("codex_host_auth_command_heal_failed: %s（%s）；请运行 aih codex set-default .aih-server 重建受管配置，或手工修复后重试", detail, configPath)
}

// runnableExecutable reports whether path can serve as an auth command.
func runnableExecutable(path string) bool {
	if strings.TrimSpace(path) == "" || !filepath.IsAbs(path) {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0
}

func absolute(path string) string {
	if resolved, err := filepath.Abs(path); err == nil {
		return resolved
	}
	return path
}
