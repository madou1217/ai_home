package anthropicmessages

import (
	"encoding/json"
	"fmt"

	"github.com/madou1217/ai_home/core/inference"
)

const anthropicStructuredOutputName = "anthropic_output"

// decodeTools 解析 Anthropic custom tools 及其精确缓存断点。
func decodeTools(
	rawTools []json.RawMessage,
) ([]inference.ToolDefinition, []inference.PromptCacheBreakpoint, error) {
	tools := make([]inference.ToolDefinition, 0, len(rawTools))
	breakpoints := make([]inference.PromptCacheBreakpoint, 0)
	for index, raw := range rawTools {
		field := fmt.Sprintf("tools[%d]", index)
		header, err := decodeHeader[contentHeaderDTO](raw, field)
		if err != nil {
			return nil, nil, err
		}
		if header.Type != "" && header.Type != "custom" {
			return nil, nil, unsupportedField(field + ".type")
		}
		wireTool, err := decodeStrict[toolDTO](raw, field)
		if err != nil {
			return nil, nil, err
		}
		switch {
		case wireTool.Type != nil && *wireTool.Type != "custom":
			return nil, nil, unsupportedField(field + ".type")
		case !isObjectSchema(wireTool.InputSchema):
			return nil, nil, invalidField(field + ".input_schema")
		}
		allowedCallers, err := decodeToolCallers(
			wireTool.AllowedCallers,
			field+".allowed_callers",
		)
		if err != nil {
			return nil, nil, err
		}

		inputExamples := make([][]byte, len(wireTool.InputExamples))
		for exampleIndex, example := range wireTool.InputExamples {
			inputExamples[exampleIndex] = append([]byte(nil), example...)
		}
		tool, toolErr := inference.NewToolDefinitionWithOptions(
			wireTool.Name,
			wireTool.Description,
			wireTool.InputSchema,
			inference.ToolDefinitionOptions{
				Strict:              wireTool.Strict,
				AllowedCallers:      allowedCallers,
				DeferLoading:        wireTool.DeferLoading,
				EagerInputStreaming: wireTool.EagerInputStreaming,
				InputExamples:       inputExamples,
			},
		)
		if toolErr != nil {
			return nil, nil, invalidField(field)
		}
		tools = append(tools, tool)
		cacheControl, err := decodePromptCacheControl(
			wireTool.CacheControl,
			field+".cache_control",
		)
		if err != nil {
			return nil, nil, err
		}
		if cacheControl != nil {
			breakpoint, breakpointErr := inference.NewToolPromptCacheBreakpoint(
				uint32(index),
				*cacheControl,
			)
			if breakpointErr != nil {
				return nil, nil, invalidField(field + ".cache_control")
			}
			breakpoints = append(breakpoints, breakpoint)
		}
	}
	return tools, breakpoints, nil
}

// decodeToolCallers 将公开调用来源转换为稳定枚举。
func decodeToolCallers(
	values []string,
	field string,
) ([]inference.ToolCaller, error) {
	callers := make([]inference.ToolCaller, len(values))
	for index, value := range values {
		caller := inference.ToolCaller(value)
		if !caller.IsValid() {
			return nil, invalidField(fmt.Sprintf("%s[%d]", field, index))
		}
		callers[index] = caller
	}
	return callers, nil
}

// isObjectSchema 校验 Anthropic custom tool 的根 Schema 明确声明 object。
func isObjectSchema(raw json.RawMessage) bool {
	var schema map[string]json.RawMessage
	if err := json.Unmarshal(raw, &schema); err != nil || schema == nil {
		return false
	}
	var schemaType string
	return json.Unmarshal(schema["type"], &schemaType) == nil && schemaType == "object"
}

// decodeToolChoice 解析工具选择并反转 disable_parallel_tool_use 语义。
func decodeToolChoice(
	raw json.RawMessage,
) (*inference.ToolChoice, *bool, error) {
	if !hasJSONValue(raw) {
		return nil, nil, nil
	}
	header, err := decodeHeader[toolChoiceHeaderDTO](raw, "tool_choice")
	if err != nil {
		return nil, nil, err
	}

	var choice inference.ToolChoice
	var disableParallel *bool
	switch header.Type {
	case "auto", "any", "none":
		wireChoice, err := decodeStrict[toolChoiceModeDTO](raw, "tool_choice")
		if err != nil {
			return nil, nil, err
		}
		if wireChoice.Type == "none" && wireChoice.DisableParallelToolUse != nil {
			return nil, nil, invalidField("tool_choice.disable_parallel_tool_use")
		}
		mode := inference.ToolChoiceAuto
		if wireChoice.Type == "any" {
			mode = inference.ToolChoiceRequired
		} else if wireChoice.Type == "none" {
			mode = inference.ToolChoiceNone
		}
		choice, err = inference.NewToolChoice(mode)
		if err != nil {
			return nil, nil, invalidField("tool_choice")
		}
		disableParallel = wireChoice.DisableParallelToolUse
	case "tool":
		wireChoice, err := decodeStrict[namedToolChoiceDTO](raw, "tool_choice")
		if err != nil {
			return nil, nil, err
		}
		choice, err = inference.NewNamedToolChoice(wireChoice.Name)
		if err != nil {
			return nil, nil, invalidField("tool_choice.name")
		}
		disableParallel = wireChoice.DisableParallelToolUse
	default:
		return nil, nil, invalidField("tool_choice.type")
	}

	var parallelToolCalls *bool
	if disableParallel != nil {
		parallel := !*disableParallel
		parallelToolCalls = &parallel
	}
	return &choice, parallelToolCalls, nil
}

// decodeOutputConfig 解析结构化输出和 reasoning effort。
func decodeOutputConfig(
	raw json.RawMessage,
) (*inference.StructuredOutput, inference.ReasoningEffort, error) {
	if !hasJSONValue(raw) {
		return nil, "", nil
	}
	wireConfig, err := decodeStrict[outputConfigDTO](raw, "output_config")
	if err != nil {
		return nil, "", err
	}

	var effort inference.ReasoningEffort
	if wireConfig.Effort != nil {
		effort, err = decodeEffort(*wireConfig.Effort, "output_config.effort")
		if err != nil {
			return nil, "", err
		}
	}
	if !hasJSONValue(wireConfig.Format) {
		return nil, effort, nil
	}
	wireFormat, err := decodeStrict[outputFormatDTO](
		wireConfig.Format,
		"output_config.format",
	)
	if err != nil {
		return nil, "", err
	}
	if wireFormat.Type != "json_schema" {
		return nil, "", invalidField("output_config.format.type")
	}
	output, outputErr := inference.NewStructuredOutput(
		anthropicStructuredOutputName,
		"",
		wireFormat.Schema,
		true,
	)
	if outputErr != nil {
		return nil, "", invalidField("output_config.format.schema")
	}
	return &output, effort, nil
}

// decodeEffort 将 Anthropic 当前四档 effort 保留为 Canonical 等级。
func decodeEffort(value string, field string) (inference.ReasoningEffort, error) {
	effort := inference.ReasoningEffort(value)
	switch effort {
	case inference.ReasoningEffortLow,
		inference.ReasoningEffortMedium,
		inference.ReasoningEffortHigh,
		inference.ReasoningEffortMax:
		return effort, nil
	default:
		return "", invalidField(field)
	}
}

// decodeReasoning 合并 thinking 和 output_config.effort 的并行语义。
func decodeReasoning(
	raw json.RawMessage,
	effort inference.ReasoningEffort,
	maxTokens uint64,
) (*inference.ReasoningConfig, error) {
	if !hasJSONValue(raw) {
		if effort == "" {
			return nil, nil
		}
		config, err := inference.NewEffortReasoning(effort, "")
		if err != nil {
			return nil, invalidField("output_config.effort")
		}
		return &config, nil
	}

	header, err := decodeHeader[thinkingHeaderDTO](raw, "thinking")
	if err != nil {
		return nil, err
	}
	var config inference.ReasoningConfig
	switch header.Type {
	case "enabled":
		wireThinking, err := decodeStrict[budgetThinkingDTO](raw, "thinking")
		if err != nil {
			return nil, err
		}
		if wireThinking.BudgetTokens == nil ||
			*wireThinking.BudgetTokens < 1024 ||
			*wireThinking.BudgetTokens >= maxTokens {
			return nil, invalidField("thinking.budget_tokens")
		}
		summary, err := decodeThinkingDisplay(wireThinking.Display)
		if err != nil {
			return nil, err
		}
		config, err = inference.NewBudgetReasoningWithEffort(
			*wireThinking.BudgetTokens,
			summary,
			effort,
		)
		if err != nil {
			return nil, invalidField("thinking")
		}
	case "adaptive":
		wireThinking, err := decodeStrict[adaptiveThinkingDTO](raw, "thinking")
		if err != nil {
			return nil, err
		}
		summary, err := decodeThinkingDisplay(wireThinking.Display)
		if err != nil {
			return nil, err
		}
		config, err = inference.NewAdaptiveReasoningWithEffort(summary, effort)
		if err != nil {
			return nil, invalidField("thinking")
		}
	case "disabled":
		if _, err := decodeStrict[disabledThinkingDTO](raw, "thinking"); err != nil {
			return nil, err
		}
		disabledEffort := effort
		if disabledEffort == "" {
			disabledEffort = inference.ReasoningEffortNone
		}
		config, err = inference.NewEffortReasoning(
			disabledEffort,
			inference.ReasoningSummaryNone,
		)
		if err != nil {
			return nil, invalidField("thinking")
		}
	default:
		return nil, invalidField("thinking.type")
	}
	return &config, nil
}

// decodeThinkingDisplay 保留 summarized 与 omitted 的输出意图。
func decodeThinkingDisplay(display *string) (inference.ReasoningSummaryMode, error) {
	if display == nil || *display == "summarized" {
		return inference.ReasoningSummaryAuto, nil
	}
	if *display == "omitted" {
		return inference.ReasoningSummaryNone, nil
	}
	return "", invalidField("thinking.display")
}
