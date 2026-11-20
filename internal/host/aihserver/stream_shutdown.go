package aihserver

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"
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
	cancel    context.CancelFunc
	inference bool
}

// inferenceStreamPath 判断是不是"正在生成回答"的推理流。这类流被中途掐断，
// 客户端（codex/claude）会当成会话异常结束；其余 SSE（WebUI watch 等）可以直接取消。
func inferenceStreamPath(request *http.Request) bool {
	if request == nil || request.URL == nil {
		return false
	}
	path := request.URL.Path
	switch {
	case path == "/v1/responses", strings.HasPrefix(path, "/v1/responses/"):
		return true
	case path == "/v1/messages", strings.HasPrefix(path, "/v1/messages/"):
		return true
	case path == "/v1/chat/completions":
		return true
	}
	return false
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
		// 推理请求在还没写出第一帧（上游 prefill）时也必须算"在跑"：
		// 否则重启只等住已经出字的流，正在等待首个 token 的请求会被直接切断。
		if inferenceStreamPath(request) {
			writer.registration = shutdown.register(cancel, true)
		}
		defer func() {
			writer.release()
			cancel()
		}()
		next.ServeHTTP(writer, writer.request)
	})
}

func (shutdown *streamShutdown) register(cancel context.CancelFunc, inference bool) *streamRegistration {
	if shutdown == nil {
		return nil
	}
	registration := &streamRegistration{cancel: cancel, inference: inference}
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

// cancelNonInference 立即取消非推理流（WebUI watch 等），推理流留给收尾窗口。
func (shutdown *streamShutdown) cancelNonInference() {
	if shutdown == nil {
		return
	}
	shutdown.mu.Lock()
	registrations := make([]*streamRegistration, 0, len(shutdown.streams))
	for registration := range shutdown.streams {
		if !registration.inference {
			registrations = append(registrations, registration)
		}
	}
	shutdown.mu.Unlock()
	for _, registration := range registrations {
		registration.cancel()
	}
}

// waitInferenceIdle 等到没有正在生成的推理流，或上下文到期。轮询间隔取 100ms：
// 这里只在进程退出路径上跑一次，不需要更细。
func (shutdown *streamShutdown) waitInferenceIdle(ctx context.Context) {
	if shutdown == nil {
		return
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if shutdown.inferenceCount() == 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (shutdown *streamShutdown) inferenceCount() int {
	if shutdown == nil {
		return 0
	}
	shutdown.mu.Lock()
	defer shutdown.mu.Unlock()
	count := 0
	for registration := range shutdown.streams {
		if registration.inference {
			count++
		}
	}
	return count
}

type streamResponseWriter struct {
	http.ResponseWriter
	shutdown     *streamShutdown
	cancel       context.CancelFunc
	request      *http.Request
	mu           sync.Mutex
	registration *streamRegistration
}

func (writer *streamResponseWriter) markStream() {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.registration != nil {
		return
	}
	contentType := strings.ToLower(writer.Header().Get("Content-Type"))
	if !strings.Contains(contentType, "text/event-stream") {
		return
	}
	writer.registration = writer.shutdown.register(writer.cancel, inferenceStreamPath(writer.request))
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
	writer.mu.Lock()
	registration := writer.registration
	writer.registration = nil
	writer.mu.Unlock()
	writer.shutdown.release(registration)
}
