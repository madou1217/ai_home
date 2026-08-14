package inference

// ProviderID 是账号和认证归属，不表达上游线协议或客户端入口协议。
type ProviderID string

const (
	// ProviderCodex 表示账号凭据和生命周期归属 Codex。
	ProviderCodex ProviderID = "codex"
	// ProviderClaude 表示账号凭据和生命周期归属 Claude。
	ProviderClaude ProviderID = "claude"
	// ProviderAgy 表示账号凭据和生命周期归属 Antigravity。
	ProviderAgy ProviderID = "agy"
)

// ParseProviderID 从未经改写的规范值创建当前阶段支持的 Provider ID。
func ParseProviderID(value string) (ProviderID, error) {
	providerID := ProviderID(value)
	if !providerID.IsValid() {
		return "", ErrInvalidProviderID
	}
	return providerID, nil
}

// IsValid 判断 Provider ID 是否属于当前 Codex/Claude 重构范围。
func (providerID ProviderID) IsValid() bool {
	return providerID == ProviderCodex ||
		providerID == ProviderClaude ||
		providerID == ProviderAgy
}

// ProtocolID 是 AI Home 调用上游时使用的真实线协议。
//
// 它与 ProviderID 分离，因此账号归属和协议实现不会形成隐式绑定。
type ProtocolID string

const (
	// ProtocolCodexResponses 表示 Codex 使用的 Responses 上游协议变体。
	ProtocolCodexResponses ProtocolID = "codex.responses"
	// ProtocolClaudeMessages 表示 Claude 使用的 Messages 上游协议变体。
	ProtocolClaudeMessages ProtocolID = "claude.messages"
	// ProtocolAgyCodeAssist 表示 Antigravity 使用的 Code Assist agent envelope。
	ProtocolAgyCodeAssist ProtocolID = "agy.code_assist"
)

// IsValid 判断上游线协议是否已有完整 Adapter。
func (protocolID ProtocolID) IsValid() bool {
	return protocolID == ProtocolCodexResponses ||
		protocolID == ProtocolClaudeMessages ||
		protocolID == ProtocolAgyCodeAssist
}

// ClientProtocolID 是进入 AI Home 的客户端请求和响应协议。
//
// Client Renderer 只依赖该值，不能从 ProviderID 推断响应形状。
type ClientProtocolID string

const (
	// ClientProtocolOpenAIResponses 表示 OpenAI Responses 客户端协议。
	ClientProtocolOpenAIResponses ClientProtocolID = "openai.responses"
	// ClientProtocolOpenAIChatCompletions 表示 OpenAI Chat Completions 客户端协议。
	ClientProtocolOpenAIChatCompletions ClientProtocolID = "openai.chat_completions"
	// ClientProtocolAnthropicMessages 表示 Anthropic Messages 客户端协议。
	ClientProtocolAnthropicMessages ClientProtocolID = "anthropic.messages"
)

// IsValid 判断客户端入口协议是否已有完整 Decoder 和 Renderer 计划。
func (protocolID ClientProtocolID) IsValid() bool {
	switch protocolID {
	case ClientProtocolOpenAIResponses,
		ClientProtocolOpenAIChatCompletions,
		ClientProtocolAnthropicMessages:
		return true
	default:
		return false
	}
}
