//go:build darwin

package accountbrowserview

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	native "github.com/madou1217/ai_home/native/account-browser"
)

func platformSupported() bool { return true }

// helperSigningIdentifier is the code identity macOS records for the surface
// helper. Screen Recording and Accessibility grants are keyed to the signature,
// so the identifier and the signed bytes must stay stable between sessions.
const helperSigningIdentifier = "com.meadeo.aih.browser-surface"

// helperCacheFormat invalidates every cached build when the launch contract
// changes in a way the source hash alone would not capture.
const helperCacheFormat = "aih-browser-surface/v1"

// helperSources is also the compile order: Swift requires top-level code last.
var helperSources = []string{"identity.swift", "mouse-events.swift", "input.swift", "capture.swift", "output.swift", "main.swift"}

func helperTarget() string {
	if runtime.GOARCH == "amd64" {
		return "x86_64-apple-macosx14.0"
	}
	return runtime.GOARCH + "-apple-macosx14.0"
}

// buildHelper compiles the surface helper once per source revision and reuses
// the same signed bytes afterwards. Rebuilding on every start produced a new
// temporary path and a new ad-hoc cdhash, so macOS treated each start as a new
// app and asked for Screen Recording again.
func buildHelper(ctx context.Context, home string) (string, func(), error) {
	root := filepath.Join(home, "run", "cache", "account-browser", "helper")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return buildTransientHelper(ctx)
	}
	key, err := helperCacheKey()
	if err != nil {
		return "", nil, err
	}
	target := filepath.Join(root, key)
	binary := filepath.Join(target, "aih-browser-surface")
	if helperCacheValid(target, key) {
		pruneHelperCache(root, key)
		return binary, func() {}, nil
	}
	staging, err := os.MkdirTemp(root, ".build-")
	if err != nil {
		return buildTransientHelper(ctx)
	}
	defer os.RemoveAll(staging)
	built, err := compileHelper(ctx, staging)
	if err != nil {
		return "", nil, err
	}
	digest, err := fileSHA256(built)
	if err != nil {
		return "", nil, err
	}
	manifest, err := json.Marshal(struct {
		Key    string `json:"key"`
		SHA256 string `json:"sha256"`
	}{Key: key, SHA256: digest})
	if err != nil {
		return "", nil, err
	}
	if err = os.WriteFile(filepath.Join(staging, "helper.json"), manifest, 0o600); err != nil {
		return "", nil, err
	}
	// Publish by rename so a half-written directory is never treated as valid.
	if err = os.Rename(staging, target); err != nil {
		if helperCacheValid(target, key) {
			pruneHelperCache(root, key)
			return binary, func() {}, nil
		}
		// A stale entry must not block a fresh build; the cache is disposable.
		if removeErr := os.RemoveAll(target); removeErr != nil {
			return "", nil, err
		}
		if err = os.Rename(staging, target); err != nil {
			return "", nil, err
		}
	}
	pruneHelperCache(root, key)
	return binary, func() {}, nil
}

func buildTransientHelper(ctx context.Context) (string, func(), error) {
	dir, err := os.MkdirTemp("", "aih-browser-surface-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	binary, err := compileHelper(ctx, dir)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	return binary, cleanup, nil
}

func compileHelper(ctx context.Context, dir string) (string, error) {
	sources := make([]string, 0, len(helperSources))
	for _, name := range helperSources {
		raw, err := native.Sources.ReadFile(name)
		if err != nil {
			return "", err
		}
		path := filepath.Join(dir, name)
		if err = os.WriteFile(path, raw, 0o600); err != nil {
			return "", err
		}
		sources = append(sources, path)
	}
	binary := filepath.Join(dir, "aih-browser-surface")
	args := []string{"swiftc", "-O", "-target", helperTarget()}
	args = append(args, sources...)
	args = append(args, "-framework", "AppKit", "-framework", "ScreenCaptureKit", "-framework", "CoreImage", "-framework", "CoreGraphics", "-framework", "CoreMedia", "-o", binary)
	buildCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := exec.CommandContext(buildCtx, "/usr/bin/xcrun", args...).Run(); err != nil {
		return "", err
	}
	// Sign the bytes that will be cached and executed; re-signing a cache hit
	// would change the hash and invalidate the TCC grant.
	if output, err := exec.CommandContext(buildCtx, "/usr/bin/codesign", "--force", "--sign", "-", "--identifier", helperSigningIdentifier, binary).CombinedOutput(); err != nil {
		return "", fmt.Errorf("browser helper signing unavailable: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return binary, nil
}

func helperCacheKey() (string, error) {
	hasher := sha256.New()
	fmt.Fprintf(hasher, "%s\n%s\n", helperCacheFormat, helperTarget())
	for _, name := range helperSources {
		raw, err := native.Sources.ReadFile(name)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(hasher, "%s %d\n", name, len(raw))
		hasher.Write(raw)
	}
	return hex.EncodeToString(hasher.Sum(nil))[:24], nil
}

func helperCacheValid(dir, key string) bool {
	raw, err := os.ReadFile(filepath.Join(dir, "helper.json"))
	if err != nil {
		return false
	}
	var manifest struct {
		Key    string `json:"key"`
		SHA256 string `json:"sha256"`
	}
	if json.Unmarshal(raw, &manifest) != nil || manifest.Key != key || len(manifest.SHA256) != 64 {
		return false
	}
	binary := filepath.Join(dir, "aih-browser-surface")
	info, err := os.Stat(binary)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o100 == 0 {
		return false
	}
	digest, err := fileSHA256(binary)
	return err == nil && digest == manifest.SHA256
}

// pruneHelperCache drops builds for other source revisions. Unlinking a binary
// that is still executing is safe on macOS; the running process keeps its inode.
func pruneHelperCache(root, keep string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || name == keep {
			continue
		}
		if strings.HasPrefix(name, ".build-") || isHelperCacheKey(name) {
			_ = os.RemoveAll(filepath.Join(root, name))
		}
	}
}

func isHelperCacheKey(name string) bool {
	if len(name) != 24 {
		return false
	}
	for _, char := range name {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err = io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
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
