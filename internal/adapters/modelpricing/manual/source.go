// Package manual 把 WebUI 按账号设置的模型自定义价格暴露为定价来源。
//
// 这是宿主构造的 manual 覆盖层（authority=95），高于 models.dev 的 aggregator；
// 只有 accountRef 唯一命中时才使用账号专属报价，聚合行只使用全局报价。
package manual

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/modelcatalogsettings"
	"github.com/madou1217/ai_home/contracts/modelpricing"
)

const sourceID = "manual:model-catalog-settings"

// SettingsLoader 读取归一后的模型目录设置；由 appstate 存储实现。
type SettingsLoader interface {
	Load(ctx context.Context) (modelcatalogsettings.Settings, error)
}

// Source 实现 pricing.quote / pricing.catalog。
type Source struct {
	loader SettingsLoader

	mu     sync.Mutex
	quotes map[string]modelpricing.Quote
	at     time.Time
}

// New 创建人工价格来源。
func New(loader SettingsLoader) *Source {
	return &Source{loader: loader}
}

// Quote 端口。
func (source *Source) Quote() modelpricing.QuoteSource { return quotePort{source: source} }

// Catalog 端口。
func (source *Source) Catalog() modelpricing.CatalogSource { return catalogPort{source: source} }

type quotePort struct{ source *Source }
type catalogPort struct{ source *Source }

func (quotePort) Capability() string   { return modelpricing.CapabilityPricingQuote }
func (catalogPort) Capability() string { return modelpricing.CapabilityPricingCatalog }

func (port quotePort) Quote(ctx context.Context, request modelpricing.QuoteRequest) (modelpricing.Quote, error) {
	quotes := port.source.snapshot(ctx)
	accountRef := strings.TrimSpace(request.AccountRef)
	provider := strings.ToLower(strings.TrimSpace(request.Provider))
	model := strings.ToLower(strings.TrimSpace(request.Model))
	if quote, ok := quotes[key(accountRef, provider, model, true)]; ok {
		return quote, nil
	}
	if quote, ok := quotes[key("", provider, model, false)]; ok {
		return quote, nil
	}
	return modelpricing.Quote{}, nil
}

func (port catalogPort) Load(ctx context.Context, _ modelpricing.CatalogRequest) (modelpricing.Catalog, error) {
	quotes := port.source.snapshot(ctx)
	result := make([]modelpricing.Quote, 0, len(quotes))
	for _, quote := range quotes {
		result = append(result, quote)
	}
	return modelpricing.Catalog{
		Source: modelpricing.Source{
			ID:        sourceID,
			Kind:      modelpricing.SourceManual,
			Authority: modelpricing.AuthorityFor(modelpricing.SourceManual),
		},
		Quotes: result,
	}, nil
}

func (source *Source) snapshot(ctx context.Context) map[string]modelpricing.Quote {
	if source == nil || source.loader == nil {
		return map[string]modelpricing.Quote{}
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.quotes != nil && time.Since(source.at) < 30*time.Second {
		return source.quotes
	}
	settings, err := source.loader.Load(ctx)
	if err != nil {
		if source.quotes == nil {
			source.quotes = map[string]modelpricing.Quote{}
		}
		return source.quotes
	}
	quotes := make(map[string]modelpricing.Quote)
	for _, item := range settings.AccountModels {
		if item.CustomPricing == nil {
			continue
		}
		provider := strings.ToLower(strings.TrimSpace(item.Provider))
		model := strings.ToLower(strings.TrimSpace(item.ID))
		if provider == "" || model == "" {
			continue
		}
		quote := modelpricing.Quote{
			Provider:    provider,
			Model:       model,
			AccountRef:  item.AccountRef,
			Input:       item.CustomPricing.Input,
			Output:      item.CustomPricing.Output,
			CacheRead:   item.CustomPricing.CacheRead,
			CacheWrite:  item.CustomPricing.CacheWrite,
			Source:      sourceDescriptor(),
			Specificity: accountSpecificity(item.AccountRef != ""),
		}.Normalize()
		scoped := item.AccountRef != ""
		quotes[key(item.AccountRef, provider, model, scoped)] = quote
	}
	source.quotes = quotes
	source.at = time.Now()
	return quotes
}

func sourceDescriptor() modelpricing.Source {
	return modelpricing.Source{
		ID:        sourceID,
		Kind:      modelpricing.SourceManual,
		Authority: modelpricing.AuthorityFor(modelpricing.SourceManual),
	}
}

func accountSpecificity(scoped bool) *float64 {
	value := 2.0
	if scoped {
		value = 3
	}
	return &value
}

func key(accountRef, provider, model string, scoped bool) string {
	return accountRef + "\x00" + provider + "\x00" + model + "\x00" + map[bool]string{true: "1", false: "0"}[scoped]
}
