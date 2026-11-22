// Package systemproxy captures, applies, and restores host-level HTTP/HTTPS
// proxy settings for the operating systems AI Home runs on.
//
// # Scope
//
// The package owns exactly three operations:
//
//   - Capture reads the current HTTP and HTTPS proxy configuration without
//     changing anything. A snapshot records the enabled state, host, port,
//     whether authentication is required, and the network service identity.
//     Passwords are never captured, logged, or serialized.
//   - Apply points one explicitly named network service at an HTTP proxy.
//     Callers must opt in before a non-loopback host is accepted. Dry-run mode
//     computes the platform commands and never executes them.
//   - Restore replays a snapshot idempotently. Only differences between the
//     live state and the snapshot produce commands; a second restore is a
//     no-op.
//
// # Platform support
//
//	macOS    Full implementation through networksetup: service discovery,
//	         web and secure web proxy get/set, proxy state, bypass domains.
//	         Apply requires an explicit network service name; the package
//	         never guesses one.
//	Windows  Best-effort detection and apply through the current user's
//	         WinINET registry settings (HKCU\Software\Microsoft\Windows\
//	         CurrentVersion\Internet Settings). No administrator rights are
//	         required or requested. Credentials are not representable in the
//	         registry, so apply with credentials returns ErrAuthUnsupported.
//	Linux    Best-effort detection and apply through GNOME gsettings
//	         (org.gnome.system.proxy). Configures the current user's dconf,
//	         so no administrator rights are required. Only GNOME-compatible
//	         desktops are covered; when gsettings is unavailable the package
//	         returns ErrUnsupportedScope instead of pretending success.
//	other    Capture, Apply, Restore, and ListServices return
//	         ErrUnsupportedPlatform.
//
// # Safety guarantees
//
//   - Dry-run never executes a command; it only returns the planned actions.
//   - Apply and Restore read the live state before planning, so a no-op run
//     does not rewrite host settings.
//   - Remote proxy hosts require ApplyOptions.AllowRemoteHost. Loopback hosts
//     (localhost, 127.0.0.0/8, ::1) are always accepted.
//   - Credentials never appear in snapshots, Result values, or errors.
//     Command lines returned in Result.Actions redact passwords.
//   - Restoring a snapshot whose configuration used proxy authentication
//     fails with ErrAuthNotRestorable before any mutation, because passwords
//     are intentionally not captured.
//   - Commands are executed directly (no shell), with a per-command timeout.
//   - A mid-plan command failure returns ErrCommandFailed; the host may then be
//     partially configured, and the returned Result lists the attempted
//     actions so callers can restore the preceding snapshot.
//
// # Error codes
//
// Every failure wraps a sentinel error with a stable systemproxy_* code; see
// errors.go. Callers should branch with errors.Is rather than matching
// message text. Platform commands that fail are wrapped as ErrCommandFailed
// with the operation and service name, without command arguments.
package systemproxy
