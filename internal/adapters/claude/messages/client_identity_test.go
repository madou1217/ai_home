package messages

import (
	"context"
	"encoding/json"
	"testing"

	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
)

// TestClaudeClientIdentityMatchesInstalledSource 验证订阅请求身份与本机当前
// Claude Code 源码中的 MACRO.VERSION 保持一致。
func TestClaudeClientIdentityMatchesInstalledSource(t *testing.T) {
	t.Parallel()

	const expected = "claude-cli/2.1.229 (external, sdk-cli)"
	if clientUserAgent != expected {
		t.Fatalf("clientUserAgent = %q, want %q", clientUserAgent, expected)
	}
}

// TestSubscriptionOAuthSendsOfficialClientContract 锁定订阅 OAuth 的官方客户端合同。
//
// 真实验收结论：同一账号、同一时刻、同一模型下，原生 Relay（字节转发官方客户端
// 请求）成功，而 Canonical 重建请求被上游按 429 限流；补齐官方身份 system 块后
// 转为 200。该合同若回退，跨协议调用会重新变成不可用。
func TestSubscriptionOAuthSendsOfficialClientContract(t *testing.T) {
	t.Parallel()

	credential, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "sk-ant-oat01-subscription-contract",
		RefreshToken: "sk-ant-ort01-subscription-contract",
		ExpiresAtMS:  4102444800000,
		Scopes:       []string{"user:inference", "user:profile"},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174333",
		},
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	auth, err := projectAuth(credential)
	if err != nil {
		t.Fatalf("projectAuth() error = %v", err)
	}
	if !auth.officialClient {
		t.Fatal("订阅 OAuth 未被判定为官方客户端通道")
	}

	request := newCompleteClaudeRequest(t)
	encoded, err := encodeRequest(request, "claude-opus-4-6", auth.officialClient)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	httpRequest, err := buildHTTPRequest(context.Background(), auth, encoded)
	if err != nil {
		t.Fatalf("buildHTTPRequest() error = %v", err)
	}

	if httpRequest.Header.Get("User-Agent") != clientUserAgent ||
		httpRequest.Header.Get(clientAppHeader) != clientAppValue ||
		httpRequest.Header.Get(clientDirectAccessHeader) !=
			clientDirectAccessValue {
		t.Fatalf("官方客户端身份 Header 缺失: %v", httpRequest.Header)
	}

	var wire struct {
		System []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"system"`
	}
	if err := json.Unmarshal(encoded.payload, &wire); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if len(wire.System) == 0 ||
		wire.System[0].Type != "text" ||
		wire.System[0].Text != clientSystemIdentity {
		t.Fatalf("官方身份 system 块缺失或不在首位: %s", encoded.payload)
	}
}

// TestNonSubscriptionCredentialsOmitOfficialClientContract 锁定合同的作用边界。
//
// 第三方 OAuth-token 中转端点不是 Claude Code 订阅通道，冒充官方 CLI 既无依据，
// 也可能被代理按未知客户端拒绝。
func TestNonSubscriptionCredentialsOmitOfficialClientContract(t *testing.T) {
	t.Parallel()

	credential, err := claudeauth.NewOAuthTokenAuth(claudeauth.OAuthTokenInput{
		AccessToken: "sk-ant-oat01-third-party-relay",
		BaseURL:     "https://oauth-relay.example/anthropic",
	})
	if err != nil {
		t.Fatalf("NewOAuthTokenAuth() error = %v", err)
	}
	auth, err := projectAuth(credential)
	if err != nil {
		t.Fatalf("projectAuth() error = %v", err)
	}
	if auth.officialClient {
		t.Fatal("第三方 OAuth-token 端点被误判为官方客户端通道")
	}

	request := newCompleteClaudeRequest(t)
	encoded, err := encodeRequest(request, "claude-opus-4-6", auth.officialClient)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	httpRequest, err := buildHTTPRequest(context.Background(), auth, encoded)
	if err != nil {
		t.Fatalf("buildHTTPRequest() error = %v", err)
	}
	if httpRequest.Header.Get("User-Agent") != "" ||
		httpRequest.Header.Get(clientAppHeader) != "" ||
		httpRequest.Header.Get(clientDirectAccessHeader) != "" {
		t.Fatalf("第三方端点收到了官方客户端身份 Header: %v", httpRequest.Header)
	}
	if bytesContainsIdentity(encoded.payload) {
		t.Fatalf("第三方端点正文注入了官方身份 system 块: %s", encoded.payload)
	}
}

// bytesContainsIdentity 判断编码正文是否包含官方身份文本。
func bytesContainsIdentity(payload []byte) bool {
	var wire struct {
		System []struct {
			Text string `json:"text"`
		} `json:"system"`
	}
	if err := json.Unmarshal(payload, &wire); err != nil {
		return false
	}
	for _, block := range wire.System {
		if block.Text == clientSystemIdentity {
			return true
		}
	}
	return false
}
