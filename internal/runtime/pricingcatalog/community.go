package pricingcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	defaultCommunityFetchTimeout = 20 * time.Second
	maxCommunityPayloadBytes     = 64 << 20 // 64 MiB
)

var (
	// ErrCommunitySourceUnknown 表示请求的社区价格源不在固定白名单内。
	ErrCommunitySourceUnknown = errors.New("community_pricing_source_unknown")
	// ErrCommunityParserUnknown 表示社区价格源声明了解析器外的类型。
	ErrCommunityParserUnknown = errors.New("community_pricing_parser_unknown")
	// ErrCommunityFetchFailed 表示上游社区价格源下载或解析失败。
	ErrCommunityFetchFailed = errors.New("community_pricing_fetch_failed")
)

// HTTPClient 抽象社区价格下载客户端，便于测试注入桩。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// CommunitySource 描述一条内置社区价格源（固定 URL + 固定解析器）。
type CommunitySource struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	URL     string `json:"url"`
	License string `json:"license"`
	Parser  string `json:"parser"`
}

// DefaultCommunitySources 返回内置支持的 LiteLLM 与 OpenRouter 社区价格源列表。
func DefaultCommunitySources() []CommunitySource {
	return []CommunitySource{
		{
			ID:      "community:litellm",
			Name:    "LiteLLM",
			Kind:    KindCommunity,
			URL:     "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
			License: "MIT",
			Parser:  "litellm",
		},
		{
			ID:      "community:openrouter",
			Name:    "OpenRouter",
			Kind:    KindCommunity,
			URL:     "https://openrouter.ai/api/v1/models",
			License: "OpenRouter terms",
			Parser:  "openrouter",
		},
	}
}

// CommunitySourceRefreshResult 表示单次社区源刷新结果。
type CommunitySourceRefreshResult struct {
	SourceID       string        `json:"sourceId"`
	OK             *bool         `json:"ok,omitempty"`
	Error          string        `json:"error,omitempty"`
	Applied        bool          `json:"applied"`
	ReviewRequired bool          `json:"reviewRequired"`
	Changes        []QuoteChange `json:"changes"`
	Reviews        []ReviewItem  `json:"reviews"`
	FetchedAt      string        `json:"fetchedAt,omitempty"`
	QuoteCount     int           `json:"quoteCount"`
}

func parseCommunityPerMillion(raw json.RawMessage) *float64 {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var number float64
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return nil
		}
		text = strings.TrimSpace(text)
		if text == "" {
			return nil
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return nil
		}
		number = parsed
	} else {
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return nil
		}
		number = parsed
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return nil
	}
	val := roundPrice(number * 1_000_000)
	return &val
}

func splitProviderAndModel(rawModel string, declaredProvider string) (string, string, bool) {
	raw := strings.TrimSpace(rawModel)
	if raw == "" {
		return "", "", false
	}
	slash := strings.IndexByte(raw, '/')
	provider := strings.ToLower(strings.TrimSpace(declaredProvider))
	if provider == "" {
		if slash > 0 {
			provider = strings.ToLower(raw[:slash])
		} else {
			provider = KindCommunity
		}
	}
	model := raw
	if slash > 0 {
		model = raw[slash+1:]
	}
	model = strings.TrimSpace(model)
	if provider == "" || model == "" {
		return "", "", false
	}
	return provider, model, true
}

func buildCommunityQuote(
	provider string,
	model string,
	input *float64,
	output *float64,
	cacheRead *float64,
	cacheWrite *float64,
	reasoning *float64,
	source CommunitySource,
	confidence float64,
) (PriceQuote, bool) {
	if input == nil && output == nil && cacheRead == nil && cacheWrite == nil {
		return PriceQuote{}, false
	}
	quote := PriceQuote{
		SchemaVersion: PriceQuoteSchemaVersion,
		Provider:      provider,
		Model:         model,
		Currency:      PriceQuoteCurrency,
		Unit:          PriceQuoteUnit,
		Input:         input,
		Output:        output,
		CacheRead:     cacheRead,
		CacheWrite:    cacheWrite,
		CacheWrite1h:  nil,
		Reasoning:     reasoning,
		Source: QuoteSource{
			ID:         source.ID,
			Kind:       KindCommunity,
			Authority:  SourceAuthorityByKind[KindCommunity],
			Confidence: confidence,
			URL:        source.URL,
			License:    source.License,
		},
		Specificity: 2,
	}
	quote.Status = deriveQuoteStatus(quote)
	return quote, true
}

type liteLLMModelEntry struct {
	LiteLLMProvider             string          `json:"litellm_provider"`
	InputCostPerToken           json.RawMessage `json:"input_cost_per_token"`
	OutputCostPerToken          json.RawMessage `json:"output_cost_per_token"`
	CacheReadInputTokenCost     json.RawMessage `json:"cache_read_input_token_cost"`
	CacheCreationInputTokenCost json.RawMessage `json:"cache_creation_input_token_cost"`
	ReasoningOutputTokenCost    json.RawMessage `json:"reasoning_output_token_cost"`
}

// ParseLiteLLM 解析 LiteLLM model_prices_and_context_window.json 载荷。
func ParseLiteLLM(payload []byte, source CommunitySource) ([]PriceQuote, error) {
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(payload, &entries); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCommunityFetchFailed, err)
	}
	if source.ID == "" {
		source.ID = "community:litellm"
	}
	keys := make([]string, 0, len(entries))
	for k := range entries {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	quotes := make([]PriceQuote, 0, len(keys))
	for _, rawModel := range keys {
		if rawModel == "sample_spec" {
			continue
		}
		rawEntry := entries[rawModel]
		var entry liteLLMModelEntry
		if err := json.Unmarshal(rawEntry, &entry); err != nil {
			continue
		}
		provider, model, ok := splitProviderAndModel(rawModel, entry.LiteLLMProvider)
		if !ok {
			continue
		}
		quote, keep := buildCommunityQuote(
			provider,
			model,
			parseCommunityPerMillion(entry.InputCostPerToken),
			parseCommunityPerMillion(entry.OutputCostPerToken),
			parseCommunityPerMillion(entry.CacheReadInputTokenCost),
			parseCommunityPerMillion(entry.CacheCreationInputTokenCost),
			parseCommunityPerMillion(entry.ReasoningOutputTokenCost),
			source,
			0.45,
		)
		if keep {
			quotes = append(quotes, quote)
		}
	}
	return quotes, nil
}

type openRouterPricing struct {
	Prompt            json.RawMessage `json:"prompt"`
	Completion        json.RawMessage `json:"completion"`
	InputCacheRead    json.RawMessage `json:"input_cache_read"`
	InputCacheWrite   json.RawMessage `json:"input_cache_write"`
	InternalReasoning json.RawMessage `json:"internal_reasoning"`
}

type openRouterModel struct {
	ID      string             `json:"id"`
	Pricing *openRouterPricing `json:"pricing"`
}

type openRouterPayload struct {
	Data []openRouterModel `json:"data"`
}

// ParseOpenRouter 解析 OpenRouter /api/v1/models 载荷。
func ParseOpenRouter(payload []byte, source CommunitySource) ([]PriceQuote, error) {
	var decoded openRouterPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCommunityFetchFailed, err)
	}
	if source.ID == "" {
		source.ID = "community:openrouter"
	}
	quotes := make([]PriceQuote, 0, len(decoded.Data))
	for _, entry := range decoded.Data {
		if entry.Pricing == nil {
			continue
		}
		provider, model, ok := splitProviderAndModel(entry.ID, "")
		if !ok {
			continue
		}
		quote, keep := buildCommunityQuote(
			provider,
			model,
			parseCommunityPerMillion(entry.Pricing.Prompt),
			parseCommunityPerMillion(entry.Pricing.Completion),
			parseCommunityPerMillion(entry.Pricing.InputCacheRead),
			parseCommunityPerMillion(entry.Pricing.InputCacheWrite),
			parseCommunityPerMillion(entry.Pricing.InternalReasoning),
			source,
			0.4,
		)
		if keep {
			quotes = append(quotes, quote)
		}
	}
	return quotes, nil
}

// ParseCommunityPayload 根据社区源声明的解析器解析响应字节。
func ParseCommunityPayload(source CommunitySource, payload []byte) ([]PriceQuote, error) {
	switch source.Parser {
	case "litellm":
		return ParseLiteLLM(payload, source)
	case "openrouter":
		return ParseOpenRouter(payload, source)
	default:
		return nil, ErrCommunityParserUnknown
	}
}

// FetchCommunitySource 拉取并解析单条社区价格源。
func FetchCommunitySource(
	ctx context.Context,
	client HTTPClient,
	source CommunitySource,
	now time.Time,
) ([]PriceQuote, string, error) {
	if client == nil {
		client = &http.Client{Timeout: defaultCommunityFetchTimeout}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, defaultCommunityFetchTimeout)
		defer cancel()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source.URL, nil)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrCommunityFetchFailed, err)
	}
	request.Header.Set("User-Agent", "aih-pricing/1.0")
	request.Header.Set("Accept", "application/json")

	response, err := client.Do(request)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrCommunityFetchFailed, err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, "", fmt.Errorf("%w: http_%d", ErrCommunityFetchFailed, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxCommunityPayloadBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrCommunityFetchFailed, err)
	}
	if int64(len(body)) > maxCommunityPayloadBytes {
		return nil, "", fmt.Errorf("%w: payload_too_large", ErrCommunityFetchFailed)
	}
	quotes, err := ParseCommunityPayload(source, body)
	if err != nil {
		return nil, "", err
	}
	if now.IsZero() {
		now = time.Now()
	}
	return quotes, formatISOString(now), nil
}
