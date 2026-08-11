package aihserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/clauderelayleaseapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
)

const (
	// realClaudeNativeRelayEnv 显式授权真实 Native Relay 请求，默认不触网。
	realClaudeNativeRelayEnv = "AIH_REAL_CLAUDE_NATIVE_RELAY"
	// realClaudeNativeRelaySessionID 是本次请求的非敏感会话标识。
	realClaudeNativeRelaySessionID = "aih-real-native-relay-session-20260811"
)

// TestRealClaudeNativeRelayEndToEnd 验证真实 OAuth 账号经过导入、租约和
// Native Messages 透传后仍能收到完整 SSE。请求最多触达一次目录和一次上游。
func TestRealClaudeNativeRelayEndToEnd(t *testing.T) {
	if strings.TrimSpace(os.Getenv(realClaudeNativeRelayEnv)) != "1" {
		t.Skip("设置 AIH_REAL_CLAUDE_NATIVE_RELAY=1 后才允许真实 Claude Native Relay 请求")
	}

	externalDocument := readRealClaudeSub2APIDocument(t)
	defer clear(externalDocument)
	singleAccount := selectRealClaudeSub2APIAccount(t, externalDocument)
	defer clear(singleAccount)
	assertRealSub2APIDocument(t, singleAccount)
	assertRealClaudeCredentialFresh(t, singleAccount)

	budget := newRealClaudeRequestBudget(1)
	models := newRealClaudeModelCatalog(t, budget)
	serverURL, client := startRealClaudeRelayServer(
		t,
		newDisposableRealCodexHome(t),
		budget,
		[]accountapp.ProviderModelDiscoverer{models},
	)
	imported := performRequest(
		t,
		client,
		http.MethodPost,
		serverURL+accountsapi.Sub2APIImportPath,
		testManagementKey,
		singleAccount,
	)
	assertStatus(t, imported, http.StatusCreated)

	modelDocument := performRequest(
		t,
		client,
		http.MethodGet,
		serverURL+modelsapi.Path,
		testClientKey,
		nil,
	)
	assertStatus(t, modelDocument, http.StatusOK)
	assertRealClaudeModelAvailable(t, modelDocument.body)

	leasePayload := []byte(`{"model":"` + realClaudeTransferModel + `"}`)
	lease := performRequest(
		t,
		client,
		http.MethodPost,
		serverURL+clauderelayleaseapi.Path,
		testClientKey,
		leasePayload,
	)
	clear(leasePayload)
	assertStatus(t, lease, http.StatusCreated)
	relayToken := decodeRealClaudeRelayToken(t, lease.body)

	body := []byte(`{"model":"` + realClaudeTransferModel + `","max_tokens":64000,` +
		`"stream":true,"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],` +
		`"messages":[{"role":"user","content":[{"type":"text","text":"` +
		`Reply with exactly: ` + realClaudeTransferMarker + `"}]}]}`)
	request, err := http.NewRequest(
		http.MethodPost,
		serverURL+claudenativerelay.Path,
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("创建真实 Native Relay 请求失败: %v", err)
	}
	request.Header.Set("Authorization", "Bearer client-auth-is-replaced")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("anthropic-version", "2023-06-01")
	request.Header.Set(
		"anthropic-beta",
		"claude-code-20250219,oauth-2025-04-20",
	)
	request.Header.Set("User-Agent", "claude-cli/2.1.225 (external, sdk-cli)")
	request.Header.Set("x-app", "cli")
	request.Header.Set("anthropic-dangerous-direct-browser-access", "true")
	request.Header.Set("X-Claude-Code-Session-Id", realClaudeNativeRelaySessionID)
	request.Header.Set(claudenativerelay.RelayTokenHeader, relayToken)
	response, err := client.Do(request)
	clear(body)
	if err != nil {
		t.Fatalf("真实 Native Relay 请求失败: %v", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("读取真实 Native Relay 响应失败: %v", err)
	}
	responseText := string(responseBody)
	sseSummary, markerFound := summarizeClaudeSSE(
		responseText,
		realClaudeTransferMarker,
	)
	if response.StatusCode != http.StatusOK ||
		!markerFound ||
		!strings.Contains(responseText, "message_stop") {
		snapshot := budget.snapshot()
		t.Logf("真实 Native Relay 脱敏 SSE 摘要: %s", sseSummary)
		t.Fatalf(
			"真实 Native Relay 响应异常: status=%d content_type=%q marker=%t message_stop=%t body_bytes=%d upstream_budget=%+v rejection=%s response_code=%s",
			response.StatusCode,
			response.Header.Get("Content-Type"),
			markerFound,
			strings.Contains(responseText, "message_stop"),
			len(responseBody),
			snapshot,
			budget.rejection(),
			safeErrorCode(responseText),
		)
	}
	if got := budget.snapshot(); got != (realClaudeRequestCounts{models: 1, messages: 1}) {
		t.Fatalf("真实 Native Relay 请求预算错误: got=%+v", got)
	}
	t.Logf(
		"真实 Claude Native Relay 验收通过: lease=POST %s status=%d messages=POST %s status=%d marker=true message_stop=true upstream_models=1 upstream_messages=1 unexpected=0",
		clauderelayleaseapi.Path,
		lease.status,
		claudenativerelay.Path,
		response.StatusCode,
	)
}

// summarizeClaudeSSE 只保留事件名、文本字节数和固定标记是否命中。
func summarizeClaudeSSE(body string, expected string) (string, bool) {
	var events []string
	textBytes := 0
	matched := false
	for _, block := range strings.Split(body, "\n\n") {
		var eventName string
		var dataLine string
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "event: "):
				eventName = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				dataLine = strings.TrimPrefix(line, "data: ")
			}
		}
		if eventName == "" {
			continue
		}
		events = append(events, eventName)
		var document struct {
			Delta struct {
				Text string `json:"text"`
			} `json:"delta"`
		}
		if json.Unmarshal([]byte(dataLine), &document) == nil && document.Delta.Text != "" {
			textBytes += len(document.Delta.Text)
			matched = matched || strings.Contains(document.Delta.Text, expected)
		}
	}
	return "events=" + strings.Join(events, ",") +
		" delta_text_bytes=" + strconv.Itoa(textBytes) +
		" expected_text=" + strconv.FormatBool(matched), matched
}

// safeErrorCode 只提取固定错误码，不回显服务端错误正文。
func safeErrorCode(body string) string {
	var document struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(body), &document) != nil {
		return "unknown"
	}
	return document.Error.Code
}

// startRealClaudeRelayServer 装配隔离数据库，并把 Canonical 与 Native Relay
// 都绑定到同一个有界真实 HTTP Client，防止测试绕过请求预算。
func startRealClaudeRelayServer(
	t *testing.T,
	aiHomeDir string,
	budget *realClaudeRequestBudget,
	discoverers []accountapp.ProviderModelDiscoverer,
) (string, *http.Client) {
	t.Helper()
	server, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:           aiHomeDir,
		ManagementKey:       func() string { return testManagementKey },
		ClientKey:           func() string { return testClientKey },
		ModelDiscoverers:    discoverers,
		InferenceHTTPClient: budget,
		UsageHTTPClient:     syntheticUsageHTTPClient{},
		RelayHTTPClient:     budget,
	})
	if err != nil {
		t.Fatalf("创建真实 Claude Native Relay Server 失败: %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = server.Close()
		t.Fatalf("监听真实 Claude Native Relay Server 失败: %v", err)
	}
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			t.Errorf("关闭真实 Claude Native Relay Server 失败: %v", err)
		}
		if err := <-serveErrors; err != nil {
			t.Errorf("真实 Claude Native Relay Server 退出失败: %v", err)
		}
		if err := server.Close(); err != nil {
			t.Errorf("释放真实 Claude Native Relay Server 资源失败: %v", err)
		}
		t.Log("temporary_native_relay_server_closed=true")
	})
	return "http://" + listener.Addr().String(), &http.Client{
		Timeout: realClaudeTransferTimeout,
	}
}

// decodeRealClaudeRelayToken 只提取短期租约 Token，不记录其内容。
func decodeRealClaudeRelayToken(t *testing.T, body string) string {
	t.Helper()
	var document struct {
		Data struct {
			Transport string `json:"transport"`
			Token     string `json:"token"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &document); err != nil ||
		document.Data.Transport != "native_oauth" ||
		document.Data.Token == "" {
		t.Fatalf(
			"真实 Claude Relay 租约响应异常: decode_error=%t transport=%q token_present=%t",
			err != nil,
			document.Data.Transport,
			document.Data.Token != "",
		)
	}
	return document.Data.Token
}
