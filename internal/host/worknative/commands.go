package worknative

import (
	"net/http"
	"runtime"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
)

// Work command identities and executable names are separate contracts. The
// encoder owns the logical provider command; registered launch strategies own
// the official binary. Only these known family aliases may differ.
func validWorkCommand(provider, command, binary string) bool {
	built, err := sessionchat.BuildStartCommand(provider, sessionchat.StartOptions{Prompt: "native-capability-encoding", Platform: runtime.GOOS})
	if err != nil || built.CommandName != command {
		return false
	}
	expected := provider
	switch {
	case providers.IsCodeBuddyFamilyProvider(provider):
		expected = "codebuddy"
	case provider == "qoder":
		expected = "qodercli"
	case provider == "qodercn":
		expected = "qoderclicn"
	}
	return binary == expected
}

func workProtocol(provider string) (string, error) {
	if _, err := sessionchat.BuildStartCommand(provider, sessionchat.StartOptions{Prompt: "native-capability-encoding", Platform: runtime.GOOS}); err != nil {
		return "", chatruntime.NewError("native_execution_provider_unsupported", http.StatusUnprocessableEntity, nil)
	}
	transport := sessionchat.ResolveNativeChatTransport(provider, false)
	if transport.Mode != sessionchat.ModeHeadlessStream || transport.PromptDelivery != sessionchat.PromptDeliveryArgv {
		return "", chatruntime.NewError("native_execution_transport_unavailable", http.StatusNotImplemented, nil)
	}
	if provider == "agy" {
		return chatruntime.NativeClientProtocolAGYStreamJSON, nil
	}
	return chatruntime.NativeClientProtocolHeadlessStream, nil
}
