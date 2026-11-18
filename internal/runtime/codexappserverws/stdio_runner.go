package codexappserverws

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"time"
)

// StdioRunResult distinguishes observed direct-child reaping from unverified
// process-group reclamation. Platform group termination currently returns no
// outcome. Neither this result nor a nil error claims the whole group is gone.
type StdioRunResult struct {
	NativeStarted               bool
	NativeReaped                bool
	ProcessGroupCleanupVerified bool
}

var errStdioCallerEndpoints = errors.New("codex_stdio_caller_endpoints_invalid")
var errStdioRunErrorsTruncated = errors.New("codex_stdio_run_errors_truncated")

// A bridge reports errors from several workers. Keep the result synchronized
// and finite without changing the existing optional logging callback.
type stdioRunErrors struct {
	mu        sync.Mutex
	errors    []error
	truncated bool
}

func (collected *stdioRunErrors) add(err error) {
	if err == nil {
		return
	}
	collected.mu.Lock()
	defer collected.mu.Unlock()
	if len(collected.errors) == 8 {
		collected.truncated = true
		return
	}
	collected.errors = append(collected.errors, err)
}

func (collected *stdioRunErrors) result() error {
	collected.mu.Lock()
	defer collected.mu.Unlock()
	result := errors.Join(collected.errors...)
	if collected.truncated {
		result = errors.Join(result, errStdioRunErrorsTruncated)
	}
	return result
}

// Observe the actual synchronous write boundaries, including errors that the
// bridge's cancellation-aware logger may suppress. Delegation preserves the
// existing framing, backpressure and endpoint ownership.
type stdioRunObservedFrames struct {
	FrameTransport
	collected *stdioRunErrors
}

func (frames stdioRunObservedFrames) Write(ctx context.Context, raw []byte) error {
	err := frames.FrameTransport.Write(ctx, raw)
	frames.collected.add(err)
	return err
}

type stdioRunObservedStdin struct {
	io.WriteCloser
	collected *stdioRunErrors
}

func (stdin stdioRunObservedStdin) Write(raw []byte) (int, error) {
	n, err := stdin.WriteCloser.Write(raw)
	if n < len(raw) && err == nil {
		err = io.ErrShortWrite
	}
	stdin.collected.add(err)
	return n, err
}

// RunStdioSession is an internal prepared caller, not a CLI policy or public
// enabled hook. Callers retain account/env/catalog/lease/admission and business
// ownership. No executable selection, policy fallback or second supervisor is
// added here. The existing WebSocket launcher uses the very same prepared owner.
//
// Endpoints must be caller-owned, distinct pipe/socket *os.File values whose
// actual deadline operations work. Regular files, TTYs and unsupported endpoints
// fail before native starts. On successful transport construction it owns their
// Close, including preflight/start failures; a rejected constructor borrows them.
// Normal stdin EOF has the bridge's explicit 15s native-exit window plus separate
// 2s stdout drain. Real native Done is always required for join: OS reaper/group
// failure is not advertised as bounded total completion, nor hidden by a detached
// timeout goroutine or a fake successful Wait.
func RunStdioSession(parent context.Context, input, output *os.File, processOptions StartProcessOptions, options FrameBridgeOptions) (result StdioRunResult, resultErr error) {
	if parent == nil || input == nil || output == nil || input == output {
		return result, errStdioCallerEndpoints
	}
	if err := parent.Err(); err != nil {
		return result, err
	}
	if !options.StdioHalfClose || options.StdinEOFTimeout != 15*time.Second || options.MaxFrameBytes > maxStdioFrameBytes {
		return result, errStdioHalfCloseOptions
	}
	for _, file := range []*os.File{input, output} {
		info, err := file.Stat()
		if err != nil || info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
			return result, errStdioCallerEndpoints
		}
	}
	frames, err := NewStdioFrameTransport(input, output, options.MaxFrameBytes)
	if err != nil {
		return result, err
	}
	var collected stdioRunErrors
	defer func() {
		collected.add(frames.Close())
		resultErr = errors.Join(resultErr, collected.result())
	}()
	prepared, err := prepareAppServerProcess(processOptions)
	if err != nil {
		return result, err
	}
	defer func() {
		collected.add(prepared.closeChecked())
		if result.NativeStarted {
			select {
			case <-prepared.process.Done():
				result.NativeReaped = true
				collected.add(prepared.process.WaitErr())
			default:
				collected.add(errStdioNativeCleanupUnknown)
			}
		}
	}()
	// These are the real not-yet-started owner's methods, not placeholders.
	if err := prepared.ready(); err != nil {
		return result, err
	}
	if err := ValidateStdioBridgePreflight(options, prepared.wait, prepared.closeChecked); err != nil {
		return result, err
	}
	if err := parent.Err(); err != nil {
		return result, err
	}
	proc, err := prepared.start()
	if err != nil {
		return result, err
	}
	result.NativeStarted = true
	logError := options.LogError
	options.LogError = func(err error) {
		collected.add(err)
		if logError != nil {
			logError(err)
		}
	}
	// Close errors must be visible even when cancellation suppresses Bridge's
	// ordinary error logging. Only this owner can close or reap this process.
	closeOwner := func() error {
		err := prepared.closeChecked()
		if err != nil {
			options.LogError(err)
		}
		return err
	}
	BridgeStdio(parent, stdioRunObservedFrames{FrameTransport: frames, collected: &collected}, &StdioBridgeSession{
		Stdin:  stdioRunObservedStdin{WriteCloser: proc.Stdin(), collected: &collected},
		Stdout: proc.Stdout(), Stderr: proc.Stderr(),
		Wait: prepared.wait, Close: closeOwner,
	}, options)
	// Bridge joins its sole Wait worker and all I/O workers before returning.
	collected.add(parent.Err())
	return result, nil
}
