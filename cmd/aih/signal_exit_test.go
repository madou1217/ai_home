package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

const signalHelperEnv = "AIH_TEST_SIGINT_HELPER"

// TestSIGINTExitCode 用子进程真实发送 SIGINT，锁住 shell 退出码 130。
//
// 旧实现让 NotifyContext 取消 context 后 run 返回 nil，进程会退成 0；
// 这个用例在撤销信号码映射时会失败。
func TestSIGINTExitCode(t *testing.T) {
	if os.Getenv(signalHelperEnv) == "1" {
		runCLI = func(ctx context.Context, _ []string, _ commandRuntime) error {
			// execute 已经装好 signal.Notify，打印 ready 让父进程安全地发信号。
			fmt.Println("ready")
			<-ctx.Done()
			return nil
		}
		os.Exit(execute(nil, defaultCommandRuntime()))
	}
	if runtime.GOOS == "windows" {
		t.Skip("SIGINT process semantics differ on Windows")
	}

	command := exec.Command(os.Args[0], "-test.run=^TestSIGINTExitCode$")
	command.Env = append(os.Environ(), signalHelperEnv+"=1")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}

	ready := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if strings.TrimSpace(scanner.Text()) == "ready" {
				close(ready)
				return
			}
		}
	}()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		t.Fatalf("helper did not become ready; stderr=%s", stderr.String())
	}
	if err := command.Process.Signal(os.Interrupt); err != nil {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		t.Fatalf("signal helper: %v", err)
	}

	waitErr := command.Wait()
	if waitErr == nil {
		t.Fatalf("helper exited 0, want 130; stderr=%s", stderr.String())
	}
	if code := command.ProcessState.ExitCode(); code != 130 {
		t.Fatalf("exit code = %d, want 130; stderr=%s", code, stderr.String())
	}
}
