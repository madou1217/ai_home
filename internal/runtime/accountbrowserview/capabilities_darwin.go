//go:build darwin

package accountbrowserview

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Only query OS/toolchain metadata. In particular, do not build or invoke the
// native helper: even its preflight would inspect permissions outside start.
func capabilityPlatformAvailable(ctx context.Context) (bool, string) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	version, err := capabilityProbeOutput(ctx, "/usr/bin/sw_vers", "-productVersion")
	if err != nil {
		return false, "browser_host_os_version_unavailable"
	}
	major, err := strconv.Atoi(strings.SplitN(strings.TrimSpace(string(version)), ".", 2)[0])
	if err != nil {
		return false, "browser_host_os_version_unavailable"
	}
	if major < 14 {
		return false, "browser_host_requires_macos14"
	}

	compiler, err := capabilityProbeOutput(ctx, "/usr/bin/xcrun", "--find", "swiftc")
	if err != nil {
		return false, "browser_native_build_unavailable"
	}
	path := strings.TrimSpace(string(compiler))
	if !filepath.IsAbs(path) {
		return false, "browser_native_build_unavailable"
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return false, "browser_native_build_unavailable"
	}
	return true, ""
}

func capabilityProbeOutput(ctx context.Context, binary string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, binary, args...)
	// Bound inherited output pipes as well as the subprocess itself.
	command.WaitDelay = 100 * time.Millisecond
	return command.Output()
}
