package accountbrowserview

import (
	"errors"

	"github.com/madou1217/ai_home/internal/runtime/accountbrowserhost"
)

// PublicErrorCode never exposes process stderr, executable paths or storage
// details. Only this closed vocabulary may cross the native/runtime boundary.
func PublicErrorCode(err error) string {
	if err == nil {
		return ""
	}
	switch {
	case errors.Is(err, ErrBusy):
		return "browser_surface_already_controlled"
	case errors.Is(err, ErrUnsupported):
		return "browser_host_platform_unavailable"
	case errors.Is(err, accountbrowserhost.ErrUnavailable):
		return "browser_browser_unavailable"
	case errors.Is(err, accountbrowserhost.ErrRecoveryRequired):
		return "browser_cleanup_required"
	case errors.Is(err, accountbrowserhost.ErrBusy):
		return "browser_surface_already_controlled"
	case errors.Is(err, accountbrowserhost.ErrUnsupported):
		return "browser_host_platform_unavailable"
	case errors.Is(err, accountbrowserhost.ErrUnsafePath):
		return "browser_storage_unsafe"
	}
	var native *surfaceError
	if errors.As(err, &native) {
		return native.code
	}
	return "browser_surface_unavailable"
}

type surfaceError struct{ code string }

func (e *surfaceError) Error() string  { return e.code }
func surfaceFailure(code string) error { return &surfaceError{code: code} }

func nativeError(code string) error {
	switch code {
	case "browser_frame_stale", "browser_capture_stopped", "browser_capture_unavailable",
		"browser_system_permission_required", "browser_screen_permission_required",
		"browser_identity_unavailable", "browser_input_permission_or_identity_lost",
		"browser_window_unavailable", "browser_window_resized_reconnect",
		"browser_multiple_windows_not_supported", "browser_event_unavailable",
		"browser_input_unavailable", "invalid_browser_pointer", "invalid_browser_scroll",
		"invalid_browser_text", "invalid_browser_url", "unsupported_browser_command",
		"unsupported_browser_key":
		return surfaceFailure(code)
	default:
		return surfaceFailure("browser_native_protocol_invalid")
	}
}
