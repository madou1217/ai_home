package modelmetadata

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrInvalidModelFacts 表示上游声明的能力事实不满足低敏值对象合同。
	ErrInvalidModelFacts = errors.New("模型能力事实无效")
)

// ModelFacts 是上游对单个模型声明的低敏能力事实（零值字段表示“本次未声明”）。
type ModelFacts struct {
	ModelID string
	// HasModalities 与 Modalities 成对出现：true 才表示输入/输出模态被声明。
	HasModalities    bool
	Modalities       Modalities
	ReasoningEfforts []inference.ReasoningEffort
	// ContextWindow 为 0 表示未声明，而不是“窗口为 0”。
	ContextWindow int
	DisplayName   string
}

// ModelFactsRegistrar 接收 Provider 级运行时能力事实。
//
// 上游账号目录是能力事实的权威来源；同一 Provider 可能由多个账号服务，
// 因此按模型合并，而不是整表替换。
type ModelFactsRegistrar interface {
	MergeModelFacts(providerID string, facts []ModelFacts) error
}

// FactsSource 是能力事实的只读来源（aih.db 模型目录投影、兼容目录等）。
//
// 来源按注入顺序裁决；它只提供事实，不决定优先级。
type FactsSource interface {
	LookupModalities(providerID string, modelID string) (Modalities, bool)
	LookupReasoningEfforts(providerID string, modelID string) ([]inference.ReasoningEffort, bool)
	LookupContextWindow(providerID string, modelID string) (int, bool)
	LookupDisplayName(providerID string, modelID string) (string, bool)
}

// CapabilityRegistryOptions 显式声明能力来源顺序与来源标识。
type CapabilityRegistryOptions struct {
	// Sources 是按优先级排列的事实来源；空表示只有上游声明。
	Sources []FactsSource
	// SourceID 是管理面展示的来源标识，缺省为 "capabilities"。
	SourceID string
}

// CapabilityRegistry 是能力事实的合并读模型。
//
// 优先级：
//  1. 上游账号目录的运行时声明（最高）；
//  2. 注入的 FactsSource（aih.db 投影/兼容来源），按注入顺序；
//  3. 模态的保守家族推断。
//
// 推理档位有额外的安全规则：Provider 一旦声明过档位，未列出的模型就是“没有档位”，
// 不再向任何第三方来源回退——错误的档位会被上游 400，不能靠猜测补齐。
type CapabilityRegistry struct {
	sources  []FactsSource
	sourceID string
	mu       sync.Mutex
	declared atomic.Pointer[declarationSnapshot]
}

type declarationSnapshot struct {
	byProvider map[string]map[string]ModelFacts
	// ladderProviders 记录已经声明过档位的 Provider（档位是 Provider 级独占事实）。
	ladderProviders map[string]bool
}

// NewCapabilityRegistry 创建能力注册表。
func NewCapabilityRegistry(options CapabilityRegistryOptions) *CapabilityRegistry {
	sourceID := strings.TrimSpace(options.SourceID)
	if sourceID == "" {
		sourceID = "capabilities"
	}
	registry := &CapabilityRegistry{
		sources:  append([]FactsSource(nil), options.Sources...),
		sourceID: sourceID,
	}
	registry.declared.Store(&declarationSnapshot{
		byProvider:      map[string]map[string]ModelFacts{},
		ladderProviders: map[string]bool{},
	})
	return registry
}

var _ Catalog = (*CapabilityRegistry)(nil)
var _ ModelFactsRegistrar = (*CapabilityRegistry)(nil)
var _ ModelDescriptorRegistrar = (*CapabilityRegistry)(nil)

// SourceID 返回来源标识。
func (registry *CapabilityRegistry) SourceID() string {
	if registry == nil {
		return ""
	}
	return registry.sourceID
}

// MergeModelFacts 按模型合并一次上游声明。
func (registry *CapabilityRegistry) MergeModelFacts(providerID string, facts []ModelFacts) error {
	if registry == nil || len(facts) == 0 {
		return nil
	}
	provider := normalizeProviderID(providerID)
	if provider == "" {
		return ErrInvalidModelFacts
	}
	normalized := make(map[string]ModelFacts, len(facts))
	for _, fact := range facts {
		modelID, err := runtimecore.NewModelID(fact.ModelID)
		if err != nil || modelID.String() != strings.TrimSpace(fact.ModelID) {
			return ErrInvalidModelFacts
		}
		if fact.HasModalities && !fact.Modalities.IsValid() {
			return ErrInvalidModelFacts
		}
		ladder, ok := NormalizeReasoningLadder(fact.ReasoningEfforts)
		if len(fact.ReasoningEfforts) > 0 && !ok {
			return ErrInvalidModelFacts
		}
		if fact.ContextWindow < 0 {
			return ErrInvalidModelFacts
		}
		key := normalizeModelKey(modelID.String())
		if _, exists := normalized[key]; exists {
			return ErrInvalidModelFacts
		}
		normalized[key] = ModelFacts{
			ModelID:          modelID.String(),
			HasModalities:    fact.HasModalities,
			Modalities:       copyModalities(fact.Modalities),
			ReasoningEfforts: ladder,
			ContextWindow:    fact.ContextWindow,
			DisplayName:      strings.TrimSpace(fact.DisplayName),
		}
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	previous := registry.declared.Load()
	next := &declarationSnapshot{
		byProvider:      make(map[string]map[string]ModelFacts, len(previous.byProvider)+1),
		ladderProviders: make(map[string]bool, len(previous.ladderProviders)+1),
	}
	for name, models := range previous.byProvider {
		copied := make(map[string]ModelFacts, len(models))
		for modelID, fact := range models {
			copied[modelID] = copyFacts(fact)
		}
		next.byProvider[name] = copied
	}
	for name := range previous.ladderProviders {
		next.ladderProviders[name] = true
	}
	current := next.byProvider[provider]
	if current == nil {
		current = make(map[string]ModelFacts, len(normalized))
	}
	for modelID, fact := range normalized {
		existing := current[modelID]
		merged := copyFacts(existing)
		if merged.ModelID == "" {
			merged.ModelID = fact.ModelID
		}
		if fact.HasModalities {
			merged.HasModalities = true
			merged.Modalities = copyModalities(fact.Modalities)
		}
		if len(fact.ReasoningEfforts) > 0 {
			merged.ReasoningEfforts = fact.ReasoningEfforts
			next.ladderProviders[provider] = true
		}
		if fact.ContextWindow > 0 {
			merged.ContextWindow = fact.ContextWindow
		}
		if fact.DisplayName != "" {
			merged.DisplayName = fact.DisplayName
		}
		current[modelID] = merged
	}
	next.byProvider[provider] = current
	registry.declared.Store(next)
	return nil
}

// ReplaceModelDescriptors 把运行时模态描述转换成能力事实。
func (registry *CapabilityRegistry) ReplaceModelDescriptors(
	providerID string,
	descriptors []ModelDescriptor,
) error {
	if len(descriptors) == 0 {
		return nil
	}
	facts := make([]ModelFacts, 0, len(descriptors))
	for _, descriptor := range descriptors {
		if !descriptor.IsValid() || descriptor.ProviderID() != normalizeProviderID(providerID) {
			return ErrInvalidModelFacts
		}
		facts = append(facts, ModelFacts{
			ModelID:       descriptor.ModelID().String(),
			HasModalities: true,
			Modalities:    descriptor.Modalities(),
		})
	}
	return registry.MergeModelFacts(providerID, facts)
}

// LookupModalities 返回声明的模态；未声明时按来源顺序查询。
func (registry *CapabilityRegistry) LookupModalities(
	providerID string,
	modelID string,
) (Modalities, bool) {
	fact, found := registry.lookupDeclared(providerID, modelID)
	if found && fact.HasModalities {
		return copyModalities(fact.Modalities), true
	}
	for _, source := range registry.sources {
		if source == nil {
			continue
		}
		if modalities, ok := source.LookupModalities(providerID, modelID); ok {
			return modalities, true
		}
	}
	return Modalities{}, false
}

// LookupOrInferModalities 在事实与来源都未命中时按保守家族兜底。
func (registry *CapabilityRegistry) LookupOrInferModalities(
	providerID string,
	modelID string,
) (Modalities, bool) {
	modalities, found := registry.LookupModalities(providerID, modelID)
	if !found {
		inferred, ok := InferModalities(modelID)
		if !ok {
			return Modalities{}, false
		}
		modalities = inferred
	}
	return WithImageGeneration(modalities, modelID), true
}

// LookupReasoningEfforts 返回档位声明；Provider 声明过档位后不再回退第三方来源。
func (registry *CapabilityRegistry) LookupReasoningEfforts(
	providerID string,
	modelID string,
) ([]inference.ReasoningEffort, bool) {
	fact, found := registry.lookupDeclared(providerID, modelID)
	if found && len(fact.ReasoningEfforts) > 0 {
		return append([]inference.ReasoningEffort(nil), fact.ReasoningEfforts...), true
	}
	if registry.ladderDeclared(providerID) {
		return nil, false
	}
	for _, source := range registry.sources {
		if source == nil {
			continue
		}
		if ladder, ok := source.LookupReasoningEfforts(providerID, modelID); ok {
			return ladder, true
		}
	}
	return nil, false
}

// LookupContextWindow 返回声明的上下文窗口；未声明时按来源顺序查询。
func (registry *CapabilityRegistry) LookupContextWindow(
	providerID string,
	modelID string,
) (int, bool) {
	fact, found := registry.lookupDeclared(providerID, modelID)
	if found && fact.ContextWindow > 0 {
		return fact.ContextWindow, true
	}
	for _, source := range registry.sources {
		if source == nil {
			continue
		}
		if window, ok := source.LookupContextWindow(providerID, modelID); ok {
			return window, true
		}
	}
	return 0, false
}

// LookupDisplayName 返回声明的显示名；未声明时按来源顺序查询。
func (registry *CapabilityRegistry) LookupDisplayName(
	providerID string,
	modelID string,
) (string, bool) {
	fact, found := registry.lookupDeclared(providerID, modelID)
	if found && fact.DisplayName != "" {
		return fact.DisplayName, true
	}
	for _, source := range registry.sources {
		if source == nil {
			continue
		}
		if name, ok := source.LookupDisplayName(providerID, modelID); ok {
			return name, true
		}
	}
	return "", false
}

func (registry *CapabilityRegistry) lookupDeclared(
	providerID string,
	modelID string,
) (ModelFacts, bool) {
	if registry == nil {
		return ModelFacts{}, false
	}
	snapshot := registry.declared.Load()
	if snapshot == nil {
		return ModelFacts{}, false
	}
	models := snapshot.byProvider[normalizeProviderID(providerID)]
	if len(models) == 0 {
		return ModelFacts{}, false
	}
	fact, found := models[normalizeModelKey(modelID)]
	if !found {
		return ModelFacts{}, false
	}
	return copyFacts(fact), true
}

func (registry *CapabilityRegistry) ladderDeclared(providerID string) bool {
	if registry == nil {
		return false
	}
	snapshot := registry.declared.Load()
	if snapshot == nil {
		return false
	}
	return snapshot.ladderProviders[normalizeProviderID(providerID)]
}

func normalizeProviderID(providerID string) string {
	return strings.ToLower(strings.TrimSpace(providerID))
}

func normalizeModelKey(modelID string) string {
	return strings.ToLower(strings.TrimSpace(NormalizeVersionSeparators(modelID)))
}

func copyFacts(fact ModelFacts) ModelFacts {
	copied := fact
	copied.Modalities = copyModalities(fact.Modalities)
	copied.ReasoningEfforts = append([]inference.ReasoningEffort(nil), fact.ReasoningEfforts...)
	return copied
}
