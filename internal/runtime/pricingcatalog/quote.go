// Package pricingcatalog 提供持久化价格源快照、人工复核队列、社区价格采集与报价合并。
//
// 从 Node lib/usage/pricing/* 迁移到 Go：价格是计费事实，只保存归一化后的 USD/1M token
// 报价与原子写入的快照，任何坏数值或未知来源都不静默折算为 0。
package pricingcatalog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// PriceQuoteSchemaVersion 是 PriceQuote 与快照文件的版本号。
	PriceQuoteSchemaVersion = 1
	// PriceQuoteCurrency 固定为美元，避免多币种混算。
	PriceQuoteCurrency = "USD"
	// PriceQuoteUnit 固定为每百万 token，避免 per-token / per-1K 混算。
	PriceQuoteUnit = "per_1m_tokens"
	// PricingSnapshotMaxAge 是快照默认保鲜窗口（14 天）。
	PricingSnapshotMaxAge = 14 * 24 * time.Hour

	StatusPriced  = "priced"
	StatusFree    = "free"
	StatusUnknown = "unknown"

	KindAccount    = "account"
	KindManual     = "manual"
	KindOfficial   = "official"
	KindVendor     = "vendor"
	KindProvider   = "provider"
	KindAggregator = "aggregator"
	KindCommunity  = "community"
	KindDerived    = "derived"
	KindUnknown    = "unknown"
)

// PriceQuoteDimensions 列出所有独立的报价维度（JSON 字段名顺序固定）。
var PriceQuoteDimensions = []string{
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"cacheWrite1h",
	"reasoning",
}

// SourceAuthorityByKind 定义宿主裁决权威上限：
// 账号自定义 > 人工覆盖 > 官方 > 厂商 > Provider > 聚合 > 社区 > 派生。
var SourceAuthorityByKind = map[string]float64{
	KindAccount:    100,
	KindManual:     95,
	KindOfficial:   90,
	KindVendor:     80,
	KindProvider:   60,
	KindAggregator: 40,
	KindCommunity:  20,
	KindDerived:    10,
	KindUnknown:    0,
}

var (
	// ErrInvalidQuote 表示单条报价不合法，调用方不得静默当作免费。
	ErrInvalidQuote = errors.New("price_quote_invalid")
)

// QuoteSource 描述一条报价的来源与可信度元数据。
type QuoteSource struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	Authority  float64 `json:"authority"`
	Confidence float64 `json:"confidence"`
	URL        string  `json:"url,omitempty"`
	License    string  `json:"license,omitempty"`
	FetchedAt  string  `json:"fetchedAt,omitempty"`
	ExpiresAt  string  `json:"expiresAt,omitempty"`
	Stale      bool    `json:"stale,omitempty"`
}

// TierWhen 描述上下文长度分档的触发条件。
type TierWhen struct {
	ContextTokensGt float64 `json:"contextTokensGt"`
}

// PriceTier 表示超过指定上下文 token 数后的分档价格（只保留显式声明的维度）。
type PriceTier struct {
	When         TierWhen `json:"when"`
	Input        *float64 `json:"input,omitempty"`
	Output       *float64 `json:"output,omitempty"`
	CacheRead    *float64 `json:"cacheRead,omitempty"`
	CacheWrite   *float64 `json:"cacheWrite,omitempty"`
	CacheWrite1h *float64 `json:"cacheWrite1h,omitempty"`
	Reasoning    *float64 `json:"reasoning,omitempty"`
}

// ConflictSide 记录维度冲突中胜出或被淘汰的某一方报价。
type ConflictSide struct {
	SourceID  string   `json:"sourceId,omitempty"`
	Authority *float64 `json:"authority,omitempty"`
	Value     *float64 `json:"value"`
}

// QuoteWarning 记录报价冲突、来源过期或插件执行告警。
type QuoteWarning struct {
	Code      string         `json:"code"`
	Dimension string         `json:"dimension,omitempty"`
	SourceID  string         `json:"sourceId,omitempty"`
	FetchedAt string         `json:"fetchedAt,omitempty"`
	Chosen    *ConflictSide  `json:"chosen,omitempty"`
	Rejected  []ConflictSide `json:"rejected,omitempty"`
	Message   string         `json:"message,omitempty"`
}

// PriceQuote 是宿主与价格插件之间的标准单源报价对象。
type PriceQuote struct {
	SchemaVersion int            `json:"schemaVersion"`
	Provider      string         `json:"provider"`
	Model         string         `json:"model"`
	AccountRef    string         `json:"accountRef,omitempty"`
	Currency      string         `json:"currency"`
	Unit          string         `json:"unit"`
	Status        string         `json:"status"`
	Input         *float64       `json:"input"`
	Output        *float64       `json:"output"`
	CacheRead     *float64       `json:"cacheRead"`
	CacheWrite    *float64       `json:"cacheWrite"`
	CacheWrite1h  *float64       `json:"cacheWrite1h"`
	Reasoning     *float64       `json:"reasoning"`
	Tiers         []PriceTier    `json:"tiers,omitempty"`
	Source        QuoteSource    `json:"source"`
	Specificity   float64        `json:"specificity"`
	Derived       bool           `json:"derived"`
	DerivedFrom   string         `json:"derivedFrom,omitempty"`
	EffectiveAt   string         `json:"effectiveAt,omitempty"`
	Warnings      []QuoteWarning `json:"warnings,omitempty"`
}

// MergedPriceQuote 是宿主按维度裁决合并后的最终报价。
type MergedPriceQuote struct {
	SchemaVersion int            `json:"schemaVersion"`
	Provider      string         `json:"provider"`
	Model         string         `json:"model"`
	Currency      string         `json:"currency"`
	Unit          string         `json:"unit"`
	Status        string         `json:"status"`
	Input         *float64       `json:"input"`
	Output        *float64       `json:"output"`
	CacheRead     *float64       `json:"cacheRead"`
	CacheWrite    *float64       `json:"cacheWrite"`
	CacheWrite1h  *float64       `json:"cacheWrite1h"`
	Reasoning     *float64       `json:"reasoning"`
	Tiers         []PriceTier    `json:"tiers,omitempty"`
	Source        *QuoteSource   `json:"source"`
	Sources       []string       `json:"sources"`
	Stale         bool           `json:"stale"`
	Derived       bool           `json:"derived"`
	DerivedFrom   string         `json:"derivedFrom,omitempty"`
	Warnings      []QuoteWarning `json:"warnings"`
}

// FlexNumber 解析 JSON 数字或数字字符串；空串与 null 视为 nil，非法格式报错。
type FlexNumber struct {
	Set   bool
	Valid bool
	Value float64
}

func (n *FlexNumber) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	n.Set = true
	if trimmed == "" || trimmed == "null" {
		n.Valid = false
		return nil
	}
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		text = strings.TrimSpace(text)
		if text == "" {
			n.Valid = false
			return nil
		}
		val, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return fmt.Errorf("invalid number %q: %w", text, err)
		}
		n.Valid = true
		n.Value = val
		return nil
	}
	val, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return err
	}
	n.Valid = true
	n.Value = val
	return nil
}

// RawSourceInput 支持字符串 sourceId 或完整 source 对象两种形态。
type RawSourceInput struct {
	ID         string      `json:"id"`
	Kind       string      `json:"kind"`
	Authority  *FlexNumber `json:"authority"`
	Confidence *FlexNumber `json:"confidence"`
	URL        string      `json:"url"`
	License    string      `json:"license"`
	FetchedAt  string      `json:"fetchedAt"`
	ExpiresAt  string      `json:"expiresAt"`
	Stale      bool        `json:"stale"`
}

func (s *RawSourceInput) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	if trimmed[0] == '"' {
		var id string
		if err := json.Unmarshal(trimmed, &id); err != nil {
			return err
		}
		s.ID = id
		return nil
	}
	type alias RawSourceInput
	var decoded alias
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return err
	}
	*s = RawSourceInput(decoded)
	return nil
}

// RawTierWhenInput 解码分档条件。
type RawTierWhenInput struct {
	ContextTokensGt *FlexNumber `json:"contextTokensGt"`
}

// RawTierInput 解码原始分档对象。
type RawTierInput struct {
	When         *RawTierWhenInput `json:"when"`
	Input        *FlexNumber       `json:"input"`
	Output       *FlexNumber       `json:"output"`
	CacheRead    *FlexNumber       `json:"cacheRead"`
	CacheWrite   *FlexNumber       `json:"cacheWrite"`
	CacheWrite1h *FlexNumber       `json:"cacheWrite1h"`
	Reasoning    *FlexNumber       `json:"reasoning"`
}

// RawQuoteInput 解码原始报价 JSON。
type RawQuoteInput struct {
	Provider    string          `json:"provider"`
	Model       string          `json:"model"`
	AccountRef  string          `json:"accountRef"`
	Currency    string          `json:"currency"`
	Unit        string          `json:"unit"`
	Input       *FlexNumber     `json:"input"`
	Output      *FlexNumber     `json:"output"`
	CacheRead   *FlexNumber     `json:"cacheRead"`
	CacheWrite  *FlexNumber     `json:"cacheWrite"`
	CacheWrite1h *FlexNumber    `json:"cacheWrite1h"`
	Reasoning   *FlexNumber     `json:"reasoning"`
	Tiers       []RawTierInput  `json:"tiers"`
	Source      *RawSourceInput `json:"source"`
	Specificity *FlexNumber     `json:"specificity"`
	Derived     bool            `json:"derived"`
	DerivedFrom string          `json:"derivedFrom"`
	EffectiveAt string          `json:"effectiveAt"`
	Warnings    []QuoteWarning  `json:"warnings"`
}

// RawQuoteList 兼容单对象与数组两种 hostOverride 传参形态。
type RawQuoteList []RawQuoteInput

// UnmarshalJSON 将单对象或数组形式的报价覆盖统一解析为切片。
func (list *RawQuoteList) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		*list = nil
		return nil
	}
	if trimmed[0] == '{' {
		var single RawQuoteInput
		if err := json.Unmarshal(trimmed, &single); err != nil {
			return err
		}
		*list = []RawQuoteInput{single}
		return nil
	}
	var items []RawQuoteInput
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return err
	}
	*list = items
	return nil
}

// MergeOptions 控制报价合并行为。
type MergeOptions struct {
	Provider     string
	Model        string
	AccountRef   string
	HostOverride []RawQuoteInput
	Now          time.Time
}

// NormalizeQuote 从原始 JSON 解析并校验一条报价。
func NormalizeQuote(raw json.RawMessage) (PriceQuote, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return PriceQuote{}, fmt.Errorf("%w: must be object", ErrInvalidQuote)
	}
	var input RawQuoteInput
	if err := json.Unmarshal(trimmed, &input); err != nil {
		return PriceQuote{}, fmt.Errorf("%w: %v", ErrInvalidQuote, err)
	}
	return BuildQuote(input)
}

// BuildQuote 校验并规整一条结构化报价。
func BuildQuote(input RawQuoteInput) (PriceQuote, error) {
	provider := strings.TrimSpace(input.Provider)
	model := strings.TrimSpace(input.Model)
	if provider == "" {
		return PriceQuote{}, fmt.Errorf("%w_provider", ErrInvalidQuote)
	}
	if model == "" {
		return PriceQuote{}, fmt.Errorf("%w_model", ErrInvalidQuote)
	}
	if strings.TrimSpace(input.Currency) != "" && strings.ToUpper(strings.TrimSpace(input.Currency)) != PriceQuoteCurrency {
		return PriceQuote{}, fmt.Errorf("%w_currency", ErrInvalidQuote)
	}
	if strings.TrimSpace(input.Unit) != "" && strings.TrimSpace(input.Unit) != PriceQuoteUnit {
		return PriceQuote{}, fmt.Errorf("%w_unit", ErrInvalidQuote)
	}

	inVal, err := normalizeFlexNumber(input.Input, "input")
	if err != nil {
		return PriceQuote{}, err
	}
	outVal, err := normalizeFlexNumber(input.Output, "output")
	if err != nil {
		return PriceQuote{}, err
	}
	crVal, err := normalizeFlexNumber(input.CacheRead, "cacheRead")
	if err != nil {
		return PriceQuote{}, err
	}
	cwVal, err := normalizeFlexNumber(input.CacheWrite, "cacheWrite")
	if err != nil {
		return PriceQuote{}, err
	}
	cw1hVal, err := normalizeFlexNumber(input.CacheWrite1h, "cacheWrite1h")
	if err != nil {
		return PriceQuote{}, err
	}
	reasonVal, err := normalizeFlexNumber(input.Reasoning, "reasoning")
	if err != nil {
		return PriceQuote{}, err
	}

	tiers := make([]PriceTier, 0, len(input.Tiers))
	for _, rawTier := range input.Tiers {
		tier, tierErr := normalizeTier(rawTier)
		if tierErr != nil {
			return PriceQuote{}, tierErr
		}
		tiers = append(tiers, tier)
	}
	sort.SliceStable(tiers, func(left, right int) bool {
		return tiers[left].When.ContextTokensGt < tiers[right].When.ContextTokensGt
	})

	source, err := normalizeSource(input.Source)
	if err != nil {
		return PriceQuote{}, err
	}
	specVal, err := normalizeFlexNumber(input.Specificity, "specificity")
	if err != nil {
		return PriceQuote{}, err
	}
	specificity := 2.0
	if specVal != nil {
		specificity = *specVal
	}
	effectiveAt, err := normalizeTimestamp(input.EffectiveAt, "effective_at")
	if err != nil {
		return PriceQuote{}, err
	}

	quote := PriceQuote{
		SchemaVersion: PriceQuoteSchemaVersion,
		Provider:      provider,
		Model:         model,
		AccountRef:    strings.TrimSpace(input.AccountRef),
		Currency:      PriceQuoteCurrency,
		Unit:          PriceQuoteUnit,
		Input:         inVal,
		Output:        outVal,
		CacheRead:     crVal,
		CacheWrite:    cwVal,
		CacheWrite1h:  cw1hVal,
		Reasoning:     reasonVal,
		Tiers:         tiers,
		Source:        source,
		Specificity:   specificity,
		Derived:       input.Derived,
		DerivedFrom:   strings.TrimSpace(input.DerivedFrom),
		EffectiveAt:   effectiveAt,
		Warnings:      append([]QuoteWarning(nil), input.Warnings...),
	}
	quote.Status = deriveQuoteStatus(quote)
	return quote, nil
}

func normalizeSource(input *RawSourceInput) (QuoteSource, error) {
	raw := RawSourceInput{}
	if input != nil {
		raw = *input
	}
	kind := normalizeSourceKind(raw.Kind)
	kindAuthority := SourceAuthorityByKind[kind]

	authPtr, err := normalizeFlexNumber(raw.Authority, "source_authority")
	if err != nil {
		return QuoteSource{}, err
	}
	authority := kindAuthority
	if authPtr != nil {
		authority = math.Min(kindAuthority, *authPtr)
	}
	authority = math.Min(100, math.Max(0, authority))

	confPtr, err := normalizeFlexNumber(raw.Confidence, "source_confidence")
	if err != nil {
		return QuoteSource{}, err
	}
	confidence := 0.5
	if confPtr != nil {
		confidence = math.Max(0, math.Min(1, *confPtr))
	}

	fetchedAt, err := normalizeTimestamp(raw.FetchedAt, "source_fetched_at")
	if err != nil {
		return QuoteSource{}, err
	}
	expiresAt, err := normalizeTimestamp(raw.ExpiresAt, "source_expires_at")
	if err != nil {
		return QuoteSource{}, err
	}

	id := strings.TrimSpace(raw.ID)
	if id == "" {
		id = "unknown"
	}
	return QuoteSource{
		ID:         id,
		Kind:       kind,
		Authority:  authority,
		Confidence: confidence,
		URL:        strings.TrimSpace(raw.URL),
		License:    strings.TrimSpace(raw.License),
		FetchedAt:  fetchedAt,
		ExpiresAt:  expiresAt,
		Stale:      raw.Stale,
	}, nil
}

func normalizeSourceKind(value string) string {
	kind := strings.ToLower(strings.TrimSpace(value))
	if _, ok := SourceAuthorityByKind[kind]; ok {
		return kind
	}
	return KindUnknown
}

func normalizeTier(input RawTierInput) (PriceTier, error) {
	if input.When == nil {
		return PriceTier{}, fmt.Errorf("%w_tier_when", ErrInvalidQuote)
	}
	gt, err := normalizeFlexNumber(input.When.ContextTokensGt, "tier_context_tokens_gt")
	if err != nil {
		return PriceTier{}, err
	}
	if gt == nil {
		return PriceTier{}, fmt.Errorf("%w_tier_when", ErrInvalidQuote)
	}
	inVal, err := normalizeFlexNumber(input.Input, "tier_input")
	if err != nil {
		return PriceTier{}, err
	}
	outVal, err := normalizeFlexNumber(input.Output, "tier_output")
	if err != nil {
		return PriceTier{}, err
	}
	crVal, err := normalizeFlexNumber(input.CacheRead, "tier_cacheRead")
	if err != nil {
		return PriceTier{}, err
	}
	cwVal, err := normalizeFlexNumber(input.CacheWrite, "tier_cacheWrite")
	if err != nil {
		return PriceTier{}, err
	}
	cw1hVal, err := normalizeFlexNumber(input.CacheWrite1h, "tier_cacheWrite1h")
	if err != nil {
		return PriceTier{}, err
	}
	reasonVal, err := normalizeFlexNumber(input.Reasoning, "tier_reasoning")
	if err != nil {
		return PriceTier{}, err
	}
	return PriceTier{
		When:         TierWhen{ContextTokensGt: *gt},
		Input:        inVal,
		Output:       outVal,
		CacheRead:    crVal,
		CacheWrite:   cwVal,
		CacheWrite1h: cw1hVal,
		Reasoning:    reasonVal,
	}, nil
}

func normalizeFlexNumber(num *FlexNumber, field string) (*float64, error) {
	if num == nil || !num.Set || !num.Valid {
		return nil, nil
	}
	if math.IsNaN(num.Value) || math.IsInf(num.Value, 0) || num.Value < 0 {
		return nil, fmt.Errorf("%w_%s", ErrInvalidQuote, field)
	}
	rounded := roundPrice(num.Value)
	return &rounded, nil
}

func roundPrice(value float64) float64 {
	rounded := math.Round(value*1e12) / 1e12
	if rounded == 0 {
		return 0
	}
	return rounded
}

func normalizeTimestamp(value string, field string) (string, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return "", nil
	}
	parsed, ok := parseFlexibleTimestamp(text)
	if !ok {
		return "", fmt.Errorf("%w_%s", ErrInvalidQuote, field)
	}
	return formatISOString(parsed), nil
}

func parseFlexibleTimestamp(text string) (time.Time, bool) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

func formatISOString(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func timestampMillis(value string) int64 {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0
	}
	parsed, ok := parseFlexibleTimestamp(text)
	if !ok {
		return 0
	}
	return parsed.UnixMilli()
}

func collectQuoteValues(quote PriceQuote) []float64 {
	values := make([]float64, 0, 6+len(quote.Tiers)*6)
	for _, dim := range PriceQuoteDimensions {
		if val := quoteDimension(quote, dim); val != nil {
			values = append(values, *val)
		}
	}
	for _, tier := range quote.Tiers {
		for _, dim := range PriceQuoteDimensions {
			if val := tierDimension(tier, dim); val != nil {
				values = append(values, *val)
			}
		}
	}
	return values
}

func deriveQuoteStatus(quote PriceQuote) string {
	values := collectQuoteValues(quote)
	if len(values) == 0 {
		return StatusUnknown
	}
	for _, value := range values {
		if value != 0 {
			return StatusPriced
		}
	}
	return StatusFree
}

func quoteDimension(quote PriceQuote, dim string) *float64 {
	switch dim {
	case "input":
		return quote.Input
	case "output":
		return quote.Output
	case "cacheRead":
		return quote.CacheRead
	case "cacheWrite":
		return quote.CacheWrite
	case "cacheWrite1h":
		return quote.CacheWrite1h
	case "reasoning":
		return quote.Reasoning
	default:
		return nil
	}
}

func tierDimension(tier PriceTier, dim string) *float64 {
	switch dim {
	case "input":
		return tier.Input
	case "output":
		return tier.Output
	case "cacheRead":
		return tier.CacheRead
	case "cacheWrite":
		return tier.CacheWrite
	case "cacheWrite1h":
		return tier.CacheWrite1h
	case "reasoning":
		return tier.Reasoning
	default:
		return nil
	}
}

func setMergedDimension(merged *MergedPriceQuote, dim string, value *float64) {
	if value == nil {
		return
	}
	copied := *value
	switch dim {
	case "input":
		merged.Input = &copied
	case "output":
		merged.Output = &copied
	case "cacheRead":
		merged.CacheRead = &copied
	case "cacheWrite":
		merged.CacheWrite = &copied
	case "cacheWrite1h":
		merged.CacheWrite1h = &copied
	case "reasoning":
		merged.Reasoning = &copied
	}
}

// QuoteStale 判断报价是否已被标记或超过 expiresAt。
func QuoteStale(quote PriceQuote, now time.Time) bool {
	if quote.Source.Stale {
		return true
	}
	expiresAt := timestampMillis(quote.Source.ExpiresAt)
	return expiresAt > 0 && expiresAt < now.UnixMilli()
}

// CreateUnknownPriceQuote 构造缺省未知报价。
func CreateUnknownPriceQuote(provider, model string) MergedPriceQuote {
	return MergedPriceQuote{
		SchemaVersion: PriceQuoteSchemaVersion,
		Provider:      strings.TrimSpace(provider),
		Model:         strings.TrimSpace(model),
		Currency:      PriceQuoteCurrency,
		Unit:          PriceQuoteUnit,
		Status:        StatusUnknown,
		Source:        nil,
		Sources:       []string{},
		Stale:         false,
		Derived:       false,
		Warnings:      []QuoteWarning{},
	}
}

type rankedQuote struct {
	quote PriceQuote
	rank  [6]float64
}

func rankQuote(quote PriceQuote, accountRef string, now time.Time) [6]float64 {
	var accountMatch float64
	if accountRef != "" && quote.AccountRef == accountRef {
		accountMatch = 1
	}
	specificity := quote.Specificity
	if quote.Derived {
		specificity = math.Min(1, specificity)
	}
	freshness := 1.0
	if QuoteStale(quote, now) {
		freshness = 0
	}
	fetchedAt := float64(timestampMillis(quote.Source.FetchedAt))
	return [6]float64{
		accountMatch,
		quote.Source.Authority,
		specificity,
		freshness,
		fetchedAt,
		quote.Source.Confidence,
	}
}

// MergePriceQuotes 容错解析原始 JSON 报价列表并执行宿主维度级裁决。
// 单条坏报价会被跳过（由调用方通过 attempts/report 观察），绝不毒化整批合并。
func MergePriceQuotes(rawQuotes []json.RawMessage, opts MergeOptions) MergedPriceQuote {
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	accountRef := strings.TrimSpace(opts.AccountRef)
	normalized := make([]PriceQuote, 0, len(rawQuotes)+len(opts.HostOverride))
	for _, raw := range rawQuotes {
		quote, err := NormalizeQuote(raw)
		if err != nil {
			continue
		}
		if quote.AccountRef != "" && quote.AccountRef != accountRef {
			continue
		}
		if quote.EffectiveAt != "" && timestampMillis(quote.EffectiveAt) > now.UnixMilli() {
			continue
		}
		normalized = append(normalized, quote)
	}
	return mergeWithOverrides(normalized, opts, now)
}

// MergeNormalizedQuotes 对已规整的报价切片执行宿主维度级裁决。
func MergeNormalizedQuotes(quotes []PriceQuote, opts MergeOptions) MergedPriceQuote {
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	accountRef := strings.TrimSpace(opts.AccountRef)
	normalized := make([]PriceQuote, 0, len(quotes)+len(opts.HostOverride))
	for _, quote := range quotes {
		if quote.AccountRef != "" && quote.AccountRef != accountRef {
			continue
		}
		if quote.EffectiveAt != "" && timestampMillis(quote.EffectiveAt) > now.UnixMilli() {
			continue
		}
		normalized = append(normalized, quote)
	}
	return mergeWithOverrides(normalized, opts, now)
}

func mergeWithOverrides(normalized []PriceQuote, opts MergeOptions, now time.Time) MergedPriceQuote {
	for _, raw := range opts.HostOverride {
		overrideInput := raw
		if strings.TrimSpace(overrideInput.Provider) == "" {
			overrideInput.Provider = opts.Provider
		}
		if strings.TrimSpace(overrideInput.Model) == "" {
			overrideInput.Model = opts.Model
		}
		if overrideInput.Source == nil {
			auth := FlexNumber{Set: true, Valid: true, Value: 100}
			conf := FlexNumber{Set: true, Valid: true, Value: 1}
			overrideInput.Source = &RawSourceInput{
				ID:         "host-override",
				Kind:       KindAccount,
				Authority:  &auth,
				Confidence: &conf,
			}
		}
		if quote, err := BuildQuote(overrideInput); err == nil {
			normalized = append(normalized, quote)
		}
	}

	ranked := make([]rankedQuote, 0, len(normalized))
	for _, quote := range normalized {
		if quote.Status == StatusUnknown {
			continue
		}
		ranked = append(ranked, rankedQuote{
			quote: quote,
			rank:  rankQuote(quote, strings.TrimSpace(opts.AccountRef), now),
		})
	}
	if len(ranked) == 0 {
		return CreateUnknownPriceQuote(opts.Provider, opts.Model)
	}

	sort.SliceStable(ranked, func(left, right int) bool {
		for idx := 0; idx < len(ranked[left].rank); idx++ {
			if ranked[left].rank[idx] != ranked[right].rank[idx] {
				return ranked[left].rank[idx] > ranked[right].rank[idx]
			}
		}
		return ranked[left].quote.Source.ID < ranked[right].quote.Source.ID
	})

	primary := ranked[0].quote
	provider := strings.TrimSpace(opts.Provider)
	if provider == "" {
		provider = primary.Provider
	}
	model := strings.TrimSpace(opts.Model)
	if model == "" {
		model = primary.Model
	}

	merged := MergedPriceQuote{
		SchemaVersion: PriceQuoteSchemaVersion,
		Provider:      provider,
		Model:         model,
		Currency:      PriceQuoteCurrency,
		Unit:          PriceQuoteUnit,
		Warnings:      []QuoteWarning{},
	}

	pickedByDim := make(map[string]PriceQuote, len(PriceQuoteDimensions))
	values := make([]float64, 0, len(PriceQuoteDimensions))
	for _, dim := range PriceQuoteDimensions {
		var candidates []PriceQuote
		for _, entry := range ranked {
			if val := quoteDimension(entry.quote, dim); val != nil {
				candidates = append(candidates, entry.quote)
			}
		}
		if len(candidates) == 0 {
			continue
		}
		winner := candidates[0]
		winnerVal := quoteDimension(winner, dim)
		setMergedDimension(&merged, dim, winnerVal)
		pickedByDim[dim] = winner
		values = append(values, *winnerVal)

		var rejected []ConflictSide
		for _, other := range candidates[1:] {
			otherVal := quoteDimension(other, dim)
			if *otherVal != *winnerVal {
				auth := other.Source.Authority
				valCopy := *otherVal
				rejected = append(rejected, ConflictSide{
					SourceID:  other.Source.ID,
					Authority: &auth,
					Value:     &valCopy,
				})
			}
		}
		if len(rejected) > 0 {
			winAuth := winner.Source.Authority
			winVal := *winnerVal
			merged.Warnings = append(merged.Warnings, QuoteWarning{
				Code:      "price_conflict",
				Dimension: dim,
				Chosen: &ConflictSide{
					SourceID:  winner.Source.ID,
					Authority: &winAuth,
					Value:     &winVal,
				},
				Rejected: rejected,
			})
		}
		if QuoteStale(winner, now) {
			merged.Warnings = append(merged.Warnings, QuoteWarning{
				Code:      "price_source_stale",
				Dimension: dim,
				SourceID:  winner.Source.ID,
				FetchedAt: winner.Source.FetchedAt,
			})
		}
	}

	for _, entry := range ranked {
		if len(entry.quote.Tiers) > 0 {
			merged.Tiers = append([]PriceTier(nil), entry.quote.Tiers...)
			for _, tier := range merged.Tiers {
				for _, dim := range PriceQuoteDimensions {
					if val := tierDimension(tier, dim); val != nil {
						values = append(values, *val)
					}
				}
			}
			break
		}
	}

	switch {
	case len(values) == 0:
		merged.Status = StatusUnknown
	default:
		allFree := true
		for _, val := range values {
			if val != 0 {
				allFree = false
				break
			}
		}
		if allFree {
			merged.Status = StatusFree
		} else {
			merged.Status = StatusPriced
		}
	}

	sourceCopy := primary.Source
	merged.Source = &sourceCopy

	seenSources := make(map[string]struct{}, len(ranked))
	sources := make([]string, 0, len(ranked))
	for _, entry := range ranked {
		id := strings.TrimSpace(entry.quote.Source.ID)
		if id == "" {
			continue
		}
		if _, exists := seenSources[id]; exists {
			continue
		}
		seenSources[id] = struct{}{}
		sources = append(sources, id)
	}
	merged.Sources = sources

	stale := QuoteStale(primary, now)
	for _, dim := range PriceQuoteDimensions {
		if q, ok := pickedByDim[dim]; ok {
			if !stale && QuoteStale(q, now) {
				stale = true
			}
			if q.Derived && !merged.Derived {
				merged.Derived = true
				merged.DerivedFrom = q.DerivedFrom
			}
		}
	}
	merged.Stale = stale
	return merged
}
