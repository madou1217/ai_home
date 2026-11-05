package relaycore

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeTransformerError 模拟上游错误契约（qoder 的 *StreamError 同形状）。
type fakeTransformerError struct {
	status  int
	code    string
	message string
}

func (err fakeTransformerError) Error() string          { return err.message }
func (err fakeTransformerError) UpstreamStatusCode() int { return err.status }
func (err fakeTransformerError) UpstreamErrorCode() string { return err.code }

// 未写 header：按上游语义给 429 + JSON 错误体，绝不是 200 空 body。
func TestWriteTransformerErrorBeforeHeader(t *testing.T) {
	recorder := httptest.NewRecorder()
	tracker := &trackingResponseWriter{ResponseWriter: recorder}
	writeTransformerError(recorder, tracker, fakeTransformerError{
		status: http.StatusTooManyRequests, code: "qoder_resource_limit", message: "queued",
	}, true)
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", recorder.Code)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, "qoder_resource_limit") || !strings.Contains(body, "queued") {
		t.Fatalf("错误体缺少 code/message: %s", body)
	}
}

// 已写 header 的流式响应：补 error 帧 + [DONE]，不能无声截断。
func TestWriteTransformerErrorAfterHeaderStreaming(t *testing.T) {
	recorder := httptest.NewRecorder()
	tracker := &trackingResponseWriter{ResponseWriter: recorder}
	tracker.WriteHeader(http.StatusOK)
	_, _ = tracker.Write([]byte("data: {\"id\":\"c1\"}\n\n"))
	writeTransformerError(recorder, tracker, fakeTransformerError{
		status: 529, code: "overloaded", message: "upstream overloaded",
	}, true)
	body := recorder.Body.String()
	if !strings.Contains(body, "\"code\":\"overloaded\"") || !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("缺少错误帧或 DONE: %s", body)
	}
}

// 已写 header 的非流式响应：正文已发出，不能再追加任何东西。
func TestWriteTransformerErrorAfterHeaderNonStreaming(t *testing.T) {
	recorder := httptest.NewRecorder()
	tracker := &trackingResponseWriter{ResponseWriter: recorder}
	tracker.WriteHeader(http.StatusOK)
	_, _ = tracker.Write([]byte("{\"ok\":true}"))
	before := recorder.Body.String()
	writeTransformerError(recorder, tracker, errors.New("boom"), false)
	if recorder.Body.String() != before {
		t.Fatalf("非流式不应追加内容: %s", recorder.Body.String())
	}
}
