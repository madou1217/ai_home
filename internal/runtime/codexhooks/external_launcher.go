package codexhooks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// ExternalLauncherOptions 配置外置启动器安装参数。
type ExternalLauncherOptions struct {
	TargetBinaryPath   string
	UpstreamBinaryPath string
	Wrapper            string
	IsWrapperInstalled func(filePath string) bool
}

// ExternalLauncherResult 返回外置启动器安装或恢复的结果。
type ExternalLauncherResult struct {
	OK                 bool   `json:"ok"`
	Installed          bool   `json:"installed"`
	Updated            bool   `json:"updated"`
	Unchanged          bool   `json:"unchanged"`
	Reason             string `json:"reason,omitempty"`
	TargetBinaryPath   string `json:"targetBinaryPath,omitempty"`
	UpstreamBinaryPath string `json:"upstreamBinaryPath,omitempty"`
}

// InstallExternalLauncher 安装外部桌面端启动器（若历史上曾原地覆写嵌套二进制，则自动恢复原件）。
func InstallExternalLauncher(opts ExternalLauncherOptions) (ExternalLauncherResult, error) {
	target := strings.TrimSpace(opts.TargetBinaryPath)
	upstream := strings.TrimSpace(opts.UpstreamBinaryPath)
	isInstalled := opts.IsWrapperInstalled
	if isInstalled == nil {
		isInstalled = func(p string) bool {
			return readFileMarkerPrefix(p, WrapperMarkerDesktop)
		}
	}

	if upstream != "" && isInstalled(upstream) {
		backupPath := upstream + ".aih-original"
		if !fileExists(backupPath) || isInstalled(backupPath) {
			return ExternalLauncherResult{
				OK:     false,
				Reason: "missing_upstream_backup",
			}, nil
		}
		if err := os.Rename(backupPath, upstream); err != nil {
			return ExternalLauncherResult{}, err
		}
	}

	if upstream == "" || !fileExists(upstream) {
		return ExternalLauncherResult{
			OK:     false,
			Reason: "upstream_binary_missing",
		}, nil
	}

	unchanged := isInstalled(target) && readTextFileSafe(target) == opts.Wrapper
	if !unchanged {
		if err := atomicWriteFile(target, []byte(opts.Wrapper), 0o755); err != nil {
			return ExternalLauncherResult{}, err
		}
	}

	return ExternalLauncherResult{
		OK:                 true,
		Installed:          true,
		Updated:            !unchanged,
		Unchanged:          unchanged,
		TargetBinaryPath:   target,
		UpstreamBinaryPath: upstream,
	}, nil
}

// ReadDesktopLaunchEnv 读取 desktop-hook-state.json，若启用外置启动器策略则注入 CODEX_CLI_PATH。
func ReadDesktopLaunchEnv(aiHomeDir string) map[string]string {
	cleanHome := strings.TrimSpace(aiHomeDir)
	if cleanHome == "" {
		return map[string]string{}
	}
	dir := filepath.Join(cleanHome, "run", "codex")
	statePath := filepath.Join(dir, "desktop-hook-state.json")
	raw, err := os.ReadFile(statePath)
	if err != nil {
		return map[string]string{}
	}
	var state struct {
		Enabled          bool   `json:"enabled"`
		HookStrategy     string `json:"hookStrategy"`
		TargetBinaryPath string `json:"targetBinaryPath"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return map[string]string{}
	}
	launcher := filepath.Join(dir, "desktop-cli")
	if !state.Enabled || state.HookStrategy != HookStrategyExternalLauncher || state.TargetBinaryPath != launcher {
		return map[string]string{}
	}
	if !isRegularFile(launcher) {
		return map[string]string{}
	}
	return map[string]string{"CODEX_CLI_PATH": launcher}
}
