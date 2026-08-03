package anthropicmessages

import (
	"strings"
	"testing"
)

// TestDecodeRoleReportsOnlySafeCategories 验证未知角色诊断可定位合同差异，
// 同时不会回显调用方提供的任意角色值。
func TestDecodeRoleReportsOnlySafeCategories(t *testing.T) {
	t.Parallel()

	tests := []struct {
		value    string
		category string
	}{
		{value: "", category: "missing"},
		{value: "developer", category: "developer"},
		{value: "tool", category: "tool"},
		{value: "secret-role-value", category: "unknown"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.category, func(t *testing.T) {
			t.Parallel()
			_, err := decodeRole(test.value, "messages[1].role")
			if err == nil ||
				!strings.Contains(err.Error(), "."+test.category) ||
				strings.Contains(err.Error(), "secret-role-value") {
				t.Fatalf("decodeRole(%q) error = %v", test.value, err)
			}
		})
	}
}
