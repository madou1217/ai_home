// Package pricingresolver 按 authority / specificity / 新鲜度合并价格插件来源。
//
// 插件只提供报价；账号覆盖、人工覆盖、来源排序与失败回退都由本包完成。
// models.dev 只是默认注册的 aggregator 来源，后续自定义插件可替换或叠加。
package pricingresolver

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/contracts/modelpricing"
	modelsdevpricing "github.com/madou1217/ai_home/internal/adapters/modelpricing/modelsdev"
)

var (
	defaultOnce     sync.Once
	defaultResolver *Resolver
	defaultErr      error
)

// Default 返回进程共享的 Resolver：models.dev 内置来源只加载一次。
func Default() (*Resolver, error) {
	defaultOnce.Do(func() {
		adapter, err := modelsdevpricing.New()
		if err != nil {
			defaultErr = err
			return
		}
		defaultResolver = New(
			[]modelpricing.QuoteSource{adapter.QuoteSource()},
			[]modelpricing.MetadataSource{adapter.MetadataSource()},
		)
	})
	return defaultResolver, defaultErr
}

// Resolver 是 modelpricing.Resolver 的默认实现。
type Resolver struct {
	quoteSources    []modelpricing.QuoteSource
	metadataSources []modelpricing.MetadataSource
	now             func() time.Time
}

// New 用价格与元数据来源构造 Resolver；来源顺序不影响裁决。
func New(quotes []modelpricing.QuoteSource, metadata []modelpricing.MetadataSource) *Resolver {
	return &Resolver{
		quoteSources:    append([]modelpricing.QuoteSource(nil), quotes...),
		metadataSources: append([]modelpricing.MetadataSource(nil), metadata...),
		now:             time.Now,
	}
}

// ResolveQuote 返回裁决后的最佳报价；全部来源未知时返回显式 unknown。
func (resolver *Resolver) ResolveQuote(ctx context.Context, request modelpricing.QuoteRequest) (modelpricing.Quote, error) {
	if resolver == nil {
		return unknownQuote(request), nil
	}
	var best modelpricing.Quote
	found := false
	var firstErr error
	for _, source := range resolver.quoteSources {
		if source == nil {
			continue
		}
		quote, err := source.Quote(ctx, request)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		quote = quote.Normalize()
		if !found || betterQuote(quote, best) {
			best = quote
			found = true
		}
	}
	if found {
		return best, nil
	}
	if firstErr != nil {
		return modelpricing.Quote{}, firstErr
	}
	return unknownQuote(request), nil
}

// ResolveMetadata 返回裁决后的最佳元数据；全部来源未知时返回显式 unknown。
func (resolver *Resolver) ResolveMetadata(ctx context.Context, request modelpricing.MetadataRequest) (modelpricing.Metadata, error) {
	if resolver == nil {
		return unknownMetadata(request), nil
	}
	var best modelpricing.Metadata
	found := false
	var firstErr error
	for _, source := range resolver.metadataSources {
		if source == nil {
			continue
		}
		metadata, err := source.Resolve(ctx, request)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if !found || betterMetadata(metadata, best) {
			best = metadata
			found = true
		}
	}
	if found {
		return best, nil
	}
	if firstErr != nil {
		return modelpricing.Metadata{}, firstErr
	}
	return unknownMetadata(request), nil
}

func betterQuote(left, right modelpricing.Quote) bool {
	leftKnown := left.Status != modelpricing.StatusUnknown
	rightKnown := right.Status != modelpricing.StatusUnknown
	if leftKnown != rightKnown {
		return leftKnown
	}
	if left.Source.Authority != right.Source.Authority {
		return left.Source.Authority > right.Source.Authority
	}
	leftSpecificity := specificity(left.Specificity)
	rightSpecificity := specificity(right.Specificity)
	if leftSpecificity != rightSpecificity {
		return leftSpecificity > rightSpecificity
	}
	if effectiveAt(left.EffectiveAt) != effectiveAt(right.EffectiveAt) {
		return effectiveAt(left.EffectiveAt) > effectiveAt(right.EffectiveAt)
	}
	return left.Source.ID < right.Source.ID
}

func betterMetadata(left, right modelpricing.Metadata) bool {
	leftKnown := left.MetadataStatus == modelpricing.MetadataResolved
	rightKnown := right.MetadataStatus == modelpricing.MetadataResolved
	if leftKnown != rightKnown {
		return leftKnown
	}
	if left.Source.Authority != right.Source.Authority {
		return left.Source.Authority > right.Source.Authority
	}
	return fetchedAt(left.Source.FetchedAt) > fetchedAt(right.Source.FetchedAt)
}

func specificity(value *float64) float64 {
	if value == nil {
		return 2
	}
	return *value
}

func effectiveAt(value *time.Time) int64 {
	if value == nil {
		return 0
	}
	return value.UnixMilli()
}

func fetchedAt(value *time.Time) int64 {
	if value == nil {
		return 0
	}
	return value.UnixMilli()
}

func unknownQuote(request modelpricing.QuoteRequest) modelpricing.Quote {
	provider := strings.TrimSpace(request.Provider)
	model := strings.TrimSpace(request.Model)
	return modelpricing.Quote{
		Provider: provider,
		Model:    model,
		Source: modelpricing.Source{
			ID:   "pricing-resolver",
			Kind: modelpricing.SourceUnknown,
		},
	}.Normalize()
}

func unknownMetadata(request modelpricing.MetadataRequest) modelpricing.Metadata {
	return modelpricing.Metadata{
		ID:                    strings.TrimSpace(request.Model),
		MetadataSchemaVersion: modelpricing.WireSchemaVersion,
		MetadataStatus:        modelpricing.MetadataUnknown,
		Source: modelpricing.Source{
			ID:   "pricing-resolver",
			Kind: modelpricing.SourceUnknown,
		},
	}
}
