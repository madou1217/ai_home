//go:build !windows

package apps

import (
	"context"

	"github.com/madou1217/ai_home/core/providers"
)

// findWindowsRegisteredDesktopClientNative is only implemented on Windows.
func findWindowsRegisteredDesktopClientNative(_ context.Context, _ string, _ *providers.DesktopPlatform, _ Options) *DesktopRecord {
	return nil
}
