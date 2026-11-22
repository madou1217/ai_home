//go:build !windows

package workspaceconnector

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

func newCommandTestFilesystem(t *testing.T) *filesystem {
	t.Helper()
	files, err := newFilesystem(t.TempDir())
	if err != nil {
		t.Fatalf("newFilesystem: %v", err)
	}
	return files
}

func decodeCommandStream(t *testing.T, encoded string) string {
	t.Helper()
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode stream: %v", err)
	}
	return string(decoded)
}

func TestRunCommandCapturesOutputAndExitCode(t *testing.T) {
	files := newCommandTestFilesystem(t)
	result, err := files.runCommand(context.Background(), remoteconnector.RunCommandRequest{
		Command: "pwd; echo out; echo err >&2; exit 7",
	})
	if err != nil {
		t.Fatalf("runCommand: %v", err)
	}
	if result.ExitCode != 7 {
		t.Fatalf("exit code = %d, want 7", result.ExitCode)
	}
	if result.Encoding != "base64" {
		t.Fatalf("encoding = %q, want base64", result.Encoding)
	}
	stdout := decodeCommandStream(t, result.Stdout)
	if !strings.Contains(stdout, "out") || !strings.Contains(stdout, files.sandbox.root) {
		t.Fatalf("stdout = %q, want command output with workspace root", stdout)
	}
	if stderr := decodeCommandStream(t, result.Stderr); !strings.Contains(stderr, "err") {
		t.Fatalf("stderr = %q, want stderr text", stderr)
	}
	if result.TimedOut || result.Truncated {
		t.Fatalf("unexpected flags: timedOut=%v truncated=%v", result.TimedOut, result.Truncated)
	}
}

func TestRunCommandConfinesWorkingDirectory(t *testing.T) {
	files := newCommandTestFilesystem(t)
	if err := os.Mkdir(filepath.Join(files.sandbox.root, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}
	if err := os.WriteFile(filepath.Join(files.sandbox.root, "seed.txt"), []byte("seed"), 0o644); err != nil {
		t.Fatalf("write seed: %v", err)
	}

	result, err := files.runCommand(context.Background(), remoteconnector.RunCommandRequest{Command: "pwd", Cwd: "sub"})
	if err != nil {
		t.Fatalf("subdir runCommand: %v", err)
	}
	if result.Cwd != "sub" {
		t.Fatalf("result cwd = %q, want sub", result.Cwd)
	}
	if stdout := decodeCommandStream(t, result.Stdout); !strings.Contains(stdout, filepath.Join(files.sandbox.root, "sub")) {
		t.Fatalf("stdout = %q, want the sub directory", stdout)
	}

	if _, err := files.runCommand(context.Background(), remoteconnector.RunCommandRequest{Command: "pwd", Cwd: "../.."}); remoteconnector.ErrorCode(err) != remoteconnector.CodePathOutsideWorkspace {
		t.Fatalf("escape error = %v, want %s", err, remoteconnector.CodePathOutsideWorkspace)
	}
	if _, err := files.runCommand(context.Background(), remoteconnector.RunCommandRequest{Command: "pwd", Cwd: "seed.txt"}); remoteconnector.ErrorCode(err) != remoteconnector.CodeNotADirectory {
		t.Fatalf("file cwd error = %v, want %s", err, remoteconnector.CodeNotADirectory)
	}
}

func TestRunCommandRejectsInvalidCommand(t *testing.T) {
	files := newCommandTestFilesystem(t)
	if _, err := files.runCommand(context.Background(), remoteconnector.RunCommandRequest{Command: "   "}); remoteconnector.ErrorCode(err) != remoteconnector.CodeInvalidPayload {
		t.Fatalf("empty command error = %v, want %s", err, remoteconnector.CodeInvalidPayload)
	}
	oversized := strings.Repeat("a", maxCommandBytes+1)
	if _, err := files.runCommand(context.Background(), remoteconnector.RunCommandRequest{Command: oversized}); remoteconnector.ErrorCode(err) != remoteconnector.CodeInvalidPayload {
		t.Fatalf("oversized command error = %v, want %s", err, remoteconnector.CodeInvalidPayload)
	}
}

func TestRunCommandTimeoutKillsProcessGroup(t *testing.T) {
	files := newCommandTestFilesystem(t)
	started := time.Now()
	result, err := files.runCommand(context.Background(), remoteconnector.RunCommandRequest{
		Command: "sleep 30 & echo $!; wait", TimeoutMS: 300,
	})
	if err != nil {
		t.Fatalf("runCommand: %v", err)
	}
	if !result.TimedOut || result.ExitCode != -1 {
		t.Fatalf("timedOut=%v exitCode=%d, want true/-1", result.TimedOut, result.ExitCode)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("timeout took %s, want a bounded kill", elapsed)
	}
	pid, parseErr := strconv.Atoi(strings.TrimSpace(decodeCommandStream(t, result.Stdout)))
	if parseErr != nil {
		t.Fatalf("parse child pid %q: %v", decodeCommandStream(t, result.Stdout), parseErr)
	}
	deadline := time.Now().Add(2 * time.Second)
	for processAlive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("child process %d survived the timeout kill", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestRunCommandTruncatesOutputButDrains(t *testing.T) {
	files := newCommandTestFilesystem(t)
	result, err := files.runCommand(context.Background(), remoteconnector.RunCommandRequest{
		Command: "yes a | head -c 300000",
	})
	if err != nil {
		t.Fatalf("runCommand: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", result.ExitCode)
	}
	if !result.Truncated {
		t.Fatal("truncated = false, want true for 300000 bytes of output")
	}
	if size := len(decodeCommandStream(t, result.Stdout)); size != maxCommandOutput {
		t.Fatalf("stdout size = %d, want the %d byte cap", size, maxCommandOutput)
	}
}

func TestRunCommandKeepsBinaryOutput(t *testing.T) {
	files := newCommandTestFilesystem(t)
	result, err := files.runCommand(context.Background(), remoteconnector.RunCommandRequest{
		Command: "printf '\\377'",
	})
	if err != nil {
		t.Fatalf("runCommand: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(result.Stdout)
	if err != nil {
		t.Fatalf("decode stdout: %v", err)
	}
	if len(raw) != 1 || raw[0] != 0xFF {
		t.Fatalf("stdout bytes = %v, want a single 0xff byte", raw)
	}
}

func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
