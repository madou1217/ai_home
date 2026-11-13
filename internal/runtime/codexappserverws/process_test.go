package codexappserverws

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestHelperProcessCodexAppServer(t *testing.T) {
	if os.Getenv("GO_WANT_CODEX_HELPER_PROCESS") != "1" {
		return
	}
	mode := os.Getenv("GO_CODEX_HELPER_MODE")
	if mode == "exit-fast" {
		_, _ = fmt.Fprintln(os.Stderr, "simulated immediate crash")
		os.Exit(1)
	}
	if mode == "ignore-term" {
		select {}
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		_, _ = fmt.Fprintf(os.Stdout, "%s\n", line)
	}
	os.Exit(0)
}

func TestResolveCodexBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX 可执行权限与符号路径测试仅在类 Unix 环境执行")
	}

	t.Run("优先使用AIH_CODEX_BINARY并支持用户目录兜底与绕过旧hook", func(t *testing.T) {
		root := t.TempDir()
		hookPath := filepath.Join(root, ".local", "bin", "codex")
		if err := os.MkdirAll(filepath.Dir(hookPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(hookPath, []byte("#!/bin/sh\n# aih-codex-cli-hook\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		origPath := hookPath + ".aih-original"
		if err := os.WriteFile(origPath, []byte("#!/bin/sh\necho ok\n"), 0o755); err != nil {
			t.Fatal(err)
		}

		t.Setenv("PATH", filepath.Join(root, "empty-path"))
		t.Setenv("HOME", root)

		resolved, err := ResolveCodexBinary(root)
		if err != nil {
			t.Fatalf("应通过用户目录与 .aih-original 解析成功: %v", err)
		}
		if resolved != origPath {
			t.Fatalf("resolved = %q, 期望 %q", resolved, origPath)
		}

		overrideBin := filepath.Join(root, "custom-codex")
		if err := os.WriteFile(overrideBin, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("AIH_CODEX_BINARY", overrideBin)
		overridden, err := ResolveCodexBinary(root)
		if err != nil || overridden != overrideBin {
			t.Fatalf("AIH_CODEX_BINARY 覆盖异常: path=%q err=%v", overridden, err)
		}
	})
}

func TestAppServerProcessLifecycleAndStartupProbe(t *testing.T) {
	t.Parallel()

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	t.Run("正常启动读写与优雅退出", func(t *testing.T) {
		t.Parallel()
		proc, err := StartAppServerProcess(StartProcessOptions{
			Command: exe,
			Args:    []string{"-test.run=^TestHelperProcessCodexAppServer$", "--"},
			Env: append(os.Environ(),
				"GO_WANT_CODEX_HELPER_PROCESS=1",
				"GO_CODEX_HELPER_MODE=echo",
			),
		})
		if err != nil {
			t.Fatal(err)
		}
		defer proc.Close()

		if err := proc.WaitForStartup(context.Background(), 30*time.Millisecond); err != nil {
			t.Fatalf("正常常驻子进程不应触发启动失败: %v", err)
		}
		if _, err := proc.Stdin().Write([]byte("{\"ping\":1}\n")); err != nil {
			t.Fatal(err)
		}
		line, err := bufio.NewReader(proc.Stdout()).ReadString('\n')
		if err != nil || strings.TrimSpace(line) != `{"ping":1}` {
			t.Fatalf("stdout 回显异常: line=%q err=%v", line, err)
		}
		proc.Close()
		select {
		case <-proc.Done():
		case <-time.After(2 * time.Second):
			t.Fatal("子进程关闭超时")
		}
	})

	t.Run("子进程秒退在StartupProbe阶段即返回错误", func(t *testing.T) {
		t.Parallel()
		proc, err := StartAppServerProcess(StartProcessOptions{
			Command: exe,
			Args:    []string{"-test.run=^TestHelperProcessCodexAppServer$", "--"},
			Env: append(os.Environ(),
				"GO_WANT_CODEX_HELPER_PROCESS=1",
				"GO_CODEX_HELPER_MODE=exit-fast",
			),
		})
		if err != nil {
			t.Fatal(err)
		}
		defer proc.Close()

		err = proc.WaitForStartup(context.Background(), 200*time.Millisecond)
		if err == nil {
			t.Fatal("秒退子进程应在 StartupProbe 返回错误")
		}
	})

	t.Run("忽略stdin关闭的子进程在Close后500ms内被强杀回收", func(t *testing.T) {
		t.Parallel()
		proc, err := StartAppServerProcess(StartProcessOptions{
			Command: exe,
			Args:    []string{"-test.run=^TestHelperProcessCodexAppServer$", "--"},
			Env: append(os.Environ(),
				"GO_WANT_CODEX_HELPER_PROCESS=1",
				"GO_CODEX_HELPER_MODE=ignore-term",
			),
		})
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		proc.Close()
		select {
		case <-proc.Done():
		case <-time.After(2 * time.Second):
			t.Fatal("忽略 EOF 的子进程应在 SIGTERM/SIGKILL 窗口后退出")
		}
		if elapsed := time.Since(start); elapsed > 2*time.Second {
			t.Fatalf("强制回收耗时异常: %v", elapsed)
		}
	})
}
