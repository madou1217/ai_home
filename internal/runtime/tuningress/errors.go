package tuningress

import (
	"errors"
	"fmt"
	"strings"
)

var (
	// ErrInvalidOptions reports that Options failed validation. Option errors
	// also wrap a more specific sentinel such as ErrNonLoopbackUpstream.
	ErrInvalidOptions = errors.New("tuningress: invalid options")

	// ErrNonLoopbackUpstream reports that the HTTP ingress is not on the local
	// machine. TUN mode is only for a loopback ingress; a remote proxy must not
	// be able to receive operating-system traffic by accident.
	ErrNonLoopbackUpstream = errors.New("upstream proxy host must be a loopback address")

	// ErrInvalidCredentials reports an incomplete or malformed credential pair.
	ErrInvalidCredentials = errors.New("upstream credentials must be either empty or a complete username/password pair without control characters")

	// ErrUnsupportedStack reports a sing-box TUN stack other than system,
	// gvisor, or mixed.
	ErrUnsupportedStack = errors.New("unsupported TUN stack")

	// ErrInvalidAddress reports a malformed or unusable TUN interface address.
	ErrInvalidAddress = errors.New("invalid TUN address")

	// ErrInvalidMTU reports an out-of-range TUN MTU.
	ErrInvalidMTU = errors.New("invalid TUN MTU")

	// ErrInvalidInterface reports a malformed TUN interface name.
	ErrInvalidInterface = errors.New("invalid TUN interface name")

	// ErrInvalidLogFile reports a log file path that cannot be embedded safely
	// in the generated configuration.
	ErrInvalidLogFile = errors.New("invalid log file path")

	// ErrInvalidDNSServer reports a direct DNS server that is not a usable IP
	// address.
	ErrInvalidDNSServer = errors.New("invalid direct DNS server address")

	// ErrBinaryNotFound reports that no sing-box executable could be located.
	// Start wraps this error when Options.SingBoxPath is missing because Start
	// never discovers or guesses a binary.
	ErrBinaryNotFound = errors.New("tuningress: sing-box binary not found")

	// ErrConfigFile reports that the temporary configuration file could not be
	// prepared securely.
	ErrConfigFile = errors.New("tuningress: failed to prepare temporary sing-box config")

	// ErrCheckFailed reports that `sing-box check` could not run or rejected
	// the generated configuration. A rejected configuration returns *CheckError,
	// which unwraps to this sentinel.
	ErrCheckFailed = errors.New("tuningress: sing-box configuration check failed")

	// ErrStartFailed reports that the sing-box child process could not start.
	ErrStartFailed = errors.New("tuningress: failed to launch sing-box")

	// ErrStartDisabled reports that Start was called without the explicit
	// takeover consent carried by Options.AllowStart.
	ErrStartDisabled = errors.New("tuningress: TUN start is disabled; set Options.AllowStart to true")

	// ErrPrivilegeRequired reports that the current process cannot create a TUN
	// interface without administrator/root privileges. The package never
	// attempts silent elevation.
	ErrPrivilegeRequired = errors.New("tuningress: TUN ingress requires administrator/root privileges; re-run the parent process elevated")

	// ErrUnsupportedPlatform reports a platform on which this package does not
	// manage TUN startup. Binary discovery and Render/Check still work.
	ErrUnsupportedPlatform = errors.New("tuningress: TUN ingress is supported on macOS, Linux, and Windows only")

	// ErrShutdownTimeout reports that sing-box did not exit within the bounded
	// shutdown window and had to be killed.
	ErrShutdownTimeout = errors.New("tuningress: sing-box did not exit within the shutdown timeout")

	// ErrNotStarted reports use of a nil or zero Runtime.
	ErrNotStarted = errors.New("tuningress: runtime was not started")
)

// CheckError describes a configuration rejected by `sing-box check`.
// Output is bounded and redacted before it is stored.
type CheckError struct {
	ExitCode int
	Output   string
}

func (e *CheckError) Error() string {
	if e == nil {
		return ErrCheckFailed.Error()
	}
	if output := strings.TrimSpace(e.Output); output != "" {
		return fmt.Sprintf("%s (exit code %d): %s", ErrCheckFailed.Error(), e.ExitCode, output)
	}
	return fmt.Sprintf("%s (exit code %d)", ErrCheckFailed.Error(), e.ExitCode)
}

// Unwrap allows errors.Is(err, ErrCheckFailed) to match.
func (e *CheckError) Unwrap() error { return ErrCheckFailed }
