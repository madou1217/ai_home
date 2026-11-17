package providercli

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// ResolveCodexBinary is the canonical resolver for CLI and app-server launches.
// It inspects installed candidates only; no shell, installer, or download is run.
func ResolveCodexBinary(hostHomeDir string) (string, error) {
	return defaultBinaryResolver().resolveCodexBinary("codex", hostHomeDir)
}

func (resolver binaryResolver) resolveCodexBinary(binary, hostHomeDir string) (string, error) {
	if override, hasOverride := resolver.lookupEnv("AIH_CODEX_BINARY"); hasOverride {
		var err error
		if override == "" || override != strings.TrimSpace(override) {
			err = errors.New("AIH_CODEX_BINARY 必须非空且没有首尾空格")
		} else {
			var resolved string
			resolved, err = resolver.lookPath(override)
			if err == nil {
				resolved, err = resolveCodexHook(resolved)
				if err == nil {
					return resolved, nil
				}
			}
		}
		return "", &CodexBinaryError{
			Code:    CodeCodexBinaryOverrideInvalid,
			Message: "AIH_CODEX_BINARY 配置的 Codex CLI 不可用；请修正或移除该显式配置: " + err.Error(),
			Action:  "fix_binary_override",
			cause:   err,
		}
	}
	if binary == "" {
		binary = "codex"
	}
	// A caller-selected command/path is also authoritative, not a discovery hint.
	if binary != "codex" {
		resolved, err := resolver.lookPath(binary)
		if err != nil {
			return "", err
		}
		return resolveCodexHook(resolved)
	}

	var legacyHookPath string
	seen := make(map[string]bool)
	tryResolved := func(resolved string) (string, error) {
		key := codexCandidateKey(resolved)
		if seen[key] {
			return "", nil
		}
		seen[key] = true
		target, err := resolveCodexHook(resolved)
		var missing *codexHookUpstreamMissing
		if errors.As(err, &missing) {
			if legacyHookPath == "" {
				legacyHookPath = missing.path
			}
			return "", nil
		}
		return target, err
	}
	resolved, err := resolver.lookPath(binary)
	if err == nil {
		if target, resolveErr := tryResolved(resolved); target != "" || resolveErr != nil {
			return target, resolveErr
		}
	} else if !errors.Is(err, exec.ErrNotFound) && !errors.Is(err, fs.ErrNotExist) {
		// In particular, preserve exec.ErrDot rather than trusting a relative PATH.
		return "", err
	}
	for _, candidate := range resolver.codexCandidatePaths(hostHomeDir) {
		resolved, err := resolver.lookPath(candidate)
		if err != nil {
			continue
		}
		if target, resolveErr := tryResolved(resolved); target != "" || resolveErr != nil {
			return target, resolveErr
		}
	}
	return "", codexOfficialCLIMissing(legacyHookPath)
}

func (resolver binaryResolver) codexCandidatePaths(hostHomeDir string) []string {
	pathEnv, _ := resolver.lookupEnv("PATH")
	dirs := filepath.SplitList(pathEnv)
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home != "" {
		if runtime.GOOS == "windows" {
			dirs = append(dirs, filepath.Join(home, "AppData", "Local", "aih-cli", "codex"))
		} else {
			dirs = append(dirs, filepath.Join(home, ".local", "share", "aih-cli", "codex", "bin"))
		}
		dirs = append(dirs,
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".codex", "packages", "standalone", "current", "bin"),
		)
		if runtime.GOOS == "windows" {
			localAppData, _ := resolver.lookupEnv("LOCALAPPDATA")
			if localAppData == "" {
				localAppData = filepath.Join(home, "AppData", "Local")
			}
			appData, _ := resolver.lookupEnv("APPDATA")
			if appData == "" {
				appData = filepath.Join(home, "AppData", "Roaming")
			}
			dirs = append(dirs,
				filepath.Join(localAppData, "codex", "packages", "standalone", "current", "bin"),
				filepath.Join(localAppData, "Programs", "OpenAI", "Codex", "bin"),
				filepath.Join(appData, "npm"),
				filepath.Join(localAppData, "pnpm"),
				filepath.Join(localAppData, "Microsoft", "WinGet", "Links"),
			)
		} else {
			dirs = append(dirs,
				filepath.Join(home, ".npm-global", "bin"),
				filepath.Join(home, ".volta", "bin"),
				filepath.Join(home, ".local", "share", "pnpm"),
			)
			if runtime.GOOS == "darwin" {
				dirs = append(dirs, filepath.Join(home, "Library", "pnpm"))
			}
		}
	}
	if runtime.GOOS != "windows" {
		dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin")
	}
	names := []string{"codex"}
	if runtime.GOOS == "windows" {
		extEnv, _ := resolver.lookupEnv("PATHEXT")
		if extEnv == "" {
			extEnv = ".COM;.EXE;.BAT;.CMD"
		}
		for _, ext := range strings.Split(extEnv, ";") {
			if strings.HasPrefix(ext, ".") && !strings.ContainsAny(ext, `/\`) {
				names = append(names, "codex"+ext)
			}
		}
	}
	var candidates []string
	seen := make(map[string]bool)
	for _, dir := range dirs {
		if !filepath.IsAbs(dir) {
			continue
		}
		for _, name := range names {
			candidate := filepath.Join(dir, name)
			key := codexCandidateKey(candidate)
			if !seen[key] {
				seen[key] = true
				candidates = append(candidates, candidate)
			}
		}
	}
	return candidates
}
