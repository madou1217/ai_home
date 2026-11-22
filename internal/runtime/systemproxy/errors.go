package systemproxy

import "errors"

// Stable error codes. Every error returned by this package wraps one of these
// sentinels, so callers can branch with errors.Is and log the code without
// depending on message wording.
var (
	// ErrUnsupportedPlatform means the package has no backend for runtime.GOOS.
	ErrUnsupportedPlatform = errors.New("systemproxy_platform_unsupported")

	// ErrUnsupportedScope means the platform exists but the required settings
	// surface is unavailable (for example gsettings is not installed).
	ErrUnsupportedScope = errors.New("systemproxy_scope_unsupported")

	// ErrServiceRequired means Apply was called on a platform that requires an
	// explicit network service and options.Service was empty.
	ErrServiceRequired = errors.New("systemproxy_service_required")

	// ErrServiceNotFound means the requested network service does not exist.
	ErrServiceNotFound = errors.New("systemproxy_service_not_found")

	// ErrInvalidHost means the proxy host is empty or malformed.
	ErrInvalidHost = errors.New("systemproxy_invalid_host")

	// ErrInvalidPort means the proxy port is outside 1-65535.
	ErrInvalidPort = errors.New("systemproxy_invalid_port")

	// ErrInvalidCredentials means only one half of a username/password pair was
	// supplied, or credentials were supplied for a platform that cannot store
	// them.
	ErrInvalidCredentials = errors.New("systemproxy_invalid_credentials")

	// ErrRemoteHostNotAllowed means the proxy host is not loopback and
	// ApplyOptions.AllowRemoteHost was false.
	ErrRemoteHostNotAllowed = errors.New("systemproxy_remote_host_not_allowed")

	// ErrAuthUnsupported means the platform cannot represent proxy credentials.
	ErrAuthUnsupported = errors.New("systemproxy_auth_unsupported")

	// ErrAuthNotRestorable means a snapshot used authentication, whose password
	// was intentionally not captured, so a faithful restore is impossible.
	ErrAuthNotRestorable = errors.New("systemproxy_auth_not_restorable")

	// ErrSnapshotPlatformMismatch means the snapshot was captured on a
	// different operating system than the current one.
	ErrSnapshotPlatformMismatch = errors.New("systemproxy_snapshot_platform_mismatch")

	// ErrDetectFailed means the live system proxy state could not be read.
	ErrDetectFailed = errors.New("systemproxy_detect_failed")

	// ErrCommandFailed means a platform command failed while applying or
	// restoring settings. Command arguments are never included in the error.
	ErrCommandFailed = errors.New("systemproxy_command_failed")
)
