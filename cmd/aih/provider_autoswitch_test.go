package main

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// TestParseRemainingPercent 只接受 0-100 的整数；边界值必须可用。
func TestParseRemainingPercent(t *testing.T) {
	for _, value := range []string{"0", "5", "100"} {
		got, err := parseRemainingPercent(value)
		if err != nil {
			t.Fatalf("parseRemainingPercent(%q): %v", value, err)
		}
		if got < 0 || got > 100 {
			t.Fatalf("parseRemainingPercent(%q) = %d", value, got)
		}
	}
	for _, value := range []string{"", "-1", "101", "abc", "3.5"} {
		if _, err := parseRemainingPercent(value); err == nil {
			t.Fatalf("parseRemainingPercent(%q) 应该失败", value)
		}
	}
}

// TestWriteAutoSwitchStatus 阈值来源必须区分「跟随 threshold_pct」与显式 remaining。
func TestWriteAutoSwitchStatus(t *testing.T) {
	var builder strings.Builder
	writeAutoSwitchStatus(&builder, "codebuddycn", managementapi.UsageConfig{
		ThresholdPct: 99,
		AutoSwitch:   true,
	})
	output := builder.String()
	if !strings.Contains(output, "已开启") || !strings.Contains(output, "剩余 ≤ 1%") {
		t.Fatalf("output = %q", output)
	}
	builder.Reset()
	remaining := 5
	writeAutoSwitchStatus(&builder, "codebuddycn", managementapi.UsageConfig{
		ThresholdPct:           99,
		AutoSwitch:             false,
		AutoSwitchRemainingPct: &remaining,
	})
	output = builder.String()
	if !strings.Contains(output, "关闭") || !strings.Contains(output, "剩余 ≤ 5%") {
		t.Fatalf("output = %q", output)
	}
}
