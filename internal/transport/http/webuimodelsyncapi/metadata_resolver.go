package webuimodelsyncapi

import (
	"context"
	"strings"
	"time"

	"github.com/madou1217/ai_home/contracts/modelpricing"
)

// resolveMetadataMap 只经插件契约的 Resolver 取元数据。
// 返回 map 是为了保持 /v0/webui/openai-models 既有的 metadata 形状不变。
//
// 未接线或来源失败时返回 nil，由调用方省略该条目；来源明确返回 unknown 时
// 仍会输出 metadataStatus=unknown，让 UI 能区分「没有来源」和「模型未知」。
func (handler *Handler) resolveMetadataMap(ctx context.Context, provider, modelID string, now time.Time) map[string]any {
	if handler == nil || handler.resolver == nil {
		return nil
	}
	metadata, err := handler.resolver.ResolveMetadata(ctx, modelpricing.MetadataRequest{
		SchemaVersion: modelpricing.WireSchemaVersion,
		Kind:          "metadata",
		Now:           &now,
		ModelRef:      modelpricing.ModelRef{Provider: provider, Model: modelID},
	})
	if err != nil {
		return nil
	}
	return legacyMetadataMap(metadata)
}

func legacyMetadataMap(metadata modelpricing.Metadata) map[string]any {
	source := legacySourceMap(metadata.Source)
	capabilities := legacyCapabilitiesMap(metadata.Capabilities)
	limits := map[string]any{}
	if metadata.Limit.Context > 0 {
		limits["context"] = metadata.Limit.Context
	}
	if metadata.Limit.Input > 0 {
		limits["input"] = metadata.Limit.Input
	}
	if metadata.Limit.MaxOutput > 0 {
		limits["output"] = metadata.Limit.MaxOutput
	}
	modalities := map[string]any{}
	if len(metadata.Modalities.Input) > 0 {
		modalities["input"] = metadata.Modalities.Input
	}
	if len(metadata.Modalities.Output) > 0 {
		modalities["output"] = metadata.Modalities.Output
	}
	result := map[string]any{
		"id":                    metadata.ID,
		"providerId":            metadata.ProviderID,
		"baseModel":             metadata.BaseModel,
		"metadataSchemaVersion": metadata.MetadataSchemaVersion,
		"metadataStatus":        string(metadata.MetadataStatus),
		"metadataSource":        metadata.MetadataSource,
		"metadataAuthority":     metadata.MetadataAuthority,
		"metadataStale":         metadata.MetadataStale,
		"source":                source,
		"name":                  metadata.Name,
		"family":                metadata.Family,
		"status":                metadata.ModelStatus,
		"dates": map[string]any{
			"release":     metadata.Dates.Release,
			"lastUpdated": metadata.Dates.LastUpdated,
			"knowledge":   metadata.Dates.Knowledge,
		},
		"capabilities": capabilities,
		"limits":       limits,
		"modalities":   modalities,
		"cost":         legacyCostMap(metadata.Cost),
	}
	if metadata.MetadataFetchedAt != nil {
		result["metadataFetchedAt"] = metadata.MetadataFetchedAt.UTC().Format(time.RFC3339Nano)
	}
	if metadata.Experimental != nil {
		result["experimental"] = *metadata.Experimental
	}
	if len(metadata.ReasoningEfforts) > 0 {
		result["reasoningEfforts"] = metadata.ReasoningEfforts
	}
	if metadata.Interleaved != nil && strings.TrimSpace(metadata.Interleaved.Field) != "" {
		result["interleaved"] = map[string]any{"field": metadata.Interleaved.Field}
	}
	if metadata.Pricing != nil {
		result["pricing"] = legacyPricingMap(*metadata.Pricing)
		result["pricingStatus"] = string(metadata.Pricing.Status)
		result["pricingAuthority"] = metadata.Pricing.Authority
		result["pricingSource"] = metadata.Pricing.Source.ID
		result["pricingStale"] = metadata.Pricing.Stale
		if metadata.Pricing.DerivedFrom != "" {
			result["derivedFrom"] = metadata.Pricing.DerivedFrom
		}
		if metadata.Pricing.Source.FetchedAt != nil {
			result["pricingFetchedAt"] = metadata.Pricing.Source.FetchedAt.UTC().Format(time.RFC3339Nano)
		}
	}
	return cleanMetadataMap(result)
}

func legacySourceMap(source modelpricing.Source) map[string]any {
	result := map[string]any{
		"type":       source.ID,
		"id":         source.ID,
		"kind":       string(source.Kind),
		"authority":  source.Authority,
		"confidence": source.Confidence,
		"url":        source.URL,
		"path":       source.Path,
		"license":    source.License,
		"stale":      source.Stale,
	}
	if source.FetchedAt != nil {
		result["fetchedAt"] = source.FetchedAt.UTC().Format(time.RFC3339Nano)
	}
	return cleanMetadataMap(result)
}

func legacyCapabilitiesMap(capabilities modelpricing.Capabilities) map[string]any {
	result := map[string]any{}
	if capabilities.Attachment != nil {
		result["attachment"] = *capabilities.Attachment
	}
	if capabilities.Reasoning != nil {
		result["reasoning"] = *capabilities.Reasoning
	}
	if capabilities.Temperature != nil {
		result["temperature"] = *capabilities.Temperature
	}
	if capabilities.ToolCall != nil {
		result["toolCall"] = *capabilities.ToolCall
	}
	if capabilities.StructuredOutput != nil {
		result["structuredOutput"] = *capabilities.StructuredOutput
	}
	if capabilities.OpenWeights != nil {
		result["openWeights"] = *capabilities.OpenWeights
	}
	if len(capabilities.ReasoningOptions) > 0 {
		items := make([]any, 0, len(capabilities.ReasoningOptions))
		for _, option := range capabilities.ReasoningOptions {
			entry := map[string]any{"type": option.Type}
			if len(option.Values) > 0 {
				entry["values"] = option.Values
			}
			if option.Min != nil {
				entry["min"] = *option.Min
			}
			if option.Max != nil {
				entry["max"] = *option.Max
			}
			items = append(items, cleanMetadataMap(entry))
		}
		result["reasoningOptions"] = items
	}
	return result
}

func legacyCostMap(cost modelpricing.Cost) map[string]any {
	result := map[string]any{}
	for key, value := range map[string]*float64{
		"input": cost.Input, "output": cost.Output,
		"reasoning": cost.Reasoning, "cacheRead": cost.CacheRead,
		"cacheWrite": cost.CacheWrite, "cacheWrite1h": cost.CacheWrite1h,
		"inputAudio": cost.InputAudio, "outputAudio": cost.OutputAudio,
	} {
		if value != nil {
			result[key] = *value
		}
	}
	if len(cost.Tiers) > 0 {
		tiers := make([]any, 0, len(cost.Tiers))
		for _, tier := range cost.Tiers {
			entry := legacyCostValues(tier.Cost)
			entry["tier"] = map[string]any{"size": tier.Tier.ContextTokensGT}
			tiers = append(tiers, cleanMetadataMap(entry))
		}
		result["tiers"] = tiers
	}
	if cost.Over200k != nil {
		result["contextOver200k"] = legacyCostValues(cost.Over200k.Cost)
	}
	return result
}

func legacyCostValues(cost modelpricing.Cost) map[string]any {
	result := map[string]any{}
	for key, value := range map[string]*float64{
		"input": cost.Input, "output": cost.Output,
		"reasoning": cost.Reasoning, "cacheRead": cost.CacheRead,
		"cacheWrite": cost.CacheWrite, "cacheWrite1h": cost.CacheWrite1h,
	} {
		if value != nil {
			result[key] = *value
		}
	}
	return result
}

func legacyPricingMap(pricing modelpricing.Pricing) map[string]any {
	result := map[string]any{
		"schemaVersion": modelpricing.WireSchemaVersion,
		"status":        string(pricing.Status),
		"authority":     pricing.Authority,
		"stale":         pricing.Stale,
		"source":        legacyPricingSourceMap(pricing.Source),
		"derived":       pricing.Derived,
		"derivedFrom":   pricing.DerivedFrom,
	}
	return cleanMetadataMap(result)
}

func legacyPricingSourceMap(source modelpricing.Source) map[string]any {
	result := map[string]any{
		"id":         source.ID,
		"kind":       string(source.Kind),
		"authority":  source.Authority,
		"confidence": source.Confidence,
		"url":        source.URL,
	}
	if source.FetchedAt != nil {
		result["fetchedAt"] = source.FetchedAt.UTC().Format(time.RFC3339Nano)
	}
	return cleanMetadataMap(result)
}

func cleanMetadataMap(source map[string]any) map[string]any {
	if len(source) == 0 {
		return nil
	}
	out := make(map[string]any, len(source))
	for key, item := range source {
		if item == nil {
			continue
		}
		switch typed := item.(type) {
		case string:
			if typed == "" {
				continue
			}
		case []string:
			if len(typed) == 0 {
				continue
			}
		case []any:
			if len(typed) == 0 {
				continue
			}
		case map[string]any:
			nested := cleanMetadataMap(typed)
			if len(nested) == 0 {
				continue
			}
			item = nested
		}
		out[key] = item
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
