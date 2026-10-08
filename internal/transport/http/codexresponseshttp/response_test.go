package codexresponseshttp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStreamingResponseContentType(t *testing.T) {
	streamBody := ": heartbeat\r\nevent: future\r\ndata: {\"opaque\":9007199254740993}\r\n\r\n" + completedEvent
	for _, test := range []struct {
		name        string
		contentType string
		body        string
		wantType    string
	}{
		{name: "missing upstream type", body: streamBody, wantType: "text/event-stream"},
		{name: "explicit event stream", contentType: "text/event-stream; charset=utf-8", body: streamBody, wantType: "text/event-stream; charset=utf-8"},
		{name: "explicit JSON", contentType: "application/json", body: `{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}`, wantType: "application/json"},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				if test.contentType == "" {
					// 禁止测试上游自动嗅探，复现 Codex 成功流缺少 Content-Type 的行为。
					response.Header()["Content-Type"] = nil
				} else {
					response.Header().Set("Content-Type", test.contentType)
				}
				_, _ = io.WriteString(response, test.body)
			}))
			defer upstream.Close()
			handler, recorder, _ := fixture(t, upstream.URL, 1)
			finished := make(chan struct{})
			gateway := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				defer close(finished)
				handler.ServeHTTP(response, request)
			}))
			defer gateway.Close()
			request, err := http.NewRequest(http.MethodPost, gateway.URL, strings.NewReader(`{"model":"gpt-native","stream":true}`))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer synthetic-client")
			request.Header.Set("Content-Type", "application/json")
			client := &http.Client{Timeout: 3 * time.Second}
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-finished:
			case <-time.After(3 * time.Second):
				t.Fatal("gateway handler did not finish")
			}
			if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != test.wantType || string(body) != test.body {
				t.Fatalf("response=%d type=%q body=%q", response.StatusCode, response.Header.Get("Content-Type"), body)
			}
			if len(recorder.successes) != 1 || len(recorder.failures) != 0 {
				t.Fatalf("successes=%d failures=%d", len(recorder.successes), len(recorder.failures))
			}
			if usage, ok := recorder.successes[0].Usage(); !ok || usage.TotalTokens() != 5 {
				t.Fatal("terminal usage not recorded")
			}
		})
	}
}

func TestRecordedUsagePreservesCacheWriteTokens(t *testing.T) {
	usage := `{"input_tokens":11,"input_tokens_details":{"cached_tokens":3,"cache_write_tokens":2},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":18}`
	for _, test := range []struct {
		name        string
		request     string
		contentType string
		body        string
	}{
		{name: "SSE", request: `{"model":"gpt-native","stream":true}`, contentType: "text/event-stream", body: "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":" + usage + "}}\n\n"},
		{name: "JSON", request: `{"model":"gpt-native"}`, contentType: "application/json", body: `{"status":"completed","usage":` + usage + `}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", test.contentType)
				_, _ = io.WriteString(response, test.body)
			}))
			defer upstream.Close()
			handler, recorder, _ := fixture(t, upstream.URL, 1)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, nativeRequestFor([]byte(test.request)))
			if response.Code != http.StatusOK || response.Body.String() != test.body {
				t.Fatalf("response=%d body=%q", response.Code, response.Body.String())
			}
			if len(recorder.successes) != 1 || len(recorder.failures) != 0 {
				t.Fatalf("successes=%d failures=%d", len(recorder.successes), len(recorder.failures))
			}
			got, ok := recorder.successes[0].Usage()
			if !ok || got.InputTokens() != 11 || got.CachedInputTokens() != 3 || got.CacheWriteInputTokens() != 2 || got.OutputTokens() != 7 || got.ReasoningTokens() != 2 || got.TotalTokens() != 18 {
				t.Fatalf("recorded usage=%+v found=%v", got, ok)
			}
		})
	}
}
