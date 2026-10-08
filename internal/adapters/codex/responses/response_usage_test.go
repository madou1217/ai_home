package responses

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

func TestCompletedUsagePreservesCacheWriteTokens(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name    string
		details string
		want    uint64
		invalid bool
	}{
		{name: "cache write", details: `{"cached_tokens":3,"cache_write_tokens":2}`, want: 2},
		{name: "legacy without cache write", details: `{"cached_tokens":3}`},
		{name: "invalid cache subsets", details: `{"cached_tokens":3,"cache_write_tokens":9}`, invalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var events []inference.StreamEvent
			decoder, err := newResponseDecoder("gpt-5.6-sol", func(event inference.StreamEvent) error {
				events = append(events, event)
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			payload := `{"type":"response.completed","response":{"id":"resp_usage","model":"gpt-5.6-sol","status":"completed","output":[],"usage":{"input_tokens":11,"input_tokens_details":` + test.details + `,"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":18}}}`
			var wire streamEventDTO
			if err := json.Unmarshal([]byte(payload), &wire); err != nil {
				t.Fatal(err)
			}
			err = decoder.Apply(wire)
			if test.invalid {
				if !errors.Is(err, ErrInvalidUpstreamResponse) || decoder.Terminal() {
					t.Fatalf("invalid subsets accepted: error=%v terminal=%v", err, decoder.Terminal())
				}
				return
			}
			if err != nil || !decoder.Terminal() || len(events) == 0 {
				t.Fatalf("error=%v terminal=%v events=%d", err, decoder.Terminal(), len(events))
			}
			completed, ok := events[len(events)-1].(inference.ResponseCompletedEvent)
			if !ok {
				t.Fatalf("last event=%v", events[len(events)-1].Kind())
			}
			usage := completed.Usage()
			if usage.InputTokens() != 11 || usage.CachedInputTokens() != 3 || usage.CacheWriteInputTokens() != test.want || usage.OutputTokens() != 7 || usage.ReasoningTokens() != 2 || usage.TotalTokens() != 18 {
				t.Fatalf("terminal usage=%+v", usage)
			}
		})
	}
}
