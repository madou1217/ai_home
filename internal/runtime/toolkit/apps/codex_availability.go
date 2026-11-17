package apps

import (
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

// resolveOfficialCodex must agree with CLI/app-server availability: a legacy
// AIH wrapper without an upstream is not an installed, usable Codex CLI.
func resolveOfficialCodex(opts Options) (string, error) {
	env := resolveEnvMap(opts)
	lookup := func(key string) (string, bool) {
		// Options override the host environment, including Windows Path/PATH.
		for _, values := range []map[string]string{opts.Env, env} {
			if value, ok := values[key]; ok {
				return value, true
			}
			if resolvePlatform(opts) == platformWindows {
				for name, value := range values {
					if strings.EqualFold(name, key) {
						return value, true
					}
				}
			}
		}
		return "", false
	}
	lookPath := opts.LookPath
	if lookPath == nil {
		lookPath = func(name string) (string, error) {
			if filepath.IsAbs(name) {
				if resolvePlatform(opts) == platformWindows && filepath.Ext(name) != "" {
					if isExecutableFile(platformWindows, name) {
						return name, nil
					}
					return "", exec.ErrNotFound
				}
				if !dirExists(filepath.Dir(name)) {
					return "", exec.ErrNotFound
				}
				if found := findExecutableInDir(resolvePlatform(opts), filepath.Dir(name), []string{filepath.Base(name)}); found != "" {
					return found, nil
				}
				return "", exec.ErrNotFound
			}
			if strings.ContainsAny(name, `/\`) {
				return "", exec.ErrDot
			}
			path, _ := lookup("PATH")
			for _, dir := range filepath.SplitList(path) {
				// Unlike CollectPathEntries, PATH entries must be directories.
				if !dirExists(dir) {
					continue
				}
				if found := findExecutableInDir(resolvePlatform(opts), dir, []string{name}); found != "" {
					if !filepath.IsAbs(dir) {
						return "", exec.ErrDot
					}
					return found, nil
				}
			}
			return "", exec.ErrNotFound
		}
	}
	return providercli.ResolveCodexBinaryWithOptions(providercli.CodexBinaryOptions{
		HostHomeDir: ResolveHostHome(opts), LookupEnv: lookup, LookPath: lookPath,
	})
}
