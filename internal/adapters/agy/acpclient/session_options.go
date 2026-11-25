package acpclient

import (
	"context"
	"fmt"
	"strings"

	acp "github.com/coder/acp-go-sdk"
)

// AGY exposes one model choice as two ACP session config options: a family
// selector ("gemini-4-neon") and a separate thought level ("low|medium|high|
// xhigh"). Callers name the public model id ("gemini-4-neon-xhigh"), so this
// adapter resolves that id against whatever the agent actually advertised in
// session/new and sets the options. Unknown values fail closed: running a
// different model than the caller asked for without saying so is never right.

// effortSuffixes are the model-id suffixes that AGY also sells as thought
// levels, longest first so "-xhigh" is not shadowed by "-high".
var effortSuffixes = []string{"xhigh", "medium", "high", "low"}

// modelOptionID and effortOptionID are the ACP config option ids the AGY agent
// advertises. Categories are matched too so a future id still resolves.
const (
	modelOptionID  = "model"
	effortOptionID = "thought_level"
)

func applyModelSelection(ctx context.Context, conn *acp.ClientSideConnection, sessionID string, options []acp.SessionConfigOption, model, effort string) error {
	model = strings.TrimSpace(model)
	effort = strings.ToLower(strings.TrimSpace(effort))
	if model == "" && effort == "" {
		return nil
	}
	selects := indexSelectOptions(options)
	modelSelect := selects[modelOptionID]
	effortSelect := selects[effortOptionID]

	derivedEffort := ""
	if model != "" {
		if modelSelect == nil {
			return fmt.Errorf("ACP agent 未提供 %s 配置项，无法选择模型 %s", modelOptionID, model)
		}
		value, suffix, err := resolveModelValue(modelSelect, model)
		if err != nil {
			return err
		}
		derivedEffort = suffix
		if err := setSelectValue(ctx, conn, sessionID, modelSelect, value); err != nil {
			return err
		}
	}
	if effort == "" {
		// Only derive the effort when the model id itself had to be split into
		// family + effort; an exact model id (e.g. gpt-oss-120b-medium) already
		// names its own variant.
		effort = derivedEffort
	}
	if effort == "" {
		return nil
	}
	if effortSelect == nil {
		return fmt.Errorf("ACP agent 未提供 %s 配置项，无法设置 effort=%s", effortOptionID, effort)
	}
	if !selectHasValue(effortSelect, effort) {
		return fmt.Errorf("ACP agent 不支持 effort=%s（可选：%s）", effort, strings.Join(selectValues(effortSelect), ","))
	}
	return setSelectValue(ctx, conn, sessionID, effortSelect, effort)
}

func indexSelectOptions(options []acp.SessionConfigOption) map[string]*acp.SessionConfigOptionSelect {
	out := make(map[string]*acp.SessionConfigOptionSelect, len(options)*2)
	for i := range options {
		selectOption := options[i].Select
		if selectOption == nil {
			continue
		}
		out[string(selectOption.Id)] = selectOption
		if selectOption.Category != nil {
			out[string(*selectOption.Category)] = selectOption
		}
	}
	return out
}

// resolveModelValue returns the value to set plus the effort encoded in the
// model id when the agent only accepts the family.
func resolveModelValue(selectOption *acp.SessionConfigOptionSelect, model string) (value, derivedEffort string, err error) {
	if selectHasValue(selectOption, model) {
		return model, "", nil
	}
	if family, effort, ok := splitEffortSuffix(model); ok && selectHasValue(selectOption, family) {
		return family, effort, nil
	}
	return "", "", fmt.Errorf("ACP agent 不提供模型 %s（可选：%s）", model, strings.Join(selectValues(selectOption), ","))
}

func splitEffortSuffix(model string) (family, effort string, ok bool) {
	lower := strings.ToLower(model)
	for _, suffix := range effortSuffixes {
		if strings.HasSuffix(lower, "-"+suffix) && len(model) > len(suffix)+1 {
			return model[:len(model)-len(suffix)-1], suffix, true
		}
	}
	return "", "", false
}

func selectHasValue(selectOption *acp.SessionConfigOptionSelect, value string) bool {
	for _, candidate := range selectValues(selectOption) {
		if candidate == value {
			return true
		}
	}
	return false
}

func selectValues(selectOption *acp.SessionConfigOptionSelect) []string {
	if selectOption.Options.Ungrouped != nil {
		out := make([]string, 0, len(*selectOption.Options.Ungrouped))
		for _, option := range *selectOption.Options.Ungrouped {
			out = append(out, string(option.Value))
		}
		return out
	}
	if selectOption.Options.Grouped != nil {
		out := make([]string, 0)
		for _, group := range *selectOption.Options.Grouped {
			for _, option := range group.Options {
				out = append(out, string(option.Value))
			}
		}
		return out
	}
	return nil
}

func setSelectValue(ctx context.Context, conn *acp.ClientSideConnection, sessionID string, selectOption *acp.SessionConfigOptionSelect, value string) error {
	if string(selectOption.CurrentValue) == value {
		return nil
	}
	_, err := conn.SetSessionConfigOption(ctx, acp.SetSessionConfigOptionRequest{
		ValueId: &acp.SetSessionConfigOptionValueId{
			SessionId: acp.SessionId(sessionID),
			ConfigId:  selectOption.Id,
			Value:     acp.SessionConfigValueId(value),
		},
	})
	if err != nil {
		return fmt.Errorf("ACP 设置 %s=%s 失败: %w", selectOption.Id, value, err)
	}
	return nil
}
