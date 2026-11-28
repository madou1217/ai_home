// Package clipboardsource resolves the application that was frontmost when a
// clipboard change was observed. Clipboard APIs do not expose the real writer,
// so this is an inferred attribution (V15 S01/S02): the UI must present it as
// observed context, never as a verified writer identity.
package clipboardsource

import (
	"context"
	"strings"
	"time"
)

// App is the frontmost application snapshot used for source attribution.
type App struct {
	Name     string
	BundleID string
}

// Resolver reports the frontmost application on the current platform.
type Resolver interface {
	Frontmost(ctx context.Context) (App, bool)
}

// Ignored reports whether an application is one of our own surfaces; a capture
// caused by our own paste must not be attributed to Lumen itself.
func Ignored(app App) bool {
	id := strings.ToLower(strings.TrimSpace(app.BundleID))
	switch id {
	case "com.meadeo.aihome", "com.meadeo.translation", "com.meadeo.ai-home":
		return true
	}
	// A locked screen or the auth agent is never a meaningful clipboard source.
	for _, prefix := range []string{"com.apple.loginwindow", "com.apple.securityagent", "com.apple.screensaver"} {
		if strings.HasPrefix(id, prefix) {
			return true
		}
	}
	name := strings.ToLower(strings.TrimSpace(app.Name))
	switch name {
	case "ai home", "aih translation", "lumen", "loginwindow", "securityagent":
		return true
	}
	return false
}

// DisplayName prefers the human name and falls back to the bundle id.
func (a App) DisplayName() string {
	if name := strings.TrimSpace(a.Name); name != "" {
		return name
	}
	return strings.TrimSpace(a.BundleID)
}

// commandTimeout bounds the platform probe so capture polling never stalls.
const commandTimeout = 600 * time.Millisecond

func withTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, commandTimeout)
}
