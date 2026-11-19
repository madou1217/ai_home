// Package custom 提供可由用户维护的价格目录来源。
//
// 价格定义放在 aih.db 的 app_kv（config:model-pricing），通过 RawConfigLoader
// 读取，不引入第二个数据库。该来源的 authority 按 kind 计算，可以覆盖
// models.dev 的 aggregator 目录；配置可同时关闭内置 aggregator。
package custom

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/contracts/modelpricing"
)

// ConfigKey 是价格插件配置在 app_kv 中的键。
const ConfigKey = "config:model-pricing"

var errInvalidConfig = errors.New("modelpricing custom: invalid config")

// RawConfigLoader 只读取 app_kv 原始值，由账号存储实现，避免适配器反向依赖。
type RawConfigLoader interface {
	LoadRawConfig(ctx context.Context, key string) ([]byte, error)
}

// Document 是 config:model-pricing 的 JSON 形状。
type Document struct {
	Enabled          bool                    `json:"enabled"`
	SourceID         string                  `json:"sourceId"`
	Kind             modelpricing.SourceKind `json:"kind"`
	URL              string                  `json:"url,omitempty"`
	License          string                  `json:"license,omitempty"`
	Confidence       float64                 `json:"confidence,omitempty"`
	DisableModelsDev bool                    `json:"disableModelsDev"`
	Quotes           []modelpricing.Quote    `json:"quotes"`
}

// Source 实现 pricing.catalog / pricing.quote，不提供元数据。
type Source struct {
	loader RawConfigLoader

	mu     sync.Mutex
	doc    Document
	loaded bool
	at     time.Time
}

// New 创建自定义价格来源；loader 为 nil 时来源不可用。
func New(loader RawConfigLoader) *Source {
	return &Source{loader: loader}
}

// Config 返回带短 TTL 的配置；未配置或配置无效时返回 ok=false。
func (source *Source) Config(ctx context.Context) (Document, bool) {
	if source == nil || source.loader == nil {
		return Document{}, false
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.loaded && time.Since(source.at) < 30*time.Second {
		return source.doc, source.doc.Enabled && len(source.doc.Quotes) > 0
	}
	raw, err := source.loader.LoadRawConfig(ctx, ConfigKey)
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
		source.doc, source.loaded, source.at = Document{}, true, time.Now()
		return source.doc, false
	}
	var document Document
	if err := json.Unmarshal(raw, &document); err != nil {
		source.doc, source.loaded, source.at = Document{}, true, time.Now()
		return source.doc, false
	}
	if document.Kind == "" {
		document.Kind = modelpricing.SourceOfficial
	}
	if document.SourceID == "" {
		document.SourceID = "custom:pricebook"
	}
	if document.Confidence <= 0 {
		document.Confidence = 0.9
	}
	quotes := make([]modelpricing.Quote, 0, len(document.Quotes))
	for _, quote := range document.Quotes {
		if quote.Source.ID == "" {
			quote.Source.ID = document.SourceID
		}
		if quote.Source.Kind == "" {
			quote.Source.Kind = document.Kind
		}
		if err := quote.Validate(); err != nil {
			continue
		}
		quotes = append(quotes, quote.Normalize())
	}
	document.Quotes = quotes
	source.doc, source.loaded, source.at = document, true, time.Now()
	return source.doc, source.doc.Enabled && len(source.doc.Quotes) > 0
}

// Catalog 实现 pricing.catalog。
func (source *Source) Catalog() modelpricing.CatalogSource { return catalogPort{source: source} }

// Quote 实现 pricing.quote。
func (source *Source) Quote() modelpricing.QuoteSource { return quotePort{source: source} }

type catalogPort struct{ source *Source }
type quotePort struct{ source *Source }

func (catalogPort) Capability() string { return modelpricing.CapabilityPricingCatalog }
func (quotePort) Capability() string   { return modelpricing.CapabilityPricingQuote }

func (port catalogPort) Load(ctx context.Context, request modelpricing.CatalogRequest) (modelpricing.Catalog, error) {
	document, ok := port.source.Config(ctx)
	if !ok {
		return modelpricing.Catalog{Quotes: []modelpricing.Quote{}}, nil
	}
	return modelpricing.Catalog{
		Source: port.source.descriptor(document),
		Quotes: document.Quotes,
	}, nil
}

func (port quotePort) Quote(ctx context.Context, request modelpricing.QuoteRequest) (modelpricing.Quote, error) {
	document, ok := port.source.Config(ctx)
	if !ok {
		return modelpricing.Quote{}, nil
	}
	var best modelpricing.Quote
	found := false
	for _, quote := range document.Quotes {
		if !strings.EqualFold(strings.TrimSpace(quote.Provider), strings.TrimSpace(request.Provider)) ||
			!strings.EqualFold(strings.TrimSpace(quote.Model), strings.TrimSpace(request.Model)) {
			continue
		}
		if quote.AccountRef != "" && !strings.EqualFold(quote.AccountRef, strings.TrimSpace(request.AccountRef)) {
			continue
		}
		if !found || quote.Specificity == nil && best.Specificity != nil ||
			quote.Specificity != nil && (best.Specificity == nil || *quote.Specificity > *best.Specificity) {
			best = quote
			found = true
		}
	}
	if !found {
		return modelpricing.Quote{}, nil
	}
	return best, nil
}

func (source *Source) descriptor(document Document) modelpricing.Source {
	return modelpricing.Source{
		ID:         document.SourceID,
		Kind:       document.Kind,
		Authority:  modelpricing.AuthorityFor(document.Kind),
		Confidence: document.Confidence,
		URL:        document.URL,
		License:    document.License,
	}
}

// ParseDocument 仅用于配置校验与非运行时工具。
func ParseDocument(raw []byte) (Document, error) {
	var document Document
	if err := json.Unmarshal(raw, &document); err != nil {
		return Document{}, err
	}
	if !document.Enabled {
		return Document{}, errInvalidConfig
	}
	return document, nil
}
