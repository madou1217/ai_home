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
}

// BridgeStdio delegates native transport to a caller frame adapter without
// changing the compatibility transformations or process lifecycle contract.
func BridgeStdio(parent context.Context, frames FrameTransport, stdio *StdioBridgeSession, options FrameBridgeOptions) {
	limit := options.MaxFrameBytes
	if limit <= 0 {
		limit = 16 * 1024 * 1024
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
	logError := func(err error) {
		if options.LogError != nil && err != nil && ctx.Err() == nil {
			options.LogError(err)
		}
	}
	workers.Add(1)
	go func() {
		defer workers.Done()
		defer close(stdoutDone)
		defer stop()
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
				if !errors.Is(err, io.EOF) {
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
			_ = stdio.Wait()
			// Wait must not close stdout before its final frame is drained. Bound a
			// descendant holding the inherited pipe after the direct child exits.
			timer := time.NewTimer(2 * time.Second)
			defer timer.Stop()
			select {
			case <-stdoutDone:
			case <-ctx.Done():
			case <-timer.C:
				stop()
			}
		}()
	}
	for {
		raw, err := frames.Read(ctx)
		if err != nil {
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

var errAppServerLineTooLarge = errors.New("codex_app_server_line_too_large")

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
