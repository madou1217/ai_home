package tuningress

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

// Runtime supervises one sing-box child process started by Start.
type Runtime struct {
	cmd             *exec.Cmd
	configDir       string
	done            chan struct{}
	waitErr         error
	shutdownTimeout time.Duration

	cleanupOnce sync.Once
	cleanupErr  error
	closeOnce   sync.Once
	closeErr    error
}

// Start launches sing-box with the generated TUN configuration. TUN mode is an
// explicit network-layer takeover: Start refuses to run unless
// Options.AllowStart is true, Options.SingBoxPath names an executable (it never
// discovers a binary), and the process already holds administrator/root
// privileges.
//
// Start uses context only for preflight cancellation. Once the child has
// started, its lifetime is owned by the returned Runtime; canceling the context
// does not stop the process, so callers should always call Close.
//
// Start does not run Check. Integrations should call Check first so a bad
// configuration is reported as *CheckError instead of an immediate child exit.
// Start also does not detect an external TUN owner such as Clash Verge; the
// integrating command is responsible for reporting that conflict.
func Start(ctx context.Context, options Options) (*Runtime, error) {
	if !options.AllowStart {
		return nil, ErrStartDisabled
	}
	if err := RequirePrivilege(); err != nil {
		return nil, err
	}
	normalized, err := options.settings()
	if err != nil {
		return nil, err
	}
	binary, err := resolveStartBinary(normalized.binaryPath)
	if err != nil {
		return nil, err
	}
	config, err := render(normalized)
	if err != nil {
		return nil, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	configDir, configPath, err := writeRuntimeConfig(config)
	if err != nil {
		return nil, err
	}
	command := exec.Command(binary, "run", "-c", configPath)
	// sing-box emits structured logs through its own LogFile setting. Child
	// standard streams are discarded so credentials from config errors cannot
	// be echoed to an unexpected destination.
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		_ = os.RemoveAll(configDir)
		return nil, fmt.Errorf("%w: %v", ErrStartFailed, err)
	}

	runtime := &Runtime{
		cmd:             command,
		configDir:       configDir,
		done:            make(chan struct{}),
		shutdownTimeout: normalized.shutdownTimeout,
	}
	go runtime.wait()
	return runtime, nil
}

func (r *Runtime) wait() {
	r.waitErr = r.cmd.Wait()
	close(r.done)
	_ = r.cleanup()
}

// PID returns the sing-box process ID, or zero when the Runtime is zero.
func (r *Runtime) PID() int {
	if r == nil || r.cmd == nil || r.cmd.Process == nil {
		return 0
	}
	return r.cmd.Process.Pid
}

// Done is closed once the sing-box process has exited and been reaped.
func (r *Runtime) Done() <-chan struct{} {
	if r == nil || r.done == nil {
		return nil
	}
	return r.done
}

// Running reports whether the child process has not exited yet.
func (r *Runtime) Running() bool {
	if r == nil || r.done == nil {
		return false
	}
	select {
	case <-r.done:
		return false
	default:
		return true
	}
}

// Wait blocks until the child exits and returns its process wait error. A
// process stopped through Close commonly returns an *exec.ExitError.
func (r *Runtime) Wait() error {
	if r == nil || r.done == nil {
		return ErrNotStarted
	}
	<-r.done
	return r.waitErr
}

// Close stops the child process with a bounded grace period, then removes the
// temporary configuration. It is idempotent and safe after the process exited
// on its own. A child that needed SIGKILL returns ErrShutdownTimeout.
func (r *Runtime) Close() error {
	if r == nil {
		return nil
	}
	r.closeOnce.Do(func() {
		r.closeErr = r.shutdown()
	})
	return r.closeErr
}

func (r *Runtime) shutdown() error {
	if r.cmd == nil || r.cmd.Process == nil {
		return r.cleanup()
	}
	select {
	case <-r.done:
		return r.cleanup()
	default:
	}

	if err := r.cmd.Process.Signal(os.Interrupt); err != nil {
		// SIGINT is not supported on Windows and the process may also have
		// exited between the select above and this signal. Kill is the safe
		// bounded fallback; a process that already exited returns
		// os.ErrProcessDone and is handled by the wait below.
		if killErr := r.cmd.Process.Kill(); killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
			// Keep waiting for the bounded window below; the process may still
			// exit on its own.
		}
	}

	timeout := r.shutdownTimeout
	if timeout <= 0 {
		timeout = DefaultShutdownTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-r.done:
		return r.cleanup()
	case <-timer.C:
		_ = r.cmd.Process.Kill()
		<-r.done
		cleanupErr := r.cleanup()
		if cleanupErr != nil {
			return fmt.Errorf("%w: %v", ErrShutdownTimeout, cleanupErr)
		}
		return ErrShutdownTimeout
	}
}

func (r *Runtime) cleanup() error {
	r.cleanupOnce.Do(func() {
		if r.configDir != "" {
			r.cleanupErr = os.RemoveAll(r.configDir)
		}
	})
	return r.cleanupErr
}
