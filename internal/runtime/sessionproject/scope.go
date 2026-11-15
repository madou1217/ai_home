package sessionproject

import (
	"path/filepath"
	"runtime"
	"strings"
)

// MatchesCwd requires a known absolute project path, not a session name
// or a guessed project slug. Symlink aliases and trailing separators are equal.
func MatchesCwd(projectPath, cwd string) bool {
	current := normalizeSessionProjectPath(cwd)
	return current != "" && normalizeSessionProjectPath(projectPath) == current
}

func normalizeSessionProjectPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || !filepath.IsAbs(value) {
		return ""
	}
	value = filepath.Clean(value)
	if resolved, err := filepath.EvalSymlinks(value); err == nil {
		value = resolved
	}
	if runtime.GOOS == "windows" {
		value = strings.ToLower(value)
	}
	return value
}
