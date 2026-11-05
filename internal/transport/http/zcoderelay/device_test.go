package zcoderelay

import "testing"

// 期望值由 Node 的 deriveZcodeDeviceMid 对同一输入计算得到（跨语言一致性守卫）。
func TestDeriveDeviceMidMatchesNode(t *testing.T) {
	got := DeriveDeviceMid("/tmp/aih", "acct_x")
	const want = "69b84b57-fe27-487b-9323-9f8b57cca780"
	if got != want {
		t.Fatalf("DeriveDeviceMid = %q, want %q", got, want)
	}
	if again := DeriveDeviceMid("/tmp/aih", "acct_x"); again != got {
		t.Fatal("同一账号必须稳定")
	}
	if other := DeriveDeviceMid("/tmp/aih", "acct_y"); other == got {
		t.Fatal("不同账号必须不同")
	}
}
