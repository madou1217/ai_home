package main

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
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

// TestDetectFailureExplainsStaleServer 旧 Server 缺路由时必须给出可执行提示。
func TestDetectFailureExplainsStaleServer(t *testing.T) {
	err := detectFailure(managementapi.RemoteError{StatusCode: 404, Code: "not_found"})
	if !strings.Contains(err.Error(), "重启 server") {
		t.Fatalf("err = %v", err)
	}
	other := detectFailure(managementapi.RemoteError{StatusCode: 500, Code: "internal_error"})
	if !strings.Contains(other.Error(), "账号管理 API 返回 500") {
		t.Fatalf("err = %v", other)
	}
}
