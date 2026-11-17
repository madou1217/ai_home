package claudedesktopcredential

import (
	"bytes"
	"debug/buildinfo"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const goCLIProgramPath = "github.com/madou1217/ai_home/cmd/aih"

// CommandOptions follows the existing bin/native/<platform>-<arch>/aih-go layout.
// ExplicitPath is authoritative: an invalid override never selects another helper.
type CommandOptions struct {
	ExplicitPath string
	PackagedPath string
	Platform     string
	Arch         string
	Env          map[string]string
}

// ResolveExecutable inspects native Go build metadata and the command marker
// without executing any candidate. In particular, aih-server and Node wrappers
// cannot be mistaken for the CLI or be started as a capability probe.
func ResolveExecutable(options CommandOptions) (string, error) {
	platform := strings.ToLower(strings.TrimSpace(options.Platform))
	switch platform {
	case "mac", "macos":
		platform = "darwin"
	case "win", "win32":
		platform = "windows"
	case "":
		platform = runtime.GOOS
	}
	arch := strings.ToLower(strings.TrimSpace(options.Arch))
	switch arch {
	case "x64", "x86_64":
		arch = "amd64"
	case "aarch64":
		arch = "arm64"
	case "":
		arch = runtime.GOARCH
	}
	if platform != runtime.GOOS || arch != runtime.GOARCH {
		return "", errors.New("desktop_credential_platform_unsupported")
	}
	if explicit := strings.TrimSpace(options.ExplicitPath); explicit != "" {
		if path := nativeCLI(explicit, platform, arch); path != "" {
			return path, nil
		}
		return "", errors.New("desktop_credential_helper_invalid")
	}
	name := "aih-go"
	if platform == "windows" {
		name += ".exe"
	}
	var candidates []string
	if current, err := os.Executable(); err == nil {
		candidates = append(candidates, current, filepath.Join(filepath.Dir(current), name))
	}
	candidates = append(candidates, options.PackagedPath)
	var searchPath string
	for key, value := range options.Env {
		if key == "PATH" || (platform == "windows" && strings.EqualFold(key, "PATH")) {
			searchPath = value
			break
		}
	}
	for _, directory := range filepath.SplitList(searchPath) {
		candidates = append(candidates, filepath.Join(directory, name))
	}
	seen := make(map[string]bool)
	for _, candidate := range candidates {
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		if path := nativeCLI(candidate, platform, arch); path != "" {
			return path, nil
		}
	}
	return "", errors.New("desktop_credential_helper_missing")
}

func nativeCLI(candidate, platform, arch string) string {
	if !filepath.IsAbs(candidate) {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return ""
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() || (platform != "windows" && info.Mode().Perm()&0111 == 0) {
		return ""
	}
	build, err := buildinfo.ReadFile(resolved)
	if err != nil || build.Path != goCLIProgramPath {
		return ""
	}
	var goos, goarch string
	for _, setting := range build.Settings {
		switch setting.Key {
		case "GOOS":
			goos = setting.Value
		case "GOARCH":
			goarch = setting.Value
		}
	}
	if goos != platform || goarch != arch || !containsCommand(resolved) {
		return ""
	}
	return resolved
}

// Older cmd/aih binaries have the same program path but lack this private
// command. A static marker check rejects those without spawning a probe child.
func containsCommand(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	marker := []byte(Command)
	buffer := make([]byte, 64*1024+len(marker))
	retained := 0
	for {
		read, err := file.Read(buffer[retained:])
		used := retained + read
		if bytes.Contains(buffer[:used], marker) {
			return true
		}
		if err != nil || read == 0 {
			return false
		}
		retained = len(marker) - 1
		if used < retained {
			retained = used
		}
		copy(buffer, buffer[used-retained:used])
	}
}
