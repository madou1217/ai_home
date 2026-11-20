package codexresponseshttp

import (
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// nativeTiming 是 Codex 原生 /v1/responses 快路径的请求级分段计时，
// 只在请求头显式要求时启用；不参与提交/换号判断。
type nativeTiming struct {
	start          time.Time
	model          string
	stream         bool
	account        string
	accountAt      time.Time
	upstreamStart  time.Time
	upstreamHeader time.Time
	probeDone      time.Time
	committed      time.Time
	firstWrite     time.Time
	mu             sync.Mutex
}

func newNativeTiming() *nativeTiming {
	return &nativeTiming{start: time.Now()}
}

func (timing *nativeTiming) markModel(model string, stream bool) {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	timing.model = model
	timing.stream = stream
	timing.mu.Unlock()
}

func (timing *nativeTiming) markAccount(account string) {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	if strings.TrimSpace(account) != "" {
		timing.account = account
	}
	timing.accountAt = time.Now()
	timing.mu.Unlock()
}

func (timing *nativeTiming) markUpstreamStart() {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	timing.upstreamStart = time.Now()
	timing.mu.Unlock()
}

func (timing *nativeTiming) markUpstreamHeader() {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	timing.upstreamHeader = time.Now()
	timing.mu.Unlock()
}

func (timing *nativeTiming) markProbeDone() {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	timing.probeDone = time.Now()
	timing.mu.Unlock()
}

func (timing *nativeTiming) markCommitted() {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	if timing.committed.IsZero() {
		timing.committed = time.Now()
	}
	timing.mu.Unlock()
}

func (timing *nativeTiming) markWrite() {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	if timing.firstWrite.IsZero() {
		timing.firstWrite = time.Now()
	}
	timing.mu.Unlock()
}

func (timing *nativeTiming) log() {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	defer timing.mu.Unlock()
	elapsed := func(at time.Time) int64 {
		if at.IsZero() {
			return -1
		}
		return at.Sub(timing.start).Milliseconds()
	}
	log.Printf(
		"responses native timing model=%s stream=%t account=%s total_ms=%d account_ms=%d upstream_ms=%d probe_ms=%d committed_ms=%d first_write_ms=%d",
		timing.model,
		timing.stream,
		timing.account,
		time.Since(timing.start).Milliseconds(),
		elapsed(timing.accountAt),
		elapsed(timing.upstreamHeader),
		elapsed(timing.probeDone),
		elapsed(timing.committed),
		elapsed(timing.firstWrite),
	)
}

type nativeTimingWriter struct {
	http.ResponseWriter
	timing *nativeTiming
}

func (writer *nativeTimingWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func (writer *nativeTimingWriter) WriteHeader(statusCode int) {
	writer.ResponseWriter.WriteHeader(statusCode)
}

func (writer *nativeTimingWriter) Write(payload []byte) (int, error) {
	writer.timing.markWrite()
	return writer.ResponseWriter.Write(payload)
}

func (writer *nativeTimingWriter) Flush() {
	writer.timing.markWrite()
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}
