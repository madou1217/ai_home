package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"time"
)

type remoteControlProxy struct {
	BaseURL string
	command *exec.Cmd
	dir     string
}

func resolveRemoteControlBinary() (string, error) {
	if explicit := strings.TrimSpace(os.Getenv("AIH_GO_CORE_BINARY")); explicit != "" {
		return explicit, nil
	}
	name := "aih-server"
	if goruntime.GOOS == "windows" {
		name = "aih-server.exe"
	}
	executable, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(executable)
		if strings.EqualFold(filepath.Base(executable), name) {
			return executable, nil
		}
		candidate := filepath.Join(dir, name)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return candidate, nil
		}
		arch := goruntime.GOARCH
		if arch == "amd64" {
			arch = "x64"
		}
		candidate = filepath.Join(dir, "..", "..", "bin", "native", goruntime.GOOS+"-"+arch, name)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return filepath.Clean(candidate), nil
		}
	}
	return "", errors.New("codex_remote_control_native_binary_missing")
}

func startRemoteControlProxy(ctx context.Context, stateFile string) (*remoteControlProxy, error) {
	binary, err := resolveRemoteControlBinary()
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "aih-codex-remote-control-")
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(dir, 0o700)
	readyFile := filepath.Join(dir, "ready.json")
	suppressFile := filepath.Join(dir, "suppress.json")
	if err := os.WriteFile(suppressFile, []byte("{\"threads\":[]}\n"), 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	args := []string{"__codex-remote-control", "--host", "127.0.0.1", "--port", "0",
		"--ready-file", readyFile, "--suppress-state-file", suppressFile,
		"--parent-pid", strconv.Itoa(os.Getpid())}
	command := exec.CommandContext(ctx, binary, args...)
	if err := command.Start(); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	proxy := &remoteControlProxy{command: command, dir: dir}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		raw, readErr := os.ReadFile(readyFile)
		if readErr == nil {
			var ready map[string]any
			if json.Unmarshal(raw, &ready) == nil && ready["ok"] == true {
				port := 0
				if number, ok := ready["port"].(float64); ok {
					port = int(number)
				}
				if port > 0 && port <= 65535 {
					_ = os.Remove(readyFile)
					proxy.BaseURL = fmt.Sprintf("http://127.0.0.1:%d/backend-api", port)
					return proxy, nil
				}
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	proxy.Close()
	return nil, errors.New("codex_remote_control_native_not_ready")
}

func (proxy *remoteControlProxy) Close() {
	if proxy == nil {
		return
	}
	if proxy.command != nil && proxy.command.Process != nil {
		_ = proxy.command.Process.Kill()
		_, _ = proxy.command.Process.Wait()
	}
	_ = os.RemoveAll(proxy.dir)
}

func desktopRemoteControlEnabled(stateFile string) bool {
	raw, err := os.ReadFile(stateFile)
	if err != nil {
		return true
	}
	var state map[string]any
	if json.Unmarshal(raw, &state) != nil {
		return true
	}
	if disabled, ok := state["remoteControlProxy"].(bool); ok && !disabled {
		return false
	}
	return true
}
