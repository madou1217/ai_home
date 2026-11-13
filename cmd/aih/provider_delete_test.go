package main

import (
	"context"
	"strings"
	"testing"
)

// TestParseDeleteSelectors 守住选择器展开：逗号/区间/去重/顺序，以及非法输入。
func TestParseDeleteSelectors(t *testing.T) {
	got, err := parseDeleteSelectors([]string{"3", "1,2", "5-7"})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := []int64{3, 1, 2, 5, 6, 7}
	if len(got) != len(want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("ids = %v, want %v", got, want)
		}
	}
	got, err = parseDeleteSelectors([]string{"2", "2", "1-2"})
	if err != nil {
		t.Fatalf("parse dup: %v", err)
	}
	if len(got) != 2 || got[0] != 2 || got[1] != 1 {
		t.Fatalf("dedupe ids = %v", got)
	}
	for _, invalid := range [][]string{
		{""},
		{"0"},
		{"-1"},
		{"a"},
		{"3-1"},
		{"1,,2"},
		{"1-100000"},
	} {
		if _, err := parseDeleteSelectors(invalid); err == nil {
			t.Fatalf("parseDeleteSelectors(%v) 应该失败", invalid)
		}
	}
}

// TestDeleteUsageRequiresSelector 无选择器时只报用法，不触碰账号。
func TestDeleteUsageRequiresSelector(t *testing.T) {
	runtime := commandRuntime{}
	err := runProviderDelete(context.Background(), "codebuddycn", nil, runtime)
	if err == nil || !strings.Contains(err.Error(), "用法") {
		t.Fatalf("err = %v", err)
	}
}
