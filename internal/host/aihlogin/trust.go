package aihlogin

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// seedLoginFolderTrust 把登录工作目录预置进投影的 settings.json trustedDirectories，
// 避免官方 CLI 首启弹「Do you trust the files in this folder?」把无头登录卡死。
//
// 与 Node codebuddy 登录策略同语义：只信任 aih 自己的登录工作目录，pattern 为
// <dir>/**；原始路径与 realpath 都加（macOS /tmp 会被 CLI 显示成 /private/tmp）。
// 登录投影里的 settings.json 若是指向宿主共享配置的符号链接，先替换成独立文件再写，
// 不把临时目录写进宿主设置。
func seedLoginFolderTrust(configDir string, cwd string) error {
	directory := strings.TrimSpace(configDir)
	workDir := strings.TrimSpace(cwd)
	if directory == "" || workDir == "" {
		return nil
	}
	patterns := trustPatterns(workDir)
	if len(patterns) == 0 {
		return nil
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	settingsPath := filepath.Join(directory, "settings.json")
	raw := []byte{}
	if info, err := os.Lstat(settingsPath); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			if target, readErr := os.ReadFile(settingsPath); readErr == nil {
				raw = target
			}
			if removeErr := os.Remove(settingsPath); removeErr != nil {
				return removeErr
			}
		} else {
			if content, readErr := os.ReadFile(settingsPath); readErr == nil {
				raw = content
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	settings := make(map[string]any)
	if len(raw) > 0 {
		if json.Unmarshal(raw, &settings) != nil || settings == nil {
			settings = make(map[string]any)
		}
	}
	existing := make([]string, 0)
	if values, ok := settings["trustedDirectories"].([]any); ok {
		for _, value := range values {
			if text, ok := value.(string); ok {
				existing = append(existing, text)
			}
		}
	}
	merged := append([]string(nil), existing...)
	for _, pattern := range patterns {
		found := false
		for _, value := range merged {
			if value == pattern {
				found = true
				break
			}
		}
		if !found {
			merged = append(merged, pattern)
		}
	}
	if len(merged) == len(existing) {
		return nil
	}
	settings["trustedDirectories"] = merged
	encoded, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(settingsPath, append(encoded, '\n'), 0o600)
}

// trustPatterns 生成 <dir>/** 与 realpath 变体（去重、去尾斜杠）。
func trustPatterns(workDir string) []string {
	patterns := make([]string, 0, 3)
	seen := make(map[string]bool)
	add := func(value string) {
		trimmed := strings.TrimSpace(value)
		trimmed = strings.TrimRight(trimmed, "/\\")
		if trimmed == "" {
			return
		}
		pattern := trimmed + "/**"
		if !seen[pattern] {
			seen[pattern] = true
			patterns = append(patterns, pattern)
		}
	}
	add(workDir)
	if absolute, err := filepath.Abs(workDir); err == nil {
		add(absolute)
	}
	if resolved, err := filepath.EvalSymlinks(workDir); err == nil {
		add(resolved)
	}
	return patterns
}

// writeFileAtomic 先写临时文件再 rename，避免半截 settings。
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".settings-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
