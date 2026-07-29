package clientprotocol_test

import (
	"errors"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
)

// TestRegistryResolvesRealProtocolAdapters 验证 Registry 只按精确协议返回真实 Adapter。
func TestRegistryResolvesRealProtocolAdapters(t *testing.T) {
	t.Parallel()

	responsesAdapter, err := openairesponses.NewAdapter(func() time.Time {
		return time.Unix(1_700_000_000, 0)
	})
	if err != nil {
		t.Fatalf("openairesponses.NewAdapter() error = %v", err)
	}
	registry, err := clientprotocol.NewRegistry(
		anthropicmessages.NewAdapter(),
		responsesAdapter,
	)
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}

	messagesAdapter, err := registry.Resolve(
		inference.ClientProtocolAnthropicMessages,
	)
	if err != nil {
		t.Fatalf("Resolve(Anthropic) error = %v", err)
	}
	messagesRequest, err := messagesAdapter.Decode([]byte(`{
		"model":"claude-opus-4-6",
		"max_tokens":1024,
		"messages":[{"role":"user","content":"你好"}]
	}`))
	if err != nil {
		t.Fatalf("Anthropic Decode() error = %v", err)
	}
	if messagesRequest.ClientProtocol() != inference.ClientProtocolAnthropicMessages ||
		messagesAdapter.NewStreamRenderer(messagesRequest).Terminal() {
		t.Fatalf("Anthropic Adapter 返回错误协议或提前终止")
	}

	responses, err := registry.Resolve(inference.ClientProtocolOpenAIResponses)
	if err != nil {
		t.Fatalf("Resolve(Responses) error = %v", err)
	}
	responsesRequest, err := responses.Decode([]byte(`{
		"model":"gpt-5.6-sol",
		"input":"你好"
	}`))
	if err != nil {
		t.Fatalf("Responses Decode() error = %v", err)
	}
	if responsesRequest.ClientProtocol() != inference.ClientProtocolOpenAIResponses ||
		responses.NewStreamRenderer(responsesRequest).Terminal() {
		t.Fatalf("Responses Adapter 返回错误协议或提前终止")
	}
}

// TestRegistryRejectsMissingDuplicateAndUnknownProtocols 验证 Registry 不做隐式回退。
func TestRegistryRejectsMissingDuplicateAndUnknownProtocols(t *testing.T) {
	t.Parallel()

	if _, err := clientprotocol.NewRegistry(); !errors.Is(
		err,
		clientprotocol.ErrInvalidAdapter,
	) {
		t.Fatalf("NewRegistry() error = %v", err)
	}
	anthropicAdapter := anthropicmessages.NewAdapter()
	if _, err := clientprotocol.NewRegistry(
		anthropicAdapter,
		anthropicAdapter,
	); !errors.Is(err, clientprotocol.ErrDuplicateProtocol) {
		t.Fatalf("duplicate NewRegistry() error = %v", err)
	}
	registry, err := clientprotocol.NewRegistry(anthropicAdapter)
	if err != nil {
		t.Fatalf("NewRegistry(Anthropic) error = %v", err)
	}
	if _, err := registry.Resolve(
		inference.ClientProtocolOpenAIResponses,
	); !errors.Is(err, clientprotocol.ErrProtocolNotRegistered) {
		t.Fatalf("Resolve(unregistered) error = %v", err)
	}
	if _, err := openairesponses.NewAdapter(nil); !errors.Is(
		err,
		clientprotocol.ErrInvalidAdapter,
	) {
		t.Fatalf("NewAdapter(nil) error = %v", err)
	}
}
