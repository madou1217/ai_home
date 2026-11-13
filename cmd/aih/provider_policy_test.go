package main

import (
	"strings"
	"testing"
)

// TestNormalizePolicySandbox 只接受三种官方 sandbox。
func TestNormalizePolicySandbox(t *testing.T) {
	for _, value := range []string{"workspace-write", "read-only", "danger-full-access"} {
		if got, err := normalizePolicySandbox(value); err != nil || got != value {
			t.Fatalf("normalize(%q) = %q, %v", value, got, err)
		}
	}
	for _, value := range []string{"", "nope", "readonly"} {
		if _, err := normalizePolicySandbox(value); err == nil {
			t.Fatalf("normalize(%q) 应该失败", value)
		}
	}
	if _, err := normalizePolicySandbox(""); err == nil || !strings.Contains(err.Error(), "Missing sandbox value") {
		t.Fatalf("空值文案 = %v", err)
	}
}

// TestEffectiveExecSandbox danger 只有显式允许时才生效。
func TestEffectiveExecSandbox(t *testing.T) {
	policy := defaultExecPolicy()
	if effectiveExecSandbox(policy) != "workspace-write" {
		t.Fatalf("default = %q", effectiveExecSandbox(policy))
	}
	policy.Exec.DefaultSandbox = sandboxDangerFull
	if effectiveExecSandbox(policy) != sandboxDangerFull {
		t.Fatalf("danger without allow = %q", effectiveExecSandbox(policy))
	}
	policy.Exec.AllowDangerFullAccess = false
	if effectiveExecSandbox(policy) != sandboxDangerFull {
		t.Fatalf("defaultSandbox 是 danger 时仍应报告 danger: %q", effectiveExecSandbox(policy))
	}
}
