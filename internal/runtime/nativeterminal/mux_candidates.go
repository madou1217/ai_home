package nativeterminal

import "path/filepath"

// Windows keeps native psmux first, then tmux/MSYS/Cygwin; no automatic install
// or removal of the existing implementation's supported multiplexer choices.
func windowsMuxCandidates(env []string) []string {
	candidates := []string{"psmux"}
	for _, root := range []string{envValue(env, "LOCALAPPDATA"), filepath.Join(envValue(env, "USERPROFILE"), "AppData", "Local")} {
		if root != "" {
			candidates = append(candidates, filepath.Join(root, "Microsoft", "WinGet", "Links", "psmux.exe"))
		}
	}
	candidates = append(candidates, "tmux")
	for _, root := range []string{envValue(env, "LOCALAPPDATA"), filepath.Join(envValue(env, "USERPROFILE"), "AppData", "Local")} {
		if root != "" {
			candidates = append(candidates, filepath.Join(root, "Microsoft", "WinGet", "Links", "tmux.exe"))
		}
	}
	return append(candidates, `C:\msys64\usr\bin\tmux.exe`, `C:\cygwin64\bin\tmux.exe`)
}
