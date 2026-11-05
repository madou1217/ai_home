package zcoderelay

import (
	"encoding/json"
	"strings"
	"testing"
)

func officialBlocks() []map[string]any {
	body := strings.Repeat("official harness rule. ", 40)
	return []map[string]any{
		{"type": "text", "text": "You are ZCode."},
		{"type": "text", "text": body, "cache_control": map[string]any{"type": "ephemeral"}},
	}
}

func TestApplyHarnessMovesClientSystemIntoReminder(t *testing.T) {
	body := []byte(`{"model":"glm-5.3","system":"client rules","messages":[{"role":"user","content":"hi"}],"max_tokens":9007199254740993}`)
	out := ApplyHarness(body, HarnessInput{
		Blocks:    officialBlocks(),
		DeviceMid: "mid-1",
		SessionID: "sess-1",
	})
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("输出不是 JSON: %v", err)
	}
	system, ok := parsed["system"].([]any)
	if !ok || len(system) != 2 {
		t.Fatalf("system 必须换成官方 harness: %#v", parsed["system"])
	}
	messages, ok := parsed["messages"].([]any)
	if !ok || len(messages) != 2 {
		t.Fatalf("客户端 system 必须搬进 messages: %#v", parsed["messages"])
	}
	first, _ := messages[0].(map[string]any)
	content, _ := first["content"].(string)
	if !strings.Contains(content, "client rules") || !strings.HasPrefix(content, "<system-reminder>") {
		t.Fatalf("reminder 内容不对: %q", content)
	}
	metadata, _ := parsed["metadata"].(map[string]any)
	userID, _ := metadata["user_id"].(string)
	if !strings.Contains(userID, "mid-1") || !strings.Contains(userID, "sess-1") {
		t.Fatalf("metadata.user_id 缺少设备/会话: %s", userID)
	}
	// UseNumber：大整数不能被 float64 改写。
	if !strings.Contains(string(out), "9007199254740993") {
		t.Fatalf("大整数被改写: %s", string(out))
	}
}

func TestApplyHarnessKeepsOfficialRequestByteIdentical(t *testing.T) {
	blocks := officialBlocks()
	body, err := json.Marshal(map[string]any{
		"model":    "glm-5.3",
		"system":   []any{blocks[0], blocks[1]},
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	out := ApplyHarness(body, HarnessInput{Blocks: blocks, DeviceMid: "mid"})
	if string(out) != string(body) {
		t.Fatal("官方 harness 请求必须逐字节不变")
	}
}

func TestApplyHarnessFailSoft(t *testing.T) {
	for _, body := range [][]byte{
		[]byte("not json"),
		[]byte("[]"),
	} {
		if out := ApplyHarness(body, HarnessInput{Blocks: officialBlocks()}); string(out) != string(body) {
			t.Fatalf("无效输入必须原样返回: %s", string(out))
		}
	}
	// system 不是字符串/块数组时，Node 语义也是「换成官方 harness」而不是原样返回。
	if out := ApplyHarness([]byte(`{"system":42}`), HarnessInput{Blocks: officialBlocks()}); !strings.Contains(string(out), "official harness rule") {
		t.Fatalf("非文本 system 也必须换成官方 harness: %s", string(out))
	}
	if out := ApplyHarness([]byte(`{"system":"x"}`), HarnessInput{}); string(out) != `{"system":"x"}` {
		t.Fatal("没有 harness 块时不应改写")
	}
}

func TestBuildUserIDKeepsExistingDevice(t *testing.T) {
	metadata := map[string]any{"user_id": `{"device_id":"official","session_id":""}`}
	email := buildUserID(metadata, HarnessInput{DeviceMid: "mid", SessionID: "sess", AccountUUID: "acct"})
	if !strings.Contains(email, `"device_id":"official"`) {
		t.Fatalf("已有 device_id 必须保留: %s", email)
	}
	if !strings.Contains(email, `"session_id":"sess"`) {
		t.Fatalf("缺失的 session_id 必须补齐: %s", email)
	}
}

func TestLooksLikeHarnessRejectsShortBody(t *testing.T) {
	if LooksLikeHarness([]any{"identity", "short"}) {
		t.Fatal("harness 正文太短时不应判定为官方 harness")
	}
	if !LooksLikeHarness([]any{officialBlocks()[0], officialBlocks()[1]}) {
		t.Fatal("合法 harness 应被识别")
	}
}
