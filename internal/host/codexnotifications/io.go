package codexnotifications

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync/atomic"
	"time"
)

const maxControlLine = 128 << 10

type inputLine struct {
	raw []byte
	err error
}

func readLines(ctx context.Context, input io.Reader) <-chan inputLine {
	out := make(chan inputLine, 16)
	go func() {
		defer close(out)
		reader := bufio.NewReaderSize(input, maxControlLine)
		for {
			line, err := reader.ReadSlice('\n')
			if err != nil {
				select {
				case out <- inputLine{err: err}:
				case <-ctx.Done():
				}
				return
			}
			copyLine := append([]byte(nil), line...)
			select {
			case out <- inputLine{raw: copyLine}:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

type outputWriter struct {
	queue     chan []byte
	failed    chan error
	pendingAt atomic.Int64
}

func newOutput(ctx context.Context, writer io.Writer) *outputWriter {
	output := &outputWriter{queue: make(chan []byte, 16), failed: make(chan error, 1)}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case raw := <-output.queue:
				output.pendingAt.Store(time.Now().UnixNano())
				if deadlines, ok := writer.(interface{ SetWriteDeadline(time.Time) error }); ok {
					_ = deadlines.SetWriteDeadline(time.Now().Add(3 * time.Second))
				}
				written, err := writer.Write(raw)
				if err == nil && written != len(raw) {
					err = io.ErrShortWrite
				}
				output.pendingAt.Store(0)
				if err != nil {
					output.failed <- err
					return
				}
			}
		}
	}()
	return output
}
func (output *outputWriter) send(ctx context.Context, raw []byte) error {
	// Most writes fit immediately; do not allocate one timeout timer per event.
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-output.failed:
		return err
	default:
	}
	select {
	case output.queue <- raw:
		return nil
	default:
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case output.queue <- raw:
		return nil
	case err := <-output.failed:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errors.New("notification_output_backpressure")
	}
}
func (output *outputWriter) message(ctx context.Context, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return output.send(ctx, append(raw, '\n'))
}
