package responseswebsocket

import (
	"net/http"
	"strconv"
	"testing"
)

// 回归：跨机中转（本机网关 → 远程 server 网关）必须放行一跳。
// 缺陷形态：把「跳数头存在」直接当成自环并 508，于是把远程 server 当上游时
// WebSocket 永远打不通，WebUI 会话表现为 `stream disconnected before completion`。
// 要防的是 A→B→A 的无限环，不是一跳中转。
func TestRelayHopAllowsExactlyOneCrossMachineHop(t *testing.T) {
	if MaxRelayHops != 1 {
		t.Fatalf("MaxRelayHops = %d, want 1", MaxRelayHops)
	}
	cases := []struct {
		header string
		want   int
	}{
		{"", 0},
		{"0", 0},
		{"1", 1},
		{"2", 2},
		{"abc", 0}, // 非法按 0
		{"-1", 0},  // 负数按 0
		{" 1 ", 1}, // 容忍首尾空白
	}
	for _, c := range cases {
		header := http.Header{}
		if c.header != "" {
			header.Set(HopHeader, c.header)
		}
		if got := RelayHop(header); got != c.want {
			t.Errorf("RelayHop(%q) = %d, want %d", c.header, got, c.want)
		}
	}

	// 上限判定：一跳放行，两跳判环。
	atLimit := http.Header{}
	atLimit.Set(HopHeader, strconv.Itoa(MaxRelayHops))
	if RelayHop(atLimit) > MaxRelayHops {
		t.Error("one hop must be allowed (cross-machine relay)")
	}
	overLimit := http.Header{}
	overLimit.Set(HopHeader, strconv.Itoa(MaxRelayHops+1))
	if RelayHop(overLimit) <= MaxRelayHops {
		t.Error("two hops must be rejected as a loop")
	}
}
