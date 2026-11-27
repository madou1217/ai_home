// Package appsessions tracks applications launched through `aih app` and
// resolves their live process IDs so CLI and WebUI can observe/renew/kill them.
//
// A launch record is deliberately small: the app catalog already owns names,
// icons, and proxy capability. This package only adds "what did we start,
// when, with which profile/proxy" and the current process state.
package appsessions

import (
	"runtime"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
)

// Instance is one launch performed by `aih app` or the WebUI app API.
type Instance struct {
	ID    string `json:"id"`
	AppID string `json:"appId"`
	Name  string `json:"name"`
	Path  string `json:"path"`
	// Executable is the concrete binary/exec command used for PID matching.
	Executable string `json:"executable,omitempty"`
	Kind       string `json:"kind"`
	// ProfileDir is set for Chromium launches; helpers carry the same flag, so
	// it is the strongest way to identify one browser instance.
	ProfileDir string `json:"profileDir,omitempty"`

	Proxied   bool   `json:"proxied"`
	ProxyURL  string `json:"proxyUrl,omitempty"`
	ProxyMode string `json:"proxyMode,omitempty"`
	// ProxyCountry/ProxyCity come from the serving entry's lease label (or its
	// published endpoint metadata); ProxyRegion is the ready-to-render Chinese
	// label. All three stay empty when the region cannot be resolved.
	ProxyCountry string `json:"proxyCountry,omitempty"`
	ProxyCity    string `json:"proxyCity,omitempty"`
	ProxyRegion  string `json:"proxyRegion,omitempty"`

	StartedAtMs int64 `json:"startedAtMs"`
	PIDs        []int `json:"pids,omitempty"`
	Live        bool  `json:"live"`
	// Adopted means the launch handed off to an already-running instance
	// (single-instance apps). The desk still shows it, but it was not spawned
	// by this launch.
	Adopted    bool   `json:"adopted,omitempty"`
	Status     string `json:"status"`
	ExitedAtMs int64  `json:"exitedAtMs,omitempty"`
}

// Status values exposed to CLI/WebUI.
const (
	StatusStarting = "starting"
	StatusRunning  = "running"
	StatusExited   = "exited"
	StatusUnknown  = "unknown"
)

// ActiveNow reports whether the instance belongs on the live desk: it still
// has a matched process or is inside the launch window. Exited rows belong in
// history so a long-lived desk cannot grow into a process graveyard.
func (instance Instance) ActiveNow() bool {
	return instance.Live || instance.Status == StatusStarting
}

// SplitActive separates live rows from exited history, preserving order.
func SplitActive(instances []Instance) (active, history []Instance) {
	for _, instance := range instances {
		if instance.ActiveNow() {
			active = append(active, instance)
		} else {
			history = append(history, instance)
		}
	}
	return active, history
}

// NewInstance builds a record from the catalog app and launch decision.
func NewInstance(app launcher.App, executable, profileDir, proxyURL, proxyMode string) Instance {
	instance := Instance{
		AppID:       app.ID,
		Name:        app.Name,
		Path:        app.Path,
		Executable:  executable,
		Kind:        string(app.Kind),
		ProfileDir:  profileDir,
		Proxied:     proxyURL != "",
		ProxyURL:    proxyURL,
		ProxyMode:   proxyMode,
		StartedAtMs: time.Now().UnixMilli(),
		Status:      StatusStarting,
	}
	return instance
}

// KillResult reports one instance's termination.
type KillResult struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	PIDs    []int  `json:"pids,omitempty"`
	Killed  bool   `json:"killed"`
	Message string `json:"message,omitempty"`
}

// ExecutableFor extracts the concrete binary used for PID matching. macOS app
// bundles are matched by their Contents/MacOS prefix, so they return "".
func ExecutableFor(app launcher.App) string {
	switch runtime.GOOS {
	case "linux":
		fields := strings.Fields(app.Exec)
		if len(fields) > 0 {
			return strings.Trim(fields[0], "\"'")
		}
	case "windows":
		path := strings.TrimSpace(app.Path)
		if path != "" && !strings.HasPrefix(strings.ToLower(path), "shell:") {
			return path
		}
	}
	return ""
}
