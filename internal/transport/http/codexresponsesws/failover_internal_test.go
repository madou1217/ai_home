package codexresponsesws

import (
	"encoding/json"
	"testing"
	"time"
)

// 换号后旧账号的 reasoning.encrypted_content 新账号解不开（400 invalid_encrypted_content）：
// 完整上下文请求里剥掉，增量请求（previous_response_id）引用本连接同账号的响应，保持不动。
func TestStripForeignReasoningOnlyTouchesFullContextRequests(t *testing.T) {
	full := []byte(`{"type":"response.create","model":"m","input":[{"type":"message","role":"user","content":"hi"},{"type":"reasoning","summary":[],"encrypted_content":"enc"}]}`)
	var stripped struct {
		Input []map[string]any `json:"input"`
	}
	if err := json.Unmarshal(stripForeignReasoning(full), &stripped); err != nil {
		t.Fatal(err)
	}
	if _, ok := stripped.Input[1]["encrypted_content"]; ok || stripped.Input[0]["content"] != "hi" {
		t.Fatalf("stripped input = %v", stripped.Input)
	}
	incremental := []byte(`{"type":"response.create","previous_response_id":"resp_1","input":[{"type":"reasoning","encrypted_content":"enc"}]}`)
	if string(stripForeignReasoning(incremental)) != string(incremental) {
		t.Fatal("incremental request must stay byte-identical")
	}
}

func TestSessionAccountsReportsTheAccountThatServedLastTime(t *testing.T) {
	registry := newSessionAccounts()
	now := time.Date(2026, 10, 2, 9, 0, 0, 0, time.UTC)
	if _, found := registry.Swap("session-1", "acct_a", now); found {
		t.Fatal("first connection has no previous account")
	}
	if previous, found := registry.Swap("session-1", "acct_b", now.Add(time.Minute)); !found || previous != "acct_a" {
		t.Fatalf("previous = %v %v", previous, found)
	}
	if _, found := registry.Swap("session-1", "acct_c", now.Add(sessionAccountTTL+2*time.Minute)); found {
		t.Fatal("expired entries are not reported")
	}
	if _, found := registry.Swap("", "acct_a", now); found {
		t.Fatal("sessions without an id are not tracked")
	}
}
