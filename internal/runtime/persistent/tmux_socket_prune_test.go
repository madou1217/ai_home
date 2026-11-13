package persistent

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPruneStaleTmuxSockets(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "aihtsp-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	// 1. 活着的 unix socket（即使年龄超过 minAge 也必须保留）。
	liveSock := filepath.Join(dir, "live")
	ln, err := net.Listen("unix", liveSock)
	if err != nil {
		t.Fatalf("net.Listen() err = %v", err)
	}
	defer ln.Close()

	// 2. 已关闭但仍留在文件系统上的死 unix socket，且年龄超过 minAge（应被删除）。
	deadOldSock := filepath.Join(dir, "dead-old")
	deadLn, err := net.Listen("unix", deadOldSock)
	if err != nil {
		t.Fatalf("net.Listen(deadOld) err = %v", err)
	}
	_ = deadLn.Close()
	if err := os.WriteFile(filepath.Join(dir, "not-a-socket.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(deadOldSock); err != nil {
		// Go net.UnixListener.Close() 会自动 unlink 文件；若被 unlink，用真实 unixgram 或绑定后不 close 再由测试场景模拟：
		// macOS 上 Go Listener.SetUnlinkOnClose(false) 可保留死 socket 文件！
		t.Logf("deadOldSock removed on Close, recreating with SetUnlinkOnClose(false)")
	}
	if unixLn, ok := ln.(*net.UnixListener); ok {
		unixLn.SetUnlinkOnClose(false)
	}

	deadOldLn, err := net.Listen("unix", deadOldSock)
	if err != nil {
		t.Fatalf("re-listen deadOldSock: %v", err)
	}
	if ul, ok := deadOldLn.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false)
	}
	_ = deadOldLn.Close()

	// 3. 刚创建（未超过 minAge）的死 socket，应保留避免误杀刚启动的 server。
	deadFreshSock := filepath.Join(dir, "dead-fresh")
	freshLn, err := net.Listen("unix", deadFreshSock)
	if err != nil {
		t.Fatalf("listen deadFreshSock: %v", err)
	}
	if ul, ok := freshLn.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false)
	}
	_ = freshLn.Close()

	now := time.Now()
	oldTime := now.Add(-5 * time.Minute)
	if err := os.Chtimes(liveSock, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(deadOldSock, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	minAge := 60 * time.Second
	summary, err := PruneStaleTmuxSockets(context.Background(), SocketPruneOptions{
		Platform:  "darwin",
		SocketDir: dir,
		Now:       func() time.Time { return now },
		MinAge:    &minAge,
		Timeout:   50 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("PruneStaleTmuxSockets() err = %v", err)
	}
	if summary.Scanned != 3 || summary.Removed != 1 || summary.Kept != 2 || summary.Skipped != 0 {
		t.Fatalf("summary = %+v, want Scanned=3 Removed=1 Kept=2 Skipped=0", summary)
	}
	if _, err := os.Stat(deadOldSock); !os.IsNotExist(err) {
		t.Fatalf("deadOldSock should be removed, err = %v", err)
	}
	if _, err := os.Stat(liveSock); err != nil {
		t.Fatalf("liveSock should remain, err = %v", err)
	}
	if _, err := os.Stat(deadFreshSock); err != nil {
		t.Fatalf("deadFreshSock should remain, err = %v", err)
	}

	winSummary, err := PruneStaleTmuxSockets(context.Background(), SocketPruneOptions{
		Platform: "windows",
	})
	if err != nil || winSummary.Skipped != 1 {
		t.Fatalf("windows summary = %+v, err = %v", winSummary, err)
	}
}
