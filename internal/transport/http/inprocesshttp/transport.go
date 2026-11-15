// Package inprocesshttp streams requests through an existing HTTP handler.
package inprocesshttp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sync"
)

type transport struct{ handler http.Handler }

func NewTransport(handler http.Handler) http.RoundTripper { return &transport{handler: handler} }

type responseWriter struct {
	header         http.Header
	status         int
	pipe           *io.PipeWriter
	once           sync.Once
	ready          chan struct{}
	responseHeader http.Header
}

func (w *responseWriter) Header() http.Header { return w.header }
func (w *responseWriter) WriteHeader(status int) {
	w.once.Do(func() {
		w.status = status
		w.responseHeader = w.header.Clone()
		close(w.ready)
	})
}
func (w *responseWriter) Write(b []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	return w.pipe.Write(b)
}
func (w *responseWriter) Flush() { w.WriteHeader(http.StatusOK) }

type responseBody struct {
	*io.PipeReader
	cancel context.CancelFunc
}

func (b *responseBody) Close() error {
	b.cancel()
	return b.PipeReader.Close()
}

func (t *transport) RoundTrip(req *http.Request) (*http.Response, error) {
	if t == nil || t.handler == nil {
		return nil, fmt.Errorf("in-process gateway handler is unavailable")
	}
	ctx, cancel := context.WithCancel(req.Context())
	request := req.Clone(ctx)
	if request.RemoteAddr == "" {
		request.RemoteAddr = "127.0.0.1:0"
	}
	pr, pw := io.Pipe()
	w := &responseWriter{header: make(http.Header), pipe: pw, ready: make(chan struct{})}
	stopCancel := context.AfterFunc(ctx, func() { _ = pr.CloseWithError(ctx.Err()) })
	go func() {
		defer func() {
			if value := recover(); value != nil {
				_ = pw.CloseWithError(fmt.Errorf("in-process gateway panic: %v", value))
			}
			w.WriteHeader(http.StatusOK)
			_ = pw.Close()
			stopCancel()
		}()
		t.handler.ServeHTTP(w, request)
	}()
	select {
	case <-ctx.Done():
		cancel()
		return nil, ctx.Err()
	case <-w.ready:
		return &http.Response{
			StatusCode: w.status, Status: fmt.Sprintf("%d %s", w.status, http.StatusText(w.status)),
			Header: w.responseHeader, Body: &responseBody{pr, cancel}, Request: request,
		}, nil
	}
}
