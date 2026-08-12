package responses

import (
	"errors"
	"strings"
	"testing"

	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
)

// TestEncodeRequestProjectsClaudeContextManagement 验证 Claude 跨协议请求不会
// 因客户端上下文编辑在 Codex Encoder 阶段失败。
func TestEncodeRequestProjectsClaudeContextManagement(t *testing.T) {
	t.Parallel()

	edit, err := inference.NewClearThinkingEdit(nil)
	if err != nil {
		t.Fatalf("NewClearThinkingEdit() error = %v", err)
	}
	management, err := inference.NewContextManagement(edit)
	if err != nil {
		t.Fatalf("NewContextManagement() error = %v", err)
	}
	input := minimalRequestInput(t, func(input *inference.RequestInput) {
		input.ClientProtocol = inference.ClientProtocolAnthropicMessages
		input.ContextManagement = &management
	})
	request, err := inference.NewRequest(input)
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	payload, err := encodeRequest(
		request,
		"gpt-5.6-sol",
		codexauth.AuthKindAPIKey,
		requestProfileForModel("gpt-5.6-sol"),
	)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	if strings.Contains(string(payload), "context_management") {
		t.Fatalf("Codex payload unexpectedly contains context_management: %s", payload)
	}

	input.ClientProtocol = inference.ClientProtocolOpenAIResponses
	nativeRequest, err := inference.NewRequest(input)
	if err != nil {
		t.Fatalf("NewRequest(native) error = %v", err)
	}
	_, err = encodeRequest(
		nativeRequest,
		"gpt-5.6-sol",
		codexauth.AuthKindAPIKey,
		requestProfileForModel("gpt-5.6-sol"),
	)
	if !errors.Is(err, ErrUnsupportedRequest) ||
		!strings.Contains(err.Error(), "context_management") {
		t.Fatalf("native encodeRequest() error = %v", err)
	}
}

// TestEncodeRequestProjectsClaudeUserID 验证 Claude metadata.user_id 只停留在
// Canonical 客户端边界，不会因为 Codex 没有等价字段而让标题请求失败。
func TestEncodeRequestProjectsClaudeUserID(t *testing.T) {
	t.Parallel()

	userID := "claude-session-user"
	input := minimalRequestInput(t, func(input *inference.RequestInput) {
		input.ClientProtocol = inference.ClientProtocolAnthropicMessages
		input.UserID = &userID
	})
	request, err := inference.NewRequest(input)
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	payload, err := encodeRequest(
		request,
		"gpt-5.6-sol",
		codexauth.AuthKindAPIKey,
		requestProfileForModel("gpt-5.6-sol"),
	)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	if strings.Contains(string(payload), userID) ||
		strings.Contains(string(payload), "user_id") {
		t.Fatalf("Codex payload unexpectedly contains user_id: %s", payload)
	}

	input.ClientProtocol = inference.ClientProtocolOpenAIResponses
	nativeRequest, err := inference.NewRequest(input)
	if err != nil {
		t.Fatalf("NewRequest(native) error = %v", err)
	}
	_, err = encodeRequest(
		nativeRequest,
		"gpt-5.6-sol",
		codexauth.AuthKindAPIKey,
		requestProfileForModel("gpt-5.6-sol"),
	)
	if !errors.Is(err, ErrUnsupportedRequest) ||
		!strings.Contains(err.Error(), "user_id") {
		t.Fatalf("native encodeRequest() error = %v", err)
	}
}

// TestEncodeRequestProjectsClaudeCacheControl 验证 Claude system cache_control
// 不会把跨协议请求挡在 Codex Encoder 前；正文仍必须进入 Codex input。
func TestEncodeRequestProjectsClaudeCacheControl(t *testing.T) {
	t.Parallel()

	request, err := anthropicmessages.NewRequestDecoder().Decode([]byte(`{
		"model":"gpt-5.6-sol",
		"max_tokens":32000,
		"system":[
			{"type":"text","text":"保持系统约束。","cache_control":{"type":"ephemeral","ttl":"1h"}}
		],
		"messages":[{"role":"user","content":"Reply with exactly: cache projection"}],
		"stream":true
	}`))
	if err != nil {
		t.Fatalf("Messages Decode() error = %v", err)
	}
	if len(request.PromptCacheBreakpoints()) == 0 {
		t.Fatal("Messages Decode() 未保留 cache_control 语义")
	}
	payload, err := encodeRequest(
		request,
		"gpt-5.6-sol",
		codexauth.AuthKindAPIKey,
		requestProfileForModel("gpt-5.6-sol"),
	)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	if !strings.Contains(string(payload), "保持系统约束") ||
		strings.Contains(string(payload), "cache_control") ||
		strings.Contains(string(payload), "prompt_cache_breakpoints") {
		t.Fatalf("Codex payload cache projection = %s", payload)
	}
}
