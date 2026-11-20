package openairesponsesapi

import (
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// requestTiming 是一次 /v1/responses 请求的分段计时，只在请求头显式要求时启用。
// 它不参与协议判断，也不改变提交/换号边界。
type requestTiming struct {
	start         time.Time
	executorStart time.Time
	executorDone  time.Time
	firstEvent    time.Time
	firstWrite    time.Time
	events        int
	model         string
	stream        bool
	mu            sync.Mutex
	writer        *timingWriter
}

func newRequestTiming(model string, stream bool) *requestTiming {
	return &requestTiming{start: time.Now(), model: model, stream: stream}
}

func (timing *requestTiming) markExecutorStart() {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	timing.executorStart = time.Now()
	timing.mu.Unlock()
}

func (timing *requestTiming) markExecutorDone() {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	timing.executorDone = time.Now()
	timing.mu.Unlock()
}

func (timing *requestTiming) markEvent() {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	if timing.firstEvent.IsZero() {
		timing.firstEvent = time.Now()
	}
	timing.events++
	timing.mu.Unlock()
}

func (timing *requestTiming) markWrite() {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	if timing.firstWrite.IsZero() {
		timing.firstWrite = time.Now()
	}
	timing.mu.Unlock()
}

func (timing *requestTiming) markModel(model string, stream bool) {
	if timing == nil {
		return
	}
	timing.mu.Lock()
	timing.model = model
	timing.stream = stream
	timing.mu.Unlock()
}

func (timing *requestTiming) log(accountRef string) {
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
		"responses timing model=%s stream=%t account=%s total_ms=%d executor_ms=%d first_event_ms=%d first_write_ms=%d events=%d",
		timing.model,
		timing.stream,
		strings.TrimSpace(accountRef),
		time.Since(timing.start).Milliseconds(),
		durationMS(timing.executorStart, timing.executorDone),
		elapsed(timing.firstEvent),
		elapsed(timing.firstWrite),
		timing.events,
	)
}

func durationMS(start time.Time, end time.Time) int64 {
	if start.IsZero() || end.IsZero() {
		return -1
	}
	return end.Sub(start).Milliseconds()
}

// timingWriter 记录首个客户端写入/刷新时间，并把 ResponseController 需要的
// 可选接口透传给底层 writer。
type timingWriter struct {
	http.ResponseWriter
	timing *requestTiming
}

func (writer *timingWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func (writer *timingWriter) WriteHeader(statusCode int) {
	writer.ResponseWriter.WriteHeader(statusCode)
}

func (writer *timingWriter) Write(payload []byte) (int, error) {
	writer.timing.markWrite()
	return writer.ResponseWriter.Write(payload)
}

func (writer *timingWriter) Flush() {
	writer.timing.markWrite()
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}
