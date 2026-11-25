//go:build !linux

package launcherd

import (
	"fmt"

	"github.com/madou1217/ai_home/application/launcher"
)

// AutostartPath is only supported on Linux desktops.
func AutostartPath() (string, error) {
	return "", fmt.Errorf("%w: XDG autostart is only supported on Linux", launcher.ErrUnsupported)
}

// AutostartEnabled always returns false on non-Linux platforms.
func AutostartEnabled() bool {
	return false
}

// EnableAutostart is only supported on Linux desktops.
func EnableAutostart(_ string) (string, error) {
	return "", fmt.Errorf("%w: XDG autostart is only supported on Linux", launcher.ErrUnsupported)
}

// DisableAutostart is only supported on Linux desktops.
func DisableAutostart() (string, bool, error) {
	return "", false, fmt.Errorf("%w: XDG autostart is only supported on Linux", launcher.ErrUnsupported)
}
