package accountmaintenance

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

func TestAcquireCreatesCoordinationStore(t *testing.T) {
	home := t.TempDir()
	lease, err := Acquire(context.Background(), home)
	if err != nil {
		t.Fatalf("获取读租约失败: %v", err)
	}
	defer lease.Close()
	file := filepath.Join(home, "run", "maintenance", databaseName)
	info, err := os.Stat(file)
	if err != nil {
		t.Fatalf("协调库未创建: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("协调库权限未收紧: %o", info.Mode().Perm())
	}
	for _, directory := range []string{"run", "run/maintenance"} {
		info, err := os.Stat(filepath.Join(home, directory))
		if err != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("目录 %s 权限不符: %v %v", directory, info, err)
		}
	}
}

func TestSharedLeasesCoexist(t *testing.T) {
	home := t.TempDir()
	first, err := Acquire(context.Background(), home)
	if err != nil {
		t.Fatalf("第一个读租约失败: %v", err)
	}
	defer first.Close()
	second, err := Acquire(context.Background(), home)
	if err != nil {
		t.Fatalf("第二个读租约不应被阻塞: %v", err)
	}
	second.Close()
}

func TestExclusiveMaintenanceFailsClosed(t *testing.T) {
	home := t.TempDir()
	// 先初始化协调库并建立表。
	initial, err := Acquire(context.Background(), home)
	if err != nil {
		t.Fatalf("初始化读租约失败: %v", err)
	}
	initial.Close()
	file := filepath.Join(home, "run", "maintenance", databaseName)
	database, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatalf("打开协调库失败: %v", err)
	}
	defer func() { _ = database.Close() }()
	database.SetMaxOpenConns(1)
	connection, err := database.Conn(context.Background())
	if err != nil {
		t.Fatalf("获取连接失败: %v", err)
	}
	defer func() { _ = connection.Close() }()
	if _, err := connection.ExecContext(context.Background(), "PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("设置 busy_timeout 失败: %v", err)
	}
	if _, err := connection.ExecContext(context.Background(), "BEGIN EXCLUSIVE"); err != nil {
		t.Fatalf("获取排他锁失败: %v", err)
	}
	started := time.Now()
	_, err = Acquire(context.Background(), home)
	if err == nil {
		t.Fatal("维护排他锁存在时读租约必须失败")
	}
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != CodeBusy {
		t.Fatalf("错误码 = %v, want %s", err, CodeBusy)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("busy 等待时间过长: %v", elapsed)
	}
}

func TestMaintenanceGateBlocksAcquire(t *testing.T) {
	home := t.TempDir()
	gate := filepath.Join(home, "run", "maintenance", gateName)
	if err := os.MkdirAll(filepath.Dir(gate), 0o700); err != nil {
		t.Fatalf("创建闸门目录失败: %v", err)
	}
	if err := os.WriteFile(gate, []byte("maintenance"), 0o600); err != nil {
		t.Fatalf("创建闸门文件失败: %v", err)
	}
	_, err := Acquire(context.Background(), home)
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != CodeInProgress {
		t.Fatalf("错误码 = %v, want %s", err, CodeInProgress)
	}
}

func TestRejectsSymlinkedMaintenanceDirectory(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "run"), 0o700); err != nil {
		t.Fatalf("创建 run 失败: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(home, "run", "maintenance")); err != nil {
		t.Skipf("当前平台不支持符号链接: %v", err)
	}
	_, err := Acquire(context.Background(), home)
	coded, ok := pluginerr.From(err)
	if !ok || (coded.Code != CodePathEscape && coded.Code != CodeUnavailable) {
		t.Fatalf("符号链接目录必须被拒绝，实际: %v", err)
	}
}
