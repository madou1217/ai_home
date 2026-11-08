package webuichatapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 帧格式必须与 Node encodeSseEvent 逐字节一致：id 行只在 seq > 0 时出现，
// 数据行是紧凑 JSON，帧尾是空行。
func TestEncodeEventMatchesNodeFrame(t *testing.T) {
	frame, err := encodeEvent(eventEnvelope{
		Schema:    EventSchema,
		EventID:   "e1",
		SessionID: "s1",
		Seq:       2,
		Type:      "turn.started",
		At:        1,
		TurnID:    "t1",
		Source:    eventSource{Provider: "p", RuntimeID: "r"},
		Payload:   turnPayload{State: "running", ActiveTurn: activeTurn{TurnID: "t1", RunID: "r1", State: "running"}},
	})
	if err != nil {
		t.Fatalf("encodeEvent() error = %v", err)
	}
	text := string(frame)
	if !strings.HasPrefix(text, "id: 2"+lineBreak) {
		t.Fatalf("缺少 id 行: %q", text)
	}
	if !strings.HasPrefix(text, "id: 2"+lineBreak+"event: turn.started"+lineBreak+"data: {") {
		t.Fatalf("帧头不符合 SSE 合同: %q", text)
	}
	if !strings.HasSuffix(text, "}"+lineBreak+lineBreak) {
		t.Fatalf("帧尾不是空行: %q", text)
	}
	// 必填字段顺序与 Node normalizeEvent 的构造顺序一致。
	order := []string{"\"schema\"", "\"eventId\"", "\"sessionId\"", "\"seq\"", "\"type\"", "\"at\"", "\"turnId\"", "\"source\"", "\"payload\""}
	lastIndex := -1
	for _, key := range order {
		index := strings.Index(text, key)
		if index < 0 {
			t.Fatalf("缺少字段 %s: %q", key, text)
		}
		if index < lastIndex {
			t.Fatalf("字段 %s 顺序错乱: %q", key, text)
		}
		lastIndex = index
	}
	// 可选字段缺席时信封里不留空串：at 之后应当直接接 turnId, source。
	if !strings.Contains(text, "\"at\":1,\"turnId\":\"t1\",\"source\"") {
		t.Fatalf("可选字段缺席时不应出现空键: %q", text)
	}
}

// seq <= 0 的传输事件不写 id 行（Node 只在 seq > 0 时写）。
func TestEncodeEventOmitsIDForZeroSequence(t *testing.T) {
	frame, err := encodeEvent(eventEnvelope{
		Schema:    EventSchema,
		EventID:   "e1",
		SessionID: "s1",
		Type:      "stream.error",
		Source:    eventSource{Provider: "p", RuntimeID: "r"},
		Payload:   map[string]string{"error": "x"},
	})
	if err != nil {
		t.Fatalf("encodeEvent() error = %v", err)
	}
	if strings.HasPrefix(string(frame), "id: ") {
		t.Fatalf("seq=0 不该写 id 行: %q", string(frame))
	}
}

// 事件序号逐条递增，心跳帧不影响序号。
func TestEventStreamNumbersEvents(t *testing.T) {
	recorder := httptest.NewRecorder()
	now := func() time.Time { return time.Unix(1_700_000_000, 0) }
	stream, err := newEventStream(recorder, "s-1", eventSource{Provider: "p", RuntimeID: "r"}, now, newIdentifier)
	if err != nil {
		t.Fatalf("newEventStream() error = %v", err)
	}
	if err := stream.open(); err != nil {
		t.Fatalf("open() error = %v", err)
	}
	for range 3 {
		if err := stream.emit("turn.completed", "", "", "", turnCompletedPayload{State: "idle"}); err != nil {
			t.Fatalf("emit() error = %v", err)
		}
	}
	stream.close()

	if recorder.Header().Get("Cache-Control") != "no-cache, no-transform" {
		t.Fatalf("Cache-Control = %q", recorder.Header().Get("Cache-Control"))
	}
	frames := parseFrames(t, recorder.Body.String())
	if len(frames) != 3 {
		t.Fatalf("帧数 = %d", len(frames))
	}
	for index, frame := range frames {
		event := decodeEvent(t, frame.data)
		if event.Seq != int64(index+1) {
			t.Fatalf("第 %d 帧 seq = %d", index, event.Seq)
		}
		if !strings.HasPrefix(event.EventID, "event-") {
			t.Fatalf("eventId = %q", event.EventID)
		}
	}
}

// 心跳在间隔到点后写出，关闭后不再写。
func TestEventStreamWritesHeartbeat(t *testing.T) {
	recorder := httptest.NewRecorder()
	stream, err := newEventStream(recorder, "s-1", eventSource{}, func() time.Time { return time.Now() }, newIdentifier)
	if err != nil {
		t.Fatalf("newEventStream() error = %v", err)
	}
	if err := stream.open(); err != nil {
		t.Fatalf("open() error = %v", err)
	}
	stream.startHeartbeat(2 * time.Millisecond)
	time.Sleep(20 * time.Millisecond)
	stream.close()
	if !strings.Contains(recorder.Body.String(), heartbeatFrame) {
		t.Fatalf("没有心跳帧: %q", recorder.Body.String())
	}
	before := recorder.Body.Len()
	stream.startHeartbeat(0)
	time.Sleep(10 * time.Millisecond)
	if recorder.Body.Len() != before {
		t.Fatal("关闭后仍在写心跳")
	}
}

// 写失败之后必须报错并标记为不可写，让上层停止读上游。
func TestEventStreamReportsWriteFailure(t *testing.T) {
	stream, err := newEventStream(&brokenResponse{}, "s-1", eventSource{}, time.Now, newIdentifier)
	if err != nil {
		t.Fatalf("newEventStream() error = %v", err)
	}
	if err := stream.emit("turn.completed", "", "", "", turnCompletedPayload{State: "idle"}); err == nil {
		t.Fatal("写失败没有报错")
	}
	if !stream.Failed() {
		t.Fatal("写失败后 Failed() 应为 true")
	}
}

// brokenResponse 是永远写不进去的 ResponseWriter。
type brokenResponse struct {
	header http.Header
}

func (response *brokenResponse) Header() http.Header {
	if response.header == nil {
		response.header = http.Header{}
	}
	return response.header
}

func (response *brokenResponse) Write([]byte) (int, error) {
	return 0, errors.New("broken pipe")
}

func (response *brokenResponse) WriteHeader(int) {}

func (response *brokenResponse) Flush() {}
