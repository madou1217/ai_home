package appsessions

import (
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Process is one OS process visible to the launcher.
type Process struct {
	PID       int
	Command   string
	StartedAt time.Time
}

// matchPIDs selects the main process(es) for an instance.
//
// Chromium launches pass a unique --user-data-dir; helpers share that flag but
// also carry --type=..., so they are filtered first. Other apps fall back to
// executable/start-time matching. If no process started in the launch window,
// a single-instance app has handed off to an existing process; adopt the
// newest matching one so the desk reflects reality.
func matchPIDs(instance Instance, processes []Process, now time.Time) ([]int, bool, int64) {
	started := time.UnixMilli(instance.StartedAtMs)
	lowerBound := started.Add(-5 * time.Second)
	upperBound := now.Add(10 * time.Second)
	var matched []int
	var adoptedStart time.Time
	for _, process := range processes {
		if process.PID <= 0 || process.Command == "" || isHelperProcess(process.Command) {
			continue
		}
		if process.StartedAt.Before(lowerBound) || process.StartedAt.After(upperBound) {
			continue
		}
		if matchesInstance(instance, process.Command) {
			matched = append(matched, process.PID)
		}
	}
	if len(matched) > 0 {
		return matched, false, 0
	}
	for _, process := range processes {
		if process.PID <= 0 || process.Command == "" || isHelperProcess(process.Command) {
			continue
		}
		if !matchesInstance(instance, process.Command) {
			continue
		}
		// A plain launch must not adopt the desk's proxied browser instance:
		// both share the executable, only one has the isolated app-proxy profile.
		if instance.ProfileDir == "" && !instance.Proxied &&
			strings.Contains(process.Command, "app-proxy") {
			continue
		}
		if adoptedStart.IsZero() || process.StartedAt.After(adoptedStart) {
			adoptedStart = process.StartedAt
			matched = []int{process.PID}
		}
	}
	if len(matched) > 0 {
		return matched, true, adoptedStart.UnixMilli()
	}
	return nil, false, 0
}

func matchesInstance(instance Instance, command string) bool {
	if instance.ProfileDir != "" &&
		strings.Contains(command, "--user-data-dir="+instance.ProfileDir) {
		return true
	}
	return matchesExecutable(instance, command)
}

func isHelperProcess(command string) bool {
	lower := strings.ToLower(command)
	for _, marker := range []string{
		"--type=", "helper", "crashpad", "gpu-process", "renderer",
		"utility-sub-type", "webview", "--extension-process",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func matchesExecutable(instance Instance, command string) bool {
	if executable := strings.TrimSpace(instance.Executable); executable != "" {
		if runtime.GOOS == "windows" {
			if strings.Contains(strings.ToLower(command), strings.ToLower(executable)) {
				return true
			}
		} else if strings.Contains(command, executable) {
			return true
		}
	}
	path := strings.TrimSpace(instance.Path)
	if path == "" {
		return false
	}
	if runtime.GOOS == "darwin" && strings.HasSuffix(strings.ToLower(path), ".app") {
		return strings.Contains(command, filepath.Join(path, "Contents", "MacOS")+string(filepath.Separator))
	}
	return strings.Contains(command, path)
}
