package codexresponseshttp

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

const completedEvent = "event: response.completed\r\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2}},\"future\":9007199254740993}\r\n\r\n"

func TestNativeBytesAndCompression(t *testing.T) {
	for _, encoding := range []string{"identity", "gzip", "zstd"} {
		t.Run(encoding, func(t *testing.T) {
			payload := []byte(`{ "model":"gpt-native", "stream":true, "previous_response_id":"resp_old", "future":9007199254740993 }`)
			var buffer bytes.Buffer
			switch encoding {
			case "gzip":
				writer := gzip.NewWriter(&buffer)
				_, _ = writer.Write(payload)
				_ = writer.Close()
				payload = buffer.Bytes()
			case "zstd":
				writer, _ := zstd.NewWriter(nil)
				payload = writer.EncodeAll(payload, nil)
				writer.Close()
			}
			upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				body, _ := io.ReadAll(request.Body)
				if !bytes.Equal(body, payload) || request.URL.Path != "/v1/responses" {
					t.Errorf("request changed: %s", body)
				}
				if request.Header.Get("Authorization") != "Bearer synthetic-upstream-0" || request.Header.Get("X-Account-Ref") != "" || request.Header.Get("Cookie") != "" {
					t.Error("credential boundary violated")
				}
				if request.Header.Get("User-Agent") != "codex_exec/0.159.0" || request.Header.Get("X-Codex-Turn-Metadata") != `{"turn":1}` {
					t.Error("client identity dropped")
				}
				response.Header().Set("Content-Type", "text/event-stream")
				response.Header().Set("X-Request-Id", "req_native")
				_, _ = io.WriteString(response, ": heartbeat\r\nevent: future\r\ndata: {\"opaque\":9007199254740993}\r\n\r\n"+completedEvent)
			}))
			defer upstream.Close()
			handler, recorder, source := fixture(t, upstream.URL, 1)
			request := nativeRequestFor(payload)
			request.Header.Set("Content-Encoding", encoding)
			request.Header.Set("Originator", "codex_exec")
			request.Header.Set("User-Agent", "codex_exec/0.159.0")
			request.Header.Set("X-Codex-Turn-Metadata", `{"turn":1}`)
			request.Header.Set("Cookie", "never-forward")
			request.Header.Set("X-Account-Ref", string(source.selections[0].AccountRef))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != 200 || response.Body.String() != ": heartbeat\r\nevent: future\r\ndata: {\"opaque\":9007199254740993}\r\n\r\n"+completedEvent {
				t.Fatalf("response=%d %q", response.Code, response.Body.String())
			}
			if response.Header().Get("X-Request-Id") != "req_native" || source.pinned != source.selections[0].AccountRef {
				t.Fatal("routing metadata lost")
			}
			if len(recorder.successes) != 1 || len(recorder.failures) != 0 {
				t.Fatalf("attempts=%+v", recorder)
			}
			if usage, ok := recorder.successes[0].Usage(); !ok || usage.TotalTokens() != 5 {
				t.Fatal("usage not recorded")
			}
		})
	}
}

func TestLastUpstreamErrorSurvivesExhaustion(t *testing.T) {
	for _, status := range []int{400, 401, 429, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			body := "{ \"error\": {\"message\":\"original upstream failure\",\"code\":\"fixture\"},\"opaque\":9007199254740993 }"
			upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls++
				response.Header().Set("Content-Type", "application/json")
				response.Header().Set("Retry-After", "7")
				response.Header().Set("Connection", "X-Private-Hop")
				response.Header().Set("X-Private-Hop", "not-forwarded")
				response.WriteHeader(status)
				_, _ = io.WriteString(response, body)
			}))
			defer upstream.Close()
			handler, recorder, _ := fixture(t, upstream.URL, 2)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
			if response.Code != status || response.Body.String() != body || response.Header().Get("Retry-After") != "7" {
				t.Fatalf("error changed: %d %q", response.Code, response.Body.String())
			}
			if response.Header().Get("X-Private-Hop") != "" {
				t.Fatal("hop header leaked")
			}
			wantCalls := 2
			if status == 400 {
				wantCalls = 1
			}
			if calls != wantCalls || len(recorder.failures) != wantCalls {
				t.Fatalf("calls=%d failures=%d", calls, len(recorder.failures))
			}
		})
	}
}

func TestSafetyRejectionIsNormalizedAndNeverRotated(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		response.WriteHeader(400)
		_, _ = io.WriteString(response, `{"error":{"code":"content_policy_violation","message":"private safety reason"}}`)
	}))
	defer upstream.Close()
	handler, recorder, _ := fixture(t, upstream.URL, 2)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
	if response.Code != 403 || calls != 1 || !strings.Contains(response.Body.String(), "upstream_safety_rejected") || strings.Contains(response.Body.String(), "private safety") {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, calls, response.Body.String())
	}
	if len(recorder.failures) != 1 || recorder.failures[0].RuntimeKind() != runtimecore.FailureSafetyRejected {
		t.Fatal("wrong classification")
	}
}

func TestFallbackRetainsOriginalRequest(t *testing.T) {
	handler, _, source := fixture(t, "http://127.0.0.1:1/v1", 1)
	source.notNative = true
	payload := []byte(`{ "model":"cross-protocol-alias", "future":9007199254740993 }`)
	handler.Fallback = http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		if !bytes.Equal(body, payload) {
			t.Fatal("canonical fallback lost bytes")
		}
		response.WriteHeader(202)
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, nativeRequestFor(payload))
	if response.Code != 202 {
		t.Fatalf("fallback=%d", response.Code)
	}
}

func TestStreamingIsImmediateAndCancellationDoesNotPenalize(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		t.Run(fmt.Sprint(disconnect), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				response.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(response, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\n\n")
				response.(http.Flusher).Flush()
			}))
			defer upstream.Close()
			handler, recorder, _ := fixture(t, upstream.URL, 2)
			response := &testWriter{ResponseRecorder: httptest.NewRecorder(), disconnect: disconnect}
			handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native","stream":true}`)))
			if len(recorder.successes) != 0 {
				t.Fatal("incomplete stream counted as success")
			}
			if disconnect && len(recorder.failures) != 0 {
				t.Fatal("downstream disconnect penalized account")
			}
			if !disconnect && (len(recorder.failures) != 1 || !response.Flushed) {
				t.Fatal("upstream disconnect not observed or stream buffered")
			}
		})
	}
}

func TestStreamingFirstByteArrivesBeforeUpstreamCompletes(testContext *testing.T) {
	finish := make(chan struct{})
	var release sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(response, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\n\n")
		response.(http.Flusher).Flush()
		select {
		case <-finish:
			_, _ = io.WriteString(response, completedEvent)
		case <-request.Context().Done():
		}
	}))
	defer upstream.Close()
	defer release.Do(func() { close(finish) })
	handler, _, _ := fixture(testContext, upstream.URL, 1)
	gateway := httptest.NewServer(handler)
	defer gateway.Close()
	client := &http.Client{Timeout: 2 * time.Second}
	request, err := http.NewRequest(http.MethodPost, gateway.URL, strings.NewReader(`{"model":"gpt-native","stream":true}`))
	if err != nil {
		testContext.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer synthetic-client")
	response, err := client.Do(request)
	if err != nil {
		testContext.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(line, "first") {
		testContext.Fatalf("first byte buffered: line=%q error=%v", line, err)
	}
	release.Do(func() { close(finish) })
	rest, err := io.ReadAll(reader)
	if err != nil || !strings.Contains(string(rest), "response.completed") {
		testContext.Fatalf("terminal event lost: %q error=%v", rest, err)
	}
}

func TestStaleCredentialsDoNotMutateRuntime(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(401)
		_, _ = io.WriteString(response, `{"error":{"message":"rejected"}}`)
	}))
	defer upstream.Close()
	handler, recorder, _ := fixture(t, upstream.URL, 1)
	recorder.current = false
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, nativeRequestFor([]byte(`{"model":"gpt-native"}`)))
	if response.Code != 401 || len(recorder.failures) != 0 {
		t.Fatal("stale credentials affected runtime")
	}
}

func TestAuthenticationAndHopRejectedBeforeRouting(t *testing.T) {
	for _, kind := range []string{"auth", "hop", "pin"} {
		t.Run(kind, func(t *testing.T) {
			handler, _, source := fixture(t, "http://127.0.0.1:1", 1)
			request := nativeRequestFor([]byte(`{"model":"gpt-native"}`))
			want := 401
			switch kind {
			case "auth":
				request.Header.Del("Authorization")
			case "hop":
				request.Header.Set(responses.NativeHopHeader, "1")
				want = 508
			case "pin":
				request.Header.Set("X-Account-Ref", "31")
				want = 400
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != want || source.opened {
				t.Fatalf("response=%d opened=%t", response.Code, source.opened)
			}
		})
	}
}

type testWriter struct {
	*httptest.ResponseRecorder
	disconnect bool
}

func (writer *testWriter) Write(payload []byte) (int, error) {
	if writer.disconnect {
		return 0, io.ErrClosedPipe
	}
	return writer.ResponseRecorder.Write(payload)
}

type testSource struct {
	selections        []Selection
	opened, notNative bool
	pinned            accountcore.AccountRef
}

func (source *testSource) Open(ctx context.Context, _ string) (Cursor, error) {
	source.opened = true
	source.pinned, _ = inferencegateway.PinnedAccount(ctx)
	if source.notNative {
		return nil, ErrNotNativeRoute
	}
	return &testCursor{selections: append([]Selection(nil), source.selections...)}, nil
}

type testCursor struct{ selections []Selection }

func (cursor *testCursor) Next(context.Context) (Selection, bool, error) {
	if len(cursor.selections) == 0 {
		return Selection{}, false, nil
	}
	selection := cursor.selections[0]
	cursor.selections = cursor.selections[1:]
	return selection, true, nil
}

type testAuthorizer struct{}

func (testAuthorizer) Authorized(request *http.Request) bool {
	return request.Header.Get("Authorization") == "Bearer synthetic-client"
}

type testRecorder struct {
	mu        sync.Mutex
	current   bool
	successes []inferencegateway.AttemptSuccess
	failures  []inferencegateway.AttemptFailure
}

func (recorder *testRecorder) RecordSuccess(_ context.Context, _ runtimecore.ModelRoute, success inferencegateway.AttemptSuccess) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.successes = append(recorder.successes, success)
	return nil
}
func (recorder *testRecorder) RecordFailure(_ context.Context, _ runtimecore.ModelRoute, failure inferencegateway.AttemptFailure) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.failures = append(recorder.failures, failure)
	return nil
}
func (recorder *testRecorder) IsCurrentCredentialObservation(context.Context, accountcredentials.CredentialObservation) (bool, error) {
	return recorder.current, nil
}
func (*testRecorder) ScheduleModelRefresh(context.Context, accountcore.AccountRef, string) error {
	return nil
}

func fixture(t *testing.T, upstream string, accounts int) (*Handler, *testRecorder, *testSource) {
	t.Helper()
	clock := func() time.Time { return time.Date(2026, 9, 30, 1, 0, 0, 0, time.UTC) }
	source := &testSource{}
	for index := 0; index < accounts; index++ {
		credential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{APIKey: fmt.Sprintf("synthetic-upstream-%d", index), BaseURL: strings.TrimSuffix(upstream, "/v1") + "/v1"})
		if err != nil {
			t.Fatal(err)
		}
		ref, _ := accountcore.ParseAccountRef(fmt.Sprintf("acct_%020x", index+1))
		snapshot, err := accountapp.NewCredentialSnapshot(ref, "codex", credential, clock())
		if err != nil {
			t.Fatal(err)
		}
		observation, err := accountcredentials.NewCredentialObservation(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		source.selections = append(source.selections, Selection{AccountRef: ref, Credential: credential, Observation: observation})
	}
	adapter, err := responses.NewAdapter(&http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, clock)
	if err != nil {
		t.Fatal(err)
	}
	recorder := &testRecorder{current: true}
	handler, err := NewHandler(Dependencies{Authorizer: testAuthorizer{}, Accounts: source, Upstream: adapter, Fallback: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) { response.WriteHeader(418) }), Attempts: recorder, Credentials: recorder, ModelRefreshes: recorder, Clock: clock})
	if err != nil {
		t.Fatal(err)
	}
	return handler, recorder, source
}

func nativeRequestFor(payload []byte) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "http://gateway.invalid/v1/responses", bytes.NewReader(payload))
	request.Header.Set("Authorization", "Bearer synthetic-client")
	request.Header.Set("Content-Type", "application/json")
	return request
}

// deadlineTrackingWriter 记录每次写截止时间的取值，模拟支持 SetWriteDeadline 的连接。
type deadlineTrackingWriter struct {
	header    http.Header
	body      bytes.Buffer
	deadlines []time.Time
}

func (writer *deadlineTrackingWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = http.Header{}
	}
	return writer.header
}

func (writer *deadlineTrackingWriter) WriteHeader(int) {}

func (writer *deadlineTrackingWriter) Write(payload []byte) (int, error) {
	return writer.body.Write(payload)
}

func (writer *deadlineTrackingWriter) Flush() {}

func (writer *deadlineTrackingWriter) SetWriteDeadline(deadline time.Time) error {
	writer.deadlines = append(writer.deadlines, deadline)
	return nil
}

// chunkReader 每次只交付一块，确保复制循环真的走了多轮。
type chunkReader struct {
	chunks [][]byte
	index  int
}

func (reader *chunkReader) Read(target []byte) (int, error) {
	if reader.index >= len(reader.chunks) {
		return 0, io.EOF
	}
	count := copy(target, reader.chunks[reader.index])
	reader.index++
	return count, nil
}

// TestCopyBodyRefreshesWriteDeadlinePerChunk 锁定 G3：长推理流的断开判据必须是
// 「持续没有数据」，而不是请求开始时定下的绝对截止时间。旧实现只在 Server 配置里
// 设一次 10 分钟 WriteTimeout，第 10 分钟必被硬切断。
func TestCopyBodyRefreshesWriteDeadlinePerChunk(t *testing.T) {
	t.Parallel()

	writer := &deadlineTrackingWriter{}
	source := &chunkReader{chunks: [][]byte{[]byte("a"), []byte("b"), []byte("c")}}
	startedBefore := time.Now()
	upstreamErr, downstreamErr := copyBody(writer, source)
	if upstreamErr != nil || downstreamErr != nil {
		t.Fatalf("copyBody() = %v, %v", upstreamErr, downstreamErr)
	}
	if writer.body.String() != "abc" {
		t.Fatalf("body = %q, want %q", writer.body.String(), "abc")
	}
	if len(writer.deadlines) != len(source.chunks) {
		t.Fatalf("write deadlines = %d, want one per chunk (%d)", len(writer.deadlines), len(source.chunks))
	}
	// 每次交付都要把 deadline 推到「当前时刻 + 空闲窗口」，且必须基于真实时间：
	// 早于起始时刻的值说明 deadline 没有随交付推进。
	earliest := startedBefore.Add(inferenceapi.StreamIdleTimeout / 2)
	for index, deadline := range writer.deadlines {
		if deadline.Before(earliest) {
			t.Fatalf("deadline[%d] = %v, want at least %v", index, deadline, earliest)
		}
	}
}

// TestCopyBodyToleratesConnectionsWithoutWriteDeadline 验证不支持写 deadline 的
// ResponseWriter 不会让交付失败（httptest.ResponseRecorder 即此类）。
func TestCopyBodyToleratesConnectionsWithoutWriteDeadline(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	upstreamErr, downstreamErr := copyBody(recorder, strings.NewReader("payload"))
	if upstreamErr != nil || downstreamErr != nil {
		t.Fatalf("copyBody() = %v, %v", upstreamErr, downstreamErr)
	}
	if recorder.Body.String() != "payload" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}
