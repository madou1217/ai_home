// Package contract 把冻结的能力基线数据加载成运行时能力来源。
//
// 它实现 application/modelmetadata.FactsSource，优先级低于上游账号目录声明，
// 高于任何兼容来源；数据文件由 contracts/model-capabilities 嵌入。
package contract

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

var ErrInvalidContract = errors.New("模型能力基线无效")

type document struct {
	Version   int                                    `json:"version"`
	Providers map[string]map[string]modelFactsRecord `json:"providers"`
}

type modelFactsRecord struct {
	Input   []string `json:"input"`
	Output  []string `json:"output"`
	Efforts []string `json:"efforts"`
	Context int      `json:"context"`
	Name    string   `json:"name"`
}

// Source 是按 Provider + 精确模型 ID 查询的冻结能力来源。
type Source struct {
	facts map[string]map[string]modelmetadata.ModelFacts
	count int
}

var _ modelmetadata.FactsSource = (*Source)(nil)

// New 解析并校验基线数据；任一记录无效时整体拒绝（启动失败关闭）。
func New(payload []byte) (*Source, error) {
	var doc document
	if err := json.Unmarshal(payload, &doc); err != nil || doc.Version != 1 || len(doc.Providers) == 0 {
		return nil, ErrInvalidContract
	}
	source := &Source{facts: make(map[string]map[string]modelmetadata.ModelFacts, len(doc.Providers))}
	for rawProvider, models := range doc.Providers {
		provider := strings.ToLower(strings.TrimSpace(rawProvider))
		if provider == "" || len(models) == 0 {
			return nil, ErrInvalidContract
		}
		byModel := make(map[string]modelmetadata.ModelFacts, len(models))
		for rawModel, record := range models {
			modelID, err := runtimecore.NewModelID(strings.TrimSpace(rawModel))
			if err != nil || modelID.String() != strings.TrimSpace(rawModel) {
				return nil, fmt.Errorf("%w: model=%s", ErrInvalidContract, rawModel)
			}
			key := normalizeModelKey(modelID.String())
			if _, exists := byModel[key]; exists {
				return nil, ErrInvalidContract
			}
			facts := modelmetadata.ModelFacts{ModelID: modelID.String(), ContextWindow: record.Context, DisplayName: strings.TrimSpace(record.Name)}
			if record.Context < 0 {
				return nil, ErrInvalidContract
			}
			if len(record.Input) > 0 || len(record.Output) > 0 {
				modalities, err := modelmetadata.NewModalities(record.Input, record.Output)
				if err != nil {
					return nil, fmt.Errorf("%w: model=%s: %v", ErrInvalidContract, rawModel, err)
				}
				facts.HasModalities = true
				facts.Modalities = modalities
			}
			if len(record.Efforts) > 0 {
				values := make([]inference.ReasoningEffort, 0, len(record.Efforts))
				for _, effort := range record.Efforts {
					values = append(values, inference.ReasoningEffort(strings.TrimSpace(effort)))
				}
				ladder, ok := modelmetadata.NormalizeReasoningLadder(values)
				if !ok {
					return nil, fmt.Errorf("%w: model=%s: efforts", ErrInvalidContract, rawModel)
				}
				facts.ReasoningEfforts = ladder
			}
			byModel[key] = facts
			source.count++
		}
		source.facts[provider] = byModel
	}
	return source, nil
}

// Count 返回已加载的 Provider/模型事实条数，供启动诊断使用。
func (source *Source) Count() int {
	if source == nil {
		return 0
	}
	return source.count
}

func (source *Source) LookupModalities(providerID string, modelID string) (modelmetadata.Modalities, bool) {
	facts, found := source.lookup(providerID, modelID)
	if !found || !facts.HasModalities {
		return modelmetadata.Modalities{}, false
	}
	return facts.Modalities, true
}

func (source *Source) LookupReasoningEfforts(providerID string, modelID string) ([]inference.ReasoningEffort, bool) {
	facts, found := source.lookup(providerID, modelID)
	if !found || len(facts.ReasoningEfforts) == 0 {
		return nil, false
	}
	return append([]inference.ReasoningEffort(nil), facts.ReasoningEfforts...), true
}

func (source *Source) LookupContextWindow(providerID string, modelID string) (int, bool) {
	facts, found := source.lookup(providerID, modelID)
	if !found || facts.ContextWindow <= 0 {
		return 0, false
	}
	return facts.ContextWindow, true
}

func (source *Source) LookupDisplayName(providerID string, modelID string) (string, bool) {
	facts, found := source.lookup(providerID, modelID)
	if !found || facts.DisplayName == "" {
		return "", false
	}
	return facts.DisplayName, true
}

func (source *Source) lookup(providerID string, modelID string) (modelmetadata.ModelFacts, bool) {
	if source == nil {
		return modelmetadata.ModelFacts{}, false
	}
	models := source.facts[strings.ToLower(strings.TrimSpace(providerID))]
	if len(models) == 0 {
		return modelmetadata.ModelFacts{}, false
	}
	facts, found := models[normalizeModelKey(modelID)]
	if !found {
		return modelmetadata.ModelFacts{}, false
	}
	return facts, true
}

func normalizeModelKey(modelID string) string {
	return strings.ToLower(strings.TrimSpace(modelmetadata.NormalizeVersionSeparators(modelID)))
}
