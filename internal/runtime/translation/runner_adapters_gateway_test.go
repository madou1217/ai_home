package translation

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestExecuteHTTPAdapters(t *testing.T) {
	ctx := context.Background()

	// 1. DeepL 成功
	srvDeepL := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "DeepL-Auth-Key dl-key" {
			t.Errorf("unexpected deepl auth header: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"translations":[{"text":"你好世界"}]}`))
	}))
	defer srvDeepL.Close()

	var deltas []string
	res := ExecuteHTTPAdapter(ctx, "deepl", AdapterInput{
		Text:      "Hello World",
		Source:    "en",
		Target:    "zh-Hans",
		Formality: "formal",
	}, map[string]string{
		"apiKey":   "dl-key",
		"endpoint": srvDeepL.URL,
	}, srvDeepL.Client(), 5*time.Second, func(ev StreamEvent) {
		if ev.Type == "delta" {
			deltas = append(deltas, ev.Content)
		}
	})
	if !res.OK || res.Text != "你好世界" || len(deltas) != 1 || deltas[0] != "你好世界" {
		t.Fatalf("DeepL adapter failed: %+v deltas=%v", res, deltas)
	}

	// 2. Microsoft 429 映射为 retryable 限流错误
	srvMS := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer srvMS.Close()
	msRes := ExecuteHTTPAdapter(ctx, "microsoft", AdapterInput{
		Text:   "Hello",
		Target: "zh-Hans",
	}, map[string]string{
		"apiKey":   "ms-key",
		"endpoint": srvMS.URL,
	}, srvMS.Client(), 5*time.Second, nil)
	if msRes.OK || msRes.Error == nil || msRes.Error.Status != 429 || !msRes.Error.Retryable {
		t.Fatalf("Microsoft 429 mismatch: %+v", msRes)
	}

	// 3. Google v2 成功
	srvGoogle := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Goog-Api-Key") != "g-key" {
			t.Errorf("missing google X-Goog-Api-Key header")
		}
		_, _ = w.Write([]byte(`{"data":{"translations":[{"translatedText":"Bonjour"}]}}`))
	}))
	defer srvGoogle.Close()
	gRes := ExecuteHTTPAdapter(ctx, "google", AdapterInput{
		Text:   "Hello",
		Source: "en",
		Target: "fr",
	}, map[string]string{
		"apiKey":   "g-key",
		"endpoint": srvGoogle.URL,
	}, srvGoogle.Client(), 5*time.Second, nil)
	if !gRes.OK || gRes.Text != "Bonjour" {
		t.Fatalf("Google adapter failed: %+v", gRes)
	}

	// 4. LibreTranslate + OpenAI + Anthropic + OpenAI-Compatible
	srvLibre := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"translatedText":"Ciao"}`))
	}))
	defer srvLibre.Close()
	lRes := ExecuteHTTPAdapter(ctx, "libretranslate", AdapterInput{
		Text:   "Hello",
		Target: "it",
	}, map[string]string{
		"endpoint": srvLibre.URL,
	}, srvLibre.Client(), 5*time.Second, nil)
	if !lRes.OK || lRes.Text != "Ciao" {
		t.Fatalf("libretranslate adapter failed: %+v", lRes)
	}

	srvOpenAI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Hola"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`))
	}))
	defer srvOpenAI.Close()
	oRes := ExecuteHTTPAdapter(ctx, "openai", AdapterInput{
		Text:   "Hello",
		Target: "es",
	}, map[string]string{
		"apiKey":   "o-key",
		"endpoint": srvOpenAI.URL,
		"model":    "gpt-4o-mini",
	}, srvOpenAI.Client(), 5*time.Second, nil)
	if !oRes.OK || oRes.Text != "Hola" || oRes.Usage == nil || oRes.Usage.OutputTokens != 2 {
		t.Fatalf("openai adapter failed: %+v", oRes)
	}

	oCompatRes := ExecuteHTTPAdapter(ctx, "openai-compatible", AdapterInput{
		Text:   "Hello",
		Target: "es",
	}, map[string]string{
		"apiKey":   "o-key",
		"endpoint": srvOpenAI.URL,
		"model":    "qwen-plus",
	}, srvOpenAI.Client(), 5*time.Second, nil)
	if !oCompatRes.OK || oCompatRes.Text != "Hola" {
		t.Fatalf("openai-compatible adapter failed: %+v", oCompatRes)
	}

	srvClaude := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"Hallo"}],"usage":{"input_tokens":4,"output_tokens":1}}`))
	}))
	defer srvClaude.Close()
	cRes := ExecuteHTTPAdapter(ctx, "anthropic", AdapterInput{
		Text:   "Hello",
		Target: "de",
	}, map[string]string{
		"apiKey":   "c-key",
		"endpoint": srvClaude.URL,
		"model":    "claude-sonnet-4",
	}, srvClaude.Client(), 5*time.Second, nil)
	if !cRes.OK || cRes.Text != "Hallo" {
		t.Fatalf("anthropic adapter failed: %+v", cRes)
	}

	// 5. Redirect 拒绝（防止 SSRF / 密钥泄露）
	srvTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"translatedText":"ShouldNotReach"}`))
	}))
	defer srvTarget.Close()
	srvRedirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srvTarget.URL, http.StatusFound)
	}))
	defer srvRedirect.Close()
	rRes := ExecuteHTTPAdapter(ctx, "libretranslate", AdapterInput{
		Text:   "Hello",
		Target: "zh-Hans",
	}, map[string]string{
		"endpoint": srvRedirect.URL,
	}, nil, 5*time.Second, nil)
	if rRes.OK || rRes.Error == nil {
		t.Fatalf("redirect should have been rejected: %+v", rRes)
	}
}

func TestExecuteGatewayStreamAndHumanizeError(t *testing.T) {
	ctx := context.Background()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected gateway path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-gw-key" {
			t.Errorf("unexpected gateway auth header: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		chunks := []string{
			`data: {"choices":[{"delta":{"content":"你好，"}}]}`,
			`data: {"choices":[{"delta":{"content":"世界"}}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}`,
			`data: [DONE]`,
		}
		for _, c := range chunks {
			_, _ = fmt.Fprintf(w, "%s\n\n", c)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer srv.Close()

	var deltas []string
	res := ExecuteGatewayStream(ctx, GatewayConfig{
		BaseURL:          func() string { return srv.URL },
		ClientKey:        func() string { return "test-gw-key" },
		HTTPClient:       srv.Client(),
		FirstByteTimeout: 3 * time.Second,
		IdleTimeout:      3 * time.Second,
	}, GatewayStreamInput{
		Model:      "gpt-5-mini",
		Provider:   "codex",
		SessionKey: "sess_1",
		Messages:   []ChatMessage{{Role: "user", Content: "Hello, world"}},
	}, func(ev StreamEvent) {
		if ev.Type == "delta" {
			deltas = append(deltas, ev.Content)
		}
	})
	if !res.OK || res.Text != "你好，世界" || len(deltas) != 2 || res.Usage == nil || res.Usage.TotalTokens != 14 {
		t.Fatalf("ExecuteGatewayStream failed: %+v deltas=%v", res, deltas)
	}

	msg := HumanizeUpstreamError(`{"error":"no_available_account","retryAfterSeconds":12,"availability":{"reasons":[{"reason":"codex quota_exhausted for model gpt-5 (schedulable: false)"}]}}`, 429, "gpt-5", "codex")
	if msg == "" || strings.Contains(msg, "{") {
		t.Fatalf("HumanizeUpstreamError returned raw json or empty: %q", msg)
	}
}

func TestRunRoutesAndHedging(t *testing.T) {
	ctx := context.Background()

	// 1. 第一条慢于对冲阈值，第二条快速成功（使用 ExecuteHedged 验证并发对冲；RunRoutes 为顺序回退）
	var primaryCalls, secondaryCalls atomic.Int32
	events := make([]StreamEvent, 0)
	res := RunRoutes(ctx, ExecuteRouteInput{
		Operation: "selection",
		Text:      "Hello",
		Source:    "en",
		Target:    "zh-Hans",
	}, RunOptions{
		Operation:     "selection",
		HedgeDisabled: true,
		Routes: []Route{
			{ID: "r1", Provider: "deepl", Model: "deepl-default", Enabled: true, Priority: 0, Operations: []string{"selection"}},
			{ID: "r2", Provider: "aih-gateway", Model: "gpt-5-mini", ModelProvider: "codex", Enabled: true, Priority: 1, Operations: []string{"selection"}},
		},
		ExecuteRoute: func(c context.Context, in ExecuteRouteInput, emit func(StreamEvent)) RunResult {
			if in.Route.ID == "r1" {
				primaryCalls.Add(1)
				return adapterFailure("timeout", "slow", 504, true)
			}
			secondaryCalls.Add(1)
			emit(StreamEvent{Type: "delta", Content: "你好"})
			return RunResult{OK: true, Text: "你好", Route: &in.Route}
		},
	}, func(ev StreamEvent) {
		events = append(events, ev)
	})
	if !res.OK || res.Text != "你好" || res.Route == nil || res.Route.ID != "r2" {
		t.Fatalf("sequential failover RunRoutes mismatch: %+v", res)
	}
	if primaryCalls.Load() != 1 || secondaryCalls.Load() != 1 {
		t.Fatalf("expected 1 call each, got primary=%d secondary=%d", primaryCalls.Load(), secondaryCalls.Load())
	}

	// 2. 验证 ExecuteHedged 首字对冲竞速
	hedgeRes := ExecuteHedged(ctx, []time.Duration{15 * time.Millisecond}, func(c context.Context, emit func(StreamEvent), idx int) RunResult {
		if idx == 0 {
			select {
			case <-time.After(150 * time.Millisecond):
				return adapterFailure("slow", "slow", 504, true)
			case <-c.Done():
				return abortedRunResult()
			}
		}
		emit(StreamEvent{Type: "delta", Content: "快译"})
		return RunResult{OK: true, Text: "快译"}
	}, nil)
	if !hedgeRes.OK || hedgeRes.Text != "快译" {
		t.Fatalf("ExecuteHedged mismatch: %+v", hedgeRes)
	}

	// 3. 已有局部输出后中途失败 -> 绝不切换到备用路由
	var fallbackCalled atomic.Bool
	partialRes := RunRoutes(ctx, ExecuteRouteInput{
		Operation: "selection",
		Text:      "Hello",
		Source:    "en",
		Target:    "zh-Hans",
	}, RunOptions{
		Operation:     "selection",
		HedgeDisabled: true,
		Routes: []Route{
			{ID: "r1", Provider: "aih-gateway", Model: "m1", Enabled: true, Priority: 0, Operations: []string{"selection"}},
			{ID: "r2", Provider: "aih-gateway", Model: "m2", Enabled: true, Priority: 1, Operations: []string{"selection"}},
		},
		ExecuteRoute: func(_ context.Context, in ExecuteRouteInput, emit func(StreamEvent)) RunResult {
			if in.Route.ID == "r1" {
				emit(StreamEvent{Type: "delta", Content: "partial-"})
				return RunResult{OK: false, Error: &ExecutionError{Code: "midstream_fail", Message: "断流", Retryable: true}}
			}
			fallbackCalled.Store(true)
			return RunResult{OK: true, Text: "should-not-happen"}
		},
	}, func(_ StreamEvent) {})
	if partialRes.OK || fallbackCalled.Load() {
		t.Fatalf("must not fail over after partial output: res=%+v fallbackCalled=%v", partialRes, fallbackCalled.Load())
	}

	// 4. ResolveTranslationRequestRoutes 校验保存的路由解析与 JSON 编解码兼容
	b, _ := json.Marshal(Route{ID: "x", Provider: "deepl", Model: "deepl-default", Enabled: true, Priority: 0, Operations: []string{"selection"}})
	var rawSlice []any
	_ = json.Unmarshal([]byte("["+string(b)+"]"), &rawSlice)
	routes, m, p, err := ResolveTranslationRequestRoutes(true, rawSlice, "", "", "selection", ModelCatalog{
		DefaultModel:    "gpt-5-mini",
		DefaultProvider: "codex",
	}, nil)
	if err != nil || len(routes) != 1 || routes[0].Provider != "deepl" || m != "deepl-default" || p != "" {
		t.Fatalf("ResolveTranslationRequestRoutes mismatch: routes=%+v m=%q p=%q err=%v", routes, m, p, err)
	}
}
