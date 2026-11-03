package usageledger

import (
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

func TestNewRecordRequiresStableUsageIdentity(t *testing.T) {
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{InputTokens: 12, OutputTokens: 8})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	record, err := NewRecord(RecordInput{
		AccountRef: accountRef,
		Provider:   "codex",
		Model:      "gpt-6.1-sol",
		SessionID:  "session-1",
		OccurredAt: time.UnixMilli(1_735_000_000_000).UTC(),
		Usage:      usage,
	})
	if err != nil {
		t.Fatalf("NewRecord() error = %v", err)
	}
	if record.AccountRef() != accountRef || record.Provider() != "codex" || record.Model() != "gpt-6.1-sol" {
		t.Fatalf("record identity = %#v", record)
	}
	if record.Usage().TotalTokens() != 20 || record.OccurredAt().Location() != time.UTC {
		t.Fatalf("record facts = %#v", record)
	}
}

func TestStatsAccumulateRecordsAndApplyFilters(t *testing.T) {
	accountRef, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	first, _ := inference.NewUsage(inference.UsageInput{InputTokens: 10, OutputTokens: 5})
	second, _ := inference.NewUsage(inference.UsageInput{InputTokens: 7, OutputTokens: 3, CachedInputTokens: 2})
	records := []Record{
		mustRecord(t, RecordInput{AccountRef: accountRef, Provider: "codex", Model: "gpt-6.1-sol", SessionID: "s1", OccurredAt: time.UnixMilli(1000).UTC(), Usage: first}),
		mustRecord(t, RecordInput{AccountRef: accountRef, Provider: "claude", Model: "claude-sonnet", SessionID: "s2", OccurredAt: time.UnixMilli(2000).UTC(), Usage: second}),
	}
	stats := Aggregate(records, Query{From: time.UnixMilli(0).UTC(), To: time.UnixMilli(1500).UTC(), Provider: "codex"})
	if stats.TotalCalls != 1 || stats.TotalSessions != 1 || stats.InputTokens != 10 || stats.OutputTokens != 5 || stats.TotalTokens != 15 {
		t.Fatalf("stats = %#v", stats)
	}
}

func TestAggregateModelsGroupsProviderAndModel(t *testing.T) {
	accountOne, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	accountTwo, _ := accountcore.ParseAccountRef("acct_abcdef0123456789abcd")
	usage, _ := inference.NewUsage(inference.UsageInput{InputTokens: 10, OutputTokens: 5})
	records := []Record{
		mustRecord(t, RecordInput{AccountRef: accountOne, Provider: "codex", Model: "gpt-6.1-sol", OccurredAt: time.UnixMilli(1000).UTC(), Usage: usage}),
		mustRecord(t, RecordInput{AccountRef: accountTwo, Provider: "codex", Model: "gpt-6.1-sol", OccurredAt: time.UnixMilli(2000).UTC(), Usage: usage}),
	}
	models := AggregateModels(records, Query{From: time.UnixMilli(0).UTC(), To: time.UnixMilli(3000).UTC()})
	if len(models) != 1 || models[0].Provider != "codex" || models[0].Model != "gpt-6.1-sol" || models[0].Calls != 2 || models[0].AccountCount != 2 || models[0].TotalTokens != 30 {
		t.Fatalf("models = %#v", models)
	}
}

func TestAggregateSessionsRequiresExplicitSessionIdentity(t *testing.T) {
	accountRef, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	usage, _ := inference.NewUsage(inference.UsageInput{InputTokens: 10, OutputTokens: 5})
	records := []Record{
		mustRecord(t, RecordInput{AccountRef: accountRef, Provider: "codex", Model: "gpt-6.1-sol", SessionID: "s1", OccurredAt: time.UnixMilli(1000).UTC(), Usage: usage}),
		mustRecord(t, RecordInput{AccountRef: accountRef, Provider: "codex", Model: "gpt-6.1-sol", SessionID: "", OccurredAt: time.UnixMilli(2000).UTC(), Usage: usage}),
	}
	sessions := AggregateSessions(records, Query{From: time.UnixMilli(0).UTC(), To: time.UnixMilli(3000).UTC()})
	if len(sessions) != 1 || sessions[0].SessionID != "s1" || sessions[0].Calls != 1 || sessions[0].TotalTokens != 15 {
		t.Fatalf("sessions = %#v", sessions)
	}
}

func mustRecord(t *testing.T, input RecordInput) Record {
	t.Helper()
	record, err := NewRecord(input)
	if err != nil {
		t.Fatalf("NewRecord() error = %v", err)
	}
	return record
}
