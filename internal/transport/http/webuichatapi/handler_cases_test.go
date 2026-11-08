package webuichatapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// okStream 是一段标准上游流：首帧 role、两段正文、收尾帧带用量、[DONE]。
func okStream() string {
	return frame(`{"choices":[{"delta":{"role":"assistant"}}]}`) +
		frame(`{"choices":[{"delta":{"content":"你"}}]}`) +
		frame(`{"choices":[{"delta":{"content":"好"}}]}`) +
		frame(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2}}`) +
		frame("[DONE]")
}

func respondWith(response *http.Response, err error) func(*http.Request) (*http.Response, error) {
	return func(*http.Request) (*http.Response, error) { return response, err }
}

// 主链路：一条 turn.submit 应当产出 Node 同序的 7 个 canonical 事件，
// 并把助手消息、用量与完成终态都写进去。
func TestHandleTurnStreamsCanonicalEvents(t *testing.T) {
	testRig := newRig(t, []accountcore.AccountRef{accountA}, respondWith(sseResponse(okStream()), nil), nil)
	recorder := testRig.post(t, submitBody, nil)

	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, want 200, body = %s", recorder.Code, recorder.Body.String())
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "text/event-stream") {
		t.Fatalf("Content-Type = %q", contentType)
	}
	if recorder.Header().Get("X-Accel-Buffering") != "no" {
		t.Fatalf("缺少 X-Accel-Buffering: no")
	}

	frames := parseFrames(t, recorder.Body.String())
	wantEvents := []string{
		"turn.queued",
		"turn.started",
		"timeline.item.started",
		"timeline.item.delta",
		"timeline.item.delta",
		"timeline.item.completed",
		"turn.completed",
	}
	if len(frames) != len(wantEvents) {
		t.Fatalf("事件数 = %d, want %d: %+v", len(frames), len(wantEvents), frames)
	}
	for index, frame := range frames {
		if frame.event != wantEvents[index] {
			t.Fatalf("第 %d 个事件 = %s, want %s", index, frame.event, wantEvents[index])
		}
		if frame.id != intToString(index+1) {
			t.Fatalf("第 %d 个事件的 id = %q, want %d", index, frame.id, index+1)
		}
		event := decodeEvent(t, frame.data)
		if event.Schema != EventSchema {
			t.Fatalf("schema = %q", event.Schema)
		}
		if event.SessionID != "s-1" {
			t.Fatalf("sessionId = %q", event.SessionID)
		}
		if event.Seq != int64(index+1) {
			t.Fatalf("seq = %d, want %d", event.Seq, index+1)
		}
		if event.Source.Provider != "openai" || event.Source.RuntimeID != "go:chat-completions" {
			t.Fatalf("source = %+v", event.Source)
		}
		if event.TurnID != "turn-fixed" || event.RunID != "run-fixed" {
			t.Fatalf("轮次身份 = %q/%q", event.TurnID, event.RunID)
		}
	}

	queued := decodePayload[turnPayload](t, decodeEvent(t, frames[0].data))
	if queued.State != "starting" || queued.SubmissionCommandID != "c-1" || queued.ActiveTurn.State != "starting" {
		t.Fatalf("turn.queued 载荷 = %+v", queued)
	}
	if queued.ActiveTurn.ClientUserMessageID != "run-fixed" || queued.ActiveTurn.TurnID != "turn-fixed" {
		t.Fatalf("activeTurn = %+v", queued.ActiveTurn)
	}

	started := decodePayload[turnPayload](t, decodeEvent(t, frames[1].data))
	if started.State != "running" {
		t.Fatalf("turn.started state = %q", started.State)
	}

	itemStarted := decodePayload[timelinePayload](t, decodeEvent(t, frames[2].data))
	if itemStarted.Item.Kind != "message" || itemStarted.Item.Status != "running" || itemStarted.Item.Content != "" {
		t.Fatalf("item.started = %+v", itemStarted.Item)
	}
	if itemStarted.Item.Detail.Role != "assistant" || itemStarted.Item.Detail.Model != "gpt-test" {
		t.Fatalf("item.started detail = %+v", itemStarted.Item.Detail)
	}

	delta := decodePayload[deltaPayload](t, decodeEvent(t, frames[3].data))
	if delta.ItemID != "item-fixed" || delta.Chunk != "你" {
		t.Fatalf("delta = %+v", delta)
	}

	completed := decodePayload[timelinePayload](t, decodeEvent(t, frames[5].data))
	if completed.Item.Status != "completed" || completed.Item.Content != "你好" {
		t.Fatalf("item.completed = %+v", completed.Item)
	}
	if completed.Item.Detail.Metrics == nil {
		t.Fatal("item.completed 缺少 metrics")
	}
	metrics := completed.Item.Detail.Metrics
	if metrics.InputTokens == nil || *metrics.InputTokens != 12 {
		t.Fatalf("inputTokens = %v", metrics.InputTokens)
	}
	if metrics.OutputTokens == nil || *metrics.OutputTokens != 2 {
		t.Fatalf("outputTokens = %v", metrics.OutputTokens)
	}
	if metrics.DurationMS != 0 {
		t.Fatalf("durationMs = %d, want 0（固定时钟）", metrics.DurationMS)
	}
	if metrics.TTFTMS == nil || *metrics.TTFTMS != 0 {
		t.Fatalf("ttftMs = %v, want 0", metrics.TTFTMS)
	}

	turnEnd := decodePayload[turnCompletedPayload](t, decodeEvent(t, frames[6].data))
	if turnEnd.State != "idle" {
		t.Fatalf("turn.completed state = %q", turnEnd.State)
	}

	successes, failures := testRig.attempts.counts()
	if successes != 1 || failures != 0 {
		t.Fatalf("尝试记账 = %d 成功 / %d 失败", successes, failures)
	}
	usages := testRig.usage.collected()
	if len(usages) != 1 || usages[0].InputTokens() != 12 || usages[0].OutputTokens() != 2 {
		t.Fatalf("用量记账 = %+v", usages)
	}
}

// 上游要求的上游请求形状：模型、单轮正文、stream、include_usage、Bearer 鉴权。
func TestHandleTurnBuildsUpstreamRequest(t *testing.T) {
	testRig := newRig(t, []accountcore.AccountRef{accountA}, respondWith(sseResponse(okStream()), nil), nil)
	testRig.post(t, submitBody, nil)

	requests, bodies := testRig.client.sent()
	if len(requests) != 1 {
		t.Fatalf("上游请求数 = %d", len(requests))
	}
	if requests[0].URL.String() != "https://upstream.test/v1/chat/completions" {
		t.Fatalf("上游 URL = %q", requests[0].URL.String())
	}
	if requests[0].Header.Get("Authorization") != "Bearer test-token" {
		t.Fatalf("Authorization = %q", requests[0].Header.Get("Authorization"))
	}
	var payload struct {
		Model    string              `json:"model"`
		Stream   bool                `json:"stream"`
		Messages []map[string]string `json:"messages"`
		Options  map[string]any      `json:"stream_options"`
	}
	if err := jsonUnmarshal(bodies[0], &payload); err != nil {
		t.Fatalf("上游请求体解码失败: %v", err)
	}
	if payload.Model != "gpt-test" || !payload.Stream {
		t.Fatalf("上游请求 = %+v", payload)
	}
	if len(payload.Messages) != 1 || payload.Messages[0]["role"] != "user" || payload.Messages[0]["content"] != "你好" {
		t.Fatalf("messages = %+v", payload.Messages)
	}
	if include, _ := payload.Options["include_usage"].(bool); !include {
		t.Fatalf("stream_options = %+v", payload.Options)
	}
}

// 可换号的失败：第一个账号 429，第二个账号成功；只记一次失败、一次成功。
func TestHandleTurnRotatesAccountOnRetryableFailure(t *testing.T) {
	var calls atomic.Int32
	respond := func(*http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			return jsonResponse(http.StatusTooManyRequests, `{"error":{"message":"rate limited"}}`), nil
		}
		return sseResponse(okStream()), nil
	}
	testRig := newRig(t, []accountcore.AccountRef{accountA, accountB}, respond, nil)
	recorder := testRig.post(t, submitBody, nil)

	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, want 200, body = %s", recorder.Code, recorder.Body.String())
	}
	attempted := testRig.credentials.attempted()
	if len(attempted) != 2 || attempted[0] != accountA || attempted[1] != accountB {
		t.Fatalf("征召顺序 = %v", attempted)
	}
	successes, failures := testRig.attempts.counts()
	if successes != 1 || failures != 1 {
		t.Fatalf("尝试记账 = %d 成功 / %d 失败", successes, failures)
	}
}

// 上游 5xx 且没有别的账号：交付上游状态码与上游文案，而不是洗成网关自有错误。
func TestHandleTurnReportsUpstreamHTTPFailure(t *testing.T) {
	testRig := newRig(
		t,
		[]accountcore.AccountRef{accountA},
		respondWith(jsonResponse(http.StatusInternalServerError, `{"error":{"message":"upstream exploded"}}`), nil),
		nil,
	)
	recorder := testRig.post(t, submitBody, nil)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("状态码 = %d, want 500", recorder.Code)
	}
	body := decodeRouteError(t, recorder)
	if body.Error != "chat_upstream_error" || body.Message != "upstream exploded" {
		t.Fatalf("错误体 = %+v", body)
	}
	if strings.Contains(recorder.Body.String(), "text/event-stream") {
		t.Fatal("失败时不应该写 SSE")
	}
}

// 上游 401 是账号问题，不是本机调用方没登录：折成 502，避免前端被踢回登录页。
func TestHandleTurnMapsUpstreamAuthFailureToGatewayError(t *testing.T) {
	testRig := newRig(
		t,
		[]accountcore.AccountRef{accountA},
		respondWith(jsonResponse(http.StatusUnauthorized, `{"error":{"message":"bad token"}}`), nil),
		nil,
	)
	recorder := testRig.post(t, submitBody, nil)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("状态码 = %d, want 502", recorder.Code)
	}
	if body := decodeRouteError(t, recorder); body.Error != "chat_upstream_error" {
		t.Fatalf("错误码 = %q", body.Error)
	}
}

// 传输层失败：网关自有错误，不冒充上游状态。
func TestHandleTurnReportsTransportFailure(t *testing.T) {
	testRig := newRig(
		t,
		[]accountcore.AccountRef{accountA},
		respondWith(nil, errors.New("dial tcp: connection refused")),
		nil,
	)
	recorder := testRig.post(t, submitBody, nil)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("状态码 = %d, want 502", recorder.Code)
	}
	if body := decodeRouteError(t, recorder); body.Error != "chat_upstream_unavailable" {
		t.Fatalf("错误码 = %q", body.Error)
	}
}

// 账号调度不可用（来源报错）与没有可用账号是两种不同的 503。
func TestHandleTurnReportsAccountSelectionFailure(t *testing.T) {
	t.Run("账号来源报错", func(t *testing.T) {
		testRig := newRig(t, nil, respondWith(sseResponse(okStream()), nil), func(dependencies *Dependencies) {
			dependencies.Accounts = &testAccounts{err: errors.New("catalog unavailable")}
		})
		recorder := testRig.post(t, submitBody, nil)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("状态码 = %d, want 503", recorder.Code)
		}
		if body := decodeRouteError(t, recorder); body.Error != "chat_runtime_unavailable" {
			t.Fatalf("错误码 = %q", body.Error)
		}
	})

	t.Run("账号池为空", func(t *testing.T) {
		testRig := newRig(t, nil, respondWith(sseResponse(okStream()), nil), nil)
		recorder := testRig.post(t, submitBody, nil)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("状态码 = %d, want 503", recorder.Code)
		}
		if body := decodeRouteError(t, recorder); body.Error != "chat_account_unavailable" {
			t.Fatalf("错误码 = %q", body.Error)
		}
	})

	t.Run("凭据解析失败", func(t *testing.T) {
		testRig := newRig(t, []accountcore.AccountRef{accountA, accountB}, respondWith(sseResponse(okStream()), nil), nil)
		testRig.credentials.resolveErr = errors.New("credential store unavailable")
		recorder := testRig.post(t, submitBody, nil)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("状态码 = %d, want 503", recorder.Code)
		}
		if body := decodeRouteError(t, recorder); body.Error != "chat_account_unavailable" {
			t.Fatalf("错误码 = %q", body.Error)
		}
		if len(testRig.credentials.attempted()) != 2 {
			t.Fatalf("凭据失败应当换号重试，实际尝试 = %v", testRig.credentials.attempted())
		}
		if requests, _ := testRig.client.sent(); len(requests) != 0 {
			t.Fatalf("凭据失败不该触网，实际请求数 = %d", len(requests))
		}
	})
}

// 钉选账号：只用指定账号，不换号。
func TestHandleTurnUsesPinnedAccount(t *testing.T) {
	testRig := newRig(t, []accountcore.AccountRef{accountA, accountB}, respondWith(sseResponse(okStream()), nil), nil)
	recorder := testRig.post(t, submitBody, map[string]string{inferenceapi.AccountRefHeader: accountB.String()})
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, want 200", recorder.Code)
	}
	attempted := testRig.credentials.attempted()
	if len(attempted) != 1 || attempted[0] != accountB {
		t.Fatalf("征召结果 = %v, want [%s]", attempted, accountB)
	}
}

// 钉选的账号不在账号池里：明确报没有可用账号，而不是偷偷换号。
func TestHandleTurnRejectsUnknownPinnedAccount(t *testing.T) {
	testRig := newRig(t, []accountcore.AccountRef{accountA}, respondWith(sseResponse(okStream()), nil), nil)
	recorder := testRig.post(t, submitBody, map[string]string{inferenceapi.AccountRefHeader: accountB.String()})
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("状态码 = %d, want 503", recorder.Code)
	}
	if body := decodeRouteError(t, recorder); body.Error != "chat_account_unavailable" {
		t.Fatalf("错误码 = %q", body.Error)
	}
	if requests, _ := testRig.client.sent(); len(requests) != 0 {
		t.Fatalf("钉选失败不该触网，实际请求数 = %d", len(requests))
	}
}

// 非规范钉选请求头：400，不进入账号选择。
func TestHandleTurnRejectsMalformedPinnedHeader(t *testing.T) {
	testRig := newRig(t, []accountcore.AccountRef{accountA}, respondWith(sseResponse(okStream()), nil), nil)
	recorder := testRig.post(t, submitBody, map[string]string{inferenceapi.AccountRefHeader: "not-an-account-ref"})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("状态码 = %d, want 400", recorder.Code)
	}
	if body := decodeRouteError(t, recorder); body.Error != "invalid_account_ref_header" {
		t.Fatalf("错误码 = %q", body.Error)
	}
}

// 提交前的业务错误信封：200 + {"error":...} 不能当成成功流。
func TestHandleTurnRejectsUpstreamErrorEnvelope(t *testing.T) {
	testRig := newRig(
		t,
		[]accountcore.AccountRef{accountA},
		respondWith(sseResponse(frame(`{"error":{"message":"quota exhausted"}}`)), nil),
		nil,
	)
	recorder := testRig.post(t, submitBody, nil)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("状态码 = %d, want 502", recorder.Code)
	}
	if body := decodeRouteError(t, recorder); body.Message != "quota exhausted" {
		t.Fatalf("错误体 = %+v", body)
	}
}

// 上游忽略 stream:true 时按整段聚合成一块增量，前端仍然看到完整流。
func TestHandleTurnAggregatesNonStreamingUpstream(t *testing.T) {
	document := `{"choices":[{"message":{"role":"assistant","content":"整段"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}`
	testRig := newRig(t, []accountcore.AccountRef{accountA}, respondWith(jsonResponse(http.StatusOK, document), nil), nil)
	recorder := testRig.post(t, submitBody, nil)

	frames := parseFrames(t, recorder.Body.String())
	if len(frames) != 6 {
		t.Fatalf("事件数 = %d: %+v", len(frames), frames)
	}
	completed := decodePayload[timelinePayload](t, decodeEvent(t, frames[4].data))
	if completed.Item.Content != "整段" {
		t.Fatalf("item.completed = %+v", completed.Item)
	}
	if completed.Item.Detail.Metrics.OutputTokens == nil || *completed.Item.Detail.Metrics.OutputTokens != 3 {
		t.Fatalf("metrics = %+v", completed.Item.Detail.Metrics)
	}
}

// 中途断流：已经开始的条目要收口成 failed，并交付 turn.failed；不记用量。
func TestHandleTurnFailsMidStream(t *testing.T) {
	body := &errorAfterReader{
		data: []byte(frame(`{"choices":[{"delta":{"content":"半句"}}]}`)),
		err:  errors.New("connection reset by peer"),
	}
	response := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(body),
	}
	testRig := newRig(t, []accountcore.AccountRef{accountA}, respondWith(response, nil), nil)
	recorder := testRig.post(t, submitBody, nil)

	frames := parseFrames(t, recorder.Body.String())
	wantEvents := []string{
		"turn.queued",
		"turn.started",
		"timeline.item.started",
		"timeline.item.delta",
		"timeline.item.completed",
		"turn.failed",
	}
	if len(frames) != len(wantEvents) {
		t.Fatalf("事件数 = %d: %+v", len(frames), frames)
	}
	for index, frame := range frames {
		if frame.event != wantEvents[index] {
			t.Fatalf("第 %d 个事件 = %s, want %s", index, frame.event, wantEvents[index])
		}
	}
	completed := decodePayload[timelinePayload](t, decodeEvent(t, frames[4].data))
	if completed.Item.Status != "failed" || completed.Item.Content != "半句" {
		t.Fatalf("item.completed = %+v", completed.Item)
	}
	failed := decodePayload[turnFailedPayload](t, decodeEvent(t, frames[5].data))
	if failed.State != "idle" || !failed.Retryable || failed.Error.Code != "chat_upstream_stream_failed" {
		t.Fatalf("turn.failed = %+v", failed)
	}
	if usages := testRig.usage.collected(); len(usages) != 0 {
		t.Fatalf("断流不应记用量，实际 = %+v", usages)
	}
	if _, failures := testRig.attempts.counts(); failures != 1 {
		t.Fatalf("失败记账 = %d, want 1", failures)
	}
}

// 空回复：不建空气泡，只交付轮次终态。
func TestHandleTurnSkipsEmptyReply(t *testing.T) {
	testRig := newRig(t, []accountcore.AccountRef{accountA}, respondWith(sseResponse(frame("[DONE]")), nil), nil)
	recorder := testRig.post(t, submitBody, nil)
	frames := parseFrames(t, recorder.Body.String())
	if len(frames) != 3 {
		t.Fatalf("事件数 = %d: %+v", len(frames), frames)
	}
	if frames[2].event != "turn.completed" {
		t.Fatalf("最后一个事件 = %s", frames[2].event)
	}
}

// 心跳：上游静默期间要持续写注释帧，避免代理把连接当空闲。
func TestHandleTurnWritesHeartbeat(t *testing.T) {
	response := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body: io.NopCloser(&delayedReader{
			chunks: [][]byte{
				[]byte(frame(`{"choices":[{"delta":{"content":"慢"}}]}`)),
				[]byte(frame("[DONE]")),
			},
			delay: 80 * time.Millisecond,
		}),
	}
	testRig := newRig(t, []accountcore.AccountRef{accountA}, respondWith(response, nil), func(dependencies *Dependencies) {
		dependencies.HeartbeatInterval = 5 * time.Millisecond
	})
	recorder := testRig.post(t, submitBody, nil)
	if !strings.Contains(recorder.Body.String(), heartbeatFrame) {
		t.Fatalf("没有心跳帧: %s", recorder.Body.String())
	}
}

// 请求边界：路径与方法不匹配时给出明确 404/405。
func TestHandleTurnRouteBoundaries(t *testing.T) {
	testRig := newRig(t, []accountcore.AccountRef{accountA}, respondWith(sseResponse(okStream()), nil), nil)

	request := httptest.NewRequest(http.MethodGet, commandPath, nil)
	recorder := httptest.NewRecorder()
	testRig.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("GET 结果 = %d, Allow = %q", recorder.Code, recorder.Header().Get("Allow"))
	}
	if body := decodeRouteError(t, recorder); body.Error != "chat_runtime_method_not_allowed" {
		t.Fatalf("错误码 = %q", body.Error)
	}

	other := httptest.NewRequest(http.MethodPost, CollectionPath+"s-1/events", strings.NewReader(submitBody))
	recorder = httptest.NewRecorder()
	testRig.handler.ServeHTTP(recorder, other)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("未知路径状态码 = %d", recorder.Code)
	}
}

// 客户端断开：上游请求必须随请求上下文一起取消，不能留在后台空转。
func TestHandleTurnCancelsUpstreamOnClientDisconnect(t *testing.T) {
	body := &blockingBody{first: []byte(frame(`{"choices":[{"delta":{"content":"开头"}}]}`)), done: make(chan struct{})}
	upstreamCanceled := make(chan struct{})
	var once sync.Once
	testRig := newRig(t, []accountcore.AccountRef{accountA}, func(request *http.Request) (*http.Response, error) {
		go func() {
			<-request.Context().Done()
			once.Do(func() { close(upstreamCanceled) })
			body.release(context.Canceled)
		}()
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       body,
		}, nil
	}, nil)

	server := httptest.NewServer(testRig.handler)
	defer server.Close()

	response, err := http.Post(server.URL+commandPath, "application/json", strings.NewReader(submitBody))
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	buffer := make([]byte, 32)
	if _, err := response.Body.Read(buffer); err != nil {
		t.Fatalf("没有读到首帧: %v", err)
	}
	_ = response.Body.Close()

	select {
	case <-upstreamCanceled:
	case <-time.After(3 * time.Second):
		t.Fatal("客户端断开后上游请求没有被取消")
	}
}

// metrics 规则与 Node turn-metrics-repository.finishInTransaction 对齐。
func TestTurnMetricsRules(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	usage, err := inference.NewUsage(inference.UsageInput{InputTokens: 100, OutputTokens: 50})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}

	turn := &turnState{startedAt: base, firstTokenAt: base.Add(200 * time.Millisecond)}
	metrics := turn.metrics(base.Add(1200*time.Millisecond), usage, true)
	if metrics.DurationMS != 1200 {
		t.Fatalf("durationMs = %d", metrics.DurationMS)
	}
	if metrics.TTFTMS == nil || *metrics.TTFTMS != 200 {
		t.Fatalf("ttftMs = %v", metrics.TTFTMS)
	}
	if metrics.TokensPerSec == nil || *metrics.TokensPerSec != 50 {
		t.Fatalf("tokensPerSec = %v", metrics.TokensPerSec)
	}

	// 解码窗口不足 500ms 时不给吞吐：样本太短，数字只会误导。
	shortTurn := &turnState{startedAt: base, firstTokenAt: base.Add(100 * time.Millisecond)}
	short := shortTurn.metrics(base.Add(400*time.Millisecond), usage, true)
	if short.TokensPerSec != nil {
		t.Fatalf("短样本不该给 tokensPerSec: %v", *short.TokensPerSec)
	}

	// ttft 不能超过总时长（时钟回拨或上游异常时可能发生）。
	clampedTurn := &turnState{startedAt: base, firstTokenAt: base.Add(5 * time.Second)}
	clamped := clampedTurn.metrics(base.Add(time.Second), usage, true)
	if clamped.TTFTMS == nil || *clamped.TTFTMS != 1000 {
		t.Fatalf("ttftMs = %v, want 1000", clamped.TTFTMS)
	}

	// 没有用量时不编造 token 字段。
	noUsage := (&turnState{startedAt: base}).metrics(base.Add(time.Second), inference.Usage{}, false)
	if noUsage.InputTokens != nil || noUsage.OutputTokens != nil || noUsage.TTFTMS != nil {
		t.Fatalf("无用量时不该有 token 字段: %+v", noUsage)
	}
	if noUsage.DurationMS != 1000 {
		t.Fatalf("durationMs = %d", noUsage.DurationMS)
	}
}

// errorAfterReader 先返回预置字节，再返回固定错误。
type errorAfterReader struct {
	data []byte
	err  error
}

func (reader *errorAfterReader) Read(payload []byte) (int, error) {
	if len(reader.data) > 0 {
		read := copy(payload, reader.data)
		reader.data = reader.data[read:]
		return read, nil
	}
	return 0, reader.err
}

// delayedReader 读完预置块后先等 delay 再 EOF，用来触发心跳。
type delayedReader struct {
	chunks [][]byte
	index  int
	delay  time.Duration
}

func (reader *delayedReader) Read(payload []byte) (int, error) {
	if reader.index >= len(reader.chunks) {
		return 0, io.EOF
	}
	if reader.index > 0 {
		// 块与块之间等待：这段静默期正是心跳该出现的地方。
		time.Sleep(reader.delay)
	}
	read := copy(payload, reader.chunks[reader.index])
	reader.index++
	return read, nil
}

// blockingBody 交付首块后一直阻塞，直到被显式释放。
type blockingBody struct {
	first []byte
	sent  bool
	done  chan struct{}
	err   error
	once  sync.Once
}

func (body *blockingBody) Read(payload []byte) (int, error) {
	if !body.sent {
		body.sent = true
		return copy(payload, body.first), nil
	}
	<-body.done
	return 0, body.err
}

func (body *blockingBody) Close() error {
	body.release(io.EOF)
	return nil
}

func (body *blockingBody) release(err error) {
	body.once.Do(func() {
		body.err = err
		close(body.done)
	})
}
