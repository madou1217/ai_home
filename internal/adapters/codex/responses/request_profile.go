package responses

import "net/http"

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
}

// requestProfileForModel 返回与 Codex rust-v0.145.0 模型清单一致的请求策略。
//
// 未知模型保守使用标准 Responses；新增 Lite 模型只需更新这一处映射。
func requestProfileForModel(model string) requestProfile {
	switch model {
	case "gpt-5.6-sol":
		return requestProfile{
			mode:                   responsesLiteMode,
			defaultReasoningEffort: "low",
		}
	case "gpt-5.6-terra", "gpt-5.6-luna":
		return requestProfile{
			mode:                   responsesLiteMode,
			defaultReasoningEffort: "medium",
		}
	default:
		return requestProfile{mode: standardResponsesMode}
	}
}

// projectRequest 按 Profile 投影顶层工具、并行调用、reasoning 和 include。
func (profile requestProfile) projectRequest(
	input []inputItemDTO,
	tools []toolDTO,
	parallelToolCalls bool,
	reasoning *reasoningDTO,
	include []string,
) (
	[]inputItemDTO,
	*[]toolDTO,
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
	reasoning.Context = reasoningContextAllTurns
	include = appendUnique(include, "reasoning.encrypted_content")

	return projectedInput, nil, false, reasoning, include
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
