//go:build windows

package accountbrowserview

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	native "github.com/madou1217/ai_home/native/account-browser"
)

func platformSupported() bool { return true }

func buildHelper(ctx context.Context, _ string) (string, func(), error) {
	dir, err := os.MkdirTemp("", "aih-browser-surface-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	source := filepath.Join(dir, "source")
	publish := filepath.Join(dir, "publish")
	if err := os.Mkdir(source, 0o700); err != nil {
		cleanup()
		return "", nil, err
	}
	for _, name := range []string{"windows/BrowserSurface.csproj", "windows/Program.cs"} {
		raw, readErr := native.Sources.ReadFile(name)
		if readErr != nil {
			cleanup()
			return "", nil, readErr
		}
		target := filepath.Join(source, filepath.Base(name))
		if writeErr := os.WriteFile(target, raw, 0o600); writeErr != nil {
			cleanup()
			return "", nil, writeErr
		}
	}
	rid := "win-x64"
	if runtime.GOARCH == "arm64" {
		rid = "win-arm64"
	}
	buildCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	cmd := runDotnet(buildCtx, source, filepath.Join(source, "BrowserSurface.csproj"), rid, publish)
	if err := cmd.Run(); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("windows_browser_helper_build_unavailable: %w", err)
	}
	binary := filepath.Join(publish, "BrowserSurface.exe")
	if _, err := os.Stat(binary); err != nil {
		cleanup()
		return "", nil, err
	}
	return binary, cleanup, nil
}

func runDotnet(ctx context.Context, dir, project, rid, output string) *exec.Cmd {
	command := exec.CommandContext(ctx, "dotnet", "publish", project, "--configuration", "Release", "--runtime", rid, "--self-contained", "true", "-p:PublishSingleFile=true", "-p:EnableCompressionInSingleFile=true", "--output", output)
	prepareBrowserCommand(command)
	return command
}

func preflight(ctx context.Context, binary string) error {
	raw, err := exec.CommandContext(ctx, binary, "--preflight").Output()
	if err != nil {
		return err
	}
	var status struct {
		Screen bool `json:"screenCapture"`
		Input  bool `json:"eventPosting"`
	}
	if json.Unmarshal(raw, &status) != nil || !status.Screen || !status.Input {
		return errPermission
	}
	return nil
}

func nativeArgs(pid int, started uint64) []string {
	return []string{strconv.Itoa(pid), strconv.FormatUint(started, 10)}
}
