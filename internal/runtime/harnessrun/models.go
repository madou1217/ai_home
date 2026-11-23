package harnessrun

import (
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
)

// thinkingLevelMap 与 pi 的 model-config schema 固定七档同序。
// 值为 null 表示该档位不可用。
type thinkingLevelMap struct {
	Off     *string `json:"off"`
	Minimal *string `json:"minimal"`
	Low     *string `json:"low"`
	Medium  *string `json:"medium"`
	High    *string `json:"high"`
	Xhigh   *string `json:"xhigh"`
	Max     *string `json:"max"`
}

// harnessModel 是 pi / dsh 模型投影的共同事实。
//
// 展示名、上下文/输出上限、推理标记与价格来自 assets/modelsdev-metadata.json
// （与 Node attachModelMetadata 同源快照的压缩投影）；模态/档位回退来自调用方注入的
// 能力来源（Runtime.Capabilities，当前是 contracts/model-capabilities 冻结基线）。
type harnessModel struct {
	ID               string
	Name             string
	Input            []string
	Reasoning        bool
	ReasoningKnown   bool
	ThinkingLevelMap *thinkingLevelMap
	ContextWindow    int64
	MaxTokens        int64
	Cost             *modelCost
}

var piThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

func levelValue(name string) *string {
	value := name
	return &value
}

// buildThinkingLevelMap 由网关发布的档位生成 pi 的 thinkingLevelMap；
// 网关没给档位时返回 nil，不猜。
func buildThinkingLevelMap(efforts []string) *thinkingLevelMap {
	if len(efforts) == 0 {
		return nil
	}
	supported := make(map[string]bool, len(efforts)+1)
	for _, effort := range efforts {
		normalized := strings.ToLower(strings.TrimSpace(effort))
		if normalized != "" {
			supported[normalized] = true
		}
	}
	if len(supported) == 0 {
		return nil
	}
	// `none` 在 pi 的词汇里是 `off`。
	if supported["none"] {
		supported["off"] = true
	}
	value := func(level string) *string {
		if supported[level] {
			return levelValue(level)
		}
		return nil
	}
	return &thinkingLevelMap{
		Off:     value("off"),
		Minimal: value("minimal"),
		Low:     value("low"),
		Medium:  value("medium"),
		High:    value("high"),
		Xhigh:   value("xhigh"),
		Max:     value("max"),
	}
}

// normalizeInputModalities 与 Node 同序：metadata 输入优先，回退网关模态；
// 只保留 text/image，并保证 text 在首位。
func normalizeInputModalities(metadataInput []string, fallback *modelModalities) []string {
	source := metadataInput
	if len(source) == 0 && fallback != nil {
		source = fallback.Input
	}
	input := make([]string, 0, len(source)+1)
	seen := make(map[string]bool)
	for _, item := range source {
		normalized := strings.ToLower(strings.TrimSpace(item))
		if (normalized != "text" && normalized != "image") || seen[normalized] {
			continue
		}
		seen[normalized] = true
		if normalized == "text" {
			input = append([]string{"text"}, input...)
			continue
		}
		input = append(input, normalized)
	}
	if !seen["text"] {
		input = append([]string{"text"}, input...)
	}
	return input
}

// buildHarnessModels 复刻 buildHarnessModelEntries：按出现顺序去重，丢弃空 id。
func buildHarnessModels(entries []gatewayModel, provider string, metadata modelmetadata.FactsSource) []harnessModel {
	models := make([]harnessModel, 0, len(entries))
	seen := make(map[string]bool)
	for _, entry := range entries {
		id := strings.TrimSpace(entry.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, buildHarnessModel(entry, provider, metadata))
	}
	return models
}

func buildHarnessModel(entry gatewayModel, provider string, metadata modelmetadata.FactsSource) harnessModel {
	id := strings.TrimSpace(entry.ID)
	model := harnessModel{
		ID:    id,
		Name:  id,
		Input: normalizeInputModalities(nil, entry.Modalities),
	}
	metadataFound := false
	if metadataEntry, found := lookupModelMetadata(provider, id); found {
		metadataFound = true
		if metadataEntry.Name != "" {
			model.Name = metadataEntry.Name
		}
		if len(metadataEntry.Input) > 0 {
			model.Input = normalizeInputModalities(metadataEntry.Input, entry.Modalities)
		}
		if metadataEntry.Context > 0 {
			model.ContextWindow = metadataEntry.Context
		}
		if metadataEntry.Output > 0 {
			model.MaxTokens = metadataEntry.Output
		}
		model.Reasoning = metadataEntry.Reasoning
		model.ReasoningKnown = true
		model.Cost = metadataEntry.Cost
	}
	var ladder []string
	if metadata != nil {
		if !metadataFound {
			if modalities, found := metadata.LookupModalities(provider, id); found {
				model.Input = normalizeInputModalities(modalities.Input(), entry.Modalities)
				model.ReasoningKnown = true
			}
		}
		if contextWindow, found := metadata.LookupContextWindow(provider, id); found && contextWindow > 0 && model.ContextWindow == 0 {
			model.ContextWindow = int64(contextWindow)
			model.ReasoningKnown = true
		}
		if efforts, found := metadata.LookupReasoningEfforts(provider, id); found {
			for _, effort := range efforts {
				ladder = append(ladder, string(effort))
			}
			model.ReasoningKnown = true
		}
	}
	if len(ladder) > 0 || len(entry.ReasoningEfforts) > 0 {
		model.Reasoning = true
		model.ReasoningKnown = true
	}
	// 档位映射只认网关发布的 aih_reasoning_efforts（Node buildThinkingLevelMap
	// 只读 entry.reasoningEfforts）；models.dev 的档位只用于能力判断。
	model.ThinkingLevelMap = buildThinkingLevelMap(entry.ReasoningEfforts)
	return model
}

// ensureRequestedModel 在目录暂时缺这个 id 时保留一项，交给网关在真实请求时
// 给权威结论，而不是在启动器里静默丢弃。
func ensureRequestedModel(entries []gatewayModel, modelID string, provider string, metadata modelmetadata.FactsSource) []gatewayModel {
	id := strings.TrimSpace(modelID)
	if id == "" {
		return entries
	}
	for _, entry := range entries {
		if strings.TrimSpace(entry.ID) == id {
			return entries
		}
	}
	return append(entries, gatewayModel{ID: id})
}

// selectLaunchModel 返回目录内的请求模型；不在目录里时回退第一条。
func selectLaunchModel(models []harnessModel, requested string) string {
	requested = strings.TrimSpace(requested)
	if requested != "" {
		for _, model := range models {
			if model.ID == requested {
				return requested
			}
		}
	}
	if len(models) == 0 {
		return ""
	}
	return strings.TrimSpace(models[0].ID)
}

// piModelEntry 与 Node buildHarnessModelEntry 的 JSON 形状一致。
//
// Node 的 reasoning 只有在 models.dev 有该模型能力记录时才出现
// （metadata.capabilities 缺失时 `undefined` 会被 JSON.stringify 省略），
// 因此这里用指针区分「未知」与「已知且为 false」。
type piModelEntry struct {
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	Input            []string          `json:"input"`
	Reasoning        *bool             `json:"reasoning,omitempty"`
	ThinkingLevelMap *thinkingLevelMap `json:"thinkingLevelMap,omitempty"`
	ContextWindow    int64             `json:"contextWindow,omitempty"`
	MaxTokens        int64             `json:"maxTokens,omitempty"`
	Cost             *modelCost        `json:"cost,omitempty"`
}

func buildPiModelEntries(models []harnessModel) []piModelEntry {
	entries := make([]piModelEntry, 0, len(models))
	for _, model := range models {
		var reasoning *bool
		if model.ReasoningKnown {
			value := model.Reasoning
			reasoning = &value
		}
		entries = append(entries, piModelEntry{
			ID:               model.ID,
			Name:             model.Name,
			Input:            model.Input,
			Reasoning:        reasoning,
			ThinkingLevelMap: model.ThinkingLevelMap,
			ContextWindow:    model.ContextWindow,
			MaxTokens:        model.MaxTokens,
			Cost:             model.Cost,
		})
	}
	return entries
}

// dshModel 与 Node buildDshModels 同形。
type dshModel struct {
	ID            string   `json:"id" yaml:"id"`
	Name          string   `json:"name" yaml:"name"`
	ContextWindow int64    `json:"contextWindow,omitempty" yaml:"contextWindow,omitempty"`
	MaxTokens     int64    `json:"maxTokens,omitempty" yaml:"maxTokens,omitempty"`
	Input         []string `json:"input" yaml:"input"`
}

func buildDshModels(models []harnessModel) []dshModel {
	entries := make([]dshModel, 0, len(models))
	for _, model := range models {
		input := model.Input
		if len(input) == 0 {
			input = []string{"text"}
		}
		entries = append(entries, dshModel{
			ID:            model.ID,
			Name:          model.Name,
			ContextWindow: model.ContextWindow,
			MaxTokens:     model.MaxTokens,
			Input:         input,
		})
	}
	return entries
}
