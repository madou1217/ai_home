package tuningress

// Privileged reports whether the current process appears to hold the
// administrator/root privilege required to create a TUN interface. It is a
// preflight signal, not a guarantee: platform policy can still reject TUN
// creation. Unsupported platforms report false.
func Privileged() bool {
	return platformSupported() && processElevated()
}

// RequirePrivilege returns ErrUnsupportedPlatform outside macOS, Linux, and
// Windows, and ErrPrivilegeRequired when the process is not running with
// administrator/root privileges. It never attempts elevation.
func RequirePrivilege() error {
	if !platformSupported() {
		return ErrUnsupportedPlatform
	}
	if !processElevated() {
		return ErrPrivilegeRequired
	}
	return nil
}
