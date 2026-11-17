package providercli

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
)

// codexHookUpstreamMissing is the only hook failure that permits another candidate.
// An invalid alias, a cycle, or an unreadable target must not be silently bypassed.
type codexHookUpstreamMissing struct {
	path string
}

func (err *codexHookUpstreamMissing) Error() string {
	return "检测到旧 Codex Node hook，但没有可用的官方上游 CLI (" + err.path + ")"
}

// resolveCodexHook follows only recognized AIH aliases and executable backups.
// Never execute a wrapper to discover its target, and bound cycles/depth.
func resolveCodexHook(resolved string) (string, error) {
	seen := make(map[string]bool)
	for depth := 0; depth < 8; depth++ {
		absolute, err := filepath.Abs(resolved)
		if err != nil {
			return "", codexHookError(CodeCodexHookUntrusted, resolved, "Codex CLI hook target cannot be resolved", err)
		}
		resolved, err = evalCodexHookPath(absolute)
		if err != nil {
			return "", codexHookError(CodeCodexHookUntrusted, absolute, "Codex CLI hook target cannot be resolved", err)
		}
		if !executableFile(resolved) {
			return "", codexHookError(CodeCodexHookUntrusted, resolved, "Codex CLI hook target is not a regular executable", nil)
		}
		key := codexCandidateKey(resolved)
		if seen[key] {
			return "", codexHookError(CodeCodexHookCycle, resolved, "Codex CLI hook alias cycle", nil)
		}
		seen[key] = true
		content, err := readCodexHookHeader(resolved)
		if err != nil {
			return "", codexHookError(CodeCodexHookUntrusted, resolved, "Codex CLI hook target cannot be inspected", err)
		}
		if !strings.Contains(content, codexhooks.WrapperMarkerCLI) {
			return resolveCodexNPMEntry(resolved)
		}
		if strings.Contains(content, codexhooks.WrapperAliasMarker) {
			target := codexhooks.ReadAliasTarget(content)
			if target == "" || !filepath.IsAbs(target) || !executableFile(target) {
				return "", codexHookError(CodeCodexHookUntrusted, resolved, "Codex CLI hook alias target is not a supported absolute executable", nil)
			}
			resolved = target
			continue
		}
		if !codexhooks.HasCLIWrapperMarkerLine(content) {
			return "", codexHookError(CodeCodexHookUntrusted, resolved, "Codex CLI hook marker is not a recognized AIH wrapper", nil)
		}
		backup, err := resolveCodexBackup(resolved)
		if err != nil {
			return "", err
		}
		resolved = backup
	}
	return "", codexHookError(CodeCodexHookDepthExceeded, resolved, "Codex CLI hook alias depth exceeded", nil)
}

// A present but broken/cyclic backup is not the same as a missing upstream.
func resolveCodexBackup(wrapper string) (string, error) {
	for _, backup := range []string{codexhooks.BuildBackupPath(wrapper), wrapper + ".aih-original"} {
		if _, err := os.Lstat(backup); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return "", codexHookError(CodeCodexHookUntrusted, backup, "Codex CLI hook backup cannot be inspected", err)
		}
		if _, err := evalCodexHookPath(backup); err != nil {
			return "", codexHookError(CodeCodexHookUntrusted, backup, "Codex CLI hook backup cannot be resolved", err)
		}
		if executableFile(backup) {
			return backup, nil
		}
	}
	return "", &codexHookUpstreamMissing{path: wrapper}
}

// Windows junctions are ModeIrregular, not ModeSymlink, on current Go versions.
// Resolve each supported link with Readlink before the final standard-library
// canonicalization. Unknown reparse points, unreadable links and cycles fail closed.
func evalCodexHookPath(path string) (string, error) {
	if runtime.GOOS != "windows" {
		return filepath.EvalSymlinks(path)
	}
	links := 0
	active := make(map[string]bool)
	fail := func(path, message string) (string, error) {
		return "", &os.PathError{Op: "evalsymlinks", Path: path, Err: errors.New(message)}
	}
	var walk func(string) (string, error)
	walk = func(path string) (string, error) {
		if !filepath.IsAbs(path) {
			return fail(path, "Codex link target is not absolute")
		}
		volume := filepath.VolumeName(path)
		current := volume + string(filepath.Separator)
		parts := strings.FieldsFunc(path[len(volume):], func(ch rune) bool { return ch == '/' || ch == '\\' })
		for index, part := range parts {
			switch part {
			case ".":
				continue
			case "..":
				current = filepath.Dir(current)
				continue
			}
			current = filepath.Join(current, part)
			info, err := os.Lstat(current)
			if err != nil {
				return "", err
			}
			if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
				key := codexCandidateKey(current)
				if active[key] {
					return fail(current, "Codex filesystem link cycle")
				}
				links++
				if links > 64 {
					return fail(current, "Codex filesystem link depth exceeded")
				}
				target, err := os.Readlink(current)
				if err != nil {
					return "", err
				}
				if !filepath.IsAbs(target) {
					if target == "" || filepath.VolumeName(target) != "" || os.IsPathSeparator(target[0]) {
						return fail(current, "Codex link target is not a supported relative path")
					}
					// Preserve target components until the walk resolves links before '..'.
					target = filepath.Dir(current) + string(filepath.Separator) + target
				}
				active[key] = true
				current, err = walk(target)
				delete(active, key)
				if err != nil {
					return "", err
				}
				info, err = os.Lstat(current)
				if err != nil {
					return "", err
				}
			}
			if index < len(parts)-1 && !info.IsDir() {
				return fail(current, "Codex link path component is not a directory")
			}
		}
		return filepath.EvalSymlinks(current)
	}
	return walk(path)
}

func readCodexHookHeader(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, 64*1024))
	return string(content), err
}

func executableFile(target string) bool {
	info, err := os.Stat(target)
	return err == nil && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode()&0o111 != 0)
}

func codexCandidateKey(path string) string {
	key := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	return key
}
