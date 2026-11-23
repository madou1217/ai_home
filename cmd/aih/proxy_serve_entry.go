package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// serveEntry 是本机 `aih proxy serve` 发布给本地消费者的当前入口。
//
// 常驻服务重启后监听端口与租约令牌都会变化，消费者（例如 SOCKS5h→HTTP
// 桥插件）读取这个文件即可重新发现入口，不需要重启或重新配置。
// 文件包含租约凭据，因此只写 0600，且只发布到本机 run/ 目录。
type serveEntry struct {
	Version   int    `json:"version"`
	PID       int    `json:"pid"`
	Name      string `json:"name,omitempty"`
	HTTPURL   string `json:"httpUrl,omitempty"`
	SOCKS5URL string `json:"socks5Url,omitempty"`
	UpdatedAt string `json:"updatedAt"`
}

// serveEntryPath 是入口状态文件的固定位置。
func serveEntryPath(home string) string {
	return filepath.Join(home, "run", "proxy", "entry.json")
}

// publishServeEntry 原子写入当前入口，并返回只删除本次写入的清理函数。
//
// 多个进程只允许最后写入者获胜：清理时核对 PID，避免退出中的旧实例
// 删掉新实例刚发布的入口。
func publishServeEntry(home string, lease *serveLease) (func(), error) {
	noop := func() {}
	if lease == nil || strings.TrimSpace(lease.socksURL) == "" {
		return noop, nil
	}
	path := serveEntryPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	entry := serveEntry{
		Version:   1,
		PID:       os.Getpid(),
		Name:      lease.name,
		HTTPURL:   lease.httpURL,
		SOCKS5URL: lease.socksURL,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	payload, err := json.Marshal(entry)
	if err != nil {
		return nil, err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return nil, err
	}
	return func() { removeServeEntry(path, entry.PID) }, nil
}

// removeServeEntry 只删除本次进程发布的入口文件。
func removeServeEntry(path string, pid int) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var entry serveEntry
	if json.Unmarshal(payload, &entry) != nil || entry.PID != pid {
		return
	}
	_ = os.Remove(path)
}
