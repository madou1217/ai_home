package modelsapi

import (
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
)

const (
	// codexRelayBaseInstructions 提供跨上游模型都成立的最小编码代理职责。
	// Provider 与账号的专属行为继续由 Canonical Request 和上游 Adapter 决定。
	codexRelayBaseInstructions = "You are a coding agent. Follow the user's instructions and use the available tools to complete the task safely and accurately."
	// codexToolOutputByteLimit 与 Codex 本地 fallback 的字节截断策略一致。
	codexToolOutputByteLimit = 10_000
)

// codexModelList 是 Codex ModelsClient 要求的顶层 envelope。
type codexModelList struct {
	Models []codexModelView `json:"models"`
}

// codexModelView 是本地模型 ID 到 Codex ModelInfo 的保守传输投影。
// 未被账号模型目录证明的上下文窗口、升级关系等能力保持 null 或缺省。
type codexModelView struct {
	AdditionalSpeedTiers              []string                    `json:"additional_speed_tiers"`
	ServiceTiers                      []modelmetadata.ServiceTier `json:"service_tiers"`
	Slug                              string                      `json:"slug"`
	DisplayName                       string                      `json:"display_name"`
	Description                       *string                     `json:"description"`
	SupportedReasoningLevels          []codexReasoningLevel       `json:"supported_reasoning_levels"`
	ShellType                         string                      `json:"shell_type"`
	Visibility                        string                      `json:"visibility"`
	SupportedInAPI                    bool                        `json:"supported_in_api"`
	Priority                          int                         `json:"priority"`
	AvailabilityNUX                   *codexUnavailableMetadata   `json:"availability_nux"`
	Upgrade                           *codexUnavailableMetadata   `json:"upgrade"`
	BaseInstructions                  string                      `json:"base_instructions"`
	SupportsReasoningSummaryParameter bool                        `json:"supports_reasoning_summary_parameter"`
	DefaultReasoningSummary           string                      `json:"default_reasoning_summary"`
	SupportVerbosity                  bool                        `json:"support_verbosity"`
	DefaultVerbosity                  *string                     `json:"default_verbosity"`
	ApplyPatchToolType                *string                     `json:"apply_patch_tool_type"`
	WebSearchToolType                 string                      `json:"web_search_tool_type"`
	TruncationPolicy                  codexTruncationPolicy       `json:"truncation_policy"`
	SupportsParallelToolCalls         bool                        `json:"supports_parallel_tool_calls"`
	SupportsImageDetailOriginal       bool                        `json:"supports_image_detail_original"`
	ExperimentalSupportedTools        []string                    `json:"experimental_supported_tools"`
	InputModalities                   []string                    `json:"input_modalities"`
	SupportsSearchTool                bool                        `json:"supports_search_tool"`
}

// codexReasoningLevel 保留 Codex 线协议的数组形状；当前目录没有可靠档位元数据。
type codexReasoningLevel struct {
	Effort      string `json:"effort"`
	Description string `json:"description"`
}

// codexUnavailableMetadata 表示本地目录尚未保存的可选 Codex 元数据。
type codexUnavailableMetadata struct{}

// codexTruncationPolicy 控制 Codex 客户端如何截断工具输出。
type codexTruncationPolicy struct {
	Mode  string `json:"mode"`
	Limit int    `json:"limit"`
}

// newCodexModelList 保持标准目录的排序和去重结果，并生成稳定优先级。
// codexSupportsUltrafast 判断模型是否按官方文档支持 Ultrafast 服务档。
// GPT-6 Astra 与 GPT-6.1 Sol 是官方明确列出的两个模型；账号无权限时上游会
// 接受 ultrafast 并降级为 default，而不是 400。
func codexSupportsUltrafast(model string) bool {
	id := strings.ToLower(strings.TrimSpace(model))
	if index := strings.LastIndex(id, "/"); index >= 0 {
		id = id[index+1:]
	}
	return id == "gpt-6.1-sol" || id == "gpt-6-astra"
}

func appendUniqueString(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func newCodexModelList(models []modelView) codexModelList {
	views := make([]codexModelView, 0, len(models))
	for index, model := range models {
		views = append(views, codexModelView{
			ServiceTiers:                      []modelmetadata.ServiceTier{},
			Slug:                              model.ID,
			DisplayName:                       model.ID,
			Description:                       nil,
			SupportedReasoningLevels:          []codexReasoningLevel{},
			ShellType:                         "shell_command",
			Visibility:                        "list",
			SupportedInAPI:                    true,
			Priority:                          index + 1,
			AvailabilityNUX:                   nil,
			Upgrade:                           nil,
			BaseInstructions:                  codexRelayBaseInstructions,
			SupportsReasoningSummaryParameter: true,
			DefaultReasoningSummary:           "auto",
			SupportVerbosity:                  false,
			DefaultVerbosity:                  nil,
			ApplyPatchToolType:                nil,
			WebSearchToolType:                 "text",
			TruncationPolicy: codexTruncationPolicy{
				Mode:  "bytes",
				Limit: codexToolOutputByteLimit,
			},
			SupportsParallelToolCalls:   true,
			SupportsImageDetailOriginal: false,
			ExperimentalSupportedTools:  []string{},
			InputModalities:             []string{"text", "image"},
			SupportsSearchTool:          true,
			AdditionalSpeedTiers:        []string{},
		})
	}
	return codexModelList{Models: views}
}
