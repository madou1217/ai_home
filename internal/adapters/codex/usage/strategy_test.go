package usage

import "testing"

// 快照里的套餐不维护清单：上游新增档位必须原样通过，
// 只排除明确不是套餐的鉴权模式与占位值。
func TestSnapshotPlanType(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{raw: "plus", want: "plus"},
		{raw: "  Pro  ", want: "pro"},
		{raw: "Pro Lite", want: "pro_lite"},
		{raw: "prolite", want: "prolite"},
		{raw: "team", want: "team"},
		{raw: "self_serve_business_usage_based", want: "self_serve_business_usage_based"},
		{raw: "enterprise_cbp_usage_based", want: "enterprise_cbp_usage_based"},
		{raw: "education", want: "education"},
		// 上游以后新增的档位不能被丢掉。
		{raw: "some_new_tier", want: "some_new_tier"},
		{raw: "Max 5x", want: "max_5x"},
		// 鉴权模式与占位值不是套餐。
		{raw: "oauth", want: ""},
		{raw: "api-key", want: ""},
		{raw: "pending", want: ""},
		{raw: "unknown", want: ""},
		{raw: "", want: ""},
	}
	for _, testCase := range cases {
		if got := snapshotPlanType(testCase.raw); got != testCase.want {
			t.Fatalf("snapshotPlanType(%q) = %q, want %q", testCase.raw, got, testCase.want)
		}
	}
}
