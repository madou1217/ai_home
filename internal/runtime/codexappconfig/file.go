package codexappconfig

import (
	"errors"
	"os"
	"path/filepath"
)

// ErrConfigChanged 表示读到的内容在写回前已被其它进程修改。
var ErrConfigChanged = errors.New("codex_config_changed_retry")

// HealConfigFile 读取 config.toml，执行全部自愈并在有变化时原子写回。
func HealConfigFile(path string, options HealOptions) (HealResult, error) {
	if path == "" {
		return HealResult{}, nil
	}
	original, exists, err := readConfigFile(path)
	if err != nil {
		return HealResult{}, err
	}
	result := HealConfig(original, options)
	if !result.Changed {
		return result, nil
	}
	if err := ReplaceConfigFile(path, result.Config, original, exists); err != nil {
		return HealResult{}, err
	}
	return result, nil
}

// PrepareConfigFile 先自愈、再按账号级配置合并，最后原子写回。
func PrepareConfigFile(path string, account AccountOnlyConfig, options SyncOptions, healOptions HealOptions) (string, error) {
	if path == "" {
		return "", nil
	}
	original, exists, err := readConfigFile(path)
	if err != nil {
		return "", err
	}
	healed := HealConfig(original, healOptions)
	merged := MergeConfigs(healed.Config, account, options)
	if healed.Config == merged && !healed.Changed {
		return merged, nil
	}
	if err := ReplaceConfigFile(path, merged, original, exists); err != nil {
		return "", err
	}
	return merged, nil
}

// ReplaceConfigFile 在写回前重新读取并核对 expected，避免覆盖并发修改。
func ReplaceConfigFile(path, content, expected string, existed bool) error {
	current, exists, err := readConfigFile(path)
	if err != nil {
		return err
	}
	if exists != existed || current != expected {
		return ErrConfigChanged
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if info, statErr := os.Stat(path); statErr == nil {
		mode = info.Mode().Perm()
	}
	temporary, err := os.CreateTemp(dir, ".aih-codex-config-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer func() {
		_ = os.Remove(temporaryName)
	}()
	if _, err := temporary.WriteString(content); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, path)
}

func readConfigFile(path string) (string, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return string(raw), true, nil
}
