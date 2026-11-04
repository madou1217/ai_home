package accountruntime

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

func testAccountState(t *testing.T, document string) AccountState {
	t.Helper()
	state, err := NewAccountState(AccountStateInput{
		AccountRef: testAccountRef(t),
		Document:   []byte(document),
		UpdatedAt:  time.UnixMilli(1_700_000_000_000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccountState() error = %v", err)
	}
	return state
}

func TestAccountStateDeriveStatusMatchesNodePriority(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(10_000).UTC()
	cases := []struct {
		name     string
		document string
		status   string
		untilMS  int64
		reason   string
	}{
		{
			name:     "empty state is healthy",
			document: "{}",
			status:   "healthy",
		},
		{
			name: "routing block wins over cooldown",
			document: `{"routingBlock":{"kind":"billing_blocked","reason":"billing","until":20000},
				"authInvalidUntil":30000,"cooldownUntil":40000}`,
			status:  "billing_blocked",
			untilMS: 20000,
			reason:  "billing",
		},
		{
			name: "expired routing block falls through",
			document: `{"routingBlock":{"kind":"quota_exhausted","reason":"quota","until":9000},
				"rateLimitUntil":20000}`,
			status:  "rate_limited",
			untilMS: 20000,
			reason:  "",
		},
		{
			name:     "auth invalid beats rate limit",
			document: `{"authInvalidUntil":20000,"rateLimitUntil":30000,"lastFailureReason":"expired"}`,
			status:   "auth_invalid",
			untilMS:  20000,
			reason:   "expired",
		},
		{
			name:     "rate limited",
			document: `{"rateLimitUntil":30000,"lastError":"429"}`,
			status:   "rate_limited",
			untilMS:  30000,
			reason:   "429",
		},
		{
			name:     "overloaded beats transient network",
			document: `{"overloadUntil":30000,"networkUntil":40000}`,
			status:   "overloaded",
			untilMS:  30000,
		},
		{
			name:     "transient network",
			document: `{"networkUntil":40000}`,
			status:   "transient_network",
			untilMS:  40000,
		},
		{
			name:     "service unavailable",
			document: `{"serviceUnavailableUntil":50000}`,
			status:   "service_unavailable",
			untilMS:  50000,
		},
		{
			name:     "upstream error",
			document: `{"upstreamErrorUntil":60000}`,
			status:   "upstream_error",
			untilMS:  60000,
		},
		{
			name:     "generic cooldown keeps failure kind",
			document: `{"cooldownUntil":70000,"lastFailureKind":"upstream_error","lastFailureReason":"boom"}`,
			status:   "upstream_error",
			untilMS:  70000,
			reason:   "boom",
		},
		{
			name:     "generic cooldown without kind is cooling down",
			document: `{"cooldownUntil":80000}`,
			status:   "cooling_down",
			untilMS:  80000,
		},
		{
			name:     "expired cooldown is healthy",
			document: `{"cooldownUntil":9000,"authInvalidUntil":8000}`,
			status:   "healthy",
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			state := testAccountState(t, testCase.document)
			status := state.DeriveStatus(now)
			if status.Status() != testCase.status {
				t.Fatalf("status = %q, want %q", status.Status(), testCase.status)
			}
			if testCase.untilMS == 0 {
				if !status.Until().IsZero() {
					t.Fatalf("until = %v, want zero", status.Until())
				}
			} else if status.Until().UnixMilli() != testCase.untilMS {
				t.Fatalf("until = %d, want %d", status.Until().UnixMilli(), testCase.untilMS)
			}
			if status.Reason() != testCase.reason {
				t.Fatalf("reason = %q, want %q", status.Reason(), testCase.reason)
			}
		})
	}
}

func TestAccountStatePreservesUnknownFields(t *testing.T) {
	t.Parallel()
	document := `{"rateLimitUntil":30000,"futureField":{"nested":true},"modelCooldowns":{"gpt-5":123}}`
	state := testAccountState(t, document)
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(state.Document(), &decoded); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if _, exists := decoded["futureField"]; !exists {
		t.Fatal("unknown field was dropped")
	}
	if string(decoded["modelCooldowns"]) != `{"gpt-5":123}` {
		t.Fatalf("modelCooldowns = %s", decoded["modelCooldowns"])
	}
}

func TestNewAccountStateRejectsInvalidDocuments(t *testing.T) {
	t.Parallel()
	ref := testAccountRef(t)
	updatedAt := time.UnixMilli(1_700_000_000_000).UTC()
	tooManyModels := make(map[string]float64, maxAccountStateModelEntries+1)
	for index := 0; index <= maxAccountStateModelEntries; index++ {
		tooManyModels["model-"+strconv.Itoa(index)] = 1
	}
	tooManyModelsPayload, err := json.Marshal(tooManyModels)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	tooManyModelsJSON := append([]byte(`{"modelCooldowns":`), append(tooManyModelsPayload, '}')...)
	cases := map[string][]byte{
		"not object":         []byte(`[]`),
		"invalid json":       []byte(`{"a":`),
		"negative time":      []byte(`{"rateLimitUntil":-1}`),
		"fractional time":    []byte(`{"rateLimitUntil":1.5}`),
		"too long reason":    []byte(`{"lastFailureReason":"` + strings.Repeat("x", maxAccountStateTextLength+1) + `"}`),
		"block without kind": []byte(`{"routingBlock":{"until":30000}}`),
		"too many models":    tooManyModelsJSON,
		"too large":          append([]byte(`{"padding":"`), append(bytesOf('x', MaxAccountStateBytes), []byte(`"}`)...)...),
	}
	for name, document := range cases {
		document := document
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := NewAccountState(AccountStateInput{
				AccountRef: ref,
				Document:   document,
				UpdatedAt:  updatedAt,
			}); err != ErrInvalidAccountState {
				t.Fatalf("error = %v, want ErrInvalidAccountState", err)
			}
		})
	}
}

func bytesOf(value byte, count int) []byte {
	buffer := make([]byte, count)
	for index := range buffer {
		buffer[index] = value
	}
	return buffer
}

func TestAccountStateDeriveBlock(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		document string
		ok       bool
		kind     FailureKind
		reason   string
		untilMS  int64
	}{
		{
			name:     "routing block maps to failure kind",
			document: `{"routingBlock":{"kind":"billing_blocked","reason":"billing","observedAt":10000,"until":60000}}`,
			ok:       true,
			kind:     FailureBillingBlocked,
			reason:   "billing",
			untilMS:  60000,
		},
		{
			name:     "routing block permission denied keeps its kind",
			document: `{"routingBlock":{"kind":"permission_denied","reason":"region","observedAt":10000,"until":31000}}`,
			ok:       true,
			kind:     FailurePermissionDenied,
			reason:   "region",
			untilMS:  31000,
		},
		{
			name:     "rate limit prefers its own until over cooldown",
			document: `{"lastFailureKind":"rate_limited","lastFailureAt":1000,"rateLimitUntil":2000,"cooldownUntil":3000}`,
			ok:       true,
			kind:     FailureRateLimited,
			untilMS:  2000,
		},
		{
			name:     "auth invalid maps to reauthentication",
			document: `{"lastFailureKind":"auth_invalid","lastFailureAt":10000,"authInvalidUntil":60000,"lastFailureReason":"expired"}`,
			ok:       true,
			kind:     FailureReauthenticationRequired,
			reason:   "expired",
		},
		{
			name:     "overload maps to model overloaded",
			document: `{"lastFailureKind":"overloaded","lastFailureAt":10000,"rateLimitUntil":60000}`,
			ok:       true,
			kind:     FailureModelOverloaded,
		},
		{
			name:     "unknown kind is not materialized",
			document: `{"lastFailureKind":"mystery","lastFailureAt":10000,"cooldownUntil":60000}`,
			ok:       false,
		},
		{
			name:     "missing observed time is not materialized",
			document: `{"lastFailureKind":"rate_limited","rateLimitUntil":60000}`,
			ok:       false,
		},
		{
			name:     "expired until is not materialized",
			document: `{"lastFailureKind":"rate_limited","lastFailureAt":10000,"rateLimitUntil":10000}`,
			ok:       false,
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			state := testAccountState(t, testCase.document)
			block, ok := state.DeriveBlock()
			if ok != testCase.ok {
				t.Fatalf("ok = %v, want %v", ok, testCase.ok)
			}
			if !ok {
				return
			}
			if block.Kind() != testCase.kind {
				t.Fatalf("kind = %q, want %q", block.Kind(), testCase.kind)
			}
			if block.Reason() != testCase.reason {
				t.Fatalf("reason = %q, want %q", block.Reason(), testCase.reason)
			}
			if block.Scope() != BlockScopeAccount {
				t.Fatalf("scope = %q", block.Scope())
			}
			if testCase.untilMS != 0 && block.Until().UnixMilli() != testCase.untilMS {
				t.Fatalf("until = %d, want %d", block.Until().UnixMilli(), testCase.untilMS)
			}
		})
	}
}
