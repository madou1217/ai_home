package hostapps

import (
	"context"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// DetectCodexDesktop reports a same-user macOS main-image candidate. It does
// not establish AIH/account ownership or grant permission to stop a process.
func DetectCodexDesktop(ctx context.Context) (DesktopProcessDetection, error) {
	result := DesktopProcessDetection{
		Platform: runtime.GOOS, ClientName: "ChatGPT",
		IdentityScope: "same_os_user_main_candidate",
	}
	var config *providers.DesktopPlatform
	if runtime.GOOS == PlatformMacOS {
		for _, provider := range providers.BuiltinManifest().Providers {
			if provider.ID == "codex" && provider.CLI != nil && provider.CLI.DesktopClient != nil {
				config = provider.CLI.DesktopClient.MacOS
				break
			}
		}
	}
	if config == nil {
		result.Reason = "unsupported_platform"
		return result, nil
	}
	result.Supported, result.ClientName = true, config.ClientName
	if ctx == nil {
		result.Reason = errDesktopScan.Error()
		return result, errDesktopScan
	}
	candidates, err := detectClaudeMac(ctx, config)
	if err == nil && ctx.Err() != nil {
		err = errDesktopScan
	}
	if err == nil {
		for _, candidate := range candidates {
			// The shared scanner permits each canonical marker/name combination.
			// Codex has two names: require each bundle to match its own main image.
			suffix := "/" + candidate.Name + ".app/Contents/MacOS/" + candidate.Name
			if !strings.HasSuffix(candidate.ExecutablePath, suffix) {
				err = errDesktopIdentity
				break
			}
		}
	}
	if err == nil && len(candidates) > 1 {
		err = errDesktopAmbiguous
	}
	if err != nil {
		result.Reason = err.Error()
		return result, err
	}
	result.OK, result.Reason = true, "not_running"
	if len(candidates) == 1 {
		result.Detected, result.Reason, result.ProcessInfo = true, "", &candidates[0]
	}
	return result, nil
}
