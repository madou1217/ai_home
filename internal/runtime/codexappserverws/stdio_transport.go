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

const maxStdioFrameBytes = 16 * 1024 * 1024

// DeadlineReadCloser and DeadlineWriteCloser admit only I/O whose deadlines and
// Close unblock pending operations. Regular files without deadlines, arbitrary
// io.Reader/io.Writer values and goroutine-per-read timeout wrappers are not a
// bounded transport and are deliberately not accepted.
type DeadlineReadCloser interface {
	io.ReadCloser
	SetReadDeadline(time.Time) error
}

type DeadlineWriteCloser interface {
	io.WriteCloser
	SetWriteDeadline(time.Time) error
}

// StdioFrameTransport frames caller stdio only; it does not own a process,
// spawn a helper, select hook policy or change the native rewrite pipeline.
// Read and Write each have one synchronous owner. Close can interrupt both.
type StdioFrameTransport struct {
	input     DeadlineReadCloser
	output    DeadlineWriteCloser
	reader    *bufio.Reader
	limit     int
	readMu    sync.Mutex
	writeMu   sync.Mutex
	readEOF   bool
	closed    chan struct{}
	closeOnce sync.Once
	closeErr  error
}

// NewStdioFrameTransport borrows already-owned endpoints. A rejected
// constructor does not close them. A successful transport owns their Close.
// The default payload ceiling is 16 MiB, never enlarged by caller options.
// As in readAppServerLine, at most limit+1 wire bytes are accepted: LF uses
// that extra byte, while CR in a CRLF terminator still consumes the budget.
// Thus CRLF cannot carry limit bytes of payload plus two free terminators.
func NewStdioFrameTransport(input DeadlineReadCloser, output DeadlineWriteCloser, limit int) (*StdioFrameTransport, error) {
	if input == nil || output == nil || limit > maxStdioFrameBytes {
		return nil, errors.New("codex_stdio_transport_options_invalid")
	}
	if limit <= 0 {
		limit = maxStdioFrameBytes
	}
	if err := input.SetReadDeadline(time.Time{}); err != nil {
		return nil, errors.New("codex_stdio_input_deadline_unavailable")
	}
	if err := output.SetWriteDeadline(time.Time{}); err != nil {
		return nil, errors.New("codex_stdio_output_deadline_unavailable")
	}
	return &StdioFrameTransport{
		input: input, output: output, reader: bufio.NewReaderSize(input, 64<<10),
		limit: limit, closed: make(chan struct{}),
	}, nil
}

// armStdioDeadline does not launch an I/O goroutine. Its small cancellation
// callback expires the endpoint deadline; disarm joins that callback before
// clearing the deadline so it cannot poison the next synchronous operation.
func armStdioDeadline(ctx context.Context, set func(time.Time) error) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	deadline, _ := ctx.Deadline()
	if err := set(deadline); err != nil {
		return nil, err
	}
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		_ = set(time.Now())
		close(done)
	})
	return func() {
		if !stop() {
			<-done
		}
		_ = set(time.Time{})
	}, nil
}

func (frames *StdioFrameTransport) Read(ctx context.Context) ([]byte, error) {
	frames.readMu.Lock()
	defer frames.readMu.Unlock()
	select {
	case <-frames.closed:
		return nil, io.ErrClosedPipe
	default:
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if frames.readEOF {
		return nil, io.EOF
	}
	disarm, err := armStdioDeadline(ctx, frames.input.SetReadDeadline)
	if err != nil {
		return nil, err
	}
	defer disarm()
	for {
		raw, readErr := readAppServerLine(frames.reader, frames.limit)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line := bytes.TrimSuffix(bytes.TrimSuffix(raw, []byte{'\n'}), []byte{'\r'})
		if len(line) > frames.limit {
			return nil, errAppServerLineTooLarge
		}
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, readErr
		}
		if errors.Is(readErr, io.EOF) {
			frames.readEOF = true
		}
		if len(line) > 0 {
			// Buffered fragments are valid only until the next Read. A final
			// nonempty unterminated line is delivered before a separate EOF.
			return line, nil
		}
		if frames.readEOF {
			return nil, io.EOF
		}
	}
}

func (frames *StdioFrameTransport) Write(parent context.Context, raw []byte) error {
	frames.writeMu.Lock()
	defer frames.writeMu.Unlock()
	select {
	case <-frames.closed:
		return io.ErrClosedPipe
	default:
	}
	if len(raw) > frames.limit {
		return errAppServerLineTooLarge
	}
	// Backpressure stays synchronous: there is no message queue or detached
	// writer. A caller which supplied no deadline still gets the core's 15s
	// write ceiling, and a shorter existing deadline is preserved.
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	disarm, err := armStdioDeadline(ctx, frames.output.SetWriteDeadline)
	if err != nil {
		return err
	}
	defer disarm()
	for _, part := range [][]byte{raw, {'\n'}} {
		for len(part) > 0 {
			n, writeErr := frames.output.Write(part)
			if err := ctx.Err(); err != nil {
				return err
			}
			if writeErr != nil {
				return writeErr
			}
			if n <= 0 || n > len(part) {
				return io.ErrShortWrite
			}
			part = part[n:]
		}
	}
	return nil
}

func (frames *StdioFrameTransport) Close() error {
	frames.closeOnce.Do(func() {
		close(frames.closed)
		frames.closeErr = errors.Join(frames.input.Close(), frames.output.Close())
	})
	return frames.closeErr
}
