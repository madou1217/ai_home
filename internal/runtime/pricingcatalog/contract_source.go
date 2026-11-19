package pricingcatalog

import (
	"context"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/contracts/modelpricing"
)

// ContractQuoteSource 把已生效（已复核通过）的插件价格来源暴露成契约端口。
//
// 只读已生效快照：pending 目录里等待复核的报价不参与计费，否则未经人工确认的
// 价格会直接影响成本口径。
func (store *Store) ContractQuoteSource() modelpricing.QuoteSource {
	return &contractSource{store: store, now: time.Now}
}

type contractSource struct {
	store *Store
	now   func() time.Time

	mu          sync.Mutex
	fingerprint string
	quotes      map[string]modelpricing.Quote
	all         []modelpricing.Quote
}

func (source *contractSource) Capability() string { return modelpricing.CapabilityPricingCatalog }

func (source *contractSource) Quote(_ context.Context, request modelpricing.QuoteRequest) (modelpricing.Quote, error) {
	quotes := source.snapshot()
	accountRef := strings.TrimSpace(request.AccountRef)
	provider := strings.ToLower(strings.TrimSpace(request.Provider))
	model := strings.ToLower(strings.TrimSpace(request.Model))
	if accountRef != "" {
		if quote, found := quotes[contractKey(provider, model, accountRef)]; found {
			return quote, nil
		}
	}
	if quote, found := quotes[contractKey(provider, model, "")]; found {
		return quote, nil
	}
	return modelpricing.Quote{}, nil
}

func (source *contractSource) Load(_ context.Context, _ modelpricing.CatalogRequest) (modelpricing.Catalog, error) {
	source.snapshot()
	source.mu.Lock()
	defer source.mu.Unlock()
	return modelpricing.Catalog{
		Source: modelpricing.Source{
			ID:        "host:pricing-sources",
			Kind:      modelpricing.SourceAggregator,
			Authority: modelpricing.AuthorityFor(modelpricing.SourceAggregator),
		},
		Quotes: append([]modelpricing.Quote(nil), source.all...),
	}, nil
}

func (source *contractSource) snapshot() map[string]modelpricing.Quote {
	if source == nil || source.store == nil {
		return map[string]modelpricing.Quote{}
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	// 失效只按目录元数据判断：生产上的社区来源有数千条、JSON 数 MB，
	// 按时间周期重解析会把计费批次拖慢；文件名 + 大小 + mtime 足以发现变更。
	fingerprint := source.fingerprintLocked()
	if source.quotes != nil && fingerprint == source.fingerprint {
		return source.quotes
	}
	now := source.now()
	documents, err := source.store.ListSources()
	if err != nil {
		if source.quotes == nil {
			source.quotes = map[string]modelpricing.Quote{}
		}
		return source.quotes
	}
	quotes := make(map[string]modelpricing.Quote)
	for _, document := range documents {
		descriptor := contractSourceDescriptor(document.Source, document.FetchedAt, now)
		for _, price := range document.Quotes {
			quote := contractQuote(document, price, descriptor)
			key := contractKey(quote.Provider, quote.Model, quote.AccountRef)
			if existing, found := quotes[key]; found && !contractPreferred(quote, existing) {
				continue
			}
			quotes[key] = quote
		}
	}
	all := make([]modelpricing.Quote, 0, len(quotes))
	for _, quote := range quotes {
		all = append(all, quote)
	}
	source.quotes = quotes
	source.all = all
	source.fingerprint = fingerprint
	return quotes
}

// fingerprintLocked 汇总 sources/ 下已生效快照的 (名称, 大小, mtime)。
//
// 目录不存在时返回稳定空值：没有来源不是「每次都要重读」。
func (source *contractSource) fingerprintLocked() string {
	directory := source.store.sourcesDir
	if strings.TrimSpace(directory) == "" {
		return ""
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return ""
	}
	parts := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") ||
			strings.HasSuffix(entry.Name(), ".pending.json") {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		parts = append(parts, entry.Name()+":"+strconv.FormatInt(info.Size(), 10)+
			":"+strconv.FormatInt(info.ModTime().UnixNano(), 10))
	}
	sort.Strings(parts)
	return strings.Join(parts, "|")
}

// contractQuote 把来源文档里的一条报价转换成契约报价。
//
// 插件不能自称 account / manual 来源：这两类由宿主独占（账号设置与人工覆盖），
// 若允许插件声明就会绕过宿主裁决直接压过人工价格，所以统一降级为 provider。
func contractQuote(document SourceDocument, price PriceQuote, descriptor modelpricing.Source) modelpricing.Quote {
	quote := modelpricing.Quote{
		Provider:     strings.ToLower(strings.TrimSpace(price.Provider)),
		Model:        strings.ToLower(strings.TrimSpace(price.Model)),
		AccountRef:   strings.TrimSpace(price.AccountRef),
		Currency:     modelpricing.CurrencyUSD,
		Unit:         modelpricing.UnitPerMillionTokens,
		Input:        price.Input,
		Output:       price.Output,
		CacheRead:    price.CacheRead,
		CacheWrite:   price.CacheWrite,
		CacheWrite1h: price.CacheWrite1h,
		Reasoning:    price.Reasoning,
		Source:       descriptor,
		Specificity:  contractSpecificity(price.AccountRef),
	}
	for _, tier := range price.Tiers {
		quote.Tiers = append(quote.Tiers, modelpricing.Tier{
			When:         modelpricing.TierWhen{ContextTokensGT: int64(tier.When.ContextTokensGt)},
			Input:        tier.Input,
			Output:       tier.Output,
			CacheRead:    tier.CacheRead,
			CacheWrite:   tier.CacheWrite,
			CacheWrite1h: tier.CacheWrite1h,
			Reasoning:    tier.Reasoning,
		})
	}
	if effective := strings.TrimSpace(document.AppliedAt); effective != "" {
		if parsed, err := time.Parse(time.RFC3339, effective); err == nil {
			// EffectiveAt 是指针字段（未给出即为 nil，表示「实时生效」）。
			effectiveAt := parsed
			quote.EffectiveAt = &effectiveAt
		}
	}
	return quote.Normalize()
}

func contractSourceDescriptor(meta SourceMeta, fetchedAt string, now time.Time) modelpricing.Source {
	kind := contractKind(meta.Kind)
	authority := modelpricing.AuthorityFor(kind)
	if meta.Authority != nil {
		declared := int(*meta.Authority)
		if declared > 0 && declared < authority {
			authority = declared
		}
	}
	descriptor := modelpricing.Source{
		ID:        strings.TrimSpace(meta.ID),
		Kind:      kind,
		Authority: authority,
		URL:       strings.TrimSpace(meta.URL),
		License:   strings.TrimSpace(meta.License),
	}
	if descriptor.ID == "" {
		descriptor.ID = "plugin:pricing-source"
	}
	if meta.Confidence != nil {
		descriptor.Confidence = *meta.Confidence
	}
	raw := strings.TrimSpace(meta.FetchedAt)
	if raw == "" {
		raw = strings.TrimSpace(fetchedAt)
	}
	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		fetched := parsed.UTC()
		descriptor.FetchedAt = &fetched
		descriptor.Stale = now.Sub(fetched) > modelpricing.SnapshotMaxAge
	}
	return descriptor
}

// contractKind 把插件声明的来源类型收敛到插件允许的范围。
func contractKind(raw string) modelpricing.SourceKind {
	switch modelpricing.SourceKind(strings.ToLower(strings.TrimSpace(raw))) {
	case modelpricing.SourceOfficial:
		return modelpricing.SourceOfficial
	case modelpricing.SourceVendor:
		return modelpricing.SourceVendor
	case modelpricing.SourceProvider, modelpricing.SourceAccount, modelpricing.SourceManual:
		return modelpricing.SourceProvider
	case modelpricing.SourceAggregator:
		return modelpricing.SourceAggregator
	case modelpricing.SourceCommunity:
		return modelpricing.SourceCommunity
	case modelpricing.SourceDerived:
		return modelpricing.SourceDerived
	default:
		return modelpricing.SourceCommunity
	}
}

func contractSpecificity(accountRef string) *float64 {
	value := 2.0
	if strings.TrimSpace(accountRef) != "" {
		value = 3
	}
	return &value
}

func contractPreferred(left, right modelpricing.Quote) bool {
	if left.Source.Authority != right.Source.Authority {
		return left.Source.Authority > right.Source.Authority
	}
	leftSpecificity, rightSpecificity := 2.0, 2.0
	if left.Specificity != nil {
		leftSpecificity = *left.Specificity
	}
	if right.Specificity != nil {
		rightSpecificity = *right.Specificity
	}
	if leftSpecificity != rightSpecificity {
		return leftSpecificity > rightSpecificity
	}
	return left.Source.ID < right.Source.ID
}

func contractKey(provider, model, accountRef string) string {
	return strings.ToLower(strings.TrimSpace(provider)) + "\x00" +
		strings.ToLower(strings.TrimSpace(model)) + "\x00" +
		strings.TrimSpace(accountRef)
}
