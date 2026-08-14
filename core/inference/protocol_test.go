package inference

import (
	"errors"
	"testing"
)

// TestProtocolIdentifiersKeepProviderAndWireProtocolIndependent 验证账号归属、
// 上游线协议和客户端入口协议不会被同一种字符串类型混用。
func TestProtocolIdentifiersKeepProviderAndWireProtocolIndependent(t *testing.T) {
	t.Parallel()

	providerID, err := ParseProviderID("codex")
	if err != nil {
		t.Fatalf("ParseProviderID() error = %v", err)
	}
	if providerID != ProviderCodex {
		t.Fatalf("ParseProviderID() = %q, want %q", providerID, ProviderCodex)
	}
	if !ProtocolCodexResponses.IsValid() {
		t.Fatal("ProtocolCodexResponses 应当是合法上游协议")
	}
	if !ClientProtocolAnthropicMessages.IsValid() {
		t.Fatal("ClientProtocolAnthropicMessages 应当是合法客户端协议")
	}
}

// TestProtocolIdentifiersRejectNonCanonicalValues 验证协议边界不会静默修剪、
// 改写大小写或接受尚未实现的协议。
func TestProtocolIdentifiersRejectNonCanonicalValues(t *testing.T) {
	t.Parallel()

	invalidProviders := []string{"", " Codex", "CODEX", "antigravity", "claude\n"}
	for _, value := range invalidProviders {
		value := value
		t.Run("provider_"+value, func(t *testing.T) {
			t.Parallel()

			_, err := ParseProviderID(value)
			if !errors.Is(err, ErrInvalidProviderID) {
				t.Fatalf("ParseProviderID(%q) error = %v, want ErrInvalidProviderID", value, err)
			}
		})
	}

	if ProtocolID("openai.responses").IsValid() {
		t.Fatal("未注册的上游协议不应被接受")
	}
	if ClientProtocolID("agy.generate").IsValid() {
		t.Fatal("未实现的客户端协议不应被接受")
	}
}
