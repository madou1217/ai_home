// Package appguard starts and tracks the platform NetGuard process for one
// app instance.
//
// The guard is a separate privileged process (aih-netguard). This package owns
// only its lifecycle: locate the binary, start it with the instance's root PID
// and resolved proxy URL, and report enough identity for the desk to show and
// stop it. Enforcement itself stays in internal/runtime/netguard.
package appguard

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ErrUnsupported means this platform cannot enforce strict GUI networking yet.
var ErrUnsupported = errors.New("当前平台暂不支持桌面应用的严格网络隔离")

// ErrUnavailable means the guard binary or its kernel component is missing.
var ErrUnavailable = errors.New("NetGuard 组件不可用")

// Spec describes one guard launch.
type Spec struct {
	// Binary overrides the discovered aih-netguard path (AIH_NETGUARD_BIN wins).
	Binary     string
	AIHomeDir  string
	RootPID    int
	ProxyURL   string
	InstanceID string
	LogPath    string
}

// Available reports whether the guard can run on this platform right now.
// It checks the binary and platform component but does not inspect a target
// process.
func Available(spec Spec) error {
	binary, err := FindBinary(spec)
	if err != nil {
		return err
	}
	_, err = backendFor(binary)
	return err
}

// Start launches the guard and returns its process ID and backend label.
//
// The caller must keep the returned PID in the instance ledger and terminate
// it when the instance exits. Start does not wait for the app: the guard
// attaches to the already-running root PID.
func Start(spec Spec) (int, string, error) {
	if spec.RootPID <= 0 {
		return 0, "", errors.New("NetGuard 需要实例根进程 PID")
	}
	if strings.TrimSpace(spec.ProxyURL) == "" {
		return 0, "", errors.New("严格模式需要已解析的代理入口")
	}
	binary, err := FindBinary(spec)
	if err != nil {
		return 0, "", err
	}
	backend, err := backendFor(binary)
	if err != nil {
		return 0, "", err
	}
	args := []string{
		"--root-pid", fmt.Sprintf("%d", spec.RootPID),
		"--proxy-url", strings.TrimSpace(spec.ProxyURL),
	}
	if id := strings.TrimSpace(spec.InstanceID); id != "" {
		args = append(args, "--instance-id", id)
	}
	command := exec.Command(binary, args...)
	command.Env = append(os.Environ(), "AIH_NETGUARD_BACKEND="+backend)
	if logPath := strings.TrimSpace(spec.LogPath); logPath != "" {
		if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
			return 0, "", err
		}
		logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return 0, "", err
		}
		command.Stdout = logFile
		command.Stderr = logFile
		// The file stays open for the child's lifetime; the OS closes it when
		// the child exits, and the parent's copy is released when Start returns.
		defer logFile.Close()
	}
	if err := command.Start(); err != nil {
		return 0, "", fmt.Errorf("启动 NetGuard 失败: %w", err)
	}
	pid := command.Process.Pid
	// Release the child from this process; the ledger owns its lifetime.
	go func() {
		_ = command.Wait()
	}()
	return pid, backend, nil
}

// FindBinary resolves the guard executable.
//
// Resolution order: AIH_NETGUARD_BIN, a sibling of the current executable,
// <aiHome>/bin, then PATH. The WinDivert DLL must sit next to the binary (or
// AIH_WINDIVERT_DLL must point at it) on Windows.
func FindBinary(spec Spec) (string, error) {
	if override := strings.TrimSpace(os.Getenv("AIH_NETGUARD_BIN")); override != "" {
		if _, err := os.Stat(override); err != nil {
			return "", fmt.Errorf("%w: %s", ErrUnavailable, override)
		}
		return override, nil
	}
	if override := strings.TrimSpace(spec.Binary); override != "" {
		if _, err := os.Stat(override); err == nil {
			return override, nil
		}
	}
	name := "aih-netguard"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	var candidates []string
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(executable), name))
	}
	if home := strings.TrimSpace(spec.AIHomeDir); home != "" {
		candidates = append(candidates, filepath.Join(home, "bin", name))
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	if resolved, err := exec.LookPath(name); err == nil {
		return resolved, nil
	}
	return "", fmt.Errorf("%w: 找不到 %s", ErrUnavailable, name)
}

// backendFor validates the platform prerequisites and returns the backend.
func backendFor(binary string) (string, error) {
	switch runtime.GOOS {
	case "windows":
		if override := strings.TrimSpace(os.Getenv("AIH_NETGUARD_BACKEND")); override != "" {
			return override, nil
		}
		dll := strings.TrimSpace(os.Getenv("AIH_WINDIVERT_DLL"))
		if dll == "" {
			dll = filepath.Join(filepath.Dir(binary), "WinDivert.dll")
		}
		if _, err := os.Stat(dll); err != nil {
			return "", fmt.Errorf("%w: 找不到 WinDivert.dll（应与 aih-netguard.exe 同目录）", ErrUnavailable)
		}
		return "windivert", nil
	case "linux", "darwin":
		if os.Getenv("AIH_NETGUARD_ALLOW_UNSUPPORTED") == "1" {
			return "test", nil
		}
		return "", ErrUnsupported
	default:
		return "", ErrUnsupported
	}
}

// Stop terminates a guard process started by Start. It is a no-op for 0.
func Stop(pid int) {
	if pid <= 0 {
		return
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = process.Kill()
	time.Sleep(200 * time.Millisecond)
}
