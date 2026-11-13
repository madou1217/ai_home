package webuimodelsyncapi

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
)

//go:embed metadata_catalog.json.gz
var embeddedModelsDevCatalogGZ []byte

const (
	modelsDevCatalogURL        = "https://models.dev/catalog.json"
	modelMetadataSchemaVersion = 1
	modelMetadataSourceID      = "models.dev"
	priceQuoteSchemaVersion    = 1
	priceSourceAuthorityAgg    = 40
	pricingSnapshotMaxAge      = 14 * 24 * time.Hour

	wildcardGenerationsPerFamily = 3
	wildcardMaxReleaseAge        = 365 * 24 * time.Hour
)

var (
	bracketSuffixPattern = regexp.MustCompile(`(?i)\[[^\]]+\]$`)
	dateTagPattern       = regexp.MustCompile(`:\d{4}$`)
	versionDotPattern    = regexp.MustCompile(`(\d)\.(\d)`)
	datedSnapshotPattern = regexp.MustCompile(`-\d{8}$`)
	patternOpenAIModel   = regexp.MustCompile(`(?i)^(gpt-|o\d|chatgpt-|text-embedding-)`)
	patternClaudeModel   = regexp.MustCompile(`(?i)^claude-`)
	patternGeminiModel   = regexp.MustCompile(`(?i)^(gemini-|gemma-)`)
	patternGrokModel     = regexp.MustCompile(`(?i)^grok-`)
	patternKimiModel     = regexp.MustCompile(`(?i)^kimi-`)
	patternGLMModel      = regexp.MustCompile(`(?i)^glm-`)
	patternDeepSeekModel = regexp.MustCompile(`(?i)^deepseek-`)
	patternMiniMaxModel  = regexp.MustCompile(`(?i)^minimax-`)
	patternQwenModel     = regexp.MustCompile(`(?i)^qwen`)
	patternMimoModel     = regexp.MustCompile(`(?i)^mimo-`)
	patternStepModel     = regexp.MustCompile(`(?i)^step-`)
	patternNemotronModel = regexp.MustCompile(`(?i)^nemotron-`)
	patternMistralModel  = regexp.MustCompile(`(?i)^mistral-`)
	patternCBDeepSeek    = regexp.MustCompile(`(?i)^deepseek-v4\.1-flash(?:$|[-:])`)
	patternCBHY4Preview  = regexp.MustCompile(`(?i)^hy4-preview$`)
	patternKimiForCoding = regexp.MustCompile(`(?i)^kimi-for-coding`)
	patternKimiK3        = regexp.MustCompile(`(?i)^k3(?:-|$)`)
)

type rawCostTier struct {
	Input        *float64       `json:"input"`
	Output       *float64       `json:"output"`
	Reasoning    *float64       `json:"reasoning"`
	CacheRead    *float64       `json:"cache_read"`
	CacheWrite   *float64       `json:"cache_write"`
	CacheWrite1h *float64       `json:"cache_write_1h"`
	CacheWrite1H *float64       `json:"cacheWrite1h"`
	InputAudio   *float64       `json:"input_audio"`
	OutputAudio  *float64       `json:"output_audio"`
	Tier         map[string]any `json:"tier"`
}

type rawCost struct {
	Input           *float64      `json:"input"`
	Output          *float64      `json:"output"`
	Reasoning       *float64      `json:"reasoning"`
	CacheRead       *float64      `json:"cache_read"`
	CacheWrite      *float64      `json:"cache_write"`
	CacheWrite1h    *float64      `json:"cache_write_1h"`
	CacheWrite1H    *float64      `json:"cacheWrite1h"`
	InputAudio      *float64      `json:"input_audio"`
	OutputAudio     *float64      `json:"output_audio"`
	Tiers           []rawCostTier `json:"tiers"`
	ContextOver200k *rawCostTier  `json:"context_over_200k"`
}

type rawReasoningOption struct {
	Type   string   `json:"type"`
	Values []string `json:"values"`
	Min    *float64 `json:"min"`
	Max    *float64 `json:"max"`
}

type rawModelRecord struct {
	ID               string               `json:"id"`
	Name             string               `json:"name"`
	Family           string               `json:"family"`
	Status           string               `json:"status"`
	Experimental     any                  `json:"experimental"`
	ReleaseDate      string               `json:"release_date"`
	LastUpdated      string               `json:"last_updated"`
	Knowledge        string               `json:"knowledge"`
	Attachment       *bool                `json:"attachment"`
	Reasoning        *bool                `json:"reasoning"`
	ReasoningOptions []rawReasoningOption `json:"reasoning_options"`
	ToolCall         *bool                `json:"tool_call"`
	StructuredOutput *bool                `json:"structured_output"`
	Temperature      *bool                `json:"temperature"`
	OpenWeights      *bool                `json:"open_weights"`
	Limit            *struct {
		Context *float64 `json:"context"`
		Input   *float64 `json:"input"`
		Output  *float64 `json:"output"`
	} `json:"limit"`
	Modalities *struct {
		Input  []string `json:"input"`
		Output []string `json:"output"`
	} `json:"modalities"`
	Cost        *rawCost `json:"cost"`
	Interleaved any      `json:"interleaved"`
}

type indexedModelRecord struct {
	id     string
	record rawModelRecord
}

type wildcardModelRow struct {
	id         string
	family     string
	releasedAt int64
}

type modelsDevCatalog struct {
	generatedAt    string
	canonicalIndex map[string]indexedModelRecord
	providerIndex  map[string]map[string]indexedModelRecord
	wildcardRows   []wildcardModelRow
}

var defaultModalitiesIndex = sync.OnceValues(func() (*modelsdev.Index, error) {
	return modelsdev.New()
})

var loadedModelsDevCatalog = sync.OnceValues(func() (*modelsDevCatalog, error) {
	reader, err := gzip.NewReader(bytes.NewReader(embeddedModelsDevCatalogGZ))
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = reader.Close()
	}()
	rawBytes, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	var doc struct {
		GeneratedAt string                    `json:"generatedAt"`
		Models      map[string]rawModelRecord `json:"models"`
		Providers   map[string]struct {
			Models map[string]rawModelRecord `json:"models"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(rawBytes, &doc); err != nil {
		return nil, err
	}
	catalog := &modelsDevCatalog{
		generatedAt:    strings.TrimSpace(doc.GeneratedAt),
		canonicalIndex: buildModelRecordIndex(doc.Models),
		providerIndex:  make(map[string]map[string]indexedModelRecord, len(doc.Providers)),
		wildcardRows:   buildWildcardRows(doc.Models),
	}
	for providerID, providerDoc := range doc.Providers {
		catalog.providerIndex[providerID] = buildModelRecordIndex(providerDoc.Models)
	}
	return catalog, nil
})

func buildModelRecordIndex(records map[string]rawModelRecord) map[string]indexedModelRecord {
	if len(records) == 0 {
		return nil
	}
	keys := make([]string, 0, len(records))
	for id := range records {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	out := make(map[string]indexedModelRecord, len(keys))
	for _, id := range keys {
		norm := strings.ToLower(strings.TrimSpace(id))
		if norm == "" {
			continue
		}
		if _, exists := out[norm]; !exists {
			out[norm] = indexedModelRecord{id: id, record: records[id]}
		}
	}
	return out
}

func buildWildcardRows(models map[string]rawModelRecord) []wildcardModelRow {
	byID := make(map[string]wildcardModelRow)
	for _, model := range models {
		fullID := strings.TrimSpace(model.ID)
		id := fullID
		if slash := strings.LastIndex(fullID, "/"); slash >= 0 {
			id = fullID[slash+1:]
		}
		if id == "" || model.ToolCall == nil || !*model.ToolCall {
			continue
		}
		if model.Modalities == nil || len(model.Modalities.Output) != 1 || model.Modalities.Output[0] != "text" {
			continue
		}
		releasedAt, ok := parseReleaseDateMillis(model.ReleaseDate)
		if !ok {
			continue
		}
		if prev, exists := byID[id]; exists && prev.releasedAt >= releasedAt {
			continue
		}
		family := strings.TrimSpace(model.Family)
		if family == "" {
			family = id
		}
		byID[id] = wildcardModelRow{
			id:         id,
			family:     family,
			releasedAt: releasedAt,
		}
	}
	out := make([]wildcardModelRow, 0, len(byID))
	for _, row := range byID {
		out = append(out, row)
	}
	sort.Slice(out, func(left, right int) bool {
		return out[left].id < out[right].id
	})
	return out
}

func parseReleaseDateMillis(value string) (int64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	for _, layout := range []string{time.RFC3339, time.RFC3339Nano, "2006-01-02"} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UnixMilli(), true
		}
	}
	return 0, false
}

func listWildcardAliasModels(pattern string, now time.Time) []string {
	alias := strings.TrimSpace(pattern)
	if !strings.HasSuffix(alias, "*") {
		return nil
	}
	prefix := alias[:len(alias)-1]
	if len(prefix) < 2 || strings.Contains(prefix, "*") {
		return nil
	}
	catalog, err := loadedModelsDevCatalog()
	if err != nil || catalog == nil {
		return nil
	}
	nowMS := now.UnixMilli()
	maxAgeMS := wildcardMaxReleaseAge.Milliseconds()
	byFamily := make(map[string][]wildcardModelRow)
	for _, row := range catalog.wildcardRows {
		if !strings.HasPrefix(row.id, prefix) {
			continue
		}
		if datedSnapshotPattern.MatchString(row.id) {
			continue
		}
		if nowMS-row.releasedAt > maxAgeMS {
			continue
		}
		byFamily[row.family] = append(byFamily[row.family], row)
	}
	if len(byFamily) == 0 {
		return nil
	}
	groups := make([][]wildcardModelRow, 0, len(byFamily))
	for _, items := range byFamily {
		sort.Slice(items, func(left, right int) bool {
			if items[left].releasedAt != items[right].releasedAt {
				return items[left].releasedAt > items[right].releasedAt
			}
			return items[left].id < items[right].id
		})
		if len(items) > wildcardGenerationsPerFamily {
			items = items[:wildcardGenerationsPerFamily]
		}
		groups = append(groups, items)
	}
	sort.Slice(groups, func(left, right int) bool {
		if groups[left][0].releasedAt != groups[right][0].releasedAt {
			return groups[left][0].releasedAt > groups[right][0].releasedAt
		}
		return groups[left][0].family < groups[right][0].family
	})
	out := make([]string, 0, len(groups)*wildcardGenerationsPerFamily)
	for _, group := range groups {
		for _, row := range group {
			out = append(out, row.id)
		}
	}
	return out
}

func isPricingSnapshotStale(fetchedAt string, now time.Time) bool {
	trimmed := strings.TrimSpace(fetchedAt)
	if trimmed == "" {
		return true
	}
	parsed, err := time.Parse(time.RFC3339Nano, trimmed)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339, trimmed)
		if err != nil {
			return true
		}
	}
	return now.Sub(parsed) > pricingSnapshotMaxAge
}

func resolveModelsDevMetadata(provider, modelID string, now time.Time) map[string]any {
	catalog, err := loadedModelsDevCatalog()
	if err != nil || catalog == nil {
		return nil
	}
	id := strings.TrimSpace(modelID)
	if id == "" {
		return nil
	}
	for _, candidateProvider := range inferModelsDevProviderIDs(provider, id) {
		if meta := catalog.readProviderModel(candidateProvider, id, now); meta != nil {
			return meta
		}
	}
	for _, baseModelID := range inferBaseModelIDs(id) {
		if meta := catalog.readBaseModel(baseModelID, id, now); meta != nil {
			return meta
		}
	}
	return nil
}

func buildUnknownModelMetadata(modelID string, now time.Time) map[string]any {
	fetchedAt := ""
	if catalog, err := loadedModelsDevCatalog(); err == nil && catalog != nil {
		fetchedAt = catalog.generatedAt
	}
	stale := isPricingSnapshotStale(fetchedAt, now)
	pricing := buildPricingMetadata(nil, fetchedAt, now, false, "")
	result := map[string]any{
		"id":                    strings.TrimSpace(modelID),
		"metadataSchemaVersion": modelMetadataSchemaVersion,
		"metadataStatus":        "unknown",
		"metadataSource":        modelMetadataSourceID,
		"metadataAuthority":     priceSourceAuthorityAgg,
		"metadataFetchedAt":     fetchedAt,
		"metadataStale":         stale,
		"source": map[string]any{
			"type":       modelMetadataSourceID,
			"id":         modelMetadataSourceID,
			"kind":       "aggregator",
			"authority":  priceSourceAuthorityAgg,
			"confidence": 0.8,
			"url":        modelsDevCatalogURL,
			"fetchedAt":  fetchedAt,
			"stale":      stale,
		},
	}
	mergePricingMetadataFields(result, pricing)
	return cleanMap(result)
}

func (catalog *modelsDevCatalog) readProviderModel(providerID, modelID string, now time.Time) map[string]any {
	provider := strings.TrimSpace(providerID)
	index := catalog.providerIndex[provider]
	if index == nil {
		return nil
	}
	stripped := stripKnownModelPrefix(modelID)
	match, ok := index[strings.ToLower(strings.TrimSpace(stripped))]
	if !ok {
		return nil
	}
	return normalizeCatalogMetadata(match.record, metadataSourceInfo{
		providerID:   provider,
		modelID:      strings.TrimSpace(modelID),
		baseModel:    catalog.inferCanonicalModelID(provider, modelID),
		relativePath: "providers/" + provider + "/models/" + match.id,
		fetchedAt:    catalog.generatedAt,
		now:          now,
	})
}

func (catalog *modelsDevCatalog) readBaseModel(baseModelID, requestedModelID string, now time.Time) map[string]any {
	match, ok := catalog.canonicalIndex[strings.ToLower(strings.TrimSpace(baseModelID))]
	if !ok {
		return nil
	}
	modelID := strings.TrimSpace(requestedModelID)
	if modelID == "" {
		modelID = match.id
	}
	info := metadataSourceInfo{
		modelID:      modelID,
		baseModel:    match.id,
		relativePath: "models/" + match.id,
		fetchedAt:    catalog.generatedAt,
		now:          now,
	}
	meta := normalizeCatalogMetadata(match.record, info)
	if meta == nil {
		return nil
	}
	if _, hasCost := meta["cost"]; !hasCost {
		if slash := strings.Index(match.id, "/"); slash > 0 {
			providerID := match.id[:slash]
			providerModelID := match.id[slash+1:]
			if providerMeta := catalog.readProviderModel(providerID, providerModelID, now); providerMeta != nil {
				if providerCost, ok := providerMeta["cost"].(map[string]any); ok && len(providerCost) > 0 {
					meta["cost"] = providerCost
					derivedFrom, _ := providerMeta["baseModel"].(string)
					if derivedFrom == "" {
						derivedFrom, _ = providerMeta["id"].(string)
					}
					pricing := buildPricingMetadata(providerCost, catalog.generatedAt, now, true, derivedFrom)
					mergePricingMetadataFields(meta, pricing)
					meta = cleanMap(meta)
				}
			}
		}
	}
	return meta
}

func (catalog *modelsDevCatalog) inferCanonicalModelID(providerID, modelID string) string {
	stripped := stripKnownModelPrefix(modelID)
	candidates := append(inferBaseModelIDs(modelID), providerID+"/"+stripped)
	for _, candidate := range candidates {
		if match, ok := catalog.canonicalIndex[strings.ToLower(strings.TrimSpace(candidate))]; ok {
			return match.id
		}
	}
	return ""
}

type metadataSourceInfo struct {
	providerID   string
	modelID      string
	baseModel    string
	relativePath string
	fetchedAt    string
	now          time.Time
}

func normalizeCatalogMetadata(model rawModelRecord, info metadataSourceInfo) map[string]any {
	cost := normalizeCostMap(model.Cost)
	pricing := buildPricingMetadata(cost, info.fetchedAt, info.now, false, "")
	stale := isPricingSnapshotStale(info.fetchedAt, info.now)
	var expBool any
	if b, ok := model.Experimental.(bool); ok {
		expBool = b
	}
	var interleavedMap map[string]any
	if m, ok := model.Interleaved.(map[string]any); ok {
		if field, ok := m["field"].(string); ok && strings.TrimSpace(field) != "" {
			interleavedMap = map[string]any{"field": strings.TrimSpace(field)}
		}
	}
	reasoningOpts := make([]any, 0, len(model.ReasoningOptions))
	for _, item := range model.ReasoningOptions {
		kind := strings.TrimSpace(item.Type)
		if kind == "" {
			continue
		}
		entry := map[string]any{"type": kind}
		if vals := normalizeStringSlice(item.Values); len(vals) > 0 {
			entry["values"] = vals
		}
		if item.Min != nil && !math.IsNaN(*item.Min) && !math.IsInf(*item.Min, 0) {
			entry["min"] = *item.Min
		}
		if item.Max != nil && !math.IsNaN(*item.Max) && !math.IsInf(*item.Max, 0) {
			entry["max"] = *item.Max
		}
		reasoningOpts = append(reasoningOpts, entry)
	}
	limits := map[string]any{}
	if model.Limit != nil {
		if finiteFloat(model.Limit.Context) {
			limits["context"] = *model.Limit.Context
		}
		if finiteFloat(model.Limit.Input) {
			limits["input"] = *model.Limit.Input
		}
		if finiteFloat(model.Limit.Output) {
			limits["output"] = *model.Limit.Output
		}
	}
	modalities := map[string]any{}
	if model.Modalities != nil {
		if inputs := normalizeStringSlice(model.Modalities.Input); len(inputs) > 0 {
			modalities["input"] = inputs
		}
		if outputs := normalizeStringSlice(model.Modalities.Output); len(outputs) > 0 {
			modalities["output"] = outputs
		}
	}
	capabilities := map[string]any{}
	if model.Attachment != nil {
		capabilities["attachment"] = *model.Attachment
	}
	if model.Reasoning != nil {
		capabilities["reasoning"] = *model.Reasoning
	}
	if len(reasoningOpts) > 0 {
		capabilities["reasoningOptions"] = reasoningOpts
	}
	if model.ToolCall != nil {
		capabilities["toolCall"] = *model.ToolCall
	}
	if model.StructuredOutput != nil {
		capabilities["structuredOutput"] = *model.StructuredOutput
	}
	if model.Temperature != nil {
		capabilities["temperature"] = *model.Temperature
	}
	if model.OpenWeights != nil {
		capabilities["openWeights"] = *model.OpenWeights
	}
	result := map[string]any{
		"id":                    info.modelID,
		"providerId":            info.providerID,
		"baseModel":             info.baseModel,
		"metadataSchemaVersion": modelMetadataSchemaVersion,
		"metadataStatus":        "resolved",
		"metadataSource":        modelMetadataSourceID,
		"metadataAuthority":     priceSourceAuthorityAgg,
		"metadataFetchedAt":     info.fetchedAt,
		"metadataStale":         stale,
		"source": map[string]any{
			"type":       modelMetadataSourceID,
			"id":         modelMetadataSourceID,
			"kind":       "aggregator",
			"authority":  priceSourceAuthorityAgg,
			"confidence": 0.8,
			"url":        modelsDevCatalogURL,
			"path":       info.relativePath,
			"fetchedAt":  info.fetchedAt,
			"stale":      stale,
		},
		"name":         strings.TrimSpace(model.Name),
		"family":       strings.TrimSpace(model.Family),
		"status":       strings.TrimSpace(model.Status),
		"experimental": expBool,
		"dates": map[string]any{
			"release":     strings.TrimSpace(model.ReleaseDate),
			"lastUpdated": strings.TrimSpace(model.LastUpdated),
			"knowledge":   strings.TrimSpace(model.Knowledge),
		},
		"capabilities": capabilities,
		"limits":       limits,
		"modalities":   modalities,
		"cost":         cost,
		"interleaved":  interleavedMap,
	}
	mergePricingMetadataFields(result, pricing)
	return cleanMap(result)
}

func normalizeCostTierMap(tier *rawCostTier) map[string]any {
	if tier == nil {
		return nil
	}
	m := map[string]any{}
	if finiteFloat(tier.Input) {
		m["input"] = *tier.Input
	}
	if finiteFloat(tier.Output) {
		m["output"] = *tier.Output
	}
	if finiteFloat(tier.Reasoning) {
		m["reasoning"] = *tier.Reasoning
	}
	if finiteFloat(tier.CacheRead) {
		m["cacheRead"] = *tier.CacheRead
	}
	if finiteFloat(tier.CacheWrite) {
		m["cacheWrite"] = *tier.CacheWrite
	}
	if finiteFloat(tier.CacheWrite1h) {
		m["cacheWrite1h"] = *tier.CacheWrite1h
	} else if finiteFloat(tier.CacheWrite1H) {
		m["cacheWrite1h"] = *tier.CacheWrite1H
	}
	if finiteFloat(tier.InputAudio) {
		m["inputAudio"] = *tier.InputAudio
	}
	if finiteFloat(tier.OutputAudio) {
		m["outputAudio"] = *tier.OutputAudio
	}
	if len(tier.Tier) > 0 {
		m["tier"] = cleanMap(tier.Tier)
	}
	return cleanMap(m)
}

func normalizeCostMap(cost *rawCost) map[string]any {
	if cost == nil {
		return nil
	}
	m := map[string]any{}
	if finiteFloat(cost.Input) {
		m["input"] = *cost.Input
	}
	if finiteFloat(cost.Output) {
		m["output"] = *cost.Output
	}
	if finiteFloat(cost.Reasoning) {
		m["reasoning"] = *cost.Reasoning
	}
	if finiteFloat(cost.CacheRead) {
		m["cacheRead"] = *cost.CacheRead
	}
	if finiteFloat(cost.CacheWrite) {
		m["cacheWrite"] = *cost.CacheWrite
	}
	if finiteFloat(cost.CacheWrite1h) {
		m["cacheWrite1h"] = *cost.CacheWrite1h
	} else if finiteFloat(cost.CacheWrite1H) {
		m["cacheWrite1h"] = *cost.CacheWrite1H
	}
	if finiteFloat(cost.InputAudio) {
		m["inputAudio"] = *cost.InputAudio
	}
	if finiteFloat(cost.OutputAudio) {
		m["outputAudio"] = *cost.OutputAudio
	}
	if len(cost.Tiers) > 0 {
		tiers := make([]map[string]any, 0, len(cost.Tiers))
		for i := range cost.Tiers {
			if t := normalizeCostTierMap(&cost.Tiers[i]); len(t) > 0 {
				tiers = append(tiers, t)
			}
		}
		if len(tiers) > 0 {
			m["tiers"] = tiers
		}
	}
	if cost.ContextOver200k != nil {
		over := map[string]any{}
		if finiteFloat(cost.ContextOver200k.Input) {
			over["input"] = *cost.ContextOver200k.Input
		}
		if finiteFloat(cost.ContextOver200k.Output) {
			over["output"] = *cost.ContextOver200k.Output
		}
		if finiteFloat(cost.ContextOver200k.CacheRead) {
			over["cacheRead"] = *cost.ContextOver200k.CacheRead
		}
		if finiteFloat(cost.ContextOver200k.CacheWrite) {
			over["cacheWrite"] = *cost.ContextOver200k.CacheWrite
		}
		if finiteFloat(cost.ContextOver200k.CacheWrite1h) {
			over["cacheWrite1h"] = *cost.ContextOver200k.CacheWrite1h
		} else if finiteFloat(cost.ContextOver200k.CacheWrite1H) {
			over["cacheWrite1h"] = *cost.ContextOver200k.CacheWrite1H
		}
		if len(over) > 0 {
			m["contextOver200k"] = over
		}
	}
	return cleanMap(m)
}

func collectCostNumbers(cost map[string]any, out *[]float64) {
	for _, value := range cost {
		switch typed := value.(type) {
		case float64:
			if !math.IsNaN(typed) && !math.IsInf(typed, 0) {
				*out = append(*out, typed)
			}
		case map[string]any:
			collectCostNumbers(typed, out)
		case []map[string]any:
			for _, item := range typed {
				collectCostNumbers(item, out)
			}
		}
	}
}

func buildPricingMetadata(cost map[string]any, fetchedAt string, now time.Time, derived bool, derivedFrom string) map[string]any {
	var values []float64
	if len(cost) > 0 {
		collectCostNumbers(cost, &values)
	}
	status := "unknown"
	if len(values) > 0 {
		allZero := true
		for _, v := range values {
			if v != 0 {
				allZero = false
				break
			}
		}
		if allZero {
			status = "free"
		} else {
			status = "priced"
		}
	}
	stale := isPricingSnapshotStale(fetchedAt, now)
	pricing := map[string]any{
		"schemaVersion": priceQuoteSchemaVersion,
		"status":        status,
		"authority":     priceSourceAuthorityAgg,
		"stale":         stale,
		"source": map[string]any{
			"id":         modelMetadataSourceID,
			"kind":       "aggregator",
			"authority":  priceSourceAuthorityAgg,
			"confidence": 0.8,
			"url":        modelsDevCatalogURL,
			"fetchedAt":  fetchedAt,
		},
	}
	if derived {
		pricing["derived"] = true
	}
	if strings.TrimSpace(derivedFrom) != "" {
		pricing["derivedFrom"] = strings.TrimSpace(derivedFrom)
	}
	return cleanMap(pricing)
}

func mergePricingMetadataFields(dst, pricing map[string]any) {
	dst["pricing"] = pricing
	if src, ok := pricing["source"].(map[string]any); ok {
		dst["pricingSource"] = src["id"]
		dst["pricingAuthority"] = src["authority"]
		dst["pricingFetchedAt"] = src["fetchedAt"]
	}
	dst["pricingStale"] = pricing["stale"]
	dst["pricingStatus"] = pricing["status"]
	if derivedFrom, ok := pricing["derivedFrom"]; ok {
		dst["derivedFrom"] = derivedFrom
	}
}

func stripKnownModelPrefix(modelID string) string {
	trimmed := strings.TrimSpace(modelID)
	if strings.HasPrefix(trimmed, "opencode-go/") {
		return strings.TrimPrefix(trimmed, "opencode-go/")
	}
	if strings.HasPrefix(trimmed, "opencode/") {
		return strings.TrimPrefix(trimmed, "opencode/")
	}
	return trimmed
}

func modelIDVariants(modelID string) []string {
	stripped := stripKnownModelPrefix(modelID)
	variants := []string{stripped}
	seen := map[string]struct{}{stripped: {}}
	add := func(candidate string) {
		if _, exists := seen[candidate]; !exists {
			seen[candidate] = struct{}{}
			variants = append(variants, candidate)
		}
	}
	if norm := versionDotPattern.ReplaceAllString(stripped, "$1-$2"); norm != stripped {
		add(norm)
	}
	if noBracket := bracketSuffixPattern.ReplaceAllString(stripped, ""); noBracket != stripped {
		add(noBracket)
	}
	if noDate := dateTagPattern.ReplaceAllString(stripped, ""); noDate != stripped {
		add(noDate)
	}
	return variants
}

func inferBaseModelIDs(modelID string) []string {
	id := strings.TrimSpace(modelID)
	candidates := make([]string, 0, 16)
	seen := make(map[string]struct{}, 16)
	add := func(c string) {
		if c == "" {
			return
		}
		if _, ok := seen[c]; !ok {
			seen[c] = struct{}{}
			candidates = append(candidates, c)
		}
	}
	if strings.Contains(id, "/") {
		add(id)
	}
	for _, variant := range modelIDVariants(id) {
		if patternOpenAIModel.MatchString(variant) {
			add("openai/" + variant)
		}
		if patternClaudeModel.MatchString(variant) {
			add("anthropic/" + variant)
		}
		if patternGeminiModel.MatchString(variant) {
			add("google/" + variant)
		}
		if patternGrokModel.MatchString(variant) {
			add("xai/" + variant)
		}
		if patternKimiModel.MatchString(variant) {
			add("moonshotai/" + variant)
		}
		if patternGLMModel.MatchString(variant) {
			add("zhipuai/" + variant)
			add("zhipu/" + variant)
		}
		if patternDeepSeekModel.MatchString(variant) {
			add("deepseek/" + variant)
		}
		if patternMiniMaxModel.MatchString(variant) {
			add("minimax/" + variant)
		}
		if patternQwenModel.MatchString(variant) {
			add("alibaba/" + variant)
			add("qwen/" + variant)
		}
		if patternMimoModel.MatchString(variant) {
			add("xiaomi/" + variant)
		}
		if patternStepModel.MatchString(variant) {
			add("stepfun/" + variant)
		}
		if patternNemotronModel.MatchString(variant) {
			add("nvidia/" + variant)
		}
		if patternMistralModel.MatchString(variant) {
			add("mistralai/" + variant)
		}
	}
	prefixes := []string{"openai", "anthropic", "google", "xai", "moonshotai", "zhipuai", "zhipu", "deepseek", "minimax", "alibaba", "qwen", "xiaomi", "stepfun"}
	for _, variant := range modelIDVariants(id) {
		trimmed := variant
		for {
			idx := strings.LastIndex(trimmed, "-")
			if idx <= 0 {
				break
			}
			trimmed = trimmed[:idx]
			for _, prefix := range prefixes {
				add(prefix + "/" + trimmed)
			}
			if strings.Contains(trimmed, "/") {
				add(trimmed)
			}
		}
	}
	return candidates
}

func inferModelsDevProviderIDs(aihProvider, modelID string) []string {
	provider := strings.ToLower(strings.TrimSpace(aihProvider))
	id := strings.TrimSpace(modelID)
	stripped := stripKnownModelPrefix(id)
	var candidates []string
	seen := map[string]struct{}{}
	add := func(items ...string) {
		for _, item := range items {
			if item == "" {
				continue
			}
			if _, ok := seen[item]; !ok {
				seen[item] = struct{}{}
				candidates = append(candidates, item)
			}
		}
	}
	if strings.HasPrefix(id, "opencode-go/") {
		add("opencode-go")
	}
	if strings.HasPrefix(id, "opencode/") {
		add("opencode")
	}
	switch provider {
	case "codex":
		add("openai", "github-copilot")
	case "claude":
		add("anthropic")
	case "gemini":
		add("google", "google-vertex")
	case "opencode":
		add("opencode-go", "opencode")
	case "cline":
		add("cline-pass")
	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		if patternCBDeepSeek.MatchString(stripped) {
			add("opencode-go")
		}
		if patternCBHY4Preview.MatchString(stripped) {
			add("tencent-token-plan")
		}
	case "agy":
		if patternClaudeModel.MatchString(stripped) {
			add("anthropic", "github-copilot", "google-vertex")
		}
		if patternGeminiModel.MatchString(stripped) {
			add("google", "github-copilot", "google-vertex")
		}
		if patternOpenAIModel.MatchString(stripped) {
			add("openai", "github-copilot")
		}
		if patternGrokModel.MatchString(stripped) {
			add("xai")
		}
		add("github-copilot")
	case "grok":
		add("xai", "github-copilot")
	case "kimi":
		add("kimi-code-plan-global", "kimi-code-plan-cn", "moonshotai-cn", "moonshotai", "kimi-for-coding")
	}

	if provider == "zcode" {
		applyLateModelRules(stripped, add, true)
		add("zai-coding-plan", "zhipuai-coding-plan", "zai", "zhipuai")
		return candidates
	}
	if provider == "" {
		applyLateModelRules(stripped, add, true)
	} else {
		applyLateModelRules(stripped, add, false)
	}
	return candidates
}

func applyLateModelRules(stripped string, add func(...string), includeGLM bool) {
	if patternKimiForCoding.MatchString(stripped) || patternKimiK3.MatchString(stripped) {
		add("kimi-code-plan-global", "kimi-code-plan-cn", "kimi-for-coding")
	}
	if includeGLM && patternGLMModel.MatchString(stripped) {
		add("zai-coding-plan", "zhipuai-coding-plan", "zai", "zhipuai")
	}
}

func resolveModelOwner(provider, modelID string) string {
	switch {
	case strings.HasPrefix(modelID, "cline-pass/"):
		return "cline"
	case strings.HasPrefix(modelID, "opencode-go/"):
		return "opencode-go"
	case strings.HasPrefix(modelID, "opencode/"):
		return "opencode-zen"
	case strings.HasPrefix(modelID, "claude-") || strings.HasPrefix(modelID, "anthropic."):
		return "anthropic"
	case strings.HasPrefix(modelID, "gemini-") || strings.Contains(modelID, "google"):
		return "google"
	case strings.HasPrefix(modelID, "opencode-"):
		return "opencode"
	case strings.HasPrefix(modelID, "gpt-") || strings.HasPrefix(modelID, "o1") || strings.HasPrefix(modelID, "o3") || strings.HasPrefix(modelID, "o4"):
		return "openai"
	case strings.HasPrefix(modelID, "kimi-") || modelID == "k3" || strings.HasPrefix(modelID, "k3-"):
		return "moonshotai"
	case strings.HasPrefix(modelID, "glm-"):
		return "zhipu"
	}
	switch provider {
	case "claude":
		return "anthropic"
	case "gemini":
		return "google"
	case "codex":
		return "openai"
	case "opencode":
		return "opencode"
	case "kimi":
		return "moonshotai"
	case "zcode":
		return "zhipu"
	case "cline":
		return "cline"
	}
	return "aih-server"
}

func resolveOpenAIProviderFromModel(modelID, ownedBy string) string {
	id := strings.ToLower(strings.TrimSpace(modelID))
	owner := strings.ToLower(strings.TrimSpace(ownedBy))
	switch {
	case owner == "openai" || strings.HasPrefix(id, "gpt-") || strings.HasPrefix(id, "o1") || strings.HasPrefix(id, "o3") || strings.HasPrefix(id, "o4"):
		return "codex"
	case owner == "zhipu" || strings.HasPrefix(id, "glm-"):
		return "zcode"
	case owner == "google" || strings.HasPrefix(id, "gemini-"):
		return "gemini"
	case owner == "anthropic" || strings.HasPrefix(id, "claude-") || strings.HasPrefix(id, "anthropic."):
		return "claude"
	case owner == "opencode" || strings.HasPrefix(id, "opencode-go/") || strings.HasPrefix(id, "opencode/"):
		return "opencode"
	default:
		return ""
	}
}

func resolveModalities(index *modelsdev.Index, provider, modelID string) ModelModalitiesView {
	if index == nil {
		loaded, err := defaultModalitiesIndex()
		if err == nil {
			index = loaded
		}
	}
	if index != nil {
		if m, found := index.LookupOrInferModalities(provider, modelID); found {
			in := m.Input()
			out := m.Output()
			if len(in) > 0 || len(out) > 0 {
				return ModelModalitiesView{
					Input:  in,
					Output: out,
				}
			}
		}
	}
	return ModelModalitiesView{
		Input:  []string{"text"},
		Output: []string{"text"},
	}
}

func resolveReasoningEfforts(index *modelsdev.Index, provider, modelID string) []string {
	if index == nil {
		loaded, err := defaultModalitiesIndex()
		if err == nil {
			index = loaded
		}
	}
	if index == nil {
		return nil
	}
	ladder, found := index.LookupReasoningEfforts(provider, modelID)
	if !found || len(ladder) == 0 {
		return nil
	}
	out := make([]string, 0, len(ladder))
	for _, value := range ladder {
		if value != inference.ReasoningEffort("") && value.IsValid() {
			out = append(out, string(value))
		}
	}
	return out
}

func finiteFloat(value *float64) bool {
	return value != nil && !math.IsNaN(*value) && !math.IsInf(*value, 0)
}

func normalizeStringSlice(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, item := range values {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; !exists {
			seen[trimmed] = struct{}{}
			out = append(out, trimmed)
		}
	}
	return out
}

func cleanMap(source map[string]any) map[string]any {
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
		case []map[string]any:
			if len(typed) == 0 {
				continue
			}
		case map[string]any:
			nested := cleanMap(typed)
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
