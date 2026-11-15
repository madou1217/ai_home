// Package codexrollout projects existing Codex history without modifying it.
package codexrollout

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	defaultTurnLimit    = 20
	defaultInitialBytes = 2 << 20
	defaultMaxBytes     = 8 << 20
	hardMaxBytes        = 32 << 20
	maxTrackedTurns     = 32768
)

var ErrReadBudget = errors.New("codex_rollout_read_budget_exceeded")

type Options struct {
	ThreadID              string   `json:"threadId"`
	Cwd                   string   `json:"cwd"`
	TurnLimit             int      `json:"turnLimit"`
	InitialBytes          int64    `json:"initialBytes"`
	MaxBytes              int64    `json:"maxBytes"`
	MaxCommandOutputChars int      `json:"maxCommandOutputChars"`
	NowMS                 *float64 `json:"nowMs"`
	StaleAfterMS          *float64 `json:"staleInProgressAfterMs"`
}

type Turn struct {
	ID          string           `json:"id"`
	Items       []map[string]any `json:"items"`
	ItemsView   string           `json:"itemsView"`
	Status      string           `json:"status"`
	Error       any              `json:"error"`
	StartedAt   *float64         `json:"startedAt"`
	CompletedAt *float64         `json:"completedAt"`
	DurationMS  *float64         `json:"durationMs"`
	Model       string           `json:"model,omitempty"`
	last        *float64
	rank        int
	nonempty    bool
	retained    bool
}

type entry struct {
	Type      string          `json:"type"`
	Timestamp json.RawMessage `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

func number(raw json.RawMessage) (float64, bool) {
	if raw == nil {
		return 0, false
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return 0, false
	}
	switch v := value.(type) {
	case nil:
		return 0, true
	case bool:
		if v {
			return 1, true
		}
		return 0, true
	case float64:
		return v, !math.IsNaN(v) && !math.IsInf(v, 0)
	case string:
		if strings.TrimSpace(v) == "" {
			return 0, true
		}
		n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return n, err == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
	}
	return 0, false
}
func text(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return string(n)
	}
	if string(raw) == "true" {
		return "true"
	}
	return ""
}
func firstText(values ...json.RawMessage) string {
	for _, raw := range values {
		if value := text(raw); value != "" {
			return value
		}
	}
	return ""
}
func timestamp(raw json.RawMessage) *float64 {
	if raw == nil || string(raw) == "null" || string(raw) == `""` {
		return nil
	}
	if n, ok := number(raw); ok {
		if n > 100000000000 {
			n /= 1000
		}
		n = math.Floor(n)
		return &n
	}
	if parsed, err := time.Parse(time.RFC3339Nano, text(raw)); err == nil {
		v := float64(parsed.Unix())
		return &v
	}
	return nil
}
func nullable(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "false" || string(raw) == `""` || string(raw) == "0" {
		return nil
	}
	return raw
}
func model(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	value = strings.TrimSpace(value)
	if strings.EqualFold(value, "<synthetic>") {
		return ""
	}
	return value
}
func normalized(options Options) (Options, error) {
	options.ThreadID = strings.TrimSpace(options.ThreadID)
	if options.ThreadID == "" {
		options.ThreadID = "thread"
	}
	options.Cwd = strings.TrimSpace(options.Cwd)
	if options.TurnLimit <= 0 {
		options.TurnLimit = defaultTurnLimit
	}
	if options.TurnLimit > 1024 {
		return options, ErrReadBudget
	}
	if options.InitialBytes <= 0 {
		options.InitialBytes = defaultInitialBytes
	}
	if options.MaxBytes <= 0 {
		options.MaxBytes = defaultMaxBytes
	}
	if options.InitialBytes > hardMaxBytes || options.MaxBytes > hardMaxBytes {
		return options, ErrReadBudget
	}
	if options.MaxCommandOutputChars == 0 {
		options.MaxCommandOutputChars = 16 << 10
	}
	return options, nil
}

// Match JavaScript's UTF-16 slice boundary, including a cut surrogate pair,
// without converting every ordinary short output into a second full buffer.
func truncateOutput(value string, limit int) any {
	if limit <= 0 {
		return value
	}
	units := 0
	cut := len(value)
	var high uint16
	for index, r := range value {
		n := 1
		if r > 0xffff {
			n = 2
		}
		if units+n > limit {
			cut = index
			if units < limit {
				h, _ := utf16.EncodeRune(r)
				high = uint16(h)
			}
			break
		}
		units += n
	}
	if cut == len(value) {
		return value
	}
	prefix, _ := json.Marshal(value[:cut])
	prefix = prefix[:len(prefix)-1]
	if high != 0 {
		prefix = append(prefix, []byte(`\u`+strconv.FormatUint(uint64(high), 16))...)
	}
	suffix, _ := json.Marshal("\n[output truncated by ai-home codex app hook]")
	return json.RawMessage(append(prefix, suffix[1:]...))
}
