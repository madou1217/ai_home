// Package boundedinput reads an exclusively owned command input to completion.
// The caller supplies the total deadline and owns all interpretation and effects.
package boundedinput

import (
	"context"
	"errors"
	"io"
	"math"
	"os"
	"time"
)

var (
	ErrUnsupportedInput = errors.New("bounded_input_unsupported")
	ErrDeadlineRequired = errors.New("bounded_input_deadline_required")
	ErrInvalidLimit     = errors.New("bounded_input_limit_invalid")
	ErrTooLarge         = errors.New("bounded_input_too_large")
)

// Read supports actual pipe/socket files and synchronous regular file input,
// never an unknown reader. It owns exclusive input access during this call and
// leaves the caller descriptor open. Regular file cancellation is cooperative:
// Stat and a synchronous kernel read may exceed the context deadline. No input
// reader worker or cancellation callback survives a return.
func Read(ctx context.Context, reader io.Reader, max int64) (raw []byte, err error) {
	if ctx == nil {
		return nil, ErrDeadlineRequired
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return nil, ErrDeadlineRequired
	}
	if max < 1 || max == math.MaxInt64 {
		return nil, ErrInvalidLimit
	}
	input, ok := reader.(*os.File)
	if !ok || input == nil {
		return nil, ErrUnsupportedInput
	}
	info, err := input.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() && info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return nil, ErrUnsupportedInput
	}
	if info.Mode().IsRegular() {
		raw, err = readRegular(ctx, input, max)
	} else {
		raw, err = readPlatform(ctx, input, max)
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		err = errors.Join(ctxErr, err)
	} else if errors.Is(err, os.ErrDeadlineExceeded) && !time.Now().Before(deadline) {
		// File deadline can fire just before the context timer is scheduled.
		err = errors.Join(context.DeadlineExceeded, err)
	}
	if int64(len(raw)) > max {
		err = errors.Join(err, ErrTooLarge)
	}
	if err != nil {
		clear(raw)
		return nil, err
	}
	return raw, nil
}

// readRegular uses the caller's current offset without reopening the file or
// changing its flags. All reads complete synchronously before this returns;
// cancellation cannot promise to interrupt a kernel filesystem operation.
func readRegular(ctx context.Context, input *os.File, max int64) (raw []byte, err error) {
	var buffer [32 << 10]byte
	defer clear(buffer[:])
	for {
		if err := ctx.Err(); err != nil {
			return raw, err
		}
		remaining := max + 1 - int64(len(raw))
		if remaining <= 0 {
			return raw, nil
		}
		chunk := buffer[:]
		if remaining < int64(len(chunk)) {
			chunk = chunk[:int(remaining)]
		}
		n, readErr := input.Read(chunk)
		if n > 0 {
			raw = append(raw, chunk[:n]...)
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return raw, errors.Join(ctxErr, readErr)
		}
		if readErr == io.EOF {
			return raw, nil
		}
		if readErr != nil {
			return raw, readErr
		}
		if n == 0 {
			return raw, io.ErrNoProgress
		}
	}
}
