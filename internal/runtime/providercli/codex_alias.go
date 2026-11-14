package providercli

import (
	"errors"
	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// resolveCodexHook follows only recognized AIH aliases and executable backups.
// Never execute a wrapper to discover its target, and bound cycles/depth.
func resolveCodexHook(resolved string) (string, error) {
	seen := make(map[string]bool)
	for depth := 0; depth < 8; depth++ {
		if real, err := filepath.EvalSymlinks(resolved); err == nil {
			resolved = real
		}
		if seen[resolved] {
			return "", errors.New("Codex CLI hook alias cycle")
		}
		seen[resolved] = true
		if !hasFileMarker(resolved, codexLegacyHookMarker) {
			return resolved, nil
		}
		if hasFileMarker(resolved, "aih-codex-cli-hook-alias") {
			file, err := os.Open(resolved)
			if err != nil {
				return "", err
			}
			content, readErr := io.ReadAll(io.LimitReader(file, 64*1024))
			file.Close()
			if readErr != nil {
				return "", readErr
			}
			target := codexhooks.ReadAliasTarget(string(content))
			if target == "" || !filepath.IsAbs(target) {
				return "", errors.New("Codex CLI hook alias target is not a supported absolute executable")
			}
			resolved = target
			if !executableFile(resolved) {
				return "", ErrProviderBinaryNotFound
			}

			continue
		}
		backup := codexhooks.BuildBackupPath(resolved)
		if !executableFile(backup) {
			backup = resolved + ".aih-original"
		}
		if !executableFile(backup) {
			return "", errors.New("检测到旧 Codex Node hook，但没有可用的官方上游 CLI")
		}
		resolved = backup
	}
	return "", errors.New("Codex CLI hook alias depth exceeded")
}

func executableFile(target string) bool {
	info, err := os.Stat(target)
	return err == nil && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode()&0o111 != 0)
}
