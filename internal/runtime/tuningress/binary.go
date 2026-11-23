package tuningress

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const binaryBaseName = "sing-box"

// DiscoverBinary locates a sing-box executable for Check. Search order is:
//
//  1. <home>/.ai_home/bin/sing-box (the managed AIH install),
//  2. directories listed in PATH,
//  3. platform system locations (Homebrew, /usr/local, Chocolatey, and so on).
//
// Start never calls DiscoverBinary; it requires Options.SingBoxPath so a TUN
// takeover cannot silently pick an unexpected binary.
func DiscoverBinary() (string, error) {
	homeDir, _ := os.UserHomeDir()
	return discoverBinary(runtime.GOOS, homeDir, os.Getenv("PATH"), os.Getenv)
}

func discoverBinary(platform, homeDir, pathEnv string, getenv func(string) string) (string, error) {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	name := binaryBaseName
	if normalizePlatform(platform) == "windows" {
		name += ".exe"
	}

	candidates := make([]string, 0, 8)
	if homeDir != "" {
		candidates = append(candidates, filepath.Join(homeDir, ".ai_home", "bin", name))
	}
	for _, dir := range filepath.SplitList(pathEnv) {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		candidates = append(candidates, filepath.Join(dir, name))
	}
	for _, dir := range systemBinaryDirs(platform, getenv) {
		candidates = append(candidates, filepath.Join(dir, name))
	}

	searched := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		searched = append(searched, candidate)
		if executableExists(candidate) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%w: searched %s", ErrBinaryNotFound, strings.Join(searched, ", "))
}

func systemBinaryDirs(platform string, getenv func(string) string) []string {
	switch normalizePlatform(platform) {
	case "darwin":
		return []string{"/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"}
	case "linux":
		return []string{"/usr/local/bin", "/usr/bin", "/usr/sbin", "/snap/bin"}
	case "windows":
		dirs := make([]string, 0, 4)
		if programFiles := strings.TrimSpace(getenv("ProgramFiles")); programFiles != "" {
			dirs = append(dirs, filepath.Join(programFiles, "sing-box"))
		}
		if programFilesX86 := strings.TrimSpace(getenv("ProgramFiles(x86)")); programFilesX86 != "" {
			dirs = append(dirs, filepath.Join(programFilesX86, "sing-box"))
		}
		if localAppData := strings.TrimSpace(getenv("LOCALAPPDATA")); localAppData != "" {
			dirs = append(dirs, filepath.Join(localAppData, "Programs", "sing-box"))
		}
		if programData := strings.TrimSpace(getenv("ProgramData")); programData != "" {
			dirs = append(dirs, filepath.Join(programData, "chocolatey", "bin"))
		}
		return dirs
	default:
		return nil
	}
}

func normalizePlatform(platform string) string {
	switch strings.ToLower(strings.TrimSpace(platform)) {
	case "darwin", "mac", "macos":
		return "darwin"
	case "windows", "win", "win32":
		return "windows"
	case "linux":
		return "linux"
	default:
		return strings.ToLower(strings.TrimSpace(platform))
	}
}

func executableExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode()&0o111 != 0
}

// resolveCheckBinary honors an explicit path, and only falls back to discovery
// when the caller did not provide one. A bad explicit path is reported instead
// of being silently replaced by another binary.
func resolveCheckBinary(explicit string) (string, error) {
	path := strings.TrimSpace(explicit)
	if path == "" {
		return DiscoverBinary()
	}
	if !executableExists(path) {
		return "", fmt.Errorf("%w: %s is not an executable file", ErrBinaryNotFound, path)
	}
	return path, nil
}

// resolveStartBinary requires an explicit path because Start changes the
// system network state and must never guess which binary owns it.
func resolveStartBinary(explicit string) (string, error) {
	path := strings.TrimSpace(explicit)
	if path == "" {
		return "", fmt.Errorf("%w: Options.SingBoxPath is required for Start", ErrBinaryNotFound)
	}
	if !executableExists(path) {
		return "", fmt.Errorf("%w: %s is not an executable file", ErrBinaryNotFound, path)
	}
	if absolute, err := filepath.Abs(path); err == nil {
		return absolute, nil
	}
	return path, nil
}
