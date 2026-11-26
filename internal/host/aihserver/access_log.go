package aihserver

import (
	"bufio"
	"log"
	"net"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/core/requestid"
)

var requestLogEnabled atomic.Bool

// ConfigureRequestLogging enables or disables the process access log.
//
// The CLI serve adapter sets this from Node's logRequests option; a direct
// aih-server starts quiet unless the environment explicitly enables it.
func ConfigureRequestLogging(enabled bool) {
	requestLogEnabled.Store(enabled)
}

type accessLogResponseWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (writer *accessLogResponseWriter) WriteHeader(status int) {
	if !writer.wrote {
		writer.status = status
		writer.wrote = true
	}
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *accessLogResponseWriter) Write(body []byte) (int, error) {
	if !writer.wrote {
		writer.status = http.StatusOK
		writer.wrote = true
	}
	return writer.ResponseWriter.Write(body)
}

func (writer *accessLogResponseWriter) Flush() {
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (writer *accessLogResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := writer.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	return hijacker.Hijack()
}

func (writer *accessLogResponseWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

// withAccessLog 记录方法、路径、状态和耗时；不记录请求头、查询串或正文。
func withAccessLog(next http.Handler, logger *log.Logger) http.Handler {
	if logger == nil {
		logger = log.Default()
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !requestLogEnabled.Load() {
			next.ServeHTTP(response, request)
			return
		}
		started := time.Now()
		writer := &accessLogResponseWriter{ResponseWriter: response, status: http.StatusOK}
		next.ServeHTTP(writer, request)
		logger.Printf(
			"access request_id=%s method=%s path=%s status=%d duration_ms=%d",
			requestid.FromContext(request.Context()),
			request.Method,
			request.URL.Path,
			writer.status,
			time.Since(started).Milliseconds(),
		)
	})
}
