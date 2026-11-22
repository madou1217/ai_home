//go:build darwin

package accountbrowserview

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	native "github.com/madou1217/ai_home/native/account-browser"
)

func platformSupported() bool { return true }

func buildHelper(ctx context.Context) (string, func(), error) {
	dir, err := os.MkdirTemp("", "aih-browser-surface-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	args := []string{"swiftc", "-O", "-target", runtime.GOARCH + "-apple-macosx14.0"}
	if runtime.GOARCH == "amd64" {
		args[3] = "x86_64-apple-macosx14.0"
	}
	for _, name := range []string{"identity.swift", "mouse-events.swift", "input.swift", "capture.swift", "output.swift", "main.swift"} {
		raw, e := native.Sources.ReadFile(name)
		if e != nil {
			cleanup()
			return "", nil, e
		}
		path := filepath.Join(dir, name)
		if e = os.WriteFile(path, raw, 0o600); e != nil {
			cleanup()
			return "", nil, e
		}
		args = append(args, path)
	}
	binary := filepath.Join(dir, "aih-browser-surface")
	args = append(args, "-framework", "AppKit", "-framework", "ScreenCaptureKit", "-framework", "CoreImage", "-framework", "CoreGraphics", "-framework", "CoreMedia", "-o", binary)
	buildCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := exec.CommandContext(buildCtx, "/usr/bin/xcrun", args...).Run(); err != nil {
		cleanup()
		return "", nil, err
	}
	return binary, cleanup, nil
}

func preflight(ctx context.Context, binary string) error {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	readStatus := func() (bool, error) {
		raw, err := exec.CommandContext(ctx, binary, "--preflight").Output()
		if err != nil {
			return false, err
		}
		var status struct {
			Screen bool `json:"screenCapture"`
			Input  bool `json:"eventPosting"`
		}
		if json.Unmarshal(raw, &status) != nil {
			return false, errPermission
		}
		return status.Screen && status.Input, nil
	}
	ready, err := readStatus()
	if err != nil {
		return err
	}
	if ready {
		return nil
	}
	// Permission requests are made only after the user has explicitly pressed
	// Start in the WebUI. The native OS owns the dialog; no UI automation occurs.
	if err := exec.CommandContext(ctx, binary, "--request-permissions").Run(); err != nil {
		return errPermission
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		ready, statusErr := readStatus()
		if statusErr == nil && ready {
			return nil
		}
		select {
		case <-ctx.Done():
			return errPermission
		case <-ticker.C:
		}
	}
}

func nativeArgs(pid int, _ uint64) []string { return []string{strconv.Itoa(pid)} }
