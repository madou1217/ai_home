package codexappserverws

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"time"
)

// FrameTransport is a bounded caller-facing message stream. Adapters own wire
// framing and configure their read limit; this core owns native RPC ordering,
// backpressure, cancellation and final native-frame draining.
type FrameTransport interface {
	Read(context.Context) ([]byte, error)
	Write(context.Context, []byte) error
	Close() error
}

// StdioBridgeSession retains the existing native process owner. Close must
// unblock the pipes and Wait rather than spawning an independent supervisor.
type StdioBridgeSession struct {
	Stdin  io.WriteCloser
	Stdout io.Reader
	Stderr io.Reader
	Wait   func() error
	Close  func() error
}

type FrameBridgeOptions struct {
	Rewrite       RewriteOptions
	MaxFrameBytes int
	LogDebug      func(string)
	LogError      func(error)
	// StdioHalfClose is opt-in: the WebSocket lifecycle remains unchanged.
	// StdinEOFTimeout bounds normal caller EOF until the single native Wait
	// completes. This private stdio contract requires exactly 15 seconds.
	// Native stdout then has its separate two-second drain window.
	StdioHalfClose  bool
	StdinEOFTimeout time.Duration
}

// ValidateStdioBridgePreflight is pure: a future stdio caller must call it
// before starting native, with its prepared owner's actual Wait and Close
// callbacks. Close must synchronously unblock pipes and Wait on success.
// Non-nil callbacks alone do not prove reclamation; that owner contract still
// needs caller integration and real acceptance. No public stdio caller is
// enabled here, and a failed preflight must not be followed by native start.
func ValidateStdioBridgePreflight(options FrameBridgeOptions, wait func() error, closeOwner func() error) error {
	if !options.StdioHalfClose || options.StdinEOFTimeout != 15*time.Second || options.MaxFrameBytes > maxStdioFrameBytes || wait == nil || closeOwner == nil {
		return errStdioHalfCloseOptions
	}
	return nil
}

// An already-started invalid session is not a substitute for preflight. Without
// a complete owner, or after Close fails, no bounded join can be promised. Do
// not enter Wait, detach a timeout goroutine, or claim native was reclaimed.
func rejectStdioBridge(frames FrameTransport, stdio *StdioBridgeSession, log func(error)) {
	report := func(err error) {
		if log != nil && err != nil {
			log(err)
		}
	}
	report(errStdioHalfCloseOptions)
	if frames != nil {
		report(frames.Close())
	}
	if stdio == nil {
		report(errStdioNativeCleanupUnknown)
		return
	}
	if stdio.Close == nil || stdio.Wait == nil {
		if stdio.Close != nil {
			report(stdio.Close())
		} else if stdio.Stdin != nil {
			// Best effort only, not process-group reclamation evidence.
			report(stdio.Stdin.Close())
		}
		report(errStdioNativeCleanupUnknown)
		return
	}
	if err := stdio.Close(); err != nil {
		report(err)
		report(errStdioNativeCleanupUnknown)
		return
	}
	// Only a complete owner whose Close succeeded may enter its sole join.
	report(stdio.Wait())
}

// BridgeStdio delegates native transport to a caller frame adapter without
// changing the compatibility transformations or process lifecycle contract.
func BridgeStdio(parent context.Context, frames FrameTransport, stdio *StdioBridgeSession, options FrameBridgeOptions) {
	limit := options.MaxFrameBytes
	if limit <= 0 {
		limit = 16 * 1024 * 1024
	}
	if options.StdioHalfClose {
		invalid := frames == nil || stdio == nil
		if !invalid {
			invalid = ValidateStdioBridgePreflight(options, stdio.Wait, stdio.Close) != nil || stdio.Stdin == nil || stdio.Stdout == nil
		}
		if invalid {
			rejectStdioBridge(frames, stdio, options.LogError)
			return
		}
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			_ = frames.Close()
			if stdio.Close != nil {
				_ = stdio.Close()
			}
		})
	}
	defer stop()
	stopParent := context.AfterFunc(parent, stop)
	defer stopParent()
	tracker := NewResumeTracker()
	defer tracker.Close()
	scopes := NewThreadListScopeTracker()
	defer scopes.Close()
	var workers sync.WaitGroup
	stdoutDone := make(chan struct{})
	nativeWaitDone := make(chan struct{})
	logError := func(err error) {
		if options.LogError != nil && err != nil && ctx.Err() == nil {
			options.LogError(err)
		}
	}
	workers.Add(1)
	go func() {
		defer workers.Done()
		defer close(stdoutDone)
		stdoutEOF := false
		defer func() {
			// In explicit stdio mode stdout EOF alone is not native exit. Do
			// not kill a child which closed stdout but is still finishing.
			if !options.StdioHalfClose || !stdoutEOF {
				stop()
			}
		}()
		if stdio.Stdout == nil {
			return
		}
		reader := bufio.NewReaderSize(stdio.Stdout, 64<<10)
		for {
			raw, err := readAppServerLine(reader, limit)
			line := bytes.TrimSuffix(bytes.TrimSuffix(raw, []byte("\n")), []byte("\r"))
			if len(line) > limit {
				logError(errAppServerLineTooLarge)
				return
			}
			if len(line) > 0 {
				patched := scopes.Patch(tracker.PatchResponse(line))
				writeCtx, stopWrite := context.WithTimeout(ctx, 15*time.Second)
				writeErr := frames.Write(writeCtx, patched)
				stopWrite()
				if writeErr != nil {
					return
				}
			}
			if err != nil {
				stdoutEOF = errors.Is(err, io.EOF)
				if !stdoutEOF {
					logError(err)
				}
				return
			}
		}
	}()
	if stdio.Stderr != nil {
		workers.Add(1)
		go func() { defer workers.Done(); drainAppServerStderr(stdio.Stderr, options.LogDebug) }()
	}
	if stdio.Wait != nil {
		workers.Add(1)
		go func() {
			defer workers.Done()
			waitErr := stdio.Wait()
			if options.StdioHalfClose {
				logError(waitErr)
			}
			// One Wait owner broadcasts completion to the EOF path; the latter
			// never calls Wait a second time or creates a new supervisor.
			close(nativeWaitDone)
			// Wait must not close stdout before its final frame is drained. Bound a
			// descendant holding the inherited pipe after the direct child exits.
			timer := time.NewTimer(2 * time.Second)
			defer timer.Stop()
			select {
			case <-stdoutDone:
				if options.StdioHalfClose {
					stop()
				}
			case <-ctx.Done():
			case <-timer.C:
				stop()
			}
		}()
	}
	for {
		raw, err := frames.Read(ctx)
		if err != nil {
			if options.StdioHalfClose && errors.Is(err, io.EOF) && ctx.Err() == nil {
				// EOF is a half-close, not cancellation. Deadline and I/O errors
				// do not take this branch and retain the ordinary stop/join path.
				if closeErr := stdio.Stdin.Close(); closeErr != nil {
					logError(closeErr)
					break
				}
				timer := time.NewTimer(options.StdinEOFTimeout)
				select {
				case <-nativeWaitDone:
					timer.Stop()
					// The sole Wait worker owns the independent post-exit
					// drain deadline, including a descendant holding stdout.
					select {
					case <-stdoutDone:
					case <-ctx.Done():
					}
				case <-timer.C:
					logError(errStdioEOFNativeExitTimeout)
				case <-ctx.Done():
				}
				timer.Stop()
			} else if options.StdioHalfClose {
				logError(err)
			}
			break
		}
		if err = scopes.TryRemember(raw, options.Rewrite); err != nil {
			logError(err)
			break
		}
		rewritten := RewriteClientMessage(raw, options.Rewrite)
		if _, err = tracker.TryRememberRequest(rewritten); err != nil {
			logError(err)
			break
		}
		if stdio.Stdin == nil {
			break
		}
		// os.Pipe supports a write deadline; other adapters still get a bounded
		// cancellation callback that closes their owner if they stop consuming.
		writeCtx, writeCancel := context.WithTimeout(ctx, 15*time.Second)
		stopOnDeadline := context.AfterFunc(writeCtx, stop)
		_, err = stdio.Stdin.Write(rewritten)
		if err == nil {
			_, err = stdio.Stdin.Write([]byte{'\n'})
		}
		stopOnDeadline()
		writeCancel()
		if err != nil {
			logError(err)
			break
		}
	}
	stop()
	workers.Wait()
}

var (
	errAppServerLineTooLarge     = errors.New("codex_app_server_line_too_large")
	errStdioHalfCloseOptions     = errors.New("codex_stdio_half_close_options_invalid")
	errStdioNativeCleanupUnknown = errors.New("codex_stdio_native_cleanup_unknown")
	errStdioEOFNativeExitTimeout = errors.New("codex_stdio_eof_native_exit_timeout")
)

// Borrow complete short lines from bufio; long frames grow once amortized and
// never exceed the configured wire ceiling. A final unterminated frame is data,
// not a reason to silently discard the last response when a process exits.
func readAppServerLine(reader *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(line)+len(fragment) > limit+1 {
			return nil, errAppServerLineTooLarge
		}
		if len(line) == 0 && err != bufio.ErrBufferFull {
			return fragment, err
		}
		line = append(line, fragment...)
		if err == bufio.ErrBufferFull {
			continue
		}
		return line, err
	}
}

func discardAppServerLine(reader *bufio.Reader) error {
	for {
		_, err := reader.ReadSlice('\n')
		if err != bufio.ErrBufferFull {
			return err
		}
	}
}

func drainAppServerStderr(reader io.Reader, log func(string)) {
	if log == nil {
		_, _ = io.Copy(io.Discard, reader)
		return
	}
	buffer := bufio.NewReaderSize(reader, 16<<10)
	for {
		line, err := readAppServerLine(buffer, 64<<10)
		if errors.Is(err, errAppServerLineTooLarge) {
			log("codex_app_server_stderr_line_truncated")
			if discardAppServerLine(buffer) != nil {
				return
			}
			continue
		}
		if len(line) > 0 {
			log(string(line))
		}
		if err != nil {
			return
		}
	}
}
