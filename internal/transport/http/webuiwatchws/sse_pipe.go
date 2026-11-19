package webuiwatchws

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

var errSSEFrameTooLarge = errors.New("sse frame exceeds maximum size")

type sseEventSink func(
	data string,
	readDeadline func() (time.Time, <-chan struct{}),
) error

type sseOpenSink func(
	readDeadline func() (time.Time, <-chan struct{}),
) error

type sseFatalSink func(code string)

// frameBudget bounds total in-flight partial SSE parser memory across all
// concurrent subscriptions sharing a single WebSocket connection.
type frameBudget struct {
	mu   sync.Mutex
	used int
	max  int
}

func newFrameBudget(maxBytes int) *frameBudget {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxAggregateFrameBytes
	}
	return &frameBudget{max: maxBytes}
}

func (budget *frameBudget) Reserve(delta int) bool {
	if budget == nil || delta <= 0 {
		return true
	}
	budget.mu.Lock()
	if budget.used+delta > budget.max {
		budget.mu.Unlock()
		return false
	}
	budget.used += delta
	budget.mu.Unlock()
	return true
}

func (budget *frameBudget) Release(delta int) {
	if budget == nil || delta <= 0 {
		return
	}
	budget.mu.Lock()
	budget.used -= delta
	if budget.used < 0 {
		budget.used = 0
	}
	budget.mu.Unlock()
}

// ssePipeWriter adapts an in-process Go SSE http.Handler onto the multiplexed
// WebSocket outbound queue without loopback TCP sockets.
//
// It implements http.ResponseWriter, http.Flusher, and SetWriteDeadline(time.Time)
// (discovered by http.NewResponseController) with real deadline enforcement:
// both immediate past deadlines and concurrent deadline updates wake blocked
// writes and return os.ErrDeadlineExceeded.
//
// Fatal parser/size failures are sticky: the first oversized frame releases
// parser reservations, invokes onFatal immediately (which emits one error frame
// and cancels subCtx), and forces every subsequent Write to fail with the same
// error even if the domain handler ignored the initial Write error.
type ssePipeWriter struct {
	ctx           context.Context
	maxFrameBytes int
	budget        *frameBudget
	onOpen        sseOpenSink
	onEvent       sseEventSink
	onFatal       sseFatalSink

	mu            sync.Mutex
	headers       http.Header
	headerWritten bool
	statusCode    int
	isEventStream bool
	openEmitted   bool
	openErr       error
	fatalErr      error
	frameTooLarge bool
	writeDeadline time.Time
	deadlineCh    chan struct{}

	// Parser state and buffer reservations are owned by the handler goroutine.
	lineBuf       []byte
	lineReserved  int
	pendingCR     bool
	dataLines     []string
	dataBytes     int
	dataReserved  int
	reservedBytes int
}

func newSSEPipeWriter(
	ctx context.Context,
	maxFrameBytes int,
	budget *frameBudget,
	onOpen sseOpenSink,
	onEvent sseEventSink,
	onFatal sseFatalSink,
) *ssePipeWriter {
	if maxFrameBytes <= 0 {
		maxFrameBytes = DefaultMaxSSEFrameBytes
	}
	return &ssePipeWriter{
		ctx:           ctx,
		maxFrameBytes: maxFrameBytes,
		budget:        budget,
		onOpen:        onOpen,
		onEvent:       onEvent,
		onFatal:       onFatal,
		headers:       make(http.Header),
		deadlineCh:    make(chan struct{}),
	}
}

func (writer *ssePipeWriter) Header() http.Header {
	writer.mu.Lock()
	headers := writer.headers
	writer.mu.Unlock()
	return headers
}

// SetWriteDeadline satisfies http.NewResponseController.SetWriteDeadline with
// live wakeups so handler timeouts and shutdown deadlines take effect promptly.
func (writer *ssePipeWriter) SetWriteDeadline(deadline time.Time) error {
	writer.mu.Lock()
	writer.writeDeadline = deadline
	close(writer.deadlineCh)
	writer.deadlineCh = make(chan struct{})
	writer.mu.Unlock()
	return nil
}

func (writer *ssePipeWriter) readDeadline() (time.Time, <-chan struct{}) {
	writer.mu.Lock()
	deadline := writer.writeDeadline
	ch := writer.deadlineCh
	writer.mu.Unlock()
	return deadline, ch
}

func (writer *ssePipeWriter) FatalErr() error {
	writer.mu.Lock()
	err := writer.fatalErr
	writer.mu.Unlock()
	return err
}

func (writer *ssePipeWriter) checkWritable() error {
	if err := writer.FatalErr(); err != nil {
		return err
	}
	if err := writer.ctx.Err(); err != nil {
		return err
	}
	deadline, _ := writer.readDeadline()
	if !deadline.IsZero() && !deadline.After(time.Now()) {
		return os.ErrDeadlineExceeded
	}
	return nil
}

func (writer *ssePipeWriter) WriteHeader(statusCode int) {
	writer.mu.Lock()
	if writer.headerWritten {
		writer.mu.Unlock()
		return
	}
	writer.headerWritten = true
	writer.statusCode = statusCode
	contentType := strings.ToLower(strings.TrimSpace(writer.headers.Get("Content-Type")))
	isSSE := statusCode == http.StatusOK && (contentType == "text/event-stream" || strings.HasPrefix(contentType, "text/event-stream;"))
	writer.isEventStream = isSSE
	writer.mu.Unlock()

	if isSSE {
		_ = writer.ensureOpenEmitted()
	}
}

func (writer *ssePipeWriter) ensureOpenEmitted() error {
	writer.mu.Lock()
	if writer.openEmitted {
		err := writer.openErr
		writer.mu.Unlock()
		return err
	}
	writer.openEmitted = true
	writer.mu.Unlock()

	var err error
	if writer.onOpen != nil {
		err = writer.onOpen(writer.readDeadline)
	}
	writer.mu.Lock()
	writer.openErr = err
	writer.mu.Unlock()
	return err
}

func (writer *ssePipeWriter) Write(chunk []byte) (int, error) {
	if err := writer.checkWritable(); err != nil {
		return 0, err
	}
	writer.mu.Lock()
	headerWritten := writer.headerWritten
	writer.mu.Unlock()
	if !headerWritten {
		writer.WriteHeader(http.StatusOK)
	}

	writer.mu.Lock()
	isSSE := writer.isEventStream
	openErr := writer.openErr
	writer.mu.Unlock()

	if !isSSE {
		// Discard non-SSE error response bodies so the handler completes cleanly
		// and the subscription runner can inspect StatusCode() deterministically.
		return len(chunk), nil
	}
	if openErr != nil {
		return 0, openErr
	}
	if len(chunk) == 0 {
		return 0, nil
	}

	remaining := chunk
	for len(remaining) > 0 {
		if err := writer.FatalErr(); err != nil {
			return 0, err
		}
		if writer.pendingCR {
			writer.pendingCR = false
			if remaining[0] == '\n' {
				remaining = remaining[1:]
				continue
			}
		}
		idx := bytes.IndexAny(remaining, "\r\n")
		if idx < 0 {
			if err := writer.appendLineSegment(remaining); err != nil {
				return 0, err
			}
			break
		}
		if idx > 0 {
			if err := writer.appendLineSegment(remaining[:idx]); err != nil {
				return 0, err
			}
		}
		delim := remaining[idx]
		remaining = remaining[idx+1:]
		if delim == '\r' {
			writer.pendingCR = true
		}
		if err := writer.consumeLine(); err != nil {
			return 0, err
		}
	}
	return len(chunk), nil
}

func (writer *ssePipeWriter) Flush() {
	if writer.FatalErr() != nil {
		return
	}
	writer.mu.Lock()
	headerWritten := writer.headerWritten
	isSSE := writer.isEventStream
	writer.mu.Unlock()
	if !headerWritten {
		writer.WriteHeader(http.StatusOK)
		return
	}
	if isSSE {
		_ = writer.ensureOpenEmitted()
	}
}

func (writer *ssePipeWriter) appendLineSegment(seg []byte) error {
	maxLineBytes := writer.maxFrameBytes + 16
	if len(writer.lineBuf)+len(seg) > maxLineBytes {
		return writer.failFatal(errSSEFrameTooLarge, "frame_too_large")
	}
	if !writer.reserve(len(seg)) {
		return writer.failFatal(errSSEFrameTooLarge, "frame_too_large")
	}
	writer.lineBuf = append(writer.lineBuf, seg...)
	writer.lineReserved += len(seg)
	return nil
}

func (writer *ssePipeWriter) consumeLine() error {
	line := writer.lineBuf
	lineLen := len(line)
	// Fast copy of line contents only when needed; release lineBuf reservation
	// before reserving dataLines so the same bytes are never double-counted.
	if lineLen == 0 {
		writer.releaseLine()
		if len(writer.dataLines) == 0 {
			return nil
		}
		payload := strings.Join(writer.dataLines, "\n")
		writer.clearDataLines()
		if payload == "" || writer.onEvent == nil {
			writer.releaseData()
			return nil
		}
		err := writer.onEvent(payload, writer.readDeadline)
		writer.releaseData()
		if errors.Is(err, errOutboundTooLarge) {
			return writer.failFatal(errSSEFrameTooLarge, "frame_too_large")
		}
		return err
	}

	// Comments (such as ": heartbeat") are ignored without allocating event data.
	if line[0] == ':' {
		writer.releaseLine()
		return nil
	}

	// Preserve exact MessageEvent.data semantics (strip at most one leading space
	// after "data:", join multiple data lines with "\n").
	if bytes.HasPrefix(line, []byte("data:")) {
		value := line[5:]
		if len(value) > 0 && value[0] == ' ' {
			value = value[1:]
		}
		copied := string(value)
		writer.releaseLine()

		added := len(copied)
		if len(writer.dataLines) > 0 {
			added++
		}
		if writer.dataBytes+added > writer.maxFrameBytes {
			return writer.failFatal(errSSEFrameTooLarge, "frame_too_large")
		}
		if !writer.reserve(added) {
			return writer.failFatal(errSSEFrameTooLarge, "frame_too_large")
		}
		writer.dataLines = append(writer.dataLines, copied)
		writer.dataBytes += added
		writer.dataReserved += added
		return nil
	}

	writer.releaseLine()
	return nil
}

func (writer *ssePipeWriter) reserve(delta int) bool {
	if delta <= 0 {
		return true
	}
	if !writer.budget.Reserve(delta) {
		return false
	}
	writer.reservedBytes += delta
	return true
}

func (writer *ssePipeWriter) release(delta int) {
	if delta <= 0 || writer.reservedBytes <= 0 {
		return
	}
	if delta > writer.reservedBytes {
		delta = writer.reservedBytes
	}
	writer.reservedBytes -= delta
	writer.budget.Release(delta)
}

func (writer *ssePipeWriter) releaseLine() {
	// Release the backing byte slice when refunding budget so an oversized line
	// cannot stay retained on the heap after logical budget drops back to 0.
	writer.lineBuf = nil
	if writer.lineReserved > 0 {
		writer.release(writer.lineReserved)
		writer.lineReserved = 0
	}
}

func (writer *ssePipeWriter) clearDataLines() {
	for i := range writer.dataLines {
		writer.dataLines[i] = ""
	}
	writer.dataLines = nil
	writer.dataBytes = 0
}

func (writer *ssePipeWriter) releaseData() {
	if writer.dataReserved > 0 {
		writer.release(writer.dataReserved)
		writer.dataReserved = 0
	}
}

// ReleaseBuffers returns all remaining reserved parser bytes to the connection's
// aggregate frameBudget. Safe to call in defer after ServeHTTP returns.
func (writer *ssePipeWriter) ReleaseBuffers() {
	writer.lineBuf = nil
	writer.lineReserved = 0
	writer.clearDataLines()
	writer.dataReserved = 0
	if writer.reservedBytes > 0 {
		writer.release(writer.reservedBytes)
	}
}

func (writer *ssePipeWriter) failFatal(err error, code string) error {
	writer.ReleaseBuffers()

	writer.mu.Lock()
	first := writer.fatalErr == nil
	if first {
		writer.fatalErr = err
		if errors.Is(err, errSSEFrameTooLarge) {
			writer.frameTooLarge = true
		}
	}
	sticky := writer.fatalErr
	onFatal := writer.onFatal
	writer.mu.Unlock()

	if first && onFatal != nil {
		onFatal(code)
	}
	return sticky
}

func (writer *ssePipeWriter) StatusCode() int {
	writer.mu.Lock()
	status := writer.statusCode
	if !writer.headerWritten {
		status = http.StatusOK
	}
	writer.mu.Unlock()
	return status
}

func (writer *ssePipeWriter) IsEventStream() bool {
	writer.mu.Lock()
	isSSE := writer.isEventStream
	writer.mu.Unlock()
	return isSSE
}

func (writer *ssePipeWriter) FrameTooLarge() bool {
	writer.mu.Lock()
	tooLarge := writer.frameTooLarge
	writer.mu.Unlock()
	return tooLarge
}
