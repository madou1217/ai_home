package zcoderelay

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

func TestTransformResponseMapsBusinessError(t *testing.T) {
	provider := &Provider{BaseProvider: relaycore.NewBaseProvider("zcode", "")}
	recorder := httptest.NewRecorder()
	body := []byte(`{"code":1005,"msg":"exceed quota limit","logid":"x"}`)
	handled, err := provider.TransformResponse(recorder, &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body))}, false)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", recorder.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	errorBody := payload["error"].(map[string]any)
	if errorBody["type"] != "zcode_business_error" || errorBody["message"] != "exceed quota limit" {
		t.Fatalf("error = %#v", errorBody)
	}
}

func TestTransformResponsePassesThroughChatBody(t *testing.T) {
	provider := &Provider{BaseProvider: relaycore.NewBaseProvider("zcode", "")}
	recorder := httptest.NewRecorder()
	body := []byte(`{"id":"x","choices":[{"message":{"content":"ok"}}]}`)
	handled, err := provider.TransformResponse(recorder, &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body))}, false)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if recorder.Code != 200 || recorder.Body.String() != string(body) {
		t.Fatalf("passthrough = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestTransformResponseLeavesNonJSONAlone(t *testing.T) {
	provider := &Provider{BaseProvider: relaycore.NewBaseProvider("zcode", "")}
	recorder := httptest.NewRecorder()
	body := []byte(`data: {"choices":[]}` + string([]byte{10, 10}))
	handled, err := provider.TransformResponse(recorder, &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body))}, true)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if recorder.Body.String() != string(body) {
		t.Fatalf("SSE 必须原样透传: %q", recorder.Body.String())
	}
}
