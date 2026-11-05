package accountsapi

import (
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

func TestBuildUsageSnapshotMapsWindowEntry(t *testing.T) {
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := buildUsageSnapshot(ref, "codex", replaceUsageRequest{
		Source:     "quota_probe",
		PlanType:   "pro",
		CapturedAt: "1793000000000",
		Entries: []replaceUsageEntry{{
			Bucket:               "primary",
			Kind:                 "window",
			Scope:                "account",
			HasRemaining:         true,
			RemainingBasisPoints: 4200,
			WindowSeconds:        18000,
			Availability:         "available",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.IsValid() || snapshot.AccountRef() != ref || snapshot.ProviderID() != "codex" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if snapshot.PlanType() != "pro" {
		t.Fatalf("plan type = %q", snapshot.PlanType())
	}
	if len(snapshot.Entries()) != 1 {
		t.Fatalf("entries = %#v", snapshot.Entries())
	}
	remaining, hasRemaining := snapshot.Entries()[0].RemainingBasisPoints()
	if !hasRemaining || remaining != 4200 {
		t.Fatalf("remaining = %d/%v", remaining, hasRemaining)
	}
}

func TestBuildUsageSnapshotRejectsOutOfRangeRemaining(t *testing.T) {
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := buildUsageSnapshot(ref, "codex", replaceUsageRequest{
		Source:     "quota_probe",
		CapturedAt: "1793000000000",
		Entries: []replaceUsageEntry{{
			Bucket:               "primary",
			Kind:                 "window",
			Scope:                "account",
			RemainingBasisPoints: 10001,
			Availability:         "available",
		}},
	}); err == nil {
		t.Fatal("expected out-of-range remaining to be rejected")
	}
}

// Node 推送的 claude 快照带模型族条目（seven_day_<family>）与套餐名：
// 传输层必须原样保留 scope/scope_key，不能把族条目压成账号级。
func TestBuildUsageSnapshotKeepsModelFamilyEntry(t *testing.T) {
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := buildUsageSnapshot(ref, "claude", replaceUsageRequest{
		Source:     "claude_oauth_usage_api",
		PlanType:   "fable",
		CapturedAt: "1793000000000",
		Collected:  true,
		Entries: []replaceUsageEntry{
			{
				Bucket:               "five_hour",
				Kind:                 "window",
				Scope:                "account",
				HasRemaining:         true,
				RemainingBasisPoints: 9000,
				WindowSeconds:        18000,
				Availability:         "available",
			},
			{
				Bucket:               "seven_day_fable",
				LimitName:            "fable",
				Kind:                 "window",
				Scope:                "model_family",
				ScopeKey:             "fable",
				HasRemaining:         true,
				RemainingBasisPoints: 0,
				WindowSeconds:        604800,
				Availability:         "exhausted",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.PlanType() != "fable" {
		t.Fatalf("plan type = %q", snapshot.PlanType())
	}
	var family *usagecore.Entry
	for index := range snapshot.Entries() {
		entry := snapshot.Entries()[index]
		if entry.Bucket() == "seven_day_fable" {
			family = &entry
		}
	}
	if family == nil {
		t.Fatalf("entries = %#v", snapshot.Entries())
	}
	if family.Scope() != usagecore.ScopeModelFamily || family.ScopeKey() != "fable" {
		t.Fatalf("family scope = %s/%q", family.Scope(), family.ScopeKey())
	}
}
