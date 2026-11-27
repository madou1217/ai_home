package proxyingress

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"
)

func (i *Ingress) openStream(ctx context.Context) (io.ReadWriteCloser, error) {
	if ctx == nil {
		ctx = i.ctx
	}
	stream, err := i.openDial(ctx)
	if err != nil {
		return nil, err
	}
	if stream == nil {
		return nil, errors.New("proxyingress: Dial returned no stream")
	}
	tracked, ok := i.trackStream(stream)
	if !ok {
		return nil, ErrClosed
	}
	return tracked, nil
}

type dialResult struct {
	stream io.ReadWriteCloser
	err    error
}

func (i *Ingress) openDial(ctx context.Context) (io.ReadWriteCloser, error) {
	dial := i.currentDial()
	if dial == nil {
		return nil, errors.New("proxyingress: Dial is not configured")
	}
	if i.dialTimeout <= 0 {
		return dial(ctx)
	}
	callCtx, cancel := context.WithCancel(ctx)
	results := make(chan dialResult, 1)
	go func() {
		stream, err := dial(callCtx)
		results <- dialResult{stream: stream, err: err}
	}()
	timer := time.NewTimer(i.dialTimeout)
	defer timer.Stop()
	select {
	case result := <-results:
		if result.err != nil {
			cancel()
			if result.stream != nil {
				_ = result.stream.Close()
			}
			return nil, result.err
		}
		if result.stream == nil {
			cancel()
			return nil, errors.New("proxyingress: Dial returned no stream")
		}
		return &cancelingStream{ReadWriteCloser: result.stream, cancel: cancel}, nil
	case <-timer.C:
		cancel()
		go discardDialResult(results)
		return nil, ErrDialTimeout
	case <-ctx.Done():
		cancel()
		go discardDialResult(results)
		return nil, ctx.Err()
	}
}

func discardDialResult(results <-chan dialResult) {
	result := <-results
	if result.stream != nil {
		_ = result.stream.Close()
	}
}

// cancelingStream ties a dialed stream to the per-dial context so that a timed
// out or abandoned dial cannot leave the stream alive.
type cancelingStream struct {
	io.ReadWriteCloser
	cancel context.CancelFunc
	once   sync.Once
}

func (stream *cancelingStream) Close() error {
	stream.once.Do(stream.cancel)
	return stream.ReadWriteCloser.Close()
}
