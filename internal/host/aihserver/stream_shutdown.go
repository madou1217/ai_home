package aihserver

import (
	"context"
	"net/http"
	"strings"
	"sync"
)

// streamShutdown only cancels handlers that have actually started an SSE
// response. Plain HTTP requests keep their normal graceful-drain behavior.
//
// http.Server.Shutdown waits for every active handler, including SSE handlers
// that are blocked waiting for the next event. Cancelling their request
// contexts lets shutdown finish without waiting for the next heartbeat or for
// the upstream stream to end.
type streamShutdown struct {
	mu      sync.Mutex
	closed  bool
	streams map[*streamRegistration]struct{}
}

type streamRegistration struct {
	cancel context.CancelFunc
}

func newStreamShutdown() *streamShutdown {
	return &streamShutdown{streams: make(map[*streamRegistration]struct{})}
}

// wrap installs a request-scoped cancel function and a response writer that
// registers the request once the handler declares text/event-stream.
func (shutdown *streamShutdown) wrap(next http.Handler) http.Handler {
	if shutdown == nil {
		return next
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithCancel(request.Context())
		writer := &streamResponseWriter{
			ResponseWriter: response,
			shutdown:       shutdown,
			cancel:         cancel,
			request:        request.WithContext(ctx),
		}
		defer func() {
			writer.release()
			cancel()
		}()
		next.ServeHTTP(writer, writer.request)
	})
}

func (shutdown *streamShutdown) register(cancel context.CancelFunc) *streamRegistration {
	if shutdown == nil {
		return nil
	}
	registration := &streamRegistration{cancel: cancel}
	shutdown.mu.Lock()
	if shutdown.closed {
		shutdown.mu.Unlock()
		cancel()
		return nil
	}
	shutdown.streams[registration] = struct{}{}
	shutdown.mu.Unlock()
	return registration
}

func (shutdown *streamShutdown) release(registration *streamRegistration) {
	if shutdown == nil || registration == nil {
		return
	}
	shutdown.mu.Lock()
	delete(shutdown.streams, registration)
	shutdown.mu.Unlock()
}

// cancelAll makes shutdown idempotent: requests that start an SSE response
// after the first call are cancelled immediately by register.
func (shutdown *streamShutdown) cancelAll() {
	if shutdown == nil {
		return
	}
	shutdown.mu.Lock()
	if shutdown.closed {
		shutdown.mu.Unlock()
		return
	}
	shutdown.closed = true
	registrations := make([]*streamRegistration, 0, len(shutdown.streams))
	for registration := range shutdown.streams {
		registrations = append(registrations, registration)
	}
	shutdown.mu.Unlock()
	for _, registration := range registrations {
		registration.cancel()
	}
}

type streamResponseWriter struct {
	http.ResponseWriter
	shutdown     *streamShutdown
	cancel       context.CancelFunc
	request      *http.Request
	registration *streamRegistration
}

func (writer *streamResponseWriter) markStream() {
	if writer.registration != nil {
		return
	}
	contentType := strings.ToLower(writer.Header().Get("Content-Type"))
	if !strings.Contains(contentType, "text/event-stream") {
		return
	}
	writer.registration = writer.shutdown.register(writer.cancel)
}

func (writer *streamResponseWriter) WriteHeader(status int) {
	writer.markStream()
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *streamResponseWriter) Write(payload []byte) (int, error) {
	writer.markStream()
	return writer.ResponseWriter.Write(payload)
}

// Flush must be explicit: SSE handlers type-assert http.Flusher, and hiding
// the underlying writer would turn a working stream into a 500.
func (writer *streamResponseWriter) Flush() {
	writer.markStream()
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Unwrap preserves http.ResponseController support (write deadlines,
// hijacking, flushing) through this wrapper.
func (writer *streamResponseWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func (writer *streamResponseWriter) release() {
	if writer == nil {
		return
	}
	writer.shutdown.release(writer.registration)
	writer.registration = nil
}
