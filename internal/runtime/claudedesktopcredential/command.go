package claudedesktopcredential

import (
	"bytes"
	"debug/buildinfo"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/regularnativefile"
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
	// StrictRegularFiles opts in only the known legacy layout recognizer.
	// The default resolver retains its existing behavior.
	StrictRegularFiles bool
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
	if options.StrictRegularFiles {
		return resolveStrictExecutable(options, platform, arch)
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
	if err != nil || !nativeBuildMatches(build, platform, arch) || !containsCommand(resolved) {
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
	return containsCommandReader(file)
}

func containsCommandReader(reader io.Reader) bool {
	marker := []byte(Command)
	buffer := make([]byte, 64*1024+len(marker))
	retained := 0
	for {
		read, err := reader.Read(buffer[retained:])
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

// nativeBuildMatches is shared by strict and compatibility inspection so the
// canonical program/platform predicates stay identical across both paths.
func nativeBuildMatches(build *buildinfo.BuildInfo, platform, arch string) bool {
	if build == nil || build.Path != goCLIProgramPath {
		return false
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
	return goos == platform && goarch == arch
}

// The opt-in branch never searches another candidate or falls back on failure.
// Build metadata and marker are read through independent readers of one handle.
func resolveStrictExecutable(options CommandOptions, platform, arch string) (string, error) {
	if !regularnativefile.Supported() {
		return "", errors.New("desktop_credential_platform_unsupported")
	}
	invalid := func() (string, error) {
		return "", errors.New("desktop_credential_helper_invalid")
	}
	explicit := strings.TrimSpace(options.ExplicitPath)
	if !filepath.IsAbs(explicit) || filepath.Clean(explicit) != explicit || strings.ContainsRune(explicit, 0) {
		return invalid()
	}
	resolved, err := filepath.EvalSymlinks(explicit)
	if err != nil {
		return invalid()
	}
	fileOptions := regularnativefile.Options{RequireExecutable: true}
	file, err := regularnativefile.Open(resolved, fileOptions)
	if err != nil {
		return invalid()
	}
	defer file.Close()
	initial, err := file.Stat()
	if err != nil {
		return invalid()
	}
	size := initial.Size()
	build, err := buildinfo.Read(io.NewSectionReader(file, 0, size))
	if err != nil || !nativeBuildMatches(build, platform, arch) {
		return invalid()
	}
	if !containsCommandReader(io.NewSectionReader(file, 0, size)) {
		return invalid()
	}
	if regularnativefile.Verify(file, initial, fileOptions) != nil {
		return invalid()
	}
	return resolved, nil
}
