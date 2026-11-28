package codexappconfig

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
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
	original, exists, err = quarantineCorruptConfig(path, original, exists)
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
	original, exists, err = quarantineCorruptConfig(path, original, exists)
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

// corruptConfigBackupSuffix 标记被隔离的损坏配置，方便事后取证与人工恢复。
const corruptConfigBackupSuffix = ".corrupt-"

// isCorruptConfigContent 报告配置内容是否已经不能作为 TOML 文本使用。
//
// 2026-11-27 一台 Windows 机器断电后，config.toml 只剩 NTFS 提交的 7151 字节长度，
// 数据块从未落盘（Valid Data Length = 0），读出来是整文件 NUL。这类内容既不能解析，
// 也不能按行 Patch：补写只会把 NUL 原样留下，让客户端永远卡在“配置无法加载”。
// TOML 文本里不可能出现 NUL，出现即按损坏处理。
func isCorruptConfigContent(content string) bool {
	return strings.ContainsRune(content, 0)
}

// quarantineCorruptConfig 把损坏的配置改名留档，并让调用方按“文件不存在”重建。
func quarantineCorruptConfig(path, content string, exists bool) (string, bool, error) {
	if !exists || !isCorruptConfigContent(content) {
		return content, exists, nil
	}
	base := path + corruptConfigBackupSuffix + time.Now().Format("20060102-150405")
	backup := base
	for index := 1; index < 100; index++ {
		if _, statErr := os.Stat(backup); errors.Is(statErr, os.ErrNotExist) {
			break
		}
		backup = fmt.Sprintf("%s-%d", base, index)
	}
	if err := os.Rename(path, backup); err != nil {
		return "", false, err
	}
	return "", false, nil
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
