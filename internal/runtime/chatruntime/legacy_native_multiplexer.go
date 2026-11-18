package chatruntime

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LegacyNativeRunOwner must exclude the old Node adopter and other Go hosts.
// Acquire must corroborate canonical lineage independently of the manifest. A
// process-local mutex is insufficient. Nil owner disables adoption before I/O.
type LegacyNativeRunOwner interface {
	Acquire(context.Context, LegacyNativeRunRef) (LegacyNativeRunLease, error)
}

// The lease pins a full run to a real tmux socket/pane/process generation. Its
// lifetime guarantees exclusive finalization/control. Exited must establish the
// original process generation exited; tmux failure or a missing socket is not proof.
// Methods must be safe for concurrent observer/control calls and promptly honor
// context cancellation. Binding must pin the log inode independently of its path.
// Close is bounded and releases only observer/ownership resources, never kills or deletes a run.
type LegacyNativeRunLease interface {
	Binding() LegacyNativeRunBinding
	Check(context.Context) error
	Exited(context.Context) (bool, error)
	Close() error
}

type LegacyNativeRunBinding struct {
	Identity         AdoptedNativeRunRequest
	SocketPath       string
	SocketIdentity   os.FileInfo
	LogIdentity      os.FileInfo
	SessionID        string
	PaneID           string
	PanePID          int
	PaneStartCommand string
}

type LegacyNativeRunState uint8

const (
	LegacyNativeRunUnknown LegacyNativeRunState = iota
	LegacyNativeRunAlive
	LegacyNativeRunExited
)

// LegacyNativeMultiplexer never creates or discovers runs. A backend must not
// fall back to a different persisted multiplexer or convert a probe error to exit.
type LegacyNativeMultiplexer interface {
	Backend() string
	Inspect(context.Context, LegacyNativeRunRef, LegacyNativeRunBinding) (LegacyNativeRunState, error)
	WriteInput(context.Context, LegacyNativeRunRef, LegacyNativeRunBinding, string, bool) error
	Abort(context.Context, LegacyNativeRunRef, LegacyNativeRunBinding) error
}

// LegacyNativeTmuxMultiplexer uses an explicit binary and socket namespace;
// neither environment discovery nor a shortened socket name establishes identity.
type LegacyNativeTmuxMultiplexer struct {
	Binary          string
	SocketDirectory string
}

func (*LegacyNativeTmuxMultiplexer) Backend() string { return "tmux" }

var legacyTmuxObjectIDPattern = regexpLegacyTmuxID()

func regexpLegacyTmuxID() func(string, byte) bool {
	return func(s string, prefix byte) bool {
		if len(s) < 2 || s[0] != prefix {
			return false
		}
		for i := 1; i < len(s); i++ {
			if s[i] < '0' || s[i] > '9' {
				return false
			}
		}
		return true
	}
}

func (t *LegacyNativeTmuxMultiplexer) validate(ref LegacyNativeRunRef, binding LegacyNativeRunBinding) error {
	if runtime.GOOS == "windows" || ref.Multiplexer != "tmux" || ref.TmuxSession != "run" ||
		!filepath.IsAbs(t.Binary) || !filepath.IsAbs(t.SocketDirectory) || filepath.Clean(t.SocketDirectory) != t.SocketDirectory ||
		binding.Identity != ref.Identity || binding.SocketPath != filepath.Join(t.SocketDirectory, ref.Socket) ||
		binding.SocketIdentity == nil || binding.SocketIdentity.Mode()&os.ModeSocket == 0 || binding.PanePID <= 0 ||
		!legacyTmuxObjectIDPattern(binding.SessionID, '$') || !legacyTmuxObjectIDPattern(binding.PaneID, '%') ||
		binding.PaneStartCommand == "" || len(binding.PaneStartCommand) > 32<<10 || strings.ContainsAny(binding.PaneStartCommand, "\x00\r\n\t") {
		return fmt.Errorf("legacy_native_tmux_binding_unavailable")
	}
	return nil
}

// Bound command output too: pane_start_command is sensitive and is never included
// in errors, diagnostics, events or evidence. Args use exec argv, never a shell.
type legacyNativeCommandBuffer struct {
	mu       sync.Mutex
	data     bytes.Buffer
	overflow bool
}

func (b *legacyNativeCommandBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	const limit = 64 << 10
	if len(p) > limit-b.data.Len() {
		b.overflow = true
		return len(p), nil
	}
	return b.data.Write(p)
}
func (t *LegacyNativeTmuxMultiplexer) command(ctx context.Context, binding LegacyNativeRunBinding, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	argv := append([]string{"-S", binding.SocketPath}, args...)
	command := exec.CommandContext(ctx, t.Binary, argv...)
	command.WaitDelay = 200 * time.Millisecond
	out := &legacyNativeCommandBuffer{}
	command.Stdout = out
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("legacy_native_tmux_command_unknown")
	}
	if out.overflow {
		return nil, fmt.Errorf("legacy_native_tmux_output_limit")
	}
	return out.data.Bytes(), nil
}

func (t *LegacyNativeTmuxMultiplexer) Inspect(ctx context.Context, ref LegacyNativeRunRef, binding LegacyNativeRunBinding) (LegacyNativeRunState, error) {
	if err := t.validate(ref, binding); err != nil {
		return LegacyNativeRunUnknown, err
	}
	before, err := os.Lstat(binding.SocketPath)
	if err != nil || before.Mode()&os.ModeSocket == 0 || !os.SameFile(before, binding.SocketIdentity) {
		return LegacyNativeRunUnknown, fmt.Errorf("legacy_native_tmux_socket_unknown")
	}
	// Exactly one pane in exactly one session: no ambiguous socket-prefix adoption.
	const format = "#{socket_path}\t#{session_name}\t#{session_id}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_start_command}\t#{pane_current_path}"
	data, err := t.command(ctx, binding, "list-panes", "-a", "-F", format)
	if err != nil {
		return LegacyNativeRunUnknown, err
	}
	after, err := os.Lstat(binding.SocketPath)
	if err != nil || !os.SameFile(before, after) {
		return LegacyNativeRunUnknown, fmt.Errorf("legacy_native_tmux_socket_replaced")
	}
	row := strings.TrimSuffix(string(data), "\n")
	fields := strings.Split(row, "\t")
	if strings.ContainsAny(row, "\r\n") || len(fields) != 8 {
		return LegacyNativeRunUnknown, fmt.Errorf("legacy_native_tmux_identity_unknown")
	}
	pid, err := strconv.Atoi(fields[4])
	if err != nil || fields[0] != binding.SocketPath || fields[1] != ref.TmuxSession || fields[2] != binding.SessionID ||
		fields[3] != binding.PaneID || pid != binding.PanePID || fields[6] != binding.PaneStartCommand || fields[7] != ref.Identity.ProjectPath {
		return LegacyNativeRunUnknown, fmt.Errorf("legacy_native_tmux_identity_mismatch")
	}
	if fields[5] == "1" {
		return LegacyNativeRunExited, nil
	}
	if fields[5] != "0" {
		return LegacyNativeRunUnknown, fmt.Errorf("legacy_native_tmux_exit_unknown")
	}
	return LegacyNativeRunAlive, nil
}

func (t *LegacyNativeTmuxMultiplexer) WriteInput(ctx context.Context, ref LegacyNativeRunRef, binding LegacyNativeRunBinding, input string, newline bool) error {
	if len(input) > 64<<10 || strings.ContainsRune(input, 0) {
		return fmt.Errorf("legacy_native_input_invalid")
	}
	state, err := t.Inspect(ctx, ref, binding)
	if err != nil {
		return err
	}
	if state != LegacyNativeRunAlive {
		return fmt.Errorf("legacy_native_run_not_alive")
	}
	if input != "" {
		if _, err := t.command(ctx, binding, "send-keys", "-t", binding.PaneID, "-l", "--", input); err != nil {
			return err
		}
	}
	if newline {
		_, err = t.command(ctx, binding, "send-keys", "-t", binding.PaneID, "Enter")
	}
	return err
}
func (t *LegacyNativeTmuxMultiplexer) Abort(ctx context.Context, ref LegacyNativeRunRef, binding LegacyNativeRunBinding) error {
	state, err := t.Inspect(ctx, ref, binding)
	if err != nil {
		return err
	}
	if state != LegacyNativeRunAlive {
		return fmt.Errorf("legacy_native_run_not_alive")
	}
	// Pin the sole inspected session; never kill a whole server or unlink a socket.
	_, err = t.command(ctx, binding, "kill-session", "-t", binding.SessionID)
	return err
}
