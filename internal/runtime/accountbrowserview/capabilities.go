package accountbrowserview

import (
	"context"
	"path/filepath"
	"runtime"
)

// Capabilities describes implemented features and read-only host prerequisites,
// not readiness. Permissions, browser installation/signature, storage access and
// native helper compilation are not verified until an explicit user start.
type Capabilities struct {
	Supported               bool                `json:"supported"`
	HostOS                  string              `json:"hostOS"`
	HostArch                string              `json:"hostArch"`
	PlatformAvailable       bool                `json:"platformAvailable"`
	Reason                  string              `json:"reason,omitempty"`
	Capture                 bool                `json:"capture"`
	Pointer                 bool                `json:"pointer"`
	Scroll                  bool                `json:"scroll"`
	Text                    bool                `json:"text"`
	RequiresUserStart       bool                `json:"requiresUserStart"`
	MayActivateNativeWindow bool                `json:"mayActivateNativeWindow"`
	Permissions             string              `json:"permissions"`
	Browser                 CapabilitiesBrowser `json:"browser"`
}

// CapabilitiesBrowser is the implemented browser target, not a verified install.
type CapabilitiesBrowser struct {
	Vendor  string `json:"vendor"`
	Channel string `json:"channel"`
}

// Capabilities observes this server, regardless of the WebUI client's platform.
// It never starts a browser/helper, creates storage, checks or requests native
// permissions, opens a window, captures a frame, or sends input.
func (s *Service) Capabilities(ctx context.Context) Capabilities {
	available, reason := capabilityPlatformAvailable(ctx)
	capabilities := Capabilities{
		HostOS:                  runtime.GOOS,
		HostArch:                runtime.GOARCH,
		PlatformAvailable:       available,
		Reason:                  reason,
		RequiresUserStart:       true,
		MayActivateNativeWindow: true,
		Permissions:             "checked-on-start",
		Browser:                 CapabilitiesBrowser{Vendor: "Microsoft Edge", Channel: "stable"},
	}
	if !available {
		return capabilities
	}
	if s == nil || !filepath.IsAbs(s.home) {
		capabilities.Reason = "browser_home_requires_absolute_path"
		return capabilities
	}
	capabilities.Supported = true
	capabilities.Capture = true
	capabilities.Pointer = true
	capabilities.Scroll = true
	capabilities.Text = true
	return capabilities
}
