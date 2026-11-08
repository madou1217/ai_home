package accountremoval

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// 假 tmux 脚本用真实子进程验证 hostTmuxProbe 的 argv 与三态解析。
const (
	aliveTmuxScript = `#!/bin/sh
printf '%s\n' "$*" >> "$AIH_TEST_TMUX_LOG"
printf 's-main\ns-other\n'
`
	absentTmuxScript = `#!/bin/sh
echo 'no server running on /tmp/tmux-501/default' >&2
exit 1
`
	brokenTmuxScript = `#!/bin/sh
echo 'tmux exploded' >&2
exit 2
`
)

func installFakeTmux(t *testing.T, script string) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("假 tmux 脚本只在 POSIX 上运行")
	}
	directory := t.TempDir()
	binary := filepath.Join(directory, "tmux")
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatalf("写入假 tmux: %v", err)
	}
	logPath := filepath.Join(directory, "calls.log")
	t.Setenv("PATH", directory)
	t.Setenv("AIH_TEST_TMUX_LOG", logPath)
	return directory, logPath
}

func TestHostTmuxProbeAlive(t *testing.T) {
	_, logPath := installFakeTmux(t, aliveTmuxScript)
	snapshot, err := (hostTmuxProbe{}).Probe(context.Background(), "aih-claude-acct_test")
	if err != nil {
		t.Fatalf("探测失败: %v", err)
	}
	if !snapshot.ServerAlive {
		t.Fatal("服务端应存活")
	}
	if strings.Join(snapshot.Sessions, ",") != "s-main,s-other" {
		t.Fatalf("会话名 = %v", snapshot.Sessions)
	}
	// 确认 argv 形状：-u -L <socket> list-sessions -F <format>。
	logContent, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("读取调用日志: %v", err)
	}
	wantArgs := "-u -L aih-claude-acct_test list-sessions -F #{session_name}"
	if strings.TrimSpace(string(logContent)) != wantArgs {
		t.Fatalf("argv = %q, want %q", strings.TrimSpace(string(logContent)), wantArgs)
	}
}

func TestHostTmuxProbeAbsent(t *testing.T) {
	installFakeTmux(t, absentTmuxScript)
	snapshot, err := (hostTmuxProbe{}).Probe(context.Background(), "aih-claude-acct_test")
	if err != nil {
		t.Fatalf("no server running 应判定为服务端不存在: %v", err)
	}
	if snapshot.ServerAlive || len(snapshot.Sessions) != 0 {
		t.Fatalf("快照 = %+v, want 不存在", snapshot)
	}
}

func TestHostTmuxProbeUncertain(t *testing.T) {
	installFakeTmux(t, brokenTmuxScript)
	if _, err := (hostTmuxProbe{}).Probe(context.Background(), "aih-claude-acct_test"); err == nil {
		t.Fatal("非 no server running 的失败必须返回 error")
	}
}

func TestParseSessionNames(t *testing.T) {
	names := parseSessionNames("s-main\r\n\n  s-second  \n")
	if strings.Join(names, ",") != "s-main,s-second" {
		t.Fatalf("会话名 = %v", names)
	}
}

// 真实探测失败必须让删除失败关闭，而不是当成「没有会话」。
func TestAssertNoSessionWritersWithFailingProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("假 tmux 脚本只在 POSIX 上运行")
	}
	aiHome := realDir(t)
	registry := filepath.Join(aiHome, "run", "persistent-sessions")
	if err := os.MkdirAll(registry, 0o700); err != nil {
		t.Fatalf("创建登记目录: %v", err)
	}
	entry := `{"provider":"claude","runtimeScope":"acct_0123456789abcdef0123","accountRef":"acct_0123456789abcdef0123","socket":"aih-claude-acct_0123456789abcdef0123","session":"s-main"}`
	if err := os.WriteFile(filepath.Join(registry, "aih-claude--s-main.json"), []byte(entry), 0o600); err != nil {
		t.Fatalf("写入登记: %v", err)
	}
	installFakeTmux(t, brokenTmuxScript)
	service, err := New(Options{AIHomeDir: aiHome})
	if err != nil {
		t.Fatalf("创建服务: %v", err)
	}
	err = service.AssertNoSessionWriters(
		context.Background(), "claude", "acct_0123456789abcdef0123",
	)
	if !errors.Is(err, accountapp.ErrAccountRuntimeUnverifiable) {
		t.Fatalf("真实探测失败必须失败关闭, err = %v", err)
	}
}

func realDir(t *testing.T) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("解析临时目录: %v", err)
	}
	return resolved
}
