package aihserver

import (
	"context"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

func TestParseUsageThresholdPct(t *testing.T) {
	cases := []struct {
		raw  string
		want float64
		ok   bool
	}{
		{raw: `{"threshold_pct":90}`, want: 90, ok: true},
		{raw: `{"threshold_pct":"85"}`, want: 85, ok: true},
		{raw: `{"threshold_pct":null}`, ok: false},
		{raw: `{"other":1}`, ok: false},
		{raw: `not-json`, ok: false},
	}
	for _, testCase := range cases {
		got, ok := parseUsageThresholdPct(testCase.raw)
		if ok != testCase.ok || (ok && got != testCase.want) {
			t.Fatalf("parseUsageThresholdPct(%s) = %v, %v; want %v, %v",
				testCase.raw, got, ok, testCase.want, testCase.ok)
		}
	}
}

func TestUsageThresholdSourceReadsConfigWithTTL(t *testing.T) {
	aiHomeDir := t.TempDir()
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	now := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	source := newUsageThresholdSource(aiHomeDir, func() time.Time { return now })
	ctx := context.Background()

	// 没有配置时按 Node 默认 95 → 剩余 5%。
	if got := source.minimumBasisPoints(ctx); got != 500 {
		t.Fatalf("default minimum = %d, want 500", got)
	}
	// 第一次读到值后按 5s TTL 缓存。
	if err := appstate.WriteKV(ctx, databasePath, usageConfigKey, `{"threshold_pct":90}`, now.UnixMilli()); err != nil {
		t.Fatalf("WriteKV() error = %v", err)
	}
	now = now.Add(6 * time.Second)
	if got := source.minimumBasisPoints(ctx); got != 1000 {
		t.Fatalf("minimum after config = %d, want 1000", got)
	}
	if err := appstate.WriteKV(ctx, databasePath, usageConfigKey, `{"threshold_pct":80}`, now.UnixMilli()); err != nil {
		t.Fatalf("WriteKV() error = %v", err)
	}
	if got := source.minimumBasisPoints(ctx); got != 1000 {
		t.Fatalf("cached minimum = %d, want 1000", got)
	}
	now = now.Add(6 * time.Second)
	if got := source.minimumBasisPoints(ctx); got != 2000 {
		t.Fatalf("minimum after TTL = %d, want 2000", got)
	}
}
