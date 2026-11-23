package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// readManagementKeyFile 读取代理服务的 Management Key。文件模式过宽时拒绝，
// 避免把远程管理凭据留在同机其他用户可读的位置。
func readManagementKeyFile(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("Management Key 文件路径为空")
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return "", errors.New("Management Key 文件不可用")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("Management Key 文件权限过宽，必须仅所有者可读")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("Management Key 文件无法读取")
	}
	key := strings.TrimSpace(string(raw))
	if key == "" {
		return "", errors.New("Management Key 文件为空")
	}
	return key, nil
}

// writeManagementKeyFile 以 0600 写入 Management Key；已存在的文件保留不动。
func writeManagementKeyFile(path, key string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	if strings.TrimSpace(key) == "" {
		return errors.New("没有可写入的 Management Key")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(strings.TrimSpace(key)+"\n"), 0600)
}
