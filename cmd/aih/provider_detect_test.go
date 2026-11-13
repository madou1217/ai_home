package main

import (
	"testing"
)

// TestDetectInventory 只统计正数并按 provider 排序，输出必须稳定。
func TestDetectInventory(t *testing.T) {
	got := detectInventory(map[string]int{"workbuddy": 1, "codebuddy": 3, "codebuddycn": 0})
	if got != "codebuddy 3、workbuddy 1" {
		t.Fatalf("inventory = %q", got)
	}
	if detectInventory(nil) != "" {
		t.Fatal("空统计不应输出内容")
	}
}
