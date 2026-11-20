//go:build !darwin

package accountbrowserview

import "context"

func capabilityPlatformAvailable(context.Context) (bool, string) {
	return false, "browser_host_platform_unavailable"
}
