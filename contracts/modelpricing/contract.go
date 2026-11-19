// Package modelpricing 定义模型价格与元数据插件的公开契约。
//
// 对应插件能力：
//
//	pricing.catalog  拉取一份来源价格目录（离线快照 + 人工复核）
//	pricing.quote    按单模型返回报价（可覆盖目录未收录的模型）
//	model.metadata   返回模型上下文/模态/能力等展示元数据
//
// 关键边界：
//   - 插件只提供“某来源的报价/元数据”，合并、账号覆盖与最终计费口径由宿主决定；
//   - 价格单位固定 USD / 每百万 token，不接受 per-token、per-1K 或包月价；
//   - 插件不能自称 account/manual 来源；宿主覆盖永远优先于任何插件；
//   - 采集失败保留上一份可用快照，不删除、不清空。
package modelpricing

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

const (
	// WireSchemaVersion 是 catalog/quote/metadata 三类载荷共同的版本号。
	WireSchemaVersion = 1

	// CurrencyUSD 是唯一允许的计价币种。
	CurrencyUSD = "USD"
	// UnitPerMillionTokens 是唯一允许的计价单位。
	UnitPerMillionTokens = "per_1m_tokens"

	CapabilityPricingCatalog = "pricing.catalog"
	CapabilityPricingQuote   = "pricing.quote"
	CapabilityModelMetadata  = "model.metadata"

	// SnapshotMaxAge 超过后标记 stale，而不是继续当作新鲜价格。
	SnapshotMaxAge = 14 * 24 * time.Hour
)

var (
	ErrInvalidQuote    = errors.New("modelpricing: invalid quote")
	ErrInvalidCatalog  = errors.New("modelpricing: invalid catalog")
	ErrInvalidMetadata = errors.New("modelpricing: invalid metadata")
)

// SourceKind 是价格来源类型；authority 由宿主按类型封顶。
type SourceKind string

const (
	SourceAccount    SourceKind = "account"
	SourceManual     SourceKind = "manual"
	SourceOfficial   SourceKind = "official"
	SourceVendor     SourceKind = "vendor"
	SourceProvider   SourceKind = "provider"
	SourceAggregator SourceKind = "aggregator"
	SourceCommunity  SourceKind = "community"
	SourceDerived    SourceKind = "derived"
	SourceUnknown    SourceKind = "unknown"
)

var sourceAuthority = map[SourceKind]int{
	SourceAccount:    100,
	SourceManual:     95,
	SourceOfficial:   90,
	SourceVendor:     80,
	SourceProvider:   60,
	SourceAggregator: 40,
	SourceCommunity:  20,
	SourceDerived:    10,
	SourceUnknown:    0,
}

// AuthorityFor 返回该来源类型的最高可信度。
func AuthorityFor(kind SourceKind) int {
	if value, ok := sourceAuthority[kind]; ok {
		return value
	}
	return 0
}

// Source 描述一条报价/元数据来自哪里。
type Source struct {
	ID         string     `json:"id"`
	Kind       SourceKind `json:"kind"`
	Authority  int        `json:"authority,omitempty"`
	Confidence float64    `json:"confidence,omitempty"`
	URL        string     `json:"url,omitempty"`
	Path       string     `json:"path,omitempty"`
	License    string     `json:"license,omitempty"`
	FetchedAt  *time.Time `json:"fetchedAt,omitempty"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
	Stale      bool       `json:"stale,omitempty"`
}

// Status 是报价状态；由宿主根据价格字段推导，插件可以不填。
type Status string

const (
	StatusPriced  Status = "priced"
	StatusFree    Status = "free"
	StatusUnknown Status = "unknown"
)

// Quote 是一条价格报价。金额为空表示该维度未声明，0 表示免费。
type Quote struct {
	SchemaVersion int      `json:"schemaVersion,omitempty"`
	Provider      string   `json:"provider"`
	Model         string   `json:"model"`
	AccountRef    string   `json:"accountRef,omitempty"`
	Currency      string   `json:"currency,omitempty"`
	Unit          string   `json:"unit,omitempty"`
	Input         *float64 `json:"input,omitempty"`
	Output        *float64 `json:"output,omitempty"`
	CacheRead     *float64 `json:"cacheRead,omitempty"`
	CacheWrite    *float64 `json:"cacheWrite,omitempty"`
	CacheWrite1h  *float64 `json:"cacheWrite1h,omitempty"`
	Reasoning     *float64 `json:"reasoning,omitempty"`

	Tiers       []Tier     `json:"tiers,omitempty"`
	Source      Source     `json:"source"`
	Specificity *float64   `json:"specificity,omitempty"`
	Derived     bool       `json:"derived,omitempty"`
	DerivedFrom string     `json:"derivedFrom,omitempty"`
	EffectiveAt *time.Time `json:"effectiveAt,omitempty"`
	Warnings    []Warning  `json:"warnings,omitempty"`
	Status      Status     `json:"status,omitempty"`
}

// Tier 是上下文长度分档价格；超过 ContextTokensGT 时整单改用该档单价。
type Tier struct {
	When         TierWhen `json:"when"`
	Input        *float64 `json:"input,omitempty"`
	Output       *float64 `json:"output,omitempty"`
	CacheRead    *float64 `json:"cacheRead,omitempty"`
	CacheWrite   *float64 `json:"cacheWrite,omitempty"`
	CacheWrite1h *float64 `json:"cacheWrite1h,omitempty"`
	Reasoning    *float64 `json:"reasoning,omitempty"`
}

type TierWhen struct {
	ContextTokensGT int64 `json:"contextTokensGt"`
}

type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

// Catalog 是一份来源目录。
type Catalog struct {
	Source      Source     `json:"source"`
	Quotes      []Quote    `json:"quotes"`
	GeneratedAt *time.Time `json:"generatedAt,omitempty"`
}

// CatalogRequest 是宿主调用 pricing.catalog 的请求体。
type CatalogRequest struct {
	SchemaVersion int        `json:"schemaVersion"`
	Kind          string     `json:"kind"` // 固定 "catalog"
	Now           *time.Time `json:"now,omitempty"`
}

// ModelRef 标识一个待查模型。
type ModelRef struct {
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	BaseModel  string `json:"baseModel,omitempty"`
	AccountRef string `json:"accountRef,omitempty"`
}

// QuoteRequest 是宿主调用 pricing.quote 的请求体。
type QuoteRequest struct {
	SchemaVersion int        `json:"schemaVersion"`
	Kind          string     `json:"kind"` // 固定 "quote"
	Now           *time.Time `json:"now,omitempty"`
	ModelRef
	ContextTokens int64 `json:"contextTokens,omitempty"`
}

// MetadataRequest 是宿主调用 model.metadata 的请求体。
type MetadataRequest struct {
	SchemaVersion int        `json:"schemaVersion"`
	Kind          string     `json:"kind"` // 固定 "metadata"
	Now           *time.Time `json:"now,omitempty"`
	ModelRef
}

// MetadataStatus 区分“查到了”和“明确未知”。
type MetadataStatus string

const (
	MetadataResolved MetadataStatus = "resolved"
	MetadataUnknown  MetadataStatus = "unknown"
)

// Metadata 是模型展示元数据。未知模型也必须显式返回 unknown，不能返回空对象。
type Metadata struct {
	ID                    string            `json:"id,omitempty"`
	ProviderID            string            `json:"providerId,omitempty"`
	BaseModel             string            `json:"baseModel,omitempty"`
	MetadataSchemaVersion int               `json:"metadataSchemaVersion"`
	MetadataStatus        MetadataStatus    `json:"metadataStatus"`
	MetadataSource        string            `json:"metadataSource,omitempty"`
	MetadataAuthority     int               `json:"metadataAuthority,omitempty"`
	MetadataFetchedAt     *time.Time        `json:"metadataFetchedAt,omitempty"`
	MetadataStale         bool              `json:"metadataStale,omitempty"`
	Source                Source            `json:"source"`
	Name                  string            `json:"name,omitempty"`
	Family                string            `json:"family,omitempty"`
	ModelStatus           string            `json:"status,omitempty"`
	Experimental          *bool             `json:"experimental,omitempty"`
	Dates                 MetadataDates     `json:"dates,omitempty"`
	Capabilities          Capabilities      `json:"capabilities,omitempty"`
	Limit                 Limit             `json:"limit,omitempty"`
	Modalities            Modalities        `json:"modalities,omitempty"`
	ReasoningEfforts      []string          `json:"reasoningEfforts,omitempty"`
	ReasoningOptions      []ReasoningOption `json:"reasoningOptions,omitempty"`
	Interleaved           *Interleaved      `json:"interleaved,omitempty"`
	Cost                  Cost              `json:"cost,omitempty"`
	Pricing               *Pricing          `json:"pricing,omitempty"`
}

// Pricing 是元数据里价格来源与新鲜度的摘要，供 UI 直接展示“价格来自哪、是否过期”。
type Pricing struct {
	Status      Status `json:"status"`
	Authority   int    `json:"authority,omitempty"`
	Stale       bool   `json:"stale,omitempty"`
	Source      Source `json:"source"`
	Derived     bool   `json:"derived,omitempty"`
	DerivedFrom string `json:"derivedFrom,omitempty"`
}

// MetadataDates 是模型生命周期信息（日期字符串原样透传）。
type MetadataDates struct {
	Release     string `json:"release,omitempty"`
	LastUpdated string `json:"lastUpdated,omitempty"`
	Knowledge   string `json:"knowledge,omitempty"`
}

type Capabilities struct {
	Attachment       *bool             `json:"attachment,omitempty"`
	Reasoning        *bool             `json:"reasoning,omitempty"`
	Temperature      *bool             `json:"temperature,omitempty"`
	ToolCall         *bool             `json:"toolCall,omitempty"`
	StructuredOutput *bool             `json:"structuredOutput,omitempty"`
	OpenWeights      *bool             `json:"openWeights,omitempty"`
	ReasoningOptions []ReasoningOption `json:"reasoningOptions,omitempty"`
}

type ReasoningOption struct {
	Type   string   `json:"type"`
	Values []string `json:"values,omitempty"`
	Min    *float64 `json:"min,omitempty"`
	Max    *float64 `json:"max,omitempty"`
}

type Interleaved struct {
	Field string `json:"field"`
}

type Limit struct {
	Context   int64 `json:"context,omitempty"`
	Input     int64 `json:"input,omitempty"`
	MaxOutput int64 `json:"maxOutput,omitempty"`
}

type Modalities struct {
	Input  []string `json:"input,omitempty"`
	Output []string `json:"output,omitempty"`
}

// Cost 是展示用价格，单位固定 USD / 每百万 token。
type Cost struct {
	Input        *float64      `json:"input,omitempty"`
	Output       *float64      `json:"output,omitempty"`
	CacheRead    *float64      `json:"cacheRead,omitempty"`
	CacheWrite   *float64      `json:"cacheWrite,omitempty"`
	CacheWrite1h *float64      `json:"cacheWrite1h,omitempty"`
	Reasoning    *float64      `json:"reasoning,omitempty"`
	InputAudio   *float64      `json:"inputAudio,omitempty"`
	OutputAudio  *float64      `json:"outputAudio,omitempty"`
	Tiers        []CostTier    `json:"tiers,omitempty"`
	Over200k     *CostOver200k `json:"contextOver200k,omitempty"`
}

type CostTier struct {
	Tier TierWhen `json:"tier,omitempty"`
	Cost
}

type CostOver200k struct {
	Cost
}

// CatalogSource 是 pricing.catalog 的宿主侧端口。
// models.dev、官方目录、社区目录和自定义插件都实现同一个接口。
type CatalogSource interface {
	Capability() string
	Load(ctx context.Context, request CatalogRequest) (Catalog, error)
}

// QuoteSource 是 pricing.quote 的宿主侧端口。
type QuoteSource interface {
	Capability() string
	Quote(ctx context.Context, request QuoteRequest) (Quote, error)
}

// MetadataSource 是 model.metadata 的宿主侧端口。
type MetadataSource interface {
	Capability() string
	Resolve(ctx context.Context, request MetadataRequest) (Metadata, error)
}

// Resolver 是宿主对外暴露的合并结果：插件排序、账号覆盖、失败回退都在实现里完成。
type Resolver interface {
	ResolveQuote(ctx context.Context, request QuoteRequest) (Quote, error)
	ResolveMetadata(ctx context.Context, request MetadataRequest) (Metadata, error)
}

// Validate 校验报价并推导 status。
func (quote Quote) Validate() error {
	if strings.TrimSpace(quote.Provider) == "" {
		return fmt.Errorf("%w: provider required", ErrInvalidQuote)
	}
	if strings.TrimSpace(quote.Model) == "" {
		return fmt.Errorf("%w: model required", ErrInvalidQuote)
	}
	if quote.Currency != "" && !strings.EqualFold(quote.Currency, CurrencyUSD) {
		return fmt.Errorf("%w: currency must be %s", ErrInvalidQuote, CurrencyUSD)
	}
	if quote.Unit != "" && quote.Unit != UnitPerMillionTokens {
		return fmt.Errorf("%w: unit must be %s", ErrInvalidQuote, UnitPerMillionTokens)
	}
	for name, value := range map[string]*float64{
		"input": quote.Input, "output": quote.Output,
		"cacheRead": quote.CacheRead, "cacheWrite": quote.CacheWrite,
		"cacheWrite1h": quote.CacheWrite1h, "reasoning": quote.Reasoning,
		"specificity": quote.Specificity,
	} {
		if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0) {
			return fmt.Errorf("%w: %s must be a non-negative number", ErrInvalidQuote, name)
		}
	}
	seen := map[int64]struct{}{}
	for index, tier := range quote.Tiers {
		if tier.When.ContextTokensGT < 0 {
			return fmt.Errorf("%w: tiers[%d].when.contextTokensGt invalid", ErrInvalidQuote, index)
		}
		if _, exists := seen[tier.When.ContextTokensGT]; exists {
			return fmt.Errorf("%w: duplicate tier threshold %d", ErrInvalidQuote, tier.When.ContextTokensGT)
		}
		seen[tier.When.ContextTokensGT] = struct{}{}
	}
	if strings.TrimSpace(quote.Source.ID) == "" {
		return fmt.Errorf("%w: source.id required", ErrInvalidQuote)
	}
	return nil
}

// Normalize 填充默认值、按来源类型封顶 authority，并推导 status。
func (quote Quote) Normalize() Quote {
	if quote.SchemaVersion == 0 {
		quote.SchemaVersion = WireSchemaVersion
	}
	if quote.Currency == "" {
		quote.Currency = CurrencyUSD
	}
	if quote.Unit == "" {
		quote.Unit = UnitPerMillionTokens
	}
	if quote.Source.Kind == "" {
		quote.Source.Kind = SourceUnknown
	}
	ceiling := AuthorityFor(quote.Source.Kind)
	if quote.Source.Authority == 0 || quote.Source.Authority > ceiling {
		quote.Source.Authority = ceiling
	}
	if quote.Source.Confidence < 0 {
		quote.Source.Confidence = 0
	}
	if quote.Source.Confidence > 1 {
		quote.Source.Confidence = 1
	}
	sort.SliceStable(quote.Tiers, func(i, j int) bool {
		return quote.Tiers[i].When.ContextTokensGT < quote.Tiers[j].When.ContextTokensGT
	})
	quote.Status = deriveStatus(quote)
	return quote
}

func deriveStatus(quote Quote) Status {
	values := []*float64{quote.Input, quote.Output, quote.CacheRead, quote.CacheWrite, quote.CacheWrite1h, quote.Reasoning}
	for _, tier := range quote.Tiers {
		values = append(values, tier.Input, tier.Output, tier.CacheRead, tier.CacheWrite, tier.CacheWrite1h, tier.Reasoning)
	}
	count := 0
	allZero := true
	for _, value := range values {
		if value == nil {
			continue
		}
		count++
		if *value != 0 {
			allZero = false
		}
	}
	switch {
	case count == 0:
		return StatusUnknown
	case allZero:
		return StatusFree
	default:
		return StatusPriced
	}
}

// Validate 校验一份目录。
func (catalog Catalog) Validate() error {
	if strings.TrimSpace(catalog.Source.ID) == "" {
		return fmt.Errorf("%w: source.id required", ErrInvalidCatalog)
	}
	for index, quote := range catalog.Quotes {
		if err := quote.Validate(); err != nil {
			return fmt.Errorf("%w: quotes[%d]: %v", ErrInvalidCatalog, index, err)
		}
	}
	return nil
}

// Validate 校验元数据；unknown 允许没有名称与成本，但必须有来源。
func (metadata Metadata) Validate() error {
	if metadata.MetadataSchemaVersion != 0 && metadata.MetadataSchemaVersion != WireSchemaVersion {
		return fmt.Errorf("%w: unsupported metadataSchemaVersion %d", ErrInvalidMetadata, metadata.MetadataSchemaVersion)
	}
	switch metadata.MetadataStatus {
	case MetadataResolved, MetadataUnknown:
	default:
		return fmt.Errorf("%w: metadataStatus must be resolved or unknown", ErrInvalidMetadata)
	}
	if strings.TrimSpace(metadata.Source.ID) == "" {
		return fmt.Errorf("%w: source.id required", ErrInvalidMetadata)
	}
	return nil
}

// IsStale 按快照时间判断是否过期；无 fetchedAt 视为过期。
func IsStale(fetchedAt *time.Time, now time.Time) bool {
	if fetchedAt == nil || fetchedAt.IsZero() {
		return true
	}
	if now.IsZero() {
		now = time.Now()
	}
	return now.Sub(*fetchedAt) > SnapshotMaxAge
}
