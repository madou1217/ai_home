package inference

import (
	"errors"
	"testing"
)

// TestPromptCacheBreakpointPreservesTargetAndControl 验证请求、消息和工具断点
// 使用稳定位置，不依赖 Anthropic JSON。
func TestPromptCacheBreakpointPreservesTargetAndControl(t *testing.T) {
	t.Parallel()

	control, err := NewPromptCacheControl(
		PromptCacheTTL1Hour,
		PromptCacheScopeGlobal,
	)
	if err != nil {
		t.Fatalf("NewPromptCacheControl() error = %v", err)
	}
	messageBreakpoint, err := NewMessagePromptCacheBreakpoint(2, 3, control)
	if err != nil {
		t.Fatalf("NewMessagePromptCacheBreakpoint() error = %v", err)
	}
	toolBreakpoint, err := NewToolPromptCacheBreakpoint(4, control)
	if err != nil {
		t.Fatalf("NewToolPromptCacheBreakpoint() error = %v", err)
	}
	requestBreakpoint, err := NewRequestPromptCacheBreakpoint(control)
	if err != nil {
		t.Fatalf("NewRequestPromptCacheBreakpoint() error = %v", err)
	}

	if messageBreakpoint.Target() != PromptCacheTargetMessageContent ||
		messageBreakpoint.MessageIndex() != 2 ||
		messageBreakpoint.ContentIndex() != 3 ||
		messageBreakpoint.Control().TTL() != PromptCacheTTL1Hour {
		t.Fatalf("message breakpoint = %#v, want exact position and control", messageBreakpoint)
	}
	if toolBreakpoint.Target() != PromptCacheTargetTool ||
		toolBreakpoint.ToolIndex() != 4 ||
		requestBreakpoint.Target() != PromptCacheTargetRequest {
		t.Fatalf("breakpoints = tool:%#v request:%#v", toolBreakpoint, requestBreakpoint)
	}
}

// TestRequestRejectsMissingOrDuplicateCacheTargets 验证缓存断点必须引用真实位置，
// 同一内容也不能声明两个相互冲突的控制。
func TestRequestRejectsMissingOrDuplicateCacheTargets(t *testing.T) {
	t.Parallel()

	text, err := NewTextContent("缓存内容")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := NewMessage(RoleUser, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	control, err := NewPromptCacheControl(PromptCacheTTL5Minutes, PromptCacheScopeDefault)
	if err != nil {
		t.Fatalf("NewPromptCacheControl() error = %v", err)
	}
	valid, _ := NewMessagePromptCacheBreakpoint(0, 0, control)
	missing, _ := NewMessagePromptCacheBreakpoint(1, 0, control)

	base := RequestInput{
		ClientProtocol: ClientProtocolAnthropicMessages,
		Model:          "claude-opus-4-6",
		Messages:       []Message{message},
	}
	base.PromptCacheBreakpoints = []PromptCacheBreakpoint{missing}
	if _, err := NewRequest(base); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("missing target error = %v, want ErrInvalidRequest", err)
	}
	base.PromptCacheBreakpoints = []PromptCacheBreakpoint{valid, valid}
	if _, err := NewRequest(base); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("duplicate target error = %v, want ErrInvalidRequest", err)
	}
}
