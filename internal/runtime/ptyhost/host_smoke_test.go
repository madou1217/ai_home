//go:build !windows

package ptyhost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"

	ptyruntime "github.com/madou1217/ai_home/internal/runtime/pty"
)

// TestHostSmoke 是临时真机冒烟：外层 PTY 模拟用户终端，/bin/sh 模拟 TUI。
func TestHostSmoke(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer slave.Close()
	if err := pty.Setsize(master, &pty.Winsize{Rows: 24, Cols: 80}); err != nil {
		t.Fatal(err)
	}
	script := "trap 'stty size' WINCH; printf 'READY\\r\\n'; read line; printf 'GOT:%s\\r\\n' \"$line\"; read wait; exit 7"
	type result struct {
		code int
		err  error
	}
	done := make(chan result, 1)
	go func() {
		code, runErr := Run(context.Background(), Config{
			Path:    "/bin/sh",
			Args:    []string{"-c", script},
			Stdin:   slave,
			Stdout:  slave,
			Starter: ptyruntime.NewStarter(),
		})
		done <- result{code: code, err: runErr}
	}()

	var mu sync.Mutex
	var output strings.Builder
	go func() {
		payload := make([]byte, 4096)
		for {
			count, readErr := master.Read(payload)
			if count > 0 {
				mu.Lock()
				output.Write(payload[:count])
				mu.Unlock()
			}
			if readErr != nil {
				return
			}
		}
	}()
	snapshot := func() string {
		mu.Lock()
		defer mu.Unlock()
		return output.String()
	}
	var resultValue *result
	waitFor := func(needle string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if strings.Contains(snapshot(), needle) {
				return
			}
			select {
			case got := <-done:
				resultValue = &got
				if strings.Contains(snapshot(), needle) {
					return
				}
				t.Fatalf("host returned before %q: code=%d err=%v output=%q", needle, got.code, got.err, snapshot())
			case <-time.After(25 * time.Millisecond):
			}
		}
		t.Fatalf("timeout waiting %q, output=%q", needle, snapshot())
	}

	waitFor("READY")
	if _, err := master.WriteString("hello\n"); err != nil {
		t.Fatal(err)
	}
	waitFor("GOT:hello")

	if err := pty.Setsize(master, &pty.Winsize{Rows: 40, Cols: 120}); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(os.Getpid(), syscall.SIGWINCH); err != nil {
		t.Fatal(err)
	}
	waitFor("40 120")
	if _, err := master.WriteString("bye\n"); err != nil {
		t.Fatal(err)
	}

	if resultValue == nil {
		select {
		case got := <-done:
			resultValue = &got
		case <-time.After(5 * time.Second):
			t.Fatal("host did not return")
		}
	}
	if resultValue.code != 7 {
		t.Fatalf("code=%d err=%v, want 7; output=%q", resultValue.code, resultValue.err, snapshot())
	}
	var exitErr *ExitError
	if !errors.As(resultValue.err, &exitErr) || exitErr.Code != 7 {
		t.Fatalf("err=%v, want ExitError{7}", resultValue.err)
	}
}

// TestHostCancel 验证 context 取消会杀掉子进程并返回 130，而不是留下 sleep。
func TestHostCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		code, runErr := Run(ctx, Config{
			Path:    "/bin/sh",
			Args:    []string{"-c", "sleep 10"},
			Stdin:   strings.NewReader(""),
			Stdout:  io.Discard,
			Starter: ptyruntime.NewStarter(),
		})
		if code != 130 {
			done <- fmt.Errorf("code=%d, want 130", code)
			return
		}
		done <- runErr
	}()
	time.Sleep(150 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		var exitErr *ExitError
		if !errors.As(err, &exitErr) || exitErr.Code != 130 {
			t.Fatalf("err=%v, want ExitError{130}", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("host did not stop after cancel")
	}
}
