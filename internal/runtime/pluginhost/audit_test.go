package pluginhost

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

func TestAuditLogAppendReadPermissionsAndInvalidLines(t *testing.T) {
	home := t.TempDir()
	fixed := time.Date(2026, 11, 13, 12, 34, 56, 789000000, time.UTC)
	audit := NewAuditLog(home, WithAuditNow(func() time.Time { return fixed }))

	expectedPath := filepath.Join(home, "plugins", "audit.log")
	if audit.Path() != expectedPath {
		t.Fatalf("期望路径 %q，实际为 %q", expectedPath, audit.Path())
	}

	empty := audit.Read(20)
	if empty == nil || len(empty) != 0 {
		t.Fatalf("不存在文件时应返回空非 nil 切片，实际 %#v", empty)
	}

	rec := audit.Append("install", map[string]any{
		"pluginId": "demo-plugin",
		"version":  "1.0.0",
		"at":       "should-be-overwritten",
	})
	if rec["at"] != "2026-11-13T12:34:56.789Z" || rec["event"] != "install" || rec["pluginId"] != "demo-plugin" {
		t.Fatalf("追加返回的审计记录异常: %#v", rec)
	}

	if runtime.GOOS != "windows" {
		dirInfo, err := os.Stat(filepath.Dir(expectedPath))
		if err != nil {
			t.Fatalf("stat 目录失败: %v", err)
		}
		if dirInfo.Mode().Perm() != 0o700 {
			t.Fatalf("期望目录权限 0700，实际 %o", dirInfo.Mode().Perm())
		}
		fileInfo, err := os.Stat(expectedPath)
		if err != nil {
			t.Fatalf("stat 文件失败: %v", err)
		}
		if fileInfo.Mode().Perm() != 0o600 {
			t.Fatalf("期望文件权限 0600，实际 %o", fileInfo.Mode().Perm())
		}
	}

	// 追加一行坏 JSON 与一条合法记录，检验损坏行降级及 limit 裁剪。
	f, err := os.OpenFile(expectedPath, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("打开文件追加坏行失败: %v", err)
	}
	_, _ = f.WriteString("{not valid json\n")
	_ = f.Close()
	audit.Append("enable", map[string]any{"instanceId": "inst-1"})

	records := audit.Read(20)
	if len(records) != 3 {
		t.Fatalf("期望 3 条记录，实际 %d: %#v", len(records), records)
	}
	if records[1]["event"] != "audit_record_invalid" || records[1]["at"] != "" {
		t.Fatalf("损坏 JSON 应返回占位记录，实际 %#v", records[1])
	}
	if records[2]["event"] != "enable" || records[2]["instanceId"] != "inst-1" {
		t.Fatalf("最后一条记录不匹配: %#v", records[2])
	}

	onlyOne := audit.Read(-5)
	if len(onlyOne) != 1 || onlyOne[0]["event"] != "enable" {
		t.Fatalf("负数 limit 应裁剪为 1 并取最后一条，实际 %#v", onlyOne)
	}
}

func TestAuditLogRotationAndLimitClamping(t *testing.T) {
	home := t.TempDir()
	audit := NewAuditLog(home, WithAuditMaxBytes(120))

	for i := 0; i < 5; i++ {
		audit.Append("enable", map[string]any{
			"instanceId": fmt.Sprintf("plugin-instance-%02d-long-padding-payload", i),
		})
	}

	rotatedPath := audit.Path() + ".1"
	if _, err := os.Stat(rotatedPath); err != nil {
		t.Fatalf("超过阈值后应轮转生成 %s: %v", rotatedPath, err)
	}

	// 写入超过 MaxAuditReadLimit 条记录验证裁剪到 1000 以及 0 -> 100。
	big := NewAuditLog(t.TempDir())
	for i := 0; i < 1050; i++ {
		big.Append("tick", map[string]any{"seq": i})
	}
	if got := len(big.Read(0)); got != 100 {
		t.Fatalf("limit=0 应读取默认 100 条，实际 %d", got)
	}
	capped := big.Read(5000)
	if len(capped) != 1000 {
		t.Fatalf("limit=5000 应裁剪到 1000 条，实际 %d", len(capped))
	}
	if capped[0]["seq"] != float64(50) || capped[999]["seq"] != float64(1049) {
		t.Fatalf("尾部切片范围异常: first=%v last=%v", capped[0]["seq"], capped[999]["seq"])
	}
}

func TestAuditLogConcurrentAppendReadRace(t *testing.T) {
	audit := NewAuditLog(t.TempDir(), WithAuditMaxBytes(256))
	var wg sync.WaitGroup
	for g := 0; g < 6; g++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				audit.Append("concurrent", map[string]any{"g": id, "i": i})
				_ = audit.Read(10)
			}
		}(g)
	}
	wg.Wait()
}
