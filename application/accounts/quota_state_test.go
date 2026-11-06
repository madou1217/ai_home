package accounts

import (
	"testing"
	"time"
)

func TestNewAccountQuotaStateRejectsInconsistentInput(t *testing.T) {
	capturedAt := time.UnixMilli(1793937685487).UTC()
	cases := []struct {
		name  string
		input AccountQuotaStateInput
	}{
		{
			name: "没有快照却带了状态",
			input: AccountQuotaStateInput{
				Found:  false,
				Status: "available",
			},
		},
		{
			name: "有快照却没有状态",
			input: AccountQuotaStateInput{
				Found:      true,
				CapturedAt: capturedAt,
			},
		},
		{
			name: "有快照却没有采集时间",
			input: AccountQuotaStateInput{
				Found:  true,
				Status: "available",
			},
		},
		{
			name: "剩余额度越界",
			input: AccountQuotaStateInput{
				Found:        true,
				Status:       "available",
				RemainingBPS: 10001,
				CapturedAt:   capturedAt,
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := NewAccountQuotaState(testCase.input); err == nil {
				t.Fatalf("期望拒绝，实际通过: %+v", testCase.input)
			}
		})
	}
}

func TestNewAccountQuotaStateNormalizes(t *testing.T) {
	capturedAt := time.UnixMilli(1793937685487).UTC()
	state, err := NewAccountQuotaState(AccountQuotaStateInput{
		Found:               true,
		Status:              "  EXHAUSTED ",
		Reason:              " usage_exhausted ",
		RemainingBPS:        0,
		HasNumericRemaining: true,
		CapturedAt:          capturedAt,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !state.IsFound() || state.Status() != "exhausted" || state.Reason() != "usage_exhausted" {
		t.Fatalf("状态未归一: %+v", state)
	}
	if !state.HasNumericRemaining() || !state.CapturedAt().Equal(capturedAt) {
		t.Fatalf("数值/时间未保留: %+v", state)
	}
}

func TestNewAccountQuotaStateAbsent(t *testing.T) {
	state, err := NewAccountQuotaState(AccountQuotaStateInput{Found: false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if state.IsFound() {
		t.Fatal("缺省快照不应被当成有状态")
	}
}
