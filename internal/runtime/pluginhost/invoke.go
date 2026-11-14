package pluginhost

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/pluginerr"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
)

const (
	// PricingQuoteCapability 是插件单次按需报价的能力名。
	PricingQuoteCapability    = "pricing.quote"
	defaultQuoteInvokeTimeout = 10 * time.Second
)

// InvokeContributionResult 表示直接调用单个插件贡献项的结果与二进制载荷长度。
type InvokeContributionResult struct {
	Value        json.RawMessage `json:"value,omitempty"`
	PayloadBytes int             `json:"payloadBytes"`
}

// PricingQuoteRequest 是插件联动报价的输入参数。
type PricingQuoteRequest struct {
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	AccountRef string `json:"accountRef,omitempty"`
	TimeoutMs  int    `json:"timeoutMs,omitempty"`
}

// InvokeContribution 在当前激活代次上直接调用指定 contributionId，并返回原始 JSON 值与 payload 字节数。
func (s *Service) InvokeContribution(
	ctx context.Context,
	contributionID string,
	value any,
	timeout time.Duration,
) (InvokeContributionResult, error) {
	id := strings.TrimSpace(contributionID)
	if id == "" {
		return InvokeContributionResult{}, pluginerr.New("plugin_contribution_required", "contributionId 不能为空")
	}
	if s == nil || s.runtime == nil {
		return InvokeContributionResult{}, pluginerr.New(CodeRuntimeUnavailable, "插件运行时不可用")
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return InvokeContributionResult{}, pluginerr.New("plugin_runtime_inactive", "当前没有已发布的插件代次")
	}
	defer lease.Release()

	raw, payload, err := s.runtime.InvokeWithPayload(ctx, lease.Generation, id, value, timeout)
	if err != nil {
		return InvokeContributionResult{}, err
	}
	return InvokeContributionResult{
		Value:        raw,
		PayloadBytes: len(payload),
	}, nil
}

// QuotePricing 向激活代次中的所有 pricing.quote 插件采集单源报价并交由 PricingService 裁决合并。
func (s *Service) QuotePricing(ctx context.Context, req PricingQuoteRequest) (pricingcatalog.MergeQuotesResult, error) {
	provider := strings.ToLower(strings.TrimSpace(req.Provider))
	model := strings.TrimSpace(req.Model)
	accountRef := strings.TrimSpace(req.AccountRef)
	if provider == "" || model == "" {
		return pricingcatalog.MergeQuotesResult{}, pluginerr.New("invalid_payload", "provider 和 model 必填")
	}
	if s == nil || s.runtime == nil {
		return pricingcatalog.MergeQuotesResult{}, pluginerr.New(CodeRuntimeUnavailable, "插件运行时不可用")
	}
	if s.pricingService == nil {
		return pricingcatalog.MergeQuotesResult{}, pluginerr.New("pricing_service_unavailable", "价格目录服务未装配")
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return pricingcatalog.MergeQuotesResult{}, pluginerr.New("plugin_runtime_inactive", "当前没有已发布的插件代次")
	}
	defer lease.Release()

	effectiveTimeout := defaultQuoteInvokeTimeout
	if req.TimeoutMs > 0 {
		effectiveTimeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}
	nowISO := time.Now().UTC().Format(auditTimeLayout)
	chain := lease.Snapshot.Projection.ByCapability(PricingQuoteCapability)
	quotes := make([]json.RawMessage, 0, len(chain))
	for _, item := range chain {
		raw, err := s.runtime.Invoke(ctx, lease.Generation, item.ID, map[string]any{
			"schemaVersion": 1,
			"kind":          "quote",
			"provider":      provider,
			"model":         model,
			"accountRef":    accountRef,
			"at":            nowISO,
		}, effectiveTimeout)
		if err != nil {
			warnQuote, _ := json.Marshal(map[string]any{
				"provider": provider,
				"model":    model,
				"source": map[string]any{
					"id":   item.ID,
					"kind": "unknown",
				},
				"warnings": []map[string]any{
					{"code": firstNonEmpty(errorCode(err), "pricing_quote_failed")},
				},
			})
			quotes = append(quotes, warnQuote)
			continue
		}
		quotes = append(quotes, extractPricingQuotes(raw)...)
	}

	return s.pricingService.MergeQuotes(pricingcatalog.MergeQuotesRequest{
		Provider:   provider,
		Model:      model,
		AccountRef: accountRef,
		Quotes:     quotes,
	})
}

func extractPricingQuotes(raw json.RawMessage) []json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var items []json.RawMessage
		if err := json.Unmarshal([]byte(trimmed), &items); err == nil {
			return items
		}
		return nil
	}
	var obj struct {
		Quotes []json.RawMessage `json:"quotes"`
	}
	if err := json.Unmarshal([]byte(trimmed), &obj); err == nil && len(obj.Quotes) > 0 {
		return obj.Quotes
	}
	return nil
}
