package nativeterminal

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// resolveExecutable consults the provided environment only, never the host
// process PATH or cwd. Explicit absolute choices still receive executable checks.
func resolveExecutable(name string, environment []string) (string, error) {
	extensions := []string{""}
	if runtime.GOOS == "windows" && filepath.Ext(name) == "" {
		extensions = nil
		for _, ext := range strings.Split(envValue(environment, "PATHEXT"), ";") {
			if ext != "" {
				extensions = append(extensions, strings.ToLower(ext))
			}
		}
		if len(extensions) == 0 {
			extensions = []string{".exe", ".com", ".cmd", ".bat"}
		}
	}
	candidates := []string{}
	if filepath.IsAbs(name) {
		candidates = append(candidates, name)
	} else if !strings.ContainsAny(name, `/\`) {
		for _, directory := range filepath.SplitList(envValue(environment, "PATH")) {
			if filepath.IsAbs(directory) {
				candidates = append(candidates, filepath.Join(directory, name))
			}
		}
	}
	for _, candidate := range candidates {
		for _, ext := range extensions {
			path := candidate + ext
			info, err := os.Stat(path)
			if err == nil && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode().Perm()&0111 != 0) {
				return path, nil
			}
		}
	}
	return "", errors.New("native_terminal_executable_unavailable")
}
