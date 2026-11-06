package codeassist

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

func decodeMessageItemIDs(t *testing.T, responseID string) []string {
	t.Helper()
	var events []inference.StreamEvent
	decoder := newResponseDecoder("gemini-3.5-flash-lite", responseID, func(event inference.StreamEvent) error {
		events = append(events, event)
		return nil
	})
	payload := []byte(`{"response":{"candidates":[{"content":{"parts":[{"text":"Hi"}]},"finishReason":"STOP"}]}}`)
	if err := decoder.Apply(payload); err != nil {
		t.Fatalf("Apply(%q): %v", responseID, err)
	}
	var ids []string
	for _, event := range events {
		if started, ok := event.(inference.OutputItemStartedEvent); ok {
			ids = append(ids, started.ItemID())
		}
	}
	return ids
}

// 回归守卫（2026-11-06）：agy 的 assistant message item id 必须跨 turn 唯一。
// 旧实现每轮第一条消息都叫 agy_message，timeline 按 item id 去重后新回复会
// 合并到旧位置，WebUI 看起来像「没有任何回复」。
func TestMessageItemIDsAreUniquePerResponse(t *testing.T) {
	first := decodeMessageItemIDs(t, "agent/100/first")
	second := decodeMessageItemIDs(t, "agent/200/second")
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("message item counts: first=%v second=%v", first, second)
	}
	if first[0] == second[0] {
		t.Fatalf("item ids collide: %q", first[0])
	}
	if !strings.Contains(first[0], "agent_100_first") || !strings.Contains(second[0], "agent_200_second") {
		t.Fatalf("item ids do not carry response identity: %q %q", first[0], second[0])
	}
}
