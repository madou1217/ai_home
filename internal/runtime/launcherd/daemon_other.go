//go:build !linux

package launcherd

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"runtime"

	"github.com/madou1217/ai_home/application/launcher"
)

// HasDesktopSession always returns false on non-Linux platforms (launcherd is Linux-only).
func HasDesktopSession() bool {
	return false
}

// DesktopAvailable reports whether the current host is a desktop platform eligible
// for AIH Launch assembly (true on macOS/Windows, false on other non-Linux OSes).
func DesktopAvailable() bool {
	return runtime.GOOS == "darwin" || runtime.GOOS == "windows"
}

// WithShutdownSignals wraps ctx to cancel on os.Interrupt.
func WithShutdownSignals(ctx context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(ctx, os.Interrupt)
}

// StartDetached is only supported on Linux.
func StartDetached(_ context.Context, _ string, _ string, _ string) (int, string, error) {
	return 0, "", fmt.Errorf("%w: launcherd daemon mode is only supported on Linux", launcher.ErrUnsupported)
}

// Build is only supported on Linux.
func Build(_ context.Context, _ string) (string, error) {
	return "", fmt.Errorf("%w: launcherd GTK UI is only supported on Linux", launcher.ErrUnsupported)
}

// Daemon is a no-op stub on non-Linux platforms.
type Daemon struct {
	socketPath string
}

// New constructs a non-Linux stub daemon.
func New(opts Options) (*Daemon, error) {
	return &Daemon{socketPath: opts.SocketPath}, nil
}

// SocketPath returns the configured control socket path.
func (d *Daemon) SocketPath() string {
	if d == nil {
		return DefaultSocketPath()
	}
	return d.socketPath
}

// Start is a no-op on non-Linux platforms.
func (d *Daemon) Start(_ context.Context) error {
	return nil
}

// Run returns ErrUnsupported on non-Linux platforms.
func (d *Daemon) Run(_ context.Context) error {
	return fmt.Errorf("%w: launcherd is only supported on Linux", launcher.ErrUnsupported)
}

// Show returns ErrUnsupported on non-Linux platforms.
func (d *Daemon) Show(_ context.Context) error {
	return fmt.Errorf("%w: launcherd is only supported on Linux", launcher.ErrUnsupported)
}

// Toggle returns ErrUnsupported on non-Linux platforms.
func (d *Daemon) Toggle(_ context.Context) error {
	return fmt.Errorf("%w: launcherd is only supported on Linux", launcher.ErrUnsupported)
}

// Hide returns ErrUnsupported on non-Linux platforms.
func (d *Daemon) Hide(_ context.Context) error {
	return fmt.Errorf("%w: launcherd is only supported on Linux", launcher.ErrUnsupported)
}

// Status reports Supported=false on non-Linux platforms.
func (d *Daemon) Status() Status {
	return Status{Supported: false}
}

// Close is a no-op on non-Linux platforms.
func (d *Daemon) Close() error {
	return nil
}
