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
// Ownership rules:
//   - a Chromium profile (--user-data-dir) is the strongest identity and is
//     matched exactly;
//   - a process belongs to at most one instance (the caller passes `claimed`);
//   - a launch without a profile claims the unclaimed process whose start time
//     is closest to the recorded launch time, not every process in a wide
//     window. The old "now + 10s" window let a direct Chrome row absorb every
//     proxied Chrome started afterwards, so "kill all" double-counted kills.
//
// If no process matches, a single-instance app may have handed off to an
// existing process; adoption is still restricted to a starting, non-exited row.
func matchPIDs(instance Instance, processes []Process, now time.Time, claimed map[int]struct{}) ([]int, bool, int64) {
	if instance.ExitedAtMs > 0 && !instance.Live {
		return nil, false, 0
	}
	started := time.UnixMilli(instance.StartedAtMs)
	if instance.ProfileDir != "" {
		var matched []int
		for _, process := range processes {
			if process.PID <= 0 || process.Command == "" || isHelperProcess(process.Command) {
				continue
			}
			if _, used := claimed[process.PID]; used {
				continue
			}
			if strings.Contains(process.Command, "--user-data-dir="+instance.ProfileDir) {
				matched = append(matched, process.PID)
			}
		}
		return matched, false, 0
	}

	var best Process
	bestDelta := time.Duration(1<<63 - 1)
	found := false
	for _, process := range processes {
		if process.PID <= 0 || process.Command == "" || isHelperProcess(process.Command) {
			continue
		}
		if _, used := claimed[process.PID]; used {
			continue
		}
		if !matchesExecutable(instance, process.Command) {
			continue
		}
		if !instance.Proxied && strings.Contains(process.Command, "app-proxy") {
			continue
		}
		delta := process.StartedAt.Sub(started)
		if delta < 0 {
			delta = -delta
		}
		if delta > 15*time.Second {
			continue
		}
		if !found || delta < bestDelta || (delta == bestDelta && process.StartedAt.After(best.StartedAt)) {
			best = process
			bestDelta = delta
			found = true
		}
	}
	if found {
		return []int{best.PID}, false, 0
	}
	if instance.Status != StatusStarting || instance.ExitedAtMs > 0 || now.Sub(started) > 2*time.Minute {
		return nil, false, 0
	}
	var adoptedStart time.Time
	for _, process := range processes {
		if process.PID <= 0 || process.Command == "" || isHelperProcess(process.Command) {
			continue
		}
		if _, used := claimed[process.PID]; used {
			continue
		}
		if !matchesInstance(instance, process.Command) {
			continue
		}
		if !instance.Proxied && strings.Contains(process.Command, "app-proxy") {
			continue
		}
		if adoptedStart.IsZero() || process.StartedAt.After(adoptedStart) {
			adoptedStart = process.StartedAt
			best = process
		}
	}
	if !adoptedStart.IsZero() {
		return []int{best.PID}, true, adoptedStart.UnixMilli()
	}
	return nil, false, 0
}

// expandKillPIDs returns every process that must die with the instance.
//
// A Chromium instance owns all processes carrying its exact profile, including
// helpers (--type=...) that the live-desk matcher filters out. For apps without
// a profile we never widen to every process of that executable: only the
// recorded main PIDs (or the closest process in the launch window) are killed.
func expandKillPIDs(instance Instance, processes []Process, now time.Time) []int {
	pids := append([]int(nil), instance.PIDs...)
	if instance.ProfileDir != "" {
		seen := make(map[int]struct{}, len(pids))
		for _, pid := range pids {
			seen[pid] = struct{}{}
		}
		for _, process := range processes {
			if process.PID <= 0 || process.Command == "" {
				continue
			}
			if _, exists := seen[process.PID]; exists {
				continue
			}
			if strings.Contains(process.Command, "--user-data-dir="+instance.ProfileDir) {
				pids = append(pids, process.PID)
				seen[process.PID] = struct{}{}
			}
		}
		return pids
	}
	if len(pids) > 0 {
		return pids
	}
	started := time.UnixMilli(instance.StartedAtMs)
	var best int
	bestDelta := time.Duration(1<<63 - 1)
	for _, process := range processes {
		if process.PID <= 0 || process.Command == "" || isHelperProcess(process.Command) {
			continue
		}
		if !matchesExecutable(instance, process.Command) {
			continue
		}
		if !instance.Proxied && strings.Contains(process.Command, "app-proxy") {
			continue
		}
		delta := process.StartedAt.Sub(started)
		if delta < 0 {
			delta = -delta
		}
		if delta > 30*time.Second {
			continue
		}
		if delta < bestDelta {
			best = process.PID
			bestDelta = delta
		}
	}
	_ = now
	if best > 0 {
		return []int{best}
	}
	return pids
}

func matchesInstance(instance Instance, command string) bool {
	// A proxied Chromium launch owns exactly one isolated profile. Falling back
	// to executable matching would absorb a concurrently running direct Chrome
	// (and every other browser window) into the proxied instance's PID list.
	if instance.ProfileDir != "" {
		return strings.Contains(command, "--user-data-dir="+instance.ProfileDir)
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
