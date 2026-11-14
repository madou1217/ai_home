package webuiaccountliveapi

import (
	"strings"
	"testing"
	"time"
)

// TestHubPublishRejectsInvalidEvents 外部注入不得覆盖 Go 自己推导的快照/账号行。
func TestHubPublishRejectsInvalidEvents(t *testing.T) {
	hub := &Hub{subs: map[*subscriber]struct{}{}}
	for _, event := range []map[string]any{
		nil,
		{"type": ""},
		{"type": "snapshot"},
		{"type": "account"},
	} {
		if err := hub.Publish(event); err == nil {
			t.Fatalf("Publish(%v) 未报错", event)
		}
	}
}

// TestHubPublishBroadcastsWithRevision 合法事件应带 hub 当前 revision 广播给订阅者。
func TestHubPublishBroadcastsWithRevision(t *testing.T) {
	hub := &Hub{subs: map[*subscriber]struct{}{}, revision: 7}
	sub := newSubscriber()
	hub.subs[sub] = struct{}{}

	if err := hub.Publish(map[string]any{
		"type":       "token-consumed",
		"provider":   "codex",
		"accountRef": "acct_x",
		"tokens":     map[string]any{"input": 1, "output": 2, "total": 3},
	}); err != nil {
		t.Fatalf("Publish 失败: %v", err)
	}

	select {
	case frame := <-sub.events:
		text := string(frame)
		if !strings.HasPrefix(text, "data: ") || !strings.HasSuffix(text, "\n\n") {
			t.Fatalf("帧格式 = %q", text)
		}
		if !strings.Contains(text, `"type":"token-consumed"`) {
			t.Fatalf("帧缺少 type: %s", text)
		}
		if !strings.Contains(text, `"revision":7`) {
			t.Fatalf("帧缺少 revision: %s", text)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("订阅者未收到事件")
	}
}
