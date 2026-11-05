package usage

import "testing"

// 快照里的套餐必须与 Node codex-strategy 的词汇表逐值一致：
// 多写一个未知值会让窗口统计出现 Node 没有的档位，少写一个会让已知档位变空。
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
		{raw: "oauth", want: ""},
		{raw: "some_new_tier", want: ""},
		{raw: "", want: ""},
	}
	for _, testCase := range cases {
		if got := snapshotPlanType(testCase.raw); got != testCase.want {
			t.Fatalf("snapshotPlanType(%q) = %q, want %q", testCase.raw, got, testCase.want)
		}
	}
}
