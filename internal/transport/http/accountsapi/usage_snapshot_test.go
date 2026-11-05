package accountsapi

import (
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
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
