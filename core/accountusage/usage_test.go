package accountusage

import (
	"errors"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func TestNewSnapshotSortsAndPreservesProviderQuotaDimensions(t *testing.T) {
	t.Parallel()

	accountRef := testAccountRef(t)
	capturedAt := time.UnixMilli(1_800_000_000_123).UTC()
	resetAt := time.UnixMilli(1_800_003_600_000).UTC()
	snapshot, err := NewSnapshot(SnapshotInput{
		AccountRef: accountRef,
		ProviderID: "claude",
		Source:     "claude_oauth_usage",
		CapturedAt: capturedAt,
		Entries: []EntryInput{
			{
				Bucket:               "seven_day_opus",
				Kind:                 KindWindow,
				Scope:                ScopeModelFamily,
				ScopeKey:             "opus",
				HasRemaining:         true,
				RemainingBasisPoints: 2_500,
				WindowSeconds:        7 * 24 * 60 * 60,
				ResetAt:              resetAt,
				Availability:         AvailabilityAvailable,
			},
			{
				Bucket:       "extra_usage",
				Kind:         KindCredits,
				Scope:        ScopeAccount,
				Availability: AvailabilityUnlimited,
			},
			{
				Bucket:               "five_hour",
				Kind:                 KindWindow,
				Scope:                ScopeAccount,
				HasRemaining:         true,
				RemainingBasisPoints: 7_500,
				WindowSeconds:        5 * 60 * 60,
				ResetAt:              resetAt,
				Availability:         AvailabilityAvailable,
			},
		},
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	if !snapshot.IsValid() ||
		snapshot.AccountRef() != accountRef ||
		snapshot.ProviderID() != "claude" ||
		snapshot.Source() != "claude_oauth_usage" ||
		!snapshot.CapturedAt().Equal(capturedAt) {
		t.Fatalf("Snapshot 元数据错误: %#v", snapshot)
	}
	entries := snapshot.Entries()
	if len(entries) != 3 ||
		entries[0].Bucket() != "extra_usage" ||
		entries[1].Bucket() != "five_hour" ||
		entries[2].Bucket() != "seven_day_opus" {
		t.Fatalf("Entries() 顺序错误: %#v", entries)
	}
	remaining, known := entries[2].RemainingBasisPoints()
	if !known || remaining != 2_500 ||
		entries[2].Scope() != ScopeModelFamily ||
		entries[2].ScopeKey() != "opus" ||
		entries[2].WindowSeconds() != 7*24*60*60 ||
		!entries[2].ResetAt().Equal(resetAt) {
		t.Fatalf("模型族窗口字段错误: %#v", entries[2])
	}

	// 返回值必须是副本，调用方不能修改不可变快照。
	entries[0] = Entry{}
	if snapshot.Entries()[0].Bucket() != "extra_usage" {
		t.Fatal("Entries() 暴露了内部切片")
	}
}

func TestNewSnapshotRejectsDuplicateAndContradictoryEntries(t *testing.T) {
	t.Parallel()

	valid := EntryInput{
		Bucket:               "primary",
		Kind:                 KindWindow,
		Scope:                ScopeAccount,
		HasRemaining:         true,
		RemainingBasisPoints: 5_000,
		WindowSeconds:        5 * 60 * 60,
		Availability:         AvailabilityAvailable,
	}
	tests := []struct {
		name    string
		entries []EntryInput
	}{
		{
			name:    "重复 limit 和 bucket",
			entries: []EntryInput{valid, valid},
		},
		{
			name: "零剩余却标记可用",
			entries: []EntryInput{{
				Bucket:               "primary",
				Kind:                 KindWindow,
				Scope:                ScopeAccount,
				HasRemaining:         true,
				RemainingBasisPoints: 0,
				Availability:         AvailabilityAvailable,
			}},
		},
		{
			name: "账号作用域携带 scope key",
			entries: []EntryInput{{
				Bucket:       "primary",
				Kind:         KindWindow,
				Scope:        ScopeAccount,
				ScopeKey:     "opus",
				Availability: AvailabilityUnknown,
			}},
		},
		{
			name: "模型族缺少 scope key",
			entries: []EntryInput{{
				Bucket:       "seven_day_opus",
				Kind:         KindWindow,
				Scope:        ScopeModelFamily,
				Availability: AvailabilityUnknown,
			}},
		},
		{
			name: "非法标识符",
			entries: []EntryInput{{
				Bucket:       "primary\nforged",
				Kind:         KindWindow,
				Scope:        ScopeAccount,
				Availability: AvailabilityUnknown,
			}},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := NewSnapshot(SnapshotInput{
				AccountRef: testAccountRef(t),
				ProviderID: "codex",
				Source:     "codex_wham_usage",
				CapturedAt: time.UnixMilli(1_800_000_000_000).UTC(),
				Entries:    testCase.entries,
			})
			if !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatalf("NewSnapshot() error = %v", err)
			}
		})
	}
}

func TestSnapshotRejectsInvalidMetadataAndEmptyEntries(t *testing.T) {
	t.Parallel()

	inputs := []SnapshotInput{
		{},
		{
			AccountRef: testAccountRef(t),
			ProviderID: "Claude",
			Source:     "claude_oauth_usage",
			CapturedAt: time.Now(),
			Entries:    []EntryInput{{}},
		},
		{
			AccountRef: testAccountRef(t),
			ProviderID: "claude",
			Source:     "claude oauth usage",
			CapturedAt: time.Now(),
			Entries:    []EntryInput{{}},
		},
		{
			AccountRef: testAccountRef(t),
			ProviderID: "claude",
			Source:     "claude_oauth_usage",
			CapturedAt: time.Time{},
			Entries:    []EntryInput{{}},
		},
		{
			AccountRef: testAccountRef(t),
			ProviderID: "claude",
			Source:     "claude_oauth_usage",
			CapturedAt: time.Now(),
			Entries:    nil,
		},
	}
	for index, input := range inputs {
		if _, err := NewSnapshot(input); !errors.Is(err, ErrInvalidSnapshot) {
			t.Fatalf("input[%d] error = %v", index, err)
		}
	}
}

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()

	accountRef, err := accountcore.ParseAccountRef(
		"acct_0123456789abcdef0123",
	)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}
