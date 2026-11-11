package plugincontrolclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(Options{
		BaseURL:       server.URL,
		ManagementKey: func() string { return "management-key" },
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return client
}

func TestNewRejectsUnsafeBaseURL(t *testing.T) {
	key := func() string { return "k" }
	for _, baseURL := range []string{
		"http://10.0.0.8:9527",
		"https://127.0.0.1:9527",
		"http://user:pass@127.0.0.1:9527",
		"http://127.0.0.1:9527/?x=1",
		"http://127.0.0.1:9527/#fragment",
		"http://localhost.evil.example:9527",
	} {
		if _, err := New(Options{BaseURL: baseURL, ManagementKey: key}); err == nil {
			t.Fatalf("%s 应被拒绝", baseURL)
		}
	}
	for _, baseURL := range []string{"http://127.0.0.1:9527", "http://localhost:9527", "http://[::1]:9527"} {
		if _, err := New(Options{BaseURL: baseURL, ManagementKey: key}); err != nil {
			t.Fatalf("%s 应被接受，error = %v", baseURL, err)
		}
	}
}

func TestPrepareDoesNotFollowRedirects(t *testing.T) {
	var redirectTargetHits int
	target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		redirectTargetHits++
		_, _ = response.Write([]byte(`{"ok":true,"ticket":"stolen","candidate":{"revision":9}}`))
	}))
	t.Cleanup(target.Close)
	redirector := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		// 模拟被接管的本地端点：把带 Authorization 的请求导向另一个端口。
		http.Redirect(response, request, target.URL+"/steal", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)
	client, err := New(Options{
		BaseURL:       redirector.URL,
		ManagementKey: func() string { return "management-key" },
		// 注入一个默认会跟随重定向的客户端：New 必须仍然关闭跳转。
		HTTPClient: &http.Client{},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := client.Prepare(context.Background(), plugincontrol.PrepareRequest{Operation: plugincontrol.OperationEnable}); err == nil {
		t.Fatal("重定向响应不应被当作成功")
	}
	if redirectTargetHits != 0 {
		t.Fatalf("重定向目标被请求了 %d 次，管理密钥可能已随跳转发往其它端点", redirectTargetHits)
	}
}

func TestPrepareSendsAuthAndDecodesCandidate(t *testing.T) {
	client := newTestClient(t, func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != preparePath || request.Method != http.MethodPost {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer management-key" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		document, _ := io.ReadAll(request.Body)
		var payload map[string]any
		if err := json.Unmarshal(document, &payload); err != nil {
			t.Errorf("body = %s", string(document))
		}
		if payload["operation"] != "enable" || payload["expectedRevision"] != float64(3) {
			t.Errorf("payload = %+v", payload)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"ok":true,"ticket":"ticket-1","generation":8,"candidate":{"schemaVersion":1,"revision":4},"contributions":[]}`))
	})
	prepared, err := client.Prepare(context.Background(), plugincontrol.PrepareRequest{
		Operation:        plugincontrol.OperationEnable,
		ExpectedRevision: 3,
		Input:            json.RawMessage(`{"pluginId":"echo"}`),
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	if prepared.Ticket != "ticket-1" || prepared.Generation != 8 || !json.Valid(prepared.Candidate) {
		t.Fatalf("prepared = %+v", prepared)
	}
}

func TestPrepareErrorCarriesCodeAndDiagnostics(t *testing.T) {
	client := newTestClient(t, func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusBadRequest)
		_, _ = response.Write([]byte(`{"ok":false,"error":"plugin_candidate_rejected","message":"apply boom","diagnostics":[{"code":"plugin_apply_failed"}]}`))
	})
	_, err := client.Prepare(context.Background(), plugincontrol.PrepareRequest{Operation: plugincontrol.OperationEnable})
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != plugincontrol.CodeCandidateRejected {
		t.Fatalf("error = %v", err)
	}
	if len(coded.Diagnostics) != 1 {
		t.Fatalf("diagnostics = %+v", coded.Diagnostics)
	}
}

func TestActivateAndDiscard(t *testing.T) {
	var paths []string
	client := newTestClient(t, func(response http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		if request.URL.Path == activatePath {
			_, _ = response.Write([]byte(`{"ok":true,"generation":9,"state":"active"}`))
			return
		}
		_, _ = response.Write([]byte(`{"ok":true}`))
	})
	activated, err := client.Activate(context.Background(), "ticket-1", 4)
	if err != nil {
		t.Fatalf("Activate() error = %v", err)
	}
	if activated.Generation != 9 || activated.State != "active" {
		t.Fatalf("activated = %+v", activated)
	}
	if err := client.Discard(context.Background(), "ticket-1", "commit_failed"); err != nil {
		t.Fatalf("Discard() error = %v", err)
	}
	if len(paths) != 2 || paths[0] != activatePath || paths[1] != discardPath {
		t.Fatalf("paths = %+v", paths)
	}
}

func TestTransportFailureIsRuntimeUnavailable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	baseURL := server.URL
	server.Close()
	client, err := New(Options{BaseURL: baseURL, ManagementKey: func() string { return "management-key" }})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = client.Prepare(context.Background(), plugincontrol.PrepareRequest{Operation: plugincontrol.OperationEnable})
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != plugincontrol.CodeRuntimeUnavailable {
		t.Fatalf("error = %v", err)
	}
}

func TestNonJSONSuccessBodyIsRuntimeUnavailable(t *testing.T) {
	client := newTestClient(t, func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte("not json"))
	})
	_, err := client.Prepare(context.Background(), plugincontrol.PrepareRequest{Operation: plugincontrol.OperationEnable})
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != plugincontrol.CodeRuntimeUnavailable {
		t.Fatalf("error = %v", err)
	}
}
