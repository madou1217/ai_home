package responses

import (
	"encoding/json"
	"net/http"
)

const (
	// responsesLiteHeader 是 Codex 上游识别 Responses Lite 合同的显式标记。
	responsesLiteHeader = "x-openai-internal-codex-responses-lite"
	// reasoningContextAllTurns 要求 Lite 模型保留完整会话的 reasoning 连续性。
	reasoningContextAllTurns = "all_turns"
)

// requestWireMode 区分同一 Responses 端点上的两种线协议形态。
type requestWireMode uint8

const (
	standardResponsesMode requestWireMode = iota
	responsesLiteMode
)

// requestProfile 把模型差异收敛为 Adapter 内部策略，避免扩散到路由和客户端层。
type requestProfile struct {
	mode                   requestWireMode
	defaultReasoningEffort string
	defaultVerbosity       string
}

// requestProfileForModel 返回与 Codex 模型清单一致的请求策略。
//
// gpt-5.6-* 对齐 rust-v0.146.0；gpt-6-* 对齐 Codex CLI 0.158.0-alpha.2.1 的
// models_cache（use_responses_lite=true、default_verbosity=low，astra 默认 low、
// sol/luna 默认 medium），且该版本客户端对 astra 实测发送 Lite 形状与 Lite Header。
// 未知模型保守使用标准 Responses；新增 Lite 模型只需更新这一处映射。
func requestProfileForModel(model string) requestProfile {
	switch model {
	case "gpt-5.6-sol", "gpt-6-astra":
		return requestProfile{
			mode:                   responsesLiteMode,
			defaultReasoningEffort: "low",
			defaultVerbosity:       "low",
		}
	case "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna":
		return requestProfile{
			mode:                   responsesLiteMode,
			defaultReasoningEffort: "medium",
			defaultVerbosity:       "low",
		}
	default:
		return requestProfile{mode: standardResponsesMode}
	}
}

// projectRequest 按 Profile 投影顶层工具、并行调用、reasoning 和 include。
func (profile requestProfile) projectRequest(
	input []inputItemDTO,
	tools []json.RawMessage,
	parallelToolCalls bool,
	reasoning *reasoningDTO,
	include []string,
) (
	[]inputItemDTO,
	*[]json.RawMessage,
	bool,
	*reasoningDTO,
	[]string,
) {
	topLevelTools := tools
	if profile.mode != responsesLiteMode {
		return input,
			&topLevelTools,
			parallelToolCalls,
			reasoning,
			include
	}

	additionalTools := tools
	projectedInput := make([]inputItemDTO, 0, len(input)+1)
	projectedInput = append(projectedInput, inputItemDTO{
		Type:            "additional_tools",
		Role:            "developer",
		AdditionalTools: &additionalTools,
	})
	projectedInput = append(projectedInput, input...)

	if reasoning == nil {
		reasoning = &reasoningDTO{}
	}
	if reasoning.Effort == "" {
		reasoning.Effort = profile.defaultReasoningEffort
	}
	if reasoning.Context == "" {
		// 客户端显式给出的 context 优先；缺省时 Lite 模型需要整段会话的 reasoning 连续性。
		reasoning.Context = reasoningContextAllTurns
	}
	include = appendUnique(include, "reasoning.encrypted_content")

	return projectedInput, nil, false, reasoning, include
}

// projectText 补齐模型清单声明的默认文本控制，同时保留客户端结构化输出。
func (profile requestProfile) projectText(
	text *textControlDTO,
) *textControlDTO {
	if profile.defaultVerbosity == "" {
		return text
	}
	if text == nil {
		text = &textControlDTO{}
	}
	if text.Verbosity == "" {
		// 客户端显式给出的 verbosity 优先，缺省才补模型清单默认值。
		text.Verbosity = profile.defaultVerbosity
	}
	return text
}

// applyHeaders 为 Responses Lite 请求附加官方兼容 Header。
func (profile requestProfile) applyHeaders(header http.Header) {
	if profile.mode == responsesLiteMode {
		header.Set(responsesLiteHeader, "true")
	}
}

// appendUnique 保持原顺序并避免重复的 include 值。
func appendUnique(values []string, candidate string) []string {
	for _, value := range values {
		if value == candidate {
			return values
		}
	}
	return append(values, candidate)
}
