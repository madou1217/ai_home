package modelsdev

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/contracts/modelpricing"
)

// Adapter 是 models.dev 的内置实现：kind=aggregator，只提供价格目录与展示元数据。
// 它不参与账号覆盖、人工复核或最终计费，所有裁决由宿主 Resolver 完成。
type Adapter struct {
	catalog *modelsDevCatalog
}

// New 加载嵌入的 models.dev 快照。加载失败直接返回错误，由宿主决定是否降级。
func New() (*Adapter, error) {
	catalog, err := loadedModelsDevCatalog()
	if err != nil {
		return nil, err
	}
	return &Adapter{catalog: catalog}, nil
}

// Source 返回 models.dev 的来源声明。
func (adapter *Adapter) Source(now time.Time) modelpricing.Source {
	source := modelpricing.Source{
		ID:         modelMetadataSourceID,
		Kind:       modelpricing.SourceAggregator,
		Authority:  modelpricing.AuthorityFor(modelpricing.SourceAggregator),
		Confidence: 0.8,
		URL:        modelsDevCatalogURL,
		License:    "MIT",
	}
	if adapter != nil && adapter.catalog != nil {
		if fetchedAt, err := time.Parse(time.RFC3339, adapter.catalog.generatedAt); err == nil {
			source.FetchedAt = &fetchedAt
			source.Stale = modelpricing.IsStale(&fetchedAt, now)
		}
	}
	return source
}

// Load 实现 pricing.catalog：把整个快照展开成统一报价。
func (adapter *Adapter) Load(_ context.Context, request modelpricing.CatalogRequest) (modelpricing.Catalog, error) {
	now := requestNow(request.Now)
	source := adapter.Source(now)
	quotes := make([]modelpricing.Quote, 0, 1024)
	if adapter == nil || adapter.catalog == nil {
		return modelpricing.Catalog{Source: source, Quotes: quotes}, nil
	}
	for providerID, models := range adapter.catalog.providerIndex {
		for key, indexed := range models {
			modelID := strings.TrimSpace(indexed.record.ID)
			if modelID == "" {
				modelID = key
			}
			quote, ok := quoteFromRecord(providerID, modelID, indexed.record, source)
			if !ok {
				continue
			}
			quotes = append(quotes, quote.Normalize())
		}
	}
	sort.Slice(quotes, func(i, j int) bool {
		if quotes[i].Provider != quotes[j].Provider {
			return quotes[i].Provider < quotes[j].Provider
		}
		return quotes[i].Model < quotes[j].Model
	})
	var generatedAt *time.Time
	if !source.FetchedAt.IsZero() {
		generatedAt = source.FetchedAt
	}
	return modelpricing.Catalog{Source: source, Quotes: quotes, GeneratedAt: generatedAt}, nil
}

// Quote 实现 pricing.quote：目录未收录时返回 unknown，而不是 0。
func (adapter *Adapter) Quote(ctx context.Context, request modelpricing.QuoteRequest) (modelpricing.Quote, error) {
	metadata, err := adapter.Resolve(ctx, modelpricing.MetadataRequest{ModelRef: request.ModelRef, Now: request.Now})
	if err != nil {
		return modelpricing.Quote{}, err
	}
	source := metadata.Source
	if strings.TrimSpace(source.ID) == "" {
		source = adapter.Source(requestNow(request.Now))
	}
	quote := modelpricing.Quote{
		Provider: request.Provider,
		Model:    request.Model,
		Source:   source,
	}
	if metadata.Cost.Input != nil || metadata.Cost.Output != nil || metadata.Cost.CacheRead != nil ||
		metadata.Cost.CacheWrite != nil || metadata.Cost.CacheWrite1h != nil || metadata.Cost.Reasoning != nil {
		quote.Input = metadata.Cost.Input
		quote.Output = metadata.Cost.Output
		quote.CacheRead = metadata.Cost.CacheRead
		quote.CacheWrite = metadata.Cost.CacheWrite
		quote.CacheWrite1h = metadata.Cost.CacheWrite1h
		quote.Reasoning = metadata.Cost.Reasoning
	}
	return quote.Normalize(), nil
}

// Resolve 实现 model.metadata：provider → base model 回退逻辑与 WebUI 共用。
func (adapter *Adapter) Resolve(_ context.Context, request modelpricing.MetadataRequest) (modelpricing.Metadata, error) {
	now := requestNow(request.Now)
	raw := ResolveMetadataMap(request.Provider, request.Model, now)
	if raw == nil {
		raw = BuildUnknownMetadataMap(request.Model, now)
	}
	return metadataFromMap(raw, adapter.Source(now)), nil
}

// CatalogSource 返回 pricing.catalog 端口。
func (adapter *Adapter) CatalogSource() modelpricing.CatalogSource {
	return catalogPort{adapter: adapter}
}

// QuoteSource 返回 pricing.quote 端口。
func (adapter *Adapter) QuoteSource() modelpricing.QuoteSource { return quotePort{adapter: adapter} }

// MetadataSource 返回 model.metadata 端口。
func (adapter *Adapter) MetadataSource() modelpricing.MetadataSource {
	return metadataPort{adapter: adapter}
}

type catalogPort struct{ adapter *Adapter }
type quotePort struct{ adapter *Adapter }
type metadataPort struct{ adapter *Adapter }

func (catalogPort) Capability() string  { return modelpricing.CapabilityPricingCatalog }
func (quotePort) Capability() string    { return modelpricing.CapabilityPricingQuote }
func (metadataPort) Capability() string { return modelpricing.CapabilityModelMetadata }

func (port catalogPort) Load(ctx context.Context, request modelpricing.CatalogRequest) (modelpricing.Catalog, error) {
	return port.adapter.Load(ctx, request)
}
func (port quotePort) Quote(ctx context.Context, request modelpricing.QuoteRequest) (modelpricing.Quote, error) {
	return port.adapter.Quote(ctx, request)
}
func (port metadataPort) Resolve(ctx context.Context, request modelpricing.MetadataRequest) (modelpricing.Metadata, error) {
	return port.adapter.Resolve(ctx, request)
}

func requestNow(value *time.Time) time.Time {
	if value != nil && !value.IsZero() {
		return *value
	}
	return time.Now()
}

func quoteFromRecord(providerID, modelID string, record rawModelRecord, source modelpricing.Source) (modelpricing.Quote, bool) {
	if record.Cost == nil {
		return modelpricing.Quote{}, false
	}
	quote := modelpricing.Quote{
		Provider:     providerID,
		Model:        modelID,
		Source:       source,
		Input:        record.Cost.Input,
		Output:       record.Cost.Output,
		CacheRead:    record.Cost.CacheRead,
		CacheWrite:   record.Cost.CacheWrite,
		CacheWrite1h: record.Cost.CacheWrite1h,
		Reasoning:    record.Cost.Reasoning,
	}
	for _, tier := range record.Cost.Tiers {
		threshold, ok := tierThreshold(tier.Tier)
		if !ok {
			continue
		}
		quote.Tiers = append(quote.Tiers, modelpricing.Tier{
			When:         modelpricing.TierWhen{ContextTokensGT: threshold},
			Input:        tier.Input,
			Output:       tier.Output,
			CacheRead:    tier.CacheRead,
			CacheWrite:   tier.CacheWrite,
			CacheWrite1h: tier.CacheWrite1h,
			Reasoning:    tier.Reasoning,
		})
	}
	return quote, true
}

func tierThreshold(tier map[string]any) (int64, bool) {
	if tier == nil {
		return 0, false
	}
	if value, ok := numericValue(tier["size"]); ok && value >= 0 {
		return int64(value), true
	}
	if value, ok := numericValue(tier["contextTokensGt"]); ok && value >= 0 {
		return int64(value), true
	}
	return 0, false
}

func metadataFromMap(raw map[string]any, fallback modelpricing.Source) modelpricing.Metadata {
	metadata := modelpricing.Metadata{
		ID:                    textValue(raw["id"]),
		ProviderID:            textValue(raw["providerId"]),
		BaseModel:             textValue(raw["baseModel"]),
		MetadataSchemaVersion: intValue(raw["metadataSchemaVersion"]),
		MetadataStatus:        modelpricing.MetadataStatus(textValue(raw["metadataStatus"])),
		MetadataSource:        textValue(raw["metadataSource"]),
		MetadataAuthority:     intValue(raw["metadataAuthority"]),
		MetadataStale:         boolValue(raw["metadataStale"]),
		Name:                  textValue(raw["name"]),
		Family:                textValue(raw["family"]),
		ModelStatus:           textValue(raw["status"]),
		Dates:                 datesFromMap(raw["dates"]),
		Capabilities:          capabilitiesFromMap(raw["capabilities"]),
		Limit:                 limitFromMap(raw["limits"]),
		Modalities:            modalitiesFromMap(raw["modalities"]),
		ReasoningEfforts:      stringSlice(raw["reasoningEfforts"]),
		Interleaved:           interleavedFromMap(raw["interleaved"]),
		Cost:                  costFromMap(raw["cost"]),
	}
	if metadata.MetadataStatus == "" {
		metadata.MetadataStatus = modelpricing.MetadataUnknown
	}
	if value, ok := raw["experimental"].(bool); ok {
		metadata.Experimental = &value
	}
	if fetchedAt := timeValue(raw["metadataFetchedAt"]); fetchedAt != nil {
		metadata.MetadataFetchedAt = fetchedAt
	}
	metadata.Source = sourceFromMap(raw["source"], fallback)
	if metadata.MetadataFetchedAt == nil {
		metadata.MetadataFetchedAt = metadata.Source.FetchedAt
	}
	if metadata.MetadataSource == "" {
		metadata.MetadataSource = metadata.Source.ID
	}
	if metadata.MetadataAuthority == 0 {
		metadata.MetadataAuthority = metadata.Source.Authority
	}
	if pricing := pricingFromMap(raw["pricing"], metadata.Source); pricing != nil {
		metadata.Pricing = pricing
	} else if textValue(raw["pricingStatus"]) != "" {
		pricingSource := metadata.Source
		if sourceID := textValue(raw["pricingSource"]); sourceID != "" {
			pricingSource.ID = sourceID
		}
		metadata.Pricing = &modelpricing.Pricing{
			Status:      modelpricing.Status(textValue(raw["pricingStatus"])),
			Authority:   intValue(raw["pricingAuthority"]),
			Stale:       boolValue(raw["pricingStale"]),
			Source:      pricingSource,
			DerivedFrom: textValue(raw["derivedFrom"]),
		}
	}
	return metadata
}

func sourceFromMap(value any, fallback modelpricing.Source) modelpricing.Source {
	raw, ok := value.(map[string]any)
	if !ok {
		return fallback
	}
	source := modelpricing.Source{
		ID:         textValue(raw["id"]),
		Kind:       modelpricing.SourceKind(textValue(raw["kind"])),
		Authority:  intValue(raw["authority"]),
		Confidence: floatValue(raw["confidence"]),
		URL:        textValue(raw["url"]),
		Path:       textValue(raw["path"]),
		License:    textValue(raw["license"]),
		Stale:      boolValue(raw["stale"]),
	}
	if source.ID == "" {
		source.ID = fallback.ID
	}
	if source.Kind == "" {
		source.Kind = fallback.Kind
	}
	if source.Authority == 0 {
		source.Authority = modelpricing.AuthorityFor(source.Kind)
	}
	source.FetchedAt = timeValue(raw["fetchedAt"])
	if source.FetchedAt == nil {
		source.FetchedAt = fallback.FetchedAt
	}
	source.ExpiresAt = timeValue(raw["expiresAt"])
	return source
}

func datesFromMap(value any) modelpricing.MetadataDates {
	raw, _ := value.(map[string]any)
	return modelpricing.MetadataDates{
		Release:     textValue(raw["release"]),
		LastUpdated: textValue(raw["lastUpdated"]),
		Knowledge:   textValue(raw["knowledge"]),
	}
}

func capabilitiesFromMap(value any) modelpricing.Capabilities {
	raw, _ := value.(map[string]any)
	capabilities := modelpricing.Capabilities{}
	if v, ok := raw["attachment"].(bool); ok {
		capabilities.Attachment = &v
	}
	if v, ok := raw["reasoning"].(bool); ok {
		capabilities.Reasoning = &v
	}
	if v, ok := raw["temperature"].(bool); ok {
		capabilities.Temperature = &v
	}
	if v, ok := raw["toolCall"].(bool); ok {
		capabilities.ToolCall = &v
	}
	if v, ok := raw["openWeights"].(bool); ok {
		capabilities.OpenWeights = &v
	}
	if v, ok := raw["structuredOutput"].(bool); ok {
		capabilities.StructuredOutput = &v
	}
	if items, ok := raw["reasoningOptions"].([]any); ok {
		for _, item := range items {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			option := modelpricing.ReasoningOption{
				Type:   textValue(entry["type"]),
				Values: stringSlice(entry["values"]),
				Min:    numberPtr(entry["min"]),
				Max:    numberPtr(entry["max"]),
			}
			if option.Type != "" {
				capabilities.ReasoningOptions = append(capabilities.ReasoningOptions, option)
			}
		}
	}
	return capabilities
}

func limitFromMap(value any) modelpricing.Limit {
	raw, _ := value.(map[string]any)
	maxOutput := intValue(raw["maxOutput"])
	if maxOutput == 0 {
		// models.dev 的 limits 使用 output 作为输出上限。
		maxOutput = intValue(raw["output"])
	}
	return modelpricing.Limit{Context: int64(intValue(raw["context"])), Input: int64(intValue(raw["input"])), MaxOutput: int64(maxOutput)}
}

func interleavedFromMap(value any) *modelpricing.Interleaved {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	field := textValue(raw["field"])
	if field == "" {
		return nil
	}
	return &modelpricing.Interleaved{Field: field}
}

func modalitiesFromMap(value any) modelpricing.Modalities {
	raw, _ := value.(map[string]any)
	return modelpricing.Modalities{Input: stringSlice(raw["input"]), Output: stringSlice(raw["output"])}
}

func costFromMap(value any) modelpricing.Cost {
	raw, _ := value.(map[string]any)
	cost := modelpricing.Cost{
		Input:        numberPtr(raw["input"]),
		Output:       numberPtr(raw["output"]),
		CacheRead:    numberPtr(raw["cacheRead"]),
		CacheWrite:   numberPtr(raw["cacheWrite"]),
		CacheWrite1h: numberPtr(raw["cacheWrite1h"]),
		Reasoning:    numberPtr(raw["reasoning"]),
		InputAudio:   numberPtr(raw["inputAudio"]),
		OutputAudio:  numberPtr(raw["outputAudio"]),
	}
	if tiers, ok := raw["tiers"].([]any); ok {
		for _, item := range tiers {
			if tierMap, ok := item.(map[string]any); ok {
				tier := modelpricing.CostTier{Cost: costFromMap(tierMap)}
				if threshold, ok := tierThresholdFromMap(tierMap["tier"]); ok {
					tier.Tier = modelpricing.TierWhen{ContextTokensGT: threshold}
				}
				cost.Tiers = append(cost.Tiers, tier)
			}
		}
	}
	return cost
}

func tierThresholdFromMap(value any) (int64, bool) {
	raw, ok := value.(map[string]any)
	if !ok {
		return 0, false
	}
	if number, ok := numericValue(raw["size"]); ok && number >= 0 {
		return int64(number), true
	}
	return 0, false
}

func pricingFromMap(value any, fallback modelpricing.Source) *modelpricing.Pricing {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	pricing := &modelpricing.Pricing{
		Status:      modelpricing.Status(textValue(raw["status"])),
		Authority:   intValue(raw["authority"]),
		Stale:       boolValue(raw["stale"]),
		Source:      sourceFromMap(raw["source"], fallback),
		Derived:     boolValue(raw["derived"]),
		DerivedFrom: textValue(raw["derivedFrom"]),
	}
	return pricing
}

func textValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func boolValue(value any) bool {
	result, _ := value.(bool)
	return result
}

func intValue(value any) int {
	number, ok := numericValue(value)
	if !ok {
		return 0
	}
	return int(number)
}

func floatValue(value any) float64 {
	number, ok := numericValue(value)
	if !ok {
		return 0
	}
	return number
}

func numericValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case jsonNumber:
		number, err := typed.Float64()
		return number, err == nil
	default:
		return 0, false
	}
}

type jsonNumber interface{ Float64() (float64, error) }

func numberPtr(value any) *float64 {
	number, ok := numericValue(value)
	if !ok {
		return nil
	}
	return &number
}

func timeValue(value any) *time.Time {
	text := textValue(value)
	if text == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		return nil
	}
	return &parsed
}

func stringSlice(value any) []string {
	items, ok := value.([]string)
	if ok {
		return items
	}
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text := textValue(item); text != "" {
			out = append(out, text)
		}
	}
	return out
}
