package accountbrowserhost

import "errors"

var (
	ErrUnsupported      = errors.New("stable browser host is unsupported on this platform")
	ErrUnavailable      = errors.New("signed stable browser is unavailable")
	ErrUnsafePath       = errors.New("browser host path is unsafe")
	ErrBusy             = errors.New("browser host directory is already owned")
	ErrRecoveryRequired = errors.New("browser host has an unclean lifecycle; explicit recovery is required")
	ErrHostExited       = errors.New("browser host exited unexpectedly")
)

// Options selects a pre-existing, private, dedicated task directory. This is
// not an account profile directory or the user's everyday browser data.
type Options struct {
	SessionDir string
}

// BrowserIdentity describes the verified installed application, not a page,
// account or login state. Filesystem paths remain internal to the runtime.
type BrowserIdentity struct {
	Vendor  string `json:"vendor"`
	Channel string `json:"channel"`
	Version string `json:"version"`
}

// Status reports process lifecycle only. Running never implies that a view,
// input bridge, isolated account or restored website login is available.
type Status struct {
	State   string          `json:"state"`
	PID     int             `json:"pid,omitempty"`
	Browser BrowserIdentity `json:"browser"`
}

type installation struct {
	identity   BrowserIdentity
	executable string
}
