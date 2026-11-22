//go:build windows

package accountbrowserview

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Windows has no macOS-style screen-capture permission gate for this surface.
// We still report only the prerequisites that can be checked without starting
// Edge or the native helper; the actual browser/window check remains a start
// boundary in helper_windows.go and accountbrowserhost.
func capabilityPlatformAvailable(ctx context.Context) (bool, string) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if !stableEdgeInstalled() {
		return false, "browser_stable_edge_unavailable"
	}
	if _, err := exec.LookPath("dotnet"); err != nil {
		return false, "browser_native_build_unavailable"
	}
	// Signature and helper build are start-time checks.
	if err := ctx.Err(); err != nil {
		return false, "browser_host_probe_cancelled"
	}
	return true, ""
}

func stableEdgeInstalled() bool {
	candidates := make([]string, 0, 4)
	for _, root := range []string{
		os.Getenv("PROGRAMFILES(X86)"),
		os.Getenv("PROGRAMFILES"),
		os.Getenv("LOCALAPPDATA"),
	} {
		if strings.TrimSpace(root) == "" {
			continue
		}
		candidates = append(candidates, filepath.Join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
	}
	if path, err := exec.LookPath("msedge.exe"); err == nil {
		candidates = append([]string{path}, candidates...)
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() {
			return true
		}
	}
	return false
}
