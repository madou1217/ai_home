package kirorelay

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

func kiroCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeKiroIdentity(
		"https://codewhisperer.us-east-1.amazonaws.com",
		"d-9067c98495.14782468",
	)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{
		"auth": map[string]any{
			"access_token": "at-1",
			"region":       "us-east-1",
			"profile_arn":  "arn:aws:codewhisperer:us-east-1:69947594:profile/x",
		},
		"profileArn": "arn:aws:codewhisperer:us-east-1:69947594:profile/x",
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatal(err)
	}
	return credential
}

func resolvedProvider(t *testing.T) *Provider {
	t.Helper()
	provider := NewProvider()
	resolved, ok := provider.Resolve(relaycore.ResolveInput{ProviderID: "kiro", Credential: kiroCredential(t)})
	if !ok {
		t.Fatal("kiro 必须被认领")
	}
	typed, ok := resolved.(*Provider)
	if !ok {
		t.Fatalf("Resolve 返回类型 %T", resolved)
	}
	return typed
}

func TestProviderResolveEndpointAndAuth(t *testing.T) {
	provider := resolvedProvider(t)
	endpoint, ok := provider.Endpoint()
	if !ok || endpoint != "https://codewhisperer.us-east-1.amazonaws.com/" {
		t.Fatalf("endpoint = %q, ok=%v", endpoint, ok)
	}
	token, err := provider.AccessToken(nil)
	if err != nil || token != "at-1" {
		t.Fatalf("token = %q, err=%v", token, err)
	}
	request, _ := http.NewRequest(http.MethodPost, endpoint, nil)
	provider.DecorateUpstream(request, token)
	if request.Header.Get("Content-Type") != ContentType {
		t.Fatalf("content-type = %q", request.Header.Get("Content-Type"))
	}
	if request.Header.Get("x-amz-target") != Operation {
		t.Fatalf("x-amz-target = %q", request.Header.Get("x-amz-target"))
	}
	if request.Header.Get("Authorization") != "Bearer at-1" {
		t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
	}
}

func TestProviderRewriteEncodesConversation(t *testing.T) {
	provider := resolvedProvider(t)
	body := []byte(`{"model":"claude-sonnet-4.5","stream":true,"messages":[{"role":"system","content":"be brief"},{"role":"user","content":"hi"}]}`)
	result, err := provider.RewriteRequest(body)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(result.Body, &parsed); err != nil {
		t.Fatal(err)
	}
	state := parsed["conversationState"].(map[string]any)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	want := "be brief" + string([]byte{10, 10}) + "hi"
	if current["content"] != want {
		t.Fatalf("current = %#v", current)
	}
	if parsed["profileArn"] == "" {
		t.Fatal("必须带 profileArn")
	}
	if len(result.Degradations) != 0 {
		t.Fatalf("deg = %#v", result.Degradations)
	}
}

func TestProviderRewriteReportsToolsDegradation(t *testing.T) {
	provider := resolvedProvider(t)
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function"}]}`)
	result, err := provider.RewriteRequest(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Degradations) != 1 || result.Degradations[0] != "tools_unsupported" {
		t.Fatalf("deg = %#v", result.Degradations)
	}
}

func kiroStream(t *testing.T) []byte {
	t.Helper()
	frames := [][]byte{
		encodeFrame(t, map[string]string{":event-type": "initial-response"}, []byte(`{"conversationId":"c1"}`)),
		encodeFrame(t, map[string]string{":event-type": "assistantResponseEvent"}, []byte(`{"content":"Hel"}`)),
		encodeFrame(t, map[string]string{":event-type": "assistantResponseEvent"}, []byte(`{"content":"lo"}`)),
	}
	return bytes.Join(frames, nil)
}

func TestTransformResponseStreaming(t *testing.T) {
	provider := resolvedProvider(t)
	provider.model = "claude-sonnet-4.5"
	recorder := httptest.NewRecorder()
	upstream := &http.Response{Body: io.NopCloser(bytes.NewReader(kiroStream(t)))}
	handled, err := provider.TransformResponse(recorder, upstream, true)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"content":"Hel"`) || !strings.Contains(body, `"content":"lo"`) {
		t.Fatalf("SSE 缺少文本增量: %s", body)
	}
	if !strings.HasSuffix(strings.TrimSpace(body), "data: [DONE]") {
		t.Fatalf("SSE 未以 DONE 结束: %s", body)
	}
	if recorder.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content-type = %q", recorder.Header().Get("Content-Type"))
	}
}

func TestTransformResponseAggregatesNonStreaming(t *testing.T) {
	provider := resolvedProvider(t)
	provider.model = "claude-sonnet-4.5"
	recorder := httptest.NewRecorder()
	upstream := &http.Response{Body: io.NopCloser(bytes.NewReader(kiroStream(t)))}
	handled, err := provider.TransformResponse(recorder, upstream, false)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	message := payload["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if message["content"] != "Hello" {
		t.Fatalf("content = %#v", message["content"])
	}
}
