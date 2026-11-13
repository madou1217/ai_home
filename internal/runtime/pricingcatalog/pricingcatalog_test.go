package pricingcatalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type stubHTTPClient struct {
	do func(req *http.Request) (*http.Response, error)
}

func (s stubHTTPClient) Do(req *http.Request) (*http.Response, error) {
	return s.do(req)
}

func httpJSONResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func TestNormalizeQuoteValidationAndCoercion(t *testing.T) {
	t.Run("normalizes numeric strings authority cap and sorted tiers", func(t *testing.T) {
		raw := json.RawMessage(`{
			"provider": " anthropic ",
			"model": " claude-sonnet-4 ",
			"input": "3",
			"output": 15,
			"cacheRead": "0.3",
			"tiers": [
				{"when": {"contextTokensGt": "200000"}, "input": "6", "output": 22.5},
				{"when": {"contextTokensGt": 100000}, "input": 4.5}
			],
			"source": {
				"id": "litellm",
				"kind": "community",
				"authority": 99,
				"confidence": 0.9,
				"fetchedAt": "2026-05-01T00:00:00Z"
			}
		}`)
		quote, err := NormalizeQuote(raw)
		if err != nil {
			t.Fatalf("NormalizeQuote failed: %v", err)
		}
		if quote.Provider != "anthropic" || quote.Model != "claude-sonnet-4" {
			t.Fatalf("unexpected provider/model: %+v", quote)
		}
		if quote.Status != StatusPriced {
			t.Fatalf("expected priced status, got %q", quote.Status)
		}
		if quote.Source.Authority != SourceAuthorityByKind[KindCommunity] {
			t.Fatalf("expected community authority cap %v, got %v", SourceAuthorityByKind[KindCommunity], quote.Source.Authority)
		}
		if len(quote.Tiers) != 2 || quote.Tiers[0].When.ContextTokensGt != 100000 || quote.Tiers[1].When.ContextTokensGt != 200000 {
			t.Fatalf("expected ascending tiers, got %+v", quote.Tiers)
		}
		if quote.Input == nil || *quote.Input != 3 || quote.CacheRead == nil || *quote.CacheRead != 0.3 {
			t.Fatalf("unexpected normalized prices: %+v", quote)
		}
	})

	t.Run("accepts string source shorthand and zero free status", func(t *testing.T) {
		raw := json.RawMessage(`{
			"provider": "ollama",
			"model": "qwen3:8b",
			"input": 0,
			"output": 0,
			"source": "local-ollama"
		}`)
		quote, err := NormalizeQuote(raw)
		if err != nil {
			t.Fatalf("NormalizeQuote failed: %v", err)
		}
		if quote.Source.ID != "local-ollama" || quote.Source.Kind != KindUnknown {
			t.Fatalf("unexpected shorthand source: %+v", quote.Source)
		}
		if quote.Status != StatusFree {
			t.Fatalf("expected free status, got %q", quote.Status)
		}
	})

	t.Run("rejects negative prices bad currency unit and missing fields", func(t *testing.T) {
		cases := []string{
			`{"model": "gpt-4.1", "source": "s1"}`,
			`{"provider": "openai", "source": "s1"}`,
			`{"provider": "openai", "model": "gpt-4.1", "currency": "EUR", "source": "s1"}`,
			`{"provider": "openai", "model": "gpt-4.1", "unit": "per_1k_tokens", "source": "s1"}`,
			`{"provider": "openai", "model": "gpt-4.1", "input": -0.5, "source": "s1"}`,
			`{"provider": "openai", "model": "gpt-4.1", "input": "not-a-num", "source": "s1"}`,
			`{"provider": "openai", "model": "gpt-4.1", "source": {"authority": "bad"}}`,
			`{"provider": "openai", "model": "gpt-4.1", "tiers": [{"input": 1}], "source": "s1"}`,
		}
		for _, tc := range cases {
			if _, err := NormalizeQuote(json.RawMessage(tc)); err == nil {
				t.Fatalf("expected error for invalid quote %s", tc)
			}
		}
	})
}

func TestMergePriceQuotesDimensionPrecedenceAndWarnings(t *testing.T) {
	now := time.Date(2026, 5, 20, 12, 0, 0, 0, time.UTC)
	expiredAt := now.Add(-24 * time.Hour).Format(time.RFC3339)

	quotes := []json.RawMessage{
		json.RawMessage(fmt.Sprintf(`{
			"provider": "openai",
			"model": "gpt-4.1",
			"input": 2.5,
			"output": 9.5,
			"cacheRead": 0.5,
			"source": {"id": "litellm", "kind": "community", "authority": 20, "confidence": 0.8, "expiresAt": %q}
		}`, expiredAt)),
		json.RawMessage(`{
			"provider": "openai",
			"model": "gpt-4.1",
			"input": 2.0,
			"source": {"id": "openai-official", "kind": "official", "authority": 90, "confidence": 1.0, "fetchedAt": "2026-05-19T12:00:00Z"}
		}`),
		json.RawMessage(`{
			"provider": "openai",
			"model": "gpt-4.1",
			"input": -99,
			"source": {"id": "broken-plugin", "kind": "vendor"}
		}`),
		json.RawMessage(`{
			"provider": "openai",
			"model": "gpt-4.1",
			"output": 8.0,
			"source": {"id": "openrouter", "kind": "aggregator", "authority": 40, "confidence": 0.9, "fetchedAt": "2026-05-19T12:00:00Z"}
		}`),
	}

	merged := MergePriceQuotes(quotes, MergeOptions{
		Provider: "OpenAI",
		Model:    "gpt-4.1",
		Now:      now,
	})
	if merged.Status != StatusPriced {
		t.Fatalf("expected priced status, got %q", merged.Status)
	}
	if merged.Input == nil || *merged.Input != 2.0 {
		t.Fatalf("expected official input=2.0, got %v", merged.Input)
	}
	// aggregator (40) beats community (20) on output; community fills missing cacheRead.
	if merged.Output == nil || *merged.Output != 8.0 {
		t.Fatalf("expected aggregator output=8.0, got %v", merged.Output)
	}
	if merged.CacheRead == nil || *merged.CacheRead != 0.5 {
		t.Fatalf("expected fallback cacheRead=0.5, got %v", merged.CacheRead)
	}
	for _, expectedSrc := range []string{"openai-official", "openrouter", "litellm"} {
		found := false
		for _, gotSrc := range merged.Sources {
			if gotSrc == expectedSrc {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected source %q in merged.Sources %+v", expectedSrc, merged.Sources)
		}
	}
	if merged.Source == nil || merged.Source.ID != "openai-official" {
		t.Fatalf("expected primary source openai-official, got %+v", merged.Source)
	}
	hasStale := false
	for _, w := range merged.Warnings {
		if w.Code == "price_source_stale" && w.SourceID == "litellm" {
			hasStale = true
		}
	}
	if !hasStale {
		t.Fatalf("expected stale warning for litellm, got %+v", merged.Warnings)
	}

	// Empty / invalid quotes stay unknown, never silently 0.
	empty := MergePriceQuotes([]json.RawMessage{json.RawMessage(`{"provider":"openai","model":"gpt-4.1","input":-1,"source":"bad"}`)}, MergeOptions{
		Provider: "openai",
		Model:    "gpt-4.1",
		Now:      now,
	})
	if empty.Status != StatusUnknown || empty.Input != nil {
		t.Fatalf("expected unknown status without values, got %+v", empty)
	}
}

func TestStorePersistenceReviewWorkflowAndPricingRecords(t *testing.T) {
	baseDir := t.TempDir()
	now := time.Date(2026, 5, 10, 8, 0, 0, 0, time.UTC)
	store, err := NewStore(baseDir, WithStoreClock(func() time.Time { return now }))
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	// Invalid sourceId must fail closed.
	if _, err := store.ApproveSource("../escape"); !errors.Is(err, ErrSourceIDInvalid) {
		t.Fatalf("expected ErrSourceIDInvalid, got %v", err)
	}

	requireReview := true
	firstQuotes := []json.RawMessage{
		json.RawMessage(`{
			"provider": "anthropic",
			"model": "claude-sonnet-4",
			"input": 3,
			"output": 15,
			"tiers": [{"when": {"contextTokensGt": 200000}, "input": 6, "output": 22.5}],
			"source": {"id": "community:litellm", "kind": "community"}
		}`),
	}
	firstOutcome, err := store.ApplySnapshot(ApplySnapshotInput{
		SourceID:      "community:litellm",
		Source:        SourceMeta{ID: "community:litellm", Kind: KindCommunity, URL: "https://example.test/litellm.json"},
		RawQuotes:     firstQuotes,
		RequireReview: &requireReview,
	})
	if err != nil {
		t.Fatalf("first ApplySnapshot failed: %v", err)
	}
	if !firstOutcome.Applied || firstOutcome.ReviewRequired {
		t.Fatalf("expected initial snapshot to auto-apply without review, got %+v", firstOutcome)
	}

	sourcePath := filepath.Join(baseDir, "pricing", "sources", "community%3Alitellm.json")
	info, err := os.Stat(sourcePath)
	if err != nil {
		t.Fatalf("expected %s to exist: %v", sourcePath, err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 file permissions, got %o", info.Mode().Perm())
	}

	// Identical prices with later fetchedAt refresh metadata only without review.
	now = now.Add(time.Hour)
	sameOutcome, err := store.ApplySnapshot(ApplySnapshotInput{
		SourceID:      "community:litellm",
		Source:        SourceMeta{ID: "community:litellm", Kind: KindCommunity},
		RawQuotes:     firstQuotes,
		RequireReview: &requireReview,
	})
	if err != nil {
		t.Fatalf("same-price ApplySnapshot failed: %v", err)
	}
	if !sameOutcome.Applied || sameOutcome.ReviewRequired || len(sameOutcome.Changes) != 0 {
		t.Fatalf("expected metadata-only refresh without review, got %+v", sameOutcome)
	}

	// Price change under requireReview=true stages pending file and leaves active file untouched.
	changedQuotes := []json.RawMessage{
		json.RawMessage(`{
			"provider": "anthropic",
			"model": "claude-sonnet-4",
			"input": 4,
			"output": 15,
			"tiers": [{"when": {"contextTokensGt": 200000}, "input": 6, "output": 22.5}],
			"source": {"id": "community:litellm", "kind": "community"}
		}`),
	}
	pendingOutcome, err := store.ApplySnapshot(ApplySnapshotInput{
		SourceID:      "community:litellm",
		Source:        SourceMeta{ID: "community:litellm", Kind: KindCommunity},
		RawQuotes:     changedQuotes,
		RequireReview: &requireReview,
	})
	if err != nil {
		t.Fatalf("changed ApplySnapshot failed: %v", err)
	}
	if pendingOutcome.Applied || !pendingOutcome.ReviewRequired || len(pendingOutcome.Changes) != 1 || len(pendingOutcome.Reviews) != 1 {
		t.Fatalf("expected pending review outcome, got %+v", pendingOutcome)
	}

	recordsBeforeApprove, err := store.BuildPricingRecords()
	if err != nil {
		t.Fatalf("BuildPricingRecords failed: %v", err)
	}
	if len(recordsBeforeApprove) != 1 || math.Abs(*recordsBeforeApprove[0].InputCostPerToken-3e-6) > 1e-15 {
		t.Fatalf("expected active input cost 3e-6 while pending, got %+v", recordsBeforeApprove)
	}
	if len(recordsBeforeApprove[0].ContextCostTiers) != 1 || *recordsBeforeApprove[0].ContextCostTiers[0].Size != 200000 {
		t.Fatalf("expected tier preserved in RawRecord, got %+v", recordsBeforeApprove[0].ContextCostTiers)
	}

	// Approve promotes pending snapshot and marks review approved.
	approveRes, err := store.ApproveSource("community:litellm")
	if err != nil {
		t.Fatalf("ApproveSource failed: %v", err)
	}
	if approveRes.Quotes != 1 {
		t.Fatalf("expected 1 approved quote, got %+v", approveRes)
	}
	if _, err := store.ApproveSource("community:litellm"); !errors.Is(err, ErrReviewPendingMissing) {
		t.Fatalf("expected ErrReviewPendingMissing after promotion, got %v", err)
	}
	recordsAfterApprove, err := store.BuildPricingRecords()
	if err != nil {
		t.Fatalf("BuildPricingRecords after approve failed: %v", err)
	}
	if len(recordsAfterApprove) != 1 || math.Abs(*recordsAfterApprove[0].InputCostPerToken-4e-6) > 1e-15 {
		t.Fatalf("expected approved input cost 4e-6, got %+v", recordsAfterApprove)
	}
	if len(store.ListReviews("pending")) != 0 || len(store.ListReviews("approved")) != 1 {
		t.Fatalf("unexpected review queue states after approve: %+v", store.ListReviews(""))
	}

	// Another change rejected keeps active snapshot at 4e-6.
	evenNewerQuotes := []json.RawMessage{
		json.RawMessage(`{"provider": "anthropic", "model": "claude-sonnet-4", "input": 9, "output": 15, "tiers": [{"when": {"contextTokensGt": 200000}, "input": 6, "output": 22.5}], "source": {"id": "community:litellm", "kind": "community"}}`),
	}
	if _, err := store.ApplySnapshot(ApplySnapshotInput{
		SourceID:      "community:litellm",
		Source:        SourceMeta{ID: "community:litellm", Kind: KindCommunity},
		RawQuotes:     evenNewerQuotes,
		RequireReview: &requireReview,
	}); err != nil {
		t.Fatalf("ApplySnapshot before reject failed: %v", err)
	}
	rejectRes, err := store.RejectSource("community:litellm")
	if err != nil || !rejectRes.Rejected {
		t.Fatalf("RejectSource failed: res=%+v err=%v", rejectRes, err)
	}
	if len(store.ListReviews("rejected")) != 1 {
		t.Fatalf("expected rejected review item, got %+v", store.ListReviews(""))
	}
	recordsAfterReject, err := store.BuildPricingRecords()
	if err != nil {
		t.Fatalf("BuildPricingRecords after reject failed: %v", err)
	}
	if len(recordsAfterReject) != 1 || math.Abs(*recordsAfterReject[0].InputCostPerToken-4e-6) > 1e-15 {
		t.Fatalf("expected active input cost to stay 4e-6 after reject, got %+v", recordsAfterReject)
	}
}

func TestStoreConcurrentAccessRaceSafety(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		idx := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			requireReview := false
			_, applyErr := store.ApplySnapshot(ApplySnapshotInput{
				SourceID: fmt.Sprintf("plugin:worker:%d", idx%2),
				Source:   SourceMeta{ID: fmt.Sprintf("plugin:worker:%d", idx%2), Kind: KindVendor},
				RawQuotes: []json.RawMessage{
					json.RawMessage(fmt.Sprintf(`{"provider":"openai","model":"gpt-4.%d","input":%d,"source":{"id":"w","kind":"vendor"}}`, idx%3, idx+1)),
				},
				RequireReview: &requireReview,
			})
			if applyErr != nil {
				t.Errorf("concurrent ApplySnapshot failed: %v", applyErr)
			}
			_, _ = store.ListSources()
			_ = store.ListReviews("")
			_, _ = store.BuildPricingRecords()
		}()
	}
	wg.Wait()
}

func TestCommunityParsersAndServiceWorkflow(t *testing.T) {
	litellmPayload := []byte(`{
		"sample_spec": {"input_cost_per_token": 0.1},
		"anthropic/claude-sonnet-4": {
			"litellm_provider": "anthropic",
			"input_cost_per_token": 0.000003,
			"output_cost_per_token": "0.000015",
			"cache_read_input_token_cost": 0.0000003
		}
	}`)
	openRouterPayload := []byte(`{
		"data": [
			{"id": "openai/gpt-4.1", "pricing": {"prompt": "0.000002", "completion": "0.000008", "input_cache_read": "0.0000005"}},
			{"id": "openrouter/auto", "pricing": {"prompt": "-1", "completion": "-1"}}
		]
	}`)

	litellmSrc := DefaultCommunitySources()[0]
	liteQuotes, err := ParseLiteLLM(litellmPayload, litellmSrc)
	if err != nil || len(liteQuotes) != 1 {
		t.Fatalf("ParseLiteLLM failed: len=%d err=%v", len(liteQuotes), err)
	}
	if *liteQuotes[0].Input != 3 || *liteQuotes[0].Output != 15 {
		t.Fatalf("unexpected litellm prices: %+v", liteQuotes[0])
	}

	orSrc := DefaultCommunitySources()[1]
	orQuotes, err := ParseOpenRouter(openRouterPayload, orSrc)
	if err != nil || len(orQuotes) != 1 {
		t.Fatalf("ParseOpenRouter failed: len=%d err=%v", len(orQuotes), err)
	}
	if orQuotes[0].Provider != "openai" || orQuotes[0].Model != "gpt-4.1" || *orQuotes[0].Input != 2 {
		t.Fatalf("unexpected openrouter quote: %+v", orQuotes[0])
	}

	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	now := time.Date(2026, 5, 11, 10, 0, 0, 0, time.UTC)
	svc, err := NewService(ServiceDependencies{
		Store: store,
		Now:   func() time.Time { return now },
		HTTPClient: stubHTTPClient{
			do: func(req *http.Request) (*http.Response, error) {
				switch {
				case strings.Contains(req.URL.String(), "litellm"):
					return httpJSONResponse(http.StatusOK, string(litellmPayload)), nil
				case strings.Contains(req.URL.String(), "openrouter"):
					return httpJSONResponse(http.StatusOK, string(openRouterPayload)), nil
				default:
					return httpJSONResponse(http.StatusNotFound, `{}`), nil
				}
			},
		},
	})
	if err != nil {
		t.Fatalf("NewService failed: %v", err)
	}

	if _, err := svc.RefreshSource(t.Context(), "unknown-src"); !errors.Is(err, ErrCommunitySourceUnknown) {
		t.Fatalf("expected ErrCommunitySourceUnknown, got %v", err)
	}

	report, err := svc.RefreshAll(t.Context(), []PluginSnapshotInput{
		{
			ContributionID: "plugin.failed",
			Error:          "worker_timeout",
			Detail:         "5000ms",
		},
	})
	if err != nil {
		t.Fatalf("RefreshAll failed: %v", err)
	}
	if report.OK || len(report.Community) != 2 || len(report.Sources) != 2 {
		t.Fatalf("unexpected RefreshAll report: %+v", report)
	}

	status, err := svc.Status(true)
	if err != nil {
		t.Fatalf("Status(true) failed: %v", err)
	}
	if status.Sources != 2 || status.Records != 2 || status.Doctor == nil || status.Doctor.LastRun == nil {
		t.Fatalf("unexpected Status(true): %+v", status)
	}

	// Verify MergeQuotes single-object hostOverride + JSON payload.
	var mergeReq MergeQuotesRequest
	err = json.Unmarshal([]byte(`{
		"provider": "openai",
		"model": "gpt-4.1",
		"quotes": [
			{"provider": "openai", "model": "gpt-4.1", "input": 2, "source": {"id": "or", "kind": "aggregator"}}
		],
		"hostOverride": {
			"provider": "openai",
			"model": "gpt-4.1",
			"input": 1.5,
			"source": {"id": "host-override", "kind": "manual"}
		}
	}`), &mergeReq)
	if err != nil {
		t.Fatalf("unmarshal MergeQuotesRequest with single hostOverride failed: %v", err)
	}
	mergeRes, err := svc.MergeQuotes(mergeReq)
	if err != nil {
		t.Fatalf("MergeQuotes failed: %v", err)
	}
	if mergeRes.Quote.Input == nil || *mergeRes.Quote.Input != 1.5 || mergeRes.Contributions != 1 {
		t.Fatalf("unexpected MergeQuotes result: %+v", mergeRes)
	}
}
