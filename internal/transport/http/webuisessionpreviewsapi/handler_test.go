package webuisessionpreviewsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type stubAuthorizer bool

func (authorizer stubAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

// fakeReader 按 provider/id 返回预设结果；provider 为 "boom" 时 panic，验证 recover。
type fakeReader struct {
	mu       sync.Mutex
	requests []PreviewRequest
	results  map[string]Preview
	errs     map[string]error
	delay    time.Duration
	inFlight int32
	peak     int32
}

func (reader *fakeReader) ReadPreview(ctx context.Context, request PreviewRequest) (Preview, error) {
	current := atomic.AddInt32(&reader.inFlight, 1)
	defer atomic.AddInt32(&reader.inFlight, -1)
	for {
		peak := atomic.LoadInt32(&reader.peak)
		if current <= peak || atomic.CompareAndSwapInt32(&reader.peak, peak, current) {
			break
		}
	}
	reader.mu.Lock()
	reader.requests = append(reader.requests, request)
	reader.mu.Unlock()
	if reader.delay > 0 {
		select {
		case <-time.After(reader.delay):
		case <-ctx.Done():
			return Preview{}, ctx.Err()
		}
	}
	if request.Provider == "boom" {
		panic("读取器爆炸")
	}
	if err, ok := reader.errs[request.Provider+"/"+request.SessionID]; ok {
		return Preview{}, err
	}
	if preview, ok := reader.results[request.Provider+"/"+request.SessionID]; ok {
		return preview, nil
	}
	return Preview{}, ErrSessionNotFound
}

func newTestHandler(t *testing.T, dependencies Dependencies) http.Handler {
	t.Helper()
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func doRequest(t *testing.T, handler http.Handler, method, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, Path, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeResponse(t *testing.T, recorder *httptest.ResponseRecorder) responseView {
	t.Helper()
	var payload responseView
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是合法 JSON: %v (%s)", err, recorder.Body.String())
	}
	return payload
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder) errorView {
	t.Helper()
	var payload errorView
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("错误响应不是合法 JSON: %v (%s)", err, recorder.Body.String())
	}
	return payload
}

func TestRejectsUnauthorized(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(false),
		Reader:     &fakeReader{},
	})
	recorder := doRequest(t, handler, http.MethodPost, `{"sessions":[]}`)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if payload := decodeError(t, recorder); payload.Error != "unauthorized" {
		t.Fatalf("error = %q, want unauthorized", payload.Error)
	}
	if recorder.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("缺少 WWW-Authenticate 头")
	}
}

func TestRejectsNonPost(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Reader:     &fakeReader{},
	})
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		recorder := doRequest(t, handler, method, "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d, want 405", method, recorder.Code)
		}
		if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
			t.Fatalf("%s Allow = %q, want POST", method, allow)
		}
	}
}

func TestEmptyBatchReturnsEmptyList(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Reader:     &fakeReader{},
	})
	cases := []string{"", "{}", `{"sessions":[]}`}
	for _, body := range cases {
		recorder := doRequest(t, handler, http.MethodPost, body)
		if recorder.Code != http.StatusOK {
			t.Fatalf("body %q status = %d, want 200", body, recorder.Code)
		}
		// previews 必须是 [] 而不是 null：前端会直接 .length。
		if !strings.Contains(recorder.Body.String(), `"previews":[]`) {
			t.Fatalf("body %q 响应 = %s, want 空数组", body, recorder.Body.String())
		}
	}
}

func TestRejectsTooManySessions(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Reader:     &fakeReader{},
		MaxBatch:   2,
	})
	body := `{"sessions":[{"provider":"claude","id":"a"},{"provider":"claude","id":"b"},{"provider":"claude","id":"c"}]}`
	recorder := doRequest(t, handler, http.MethodPost, body)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if payload := decodeError(t, recorder); payload.Error != "too_many_sessions" {
		t.Fatalf("error = %q, want too_many_sessions", payload.Error)
	}
}

func TestDefaultBatchLimitIsTwoHundred(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Reader:     &fakeReader{},
	})
	items := make([]string, 0, DefaultMaxBatch+1)
	for index := 0; index <= DefaultMaxBatch; index++ {
		items = append(items, `{"provider":"claude","id":"s"}`)
	}
	recorder := doRequest(t, handler, http.MethodPost, `{"sessions":[`+strings.Join(items, ",")+`]}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

func TestRejectsInvalidJSON(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Reader:     &fakeReader{},
	})
	recorder := doRequest(t, handler, http.MethodPost, `{"sessions":`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if payload := decodeError(t, recorder); payload.Error != "invalid_json_body" {
		t.Fatalf("error = %q, want invalid_json_body", payload.Error)
	}
}

func TestBatchPreservesOrderAndEchoesRefs(t *testing.T) {
	reader := &fakeReader{results: map[string]Preview{
		"claude/one": {Model: "claude-opus", Preview: "第一条回复"},
		"codex/two":  {Model: "gpt-6.1", Preview: "第二条回复"},
	}}
	handler := newTestHandler(t, Dependencies{Authorizer: stubAuthorizer(true), Reader: reader})
	body := `{"sessions":[
		{"provider":"claude","id":"one","projectDirName":"proj","accountRef":"acct_1"},
		{"provider":"codex","id":"two"}
	]}`
	recorder := doRequest(t, handler, http.MethodPost, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	payload := decodeResponse(t, recorder)
	if !payload.OK {
		t.Fatalf("ok = false, want true")
	}
	if len(payload.Previews) != 2 {
		t.Fatalf("previews 数量 = %d, want 2", len(payload.Previews))
	}
	first := payload.Previews[0]
	if first.Provider != "claude" || first.ID != "one" || first.ProjectDirName != "proj" || first.AccountRef != "acct_1" {
		t.Fatalf("首条引用未回显: %+v", first)
	}
	if first.Model != "claude-opus" || first.Preview != "第一条回复" || first.Error != "" {
		t.Fatalf("首条内容 = %+v", first)
	}
	second := payload.Previews[1]
	if second.Provider != "codex" || second.ID != "two" || second.ProjectDirName != "" || second.AccountRef != "" {
		t.Fatalf("次条引用 = %+v", second)
	}
	if second.Model != "gpt-6.1" || second.Preview != "第二条回复" {
		t.Fatalf("次条内容 = %+v", second)
	}
}

func TestPartialFailureKeepsBatch(t *testing.T) {
	reader := &fakeReader{
		results: map[string]Preview{"claude/ok": {Model: "m", Preview: "p"}},
		errs: map[string]error{
			"opencode/unsupported": ErrUnsupportedProvider,
			"claude/missing":       ErrSessionNotFound,
			"claude/traversal":     ErrInvalidSessionRef,
			"claude/broken":        ErrReadFailed,
		},
	}
	handler := newTestHandler(t, Dependencies{Authorizer: stubAuthorizer(true), Reader: reader})
	body := `{"sessions":[
		{"provider":"opencode","id":"unsupported"},
		{"provider":"claude","id":"missing"},
		{"provider":"claude","id":"traversal"},
		{"provider":"claude","id":"broken"},
		{"provider":"boom","id":"panic"},
		{"provider":"claude","id":"ok"}
	]}`
	recorder := doRequest(t, handler, http.MethodPost, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200（单条失败不能拖垮整批）", recorder.Code)
	}
	payload := decodeResponse(t, recorder)
	want := []string{
		errorCodeUnsupportedProvider,
		errorCodeSessionNotFound,
		errorCodeInvalidSessionRef,
		errorCodeReadFailed,
		errorCodeReadFailed,
		"",
	}
	if len(payload.Previews) != len(want) {
		t.Fatalf("previews 数量 = %d, want %d", len(payload.Previews), len(want))
	}
	for index, code := range want {
		if payload.Previews[index].Error != code {
			t.Fatalf("第 %d 条 error = %q, want %q", index, payload.Previews[index].Error, code)
		}
	}
	if last := payload.Previews[len(want)-1]; last.Model != "m" || last.Preview != "p" {
		t.Fatalf("成功条目被污染: %+v", last)
	}
}

func TestSkipsItemsWithoutProviderOrID(t *testing.T) {
	reader := &fakeReader{results: map[string]Preview{"claude/ok": {Model: "m"}}}
	handler := newTestHandler(t, Dependencies{Authorizer: stubAuthorizer(true), Reader: reader})
	body := `{"sessions":[{"provider":"","id":"x"},{"provider":"claude","id":"  "},{"provider":"claude","id":"ok"}]}`
	recorder := doRequest(t, handler, http.MethodPost, body)
	payload := decodeResponse(t, recorder)
	if len(payload.Previews) != 1 || payload.Previews[0].ID != "ok" {
		t.Fatalf("previews = %+v, want 只有 ok", payload.Previews)
	}
}

func TestConcurrencyIsBounded(t *testing.T) {
	reader := &fakeReader{delay: 20 * time.Millisecond}
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		Reader:      reader,
		Concurrency: 3,
	})
	items := make([]string, 0, 12)
	for index := 0; index < 12; index++ {
		items = append(items, `{"provider":"claude","id":"s"}`)
	}
	recorder := doRequest(t, handler, http.MethodPost, `{"sessions":[`+strings.Join(items, ",")+`]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if peak := atomic.LoadInt32(&reader.peak); peak > 3 {
		t.Fatalf("并发峰值 = %d, 超过上限 3", peak)
	}
}

func TestTimeoutMarksUnfinishedItems(t *testing.T) {
	reader := &fakeReader{delay: 5 * time.Second}
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		Reader:      reader,
		Concurrency: 1,
		Timeout:     30 * time.Millisecond,
	})
	body := `{"sessions":[{"provider":"claude","id":"a"},{"provider":"claude","id":"b"}]}`
	started := time.Now()
	recorder := doRequest(t, handler, http.MethodPost, body)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("整批耗时 %v，整体超时没有生效", elapsed)
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	payload := decodeResponse(t, recorder)
	for index, item := range payload.Previews {
		if item.Error != errorCodeTimeout {
			t.Fatalf("第 %d 条 error = %q, want timeout", index, item.Error)
		}
	}
}

func TestNewHandlerRequiresReaderOrHome(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("缺鉴权时 error = %v, want ErrInvalidDependencies", err)
	}
	if _, err := NewHandler(Dependencies{Authorizer: stubAuthorizer(true)}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("缺读取端口时 error = %v, want ErrInvalidDependencies", err)
	}
	handler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer(true), HostHomeDir: t.TempDir()})
	if err != nil {
		t.Fatalf("带 HostHomeDir 时应能构造: %v", err)
	}
	if handler == nil {
		t.Fatalf("handler 为 nil")
	}
}

func TestUnavailableHandlerReturns503(t *testing.T) {
	var handler *Handler
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}
