package webuiopenappapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHostLauncherSendsPlanAndTranslatesResult(t *testing.T) {
	var received launchPayload
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != InternalLaunchPath {
			t.Errorf("path = %q, want %q", request.URL.Path, InternalLaunchPath)
		}
		authorization = request.Header.Get("Authorization")
		if err := json.NewDecoder(request.Body).Decode(&received); err != nil {
			t.Errorf("decode body: %v", err)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte("{\"ok\":true,\"result\":{\"ok\":true,\"status\":\"launched\",\"pid\":4321,\"launchMode\":\"webui-pty\",\"sessionKey\":\"account-cli:test\",\"pids\":[1,2]}}"))
	}))
	defer server.Close()

	launcher := NewHostLauncher(HostLauncherOptions{
		BaseURL:       server.URL,
		ManagementKey: func() string { return "boot-key" },
		HTTPClient:    server.Client(),
	})
	result, err := launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: "acct_0123456789abcdef0123",
		Kind:       kindCLI,
		Action:     actionOpen,
		Harness:    "pi",
		Model:      "gpt-5",
		TerminalID: "system-default",
		Workdir:    "/tmp/project",
		Transport:  transportWebUI,
		SessionKey: "account-cli:test",
	})
	if err != nil {
		t.Fatalf("Launch() error = %v", err)
	}
	if authorization != "Bearer boot-key" {
		t.Fatalf("authorization = %q", authorization)
	}
	if received.Provider != "codex" || received.Harness != "pi" || received.Transport != transportWebUI {
		t.Fatalf("payload = %+v", received)
	}
	if !result.OK || result.Status != "launched" || result.PID == nil || *result.PID != 4321 {
		t.Fatalf("result = %+v", result)
	}
	if result.LaunchMode != "webui-pty" || result.SessionKey != "account-cli:test" || len(result.PIDs) != 2 {
		t.Fatalf("result = %+v", result)
	}
}

func TestHostLauncherReportsHostFailuresAsUnavailable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusForbidden)
		_, _ = writer.Write([]byte("{\"ok\":false,\"error\":\"launch_internal_unauthorized\",\"message\":\"内部调用未授权\"}"))
	}))
	defer server.Close()

	launcher := NewHostLauncher(HostLauncherOptions{BaseURL: server.URL, HTTPClient: server.Client()})
	result, err := launcher.Launch(context.Background(), Request{})
	if err != nil {
		t.Fatalf("Launch() error = %v", err)
	}
	if result.OK || result.Error != "launch_host_unavailable" {
		t.Fatalf("result = %+v, want launch_host_unavailable", result)
	}
	if result.Message != "内部调用未授权" {
		t.Fatalf("message = %q", result.Message)
	}
}
