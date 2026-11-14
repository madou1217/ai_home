// Package nativeterminal owns the native AIH terminal lifecycle outside the Server.
// The pane runs the Go CLI itself; credentials remain in the existing provider runtime.
package nativeterminal

import (
	"context"
	"errors"
	"io"
	"regexp"
)

const Command = "__native-terminal"
const Owner = "go-native-terminal-v1"

var ErrInvalid = errors.New("native_terminal_invalid")
var safePart = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
var accountRefPattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)

// Runtime is the thin cmd/aih adapter, not a second provider launch implementation.
type Runtime struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	RunCLI func(context.Context, []string) error
}

// Spec contains addressing metadata only. Environment is handed to the inner process
// through a private, one-shot launch envelope, never the persistent registry or argv.
type Spec struct {
	Provider         string   `json:"provider"`
	IdentityProvider string   `json:"identityProvider"`
	AccountRef       string   `json:"accountRef"`
	CLIAccountID     int64    `json:"cliAccountId"`
	CWD              string   `json:"cwd"`
	Label            string   `json:"label,omitempty"`
	Model            string   `json:"model,omitempty"`
	Args             []string `json:"args"`
}

type Entry struct {
	// Set only by a matching private sidecar read, never accepted from JSON.
	trustedOwner bool
	Spec
	Owner             string   `json:"nativeTerminalOwner"`
	RuntimeScope      string   `json:"runtimeScope"`
	Socket            string   `json:"socket"`
	Session           string   `json:"session"`
	ForwardArgs       []string `json:"forwardArgs"`
	CorrelationID     string   `json:"correlationId"`
	NativeSessionID   string   `json:"nativeSessionId,omitempty"`
	SupervisorManaged bool     `json:"supervisorManaged"`
	CreatedAt         int64    `json:"createdAt"`
	UpdatedAt         int64    `json:"updatedAt"`
	SupervisorPID     int      `json:"supervisorPid,omitempty"`
	CloseRequested    bool     `json:"closeRequested,omitempty"`
	CleanupError      string   `json:"cleanupError,omitempty"`
	Unrecoverable     string   `json:"unrecoverable,omitempty"`
	Mux               string   `json:"nativeTerminalMux,omitempty"`
	MuxSignature      string   `json:"nativeTerminalMuxSignature,omitempty"`
}

type launchEnvelope struct {
	Entry Entry    `json:"entry"`
	Env   []string `json:"env"`
}

type CloseResult struct {
	Matched int
	PIDs    []int
}
