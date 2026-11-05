package accountusage

import (
	"strings"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func planTestEntry() EntryInput {
	return EntryInput{
		Bucket:               "primary",
		Kind:                 KindWindow,
		Scope:                ScopeAccount,
		HasRemaining:         true,
		RemainingBasisPoints: 8000,
		WindowSeconds:        5 * 60 * 60,
		Availability:         AvailabilityAvailable,
	}
}

func planTestSnapshot(t *testing.T, planType string) (Snapshot, error) {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return NewSnapshot(SnapshotInput{
		AccountRef: accountRef,
		ProviderID: "codex",
		Source:     "codex_wham_usage",
		PlanType:   planType,
		CapturedAt: time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC),
		Entries:    []EntryInput{planTestEntry()},
	})
}

func TestSnapshotCarriesPlanType(t *testing.T) {
	snapshot, err := planTestSnapshot(t, "pro")
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	if snapshot.PlanType() != "pro" {
		t.Fatalf("PlanType() = %q, want pro", snapshot.PlanType())
	}
	if !snapshot.IsValid() {
		t.Fatal("带套餐的快照必须自洽")
	}
}

func TestSnapshotAllowsUnknownPlanType(t *testing.T) {
	snapshot, err := planTestSnapshot(t, "")
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	if snapshot.PlanType() != "" {
		t.Fatalf("PlanType() = %q, want empty", snapshot.PlanType())
	}
	if !snapshot.IsValid() {
		t.Fatal("未知套餐是合法状态")
	}
}

func TestSnapshotRejectsInvalidPlanType(t *testing.T) {
	cases := []struct {
		name     string
		planType string
	}{
		{name: "首尾空白", planType: " pro "},
		{name: "超长", planType: strings.Repeat("a", 65)},
		{name: "控制字符", planType: "pro\x00"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := planTestSnapshot(t, testCase.planType); err == nil {
				t.Fatalf("PlanType=%q 应被拒绝", testCase.planType)
			}
		})
	}
}

func TestIsPlanToken(t *testing.T) {
	cases := []struct {
		token string
		want  bool
	}{
		{token: "pro", want: true},
		{token: "fable", want: true},
		{token: "pro_plus", want: true},
		{token: "some_new_tier", want: true},
		{token: "oauth", want: false},
		{token: "oauth_browser", want: false},
		{token: "oauth_device", want: false},
		{token: "api_key", want: false},
		{token: "apikey", want: false},
		{token: "pending", want: false},
		{token: "unknown", want: false},
		{token: "", want: false},
	}
	for _, testCase := range cases {
		if got := IsPlanToken(testCase.token); got != testCase.want {
			t.Fatalf("IsPlanToken(%q) = %v, want %v", testCase.token, got, testCase.want)
		}
	}
}

func TestNormalizePlanName(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{raw: "Pro", want: "pro"},
		{raw: "  Pro Plus  ", want: "pro plus"},
		{raw: "Pro-Plus", want: "pro-plus"},
		{raw: "", want: ""},
		{raw: "   ", want: ""},
		{raw: strings.Repeat("a", 65), want: ""},
	}
	for _, testCase := range cases {
		if got := NormalizePlanName(testCase.raw); got != testCase.want {
			t.Fatalf("NormalizePlanName(%q) = %q, want %q", testCase.raw, got, testCase.want)
		}
	}
}

func TestNormalizePlanToken(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{raw: "Pro", want: "pro"},
		{raw: "  Pro Plus  ", want: "pro_plus"},
		{raw: "ZCode Start Plan", want: "zcode_start_plan"},
		{raw: "pro-lite", want: "pro_lite"},
		{raw: "pro   --  lite", want: "pro_lite"},
		{raw: "", want: ""},
		{raw: "   ", want: ""},
		{raw: strings.Repeat("a", 65), want: ""},
	}
	for _, testCase := range cases {
		if got := NormalizePlanToken(testCase.raw); got != testCase.want {
			t.Fatalf("NormalizePlanToken(%q) = %q, want %q", testCase.raw, got, testCase.want)
		}
	}
}
