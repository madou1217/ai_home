package codexpreferences

import (
	"fmt"
	"os"
	"path/filepath"
)

// CheckHostReady refuses to combine an interrupted default transaction's native
// files with its uncommitted database selection. It is observational only: the
// next explicit set-default owns recovery while holding the host lock.
func CheckHostReady(home string) error {
	if home == "" {
		return nil
	}
	candidates := make(map[string]bool)
	for _, directory := range []string{home, resolvedHome(home)} {
		for _, name := range []string{".aih-default-change.json", "config.toml.aih-default-conflict", "auth.json.aih-default-conflict"} {
			candidates[filepath.Join(directory, name)] = true
		}
		for _, name := range []string{"config.toml", "auth.json"} {
			resolved, err := filepath.EvalSymlinks(filepath.Join(directory, name))
			if err == nil {
				candidates[resolved+".aih-default-conflict"] = true
			} else if !os.IsNotExist(err) {
				return fmt.Errorf("codex_default_recovery_state_unavailable")
			}
		}
	}
	for candidate := range candidates {
		_, err := os.Lstat(candidate)
		if err == nil {
			return fmt.Errorf("codex_default_recovery_required: rerun codex set-default before launching")
		}
		if !os.IsNotExist(err) {
			return fmt.Errorf("codex_default_recovery_state_unavailable")
		}
	}

	return nil
}

func resolvedHome(home string) string {
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		return resolved
	}
	return home
}
