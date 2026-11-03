package inference

// 本文件保存只影响输出风格或 reasoning 连续性、不改变对话语义的请求提示。
//
// 来源：OpenAI Responses Lite 请求形状。Codex CLI 0.158.0-alpha.2.1（ChatGPT.app 捆绑）
// 对 use_responses_lite 模型（gpt-6-astra / gpt-6-sol / gpt-6-luna / gpt-5.6-*）总会发送
// text.verbosity 与 reasoning.context；仓库 request_profile.go 记录 rust-v0.146.0 已有同形状。
// 没有等价控制的 Provider（Claude、AGY）按提示语义忽略它们，而不是拒绝整个请求。

// TextVerbosity 是模型输出详略程度的提示。
type TextVerbosity string

const (
	// TextVerbosityLow 要求简洁输出。
	TextVerbosityLow TextVerbosity = "low"
	// TextVerbosityMedium 要求中等详略。
	TextVerbosityMedium TextVerbosity = "medium"
	// TextVerbosityHigh 要求详尽输出。
	TextVerbosityHigh TextVerbosity = "high"
)

// IsValid 判断详略提示是否为已知值。
func (verbosity TextVerbosity) IsValid() bool {
	return verbosity == TextVerbosityLow ||
		verbosity == TextVerbosityMedium ||
		verbosity == TextVerbosityHigh
}

// ReasoningContext 是 reasoning 连续性保留范围。
type ReasoningContext string

const (
	// ReasoningContextAllTurns 要求模型在整段会话中保留 reasoning 连续性。
	ReasoningContextAllTurns ReasoningContext = "all_turns"
)

// IsValid 判断 reasoning 连续性范围是否为已知值。
//
// 只接受实测见过的值；新值由协议解码器拒收并交还能透传的宿主处理。
func (context ReasoningContext) IsValid() bool {
	return context == ReasoningContextAllTurns
}

// TextVerbosity 返回可选输出详略提示。
func (request Request) TextVerbosity() (TextVerbosity, bool) {
	return request.textVerbosity, request.textVerbosity != ""
}

// ReasoningContext 返回可选 reasoning 连续性范围。
func (request Request) ReasoningContext() (ReasoningContext, bool) {
	return request.reasoningContext, request.reasoningContext != ""
}
