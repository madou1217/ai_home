package webuisessionmessagesapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeClaudeParitySession(t *testing.T, records ...map[string]any) (string, string, string) {
	t.Helper()
	home := t.TempDir()
	projectDirName := "-tmp-claude-parity"
	sessionID := "session-1"
	path := filepath.Join(home, ".claude", "projects", projectDirName, sessionID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	var content strings.Builder
	for _, record := range records {
		raw, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		content.Write(raw)
		content.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(content.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	return home, projectDirName, sessionID
}

func claudeTranscriptRecord(recordType, uuid, parentUUID, requestID, timestamp string, content any) map[string]any {
	return map[string]any{
		"type":       recordType,
		"uuid":       uuid,
		"parentUuid": parentUUID,
		"requestId":  requestID,
		"timestamp":  timestamp,
		"message": map[string]any{
			"role":    recordType,
			"content": content,
		},
	}
}

func claudeAssistantTextRecord(uuid, parentUUID, requestID, timestamp, text, model string) map[string]any {
	record := claudeTranscriptRecord("assistant", uuid, parentUUID, requestID, timestamp, []any{
		map[string]any{"type": "text", "text": text},
	})
	record["message"].(map[string]any)["model"] = model
	return record
}

func decodeClaudeParityMessages(t *testing.T, messages []json.RawMessage) []map[string]any {
	t.Helper()
	decoded := make([]map[string]any, 0, len(messages))
	for _, raw := range messages {
		var message map[string]any
		if err := json.Unmarshal(raw, &message); err != nil {
			t.Fatal(err)
		}
		decoded = append(decoded, message)
	}
	return decoded
}

func TestReadClaudeMessagesDoesNotMergeAcrossRequestBoundaries(t *testing.T) {
	home, projectDirName, sessionID := writeClaudeParitySession(t,
		claudeTranscriptRecord("user", "u1", "", "", "2026-10-29T11:32:13.031Z", "hello"),
		claudeAssistantTextRecord("a1", "u1", "request-1", "2026-10-29T11:32:24.000Z", "first answer", "claude-opus-5.5"),
		claudeAssistantTextRecord("a2", "a1", "request-2", "2026-10-29T11:32:25.000Z", "API Error: 503", "claude-opus-5.5"),
	)
	messages, err := readClaudeMessages(home, projectDirName, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	decoded := decodeClaudeParityMessages(t, messages)
	if len(decoded) != 3 {
		t.Fatalf("messages=%d %+v", len(decoded), decoded)
	}
	if decoded[1]["content"] != "first answer" || decoded[2]["content"] != "API Error: 503" {
		t.Fatalf("assistant messages=%+v", decoded[1:])
	}
}

func TestReadClaudeMessagesMergesSameRequestBoundary(t *testing.T) {
	home, projectDirName, sessionID := writeClaudeParitySession(t,
		claudeTranscriptRecord("user", "u1", "", "", "2026-10-29T11:32:13.031Z", "hello"),
		claudeAssistantTextRecord("a1", "u1", "request-1", "2026-10-29T11:32:24.000Z", "part one", "claude-opus-5.5"),
		claudeAssistantTextRecord("a2", "a1", "request-1", "2026-10-29T11:32:24.500Z", "part two", ""),
	)
	messages, err := readClaudeMessages(home, projectDirName, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	decoded := decodeClaudeParityMessages(t, messages)
	if len(decoded) != 2 {
		t.Fatalf("messages=%d %+v", len(decoded), decoded)
	}
	if decoded[1]["content"] != "part one\n\npart two" {
		t.Fatalf("content=%q", decoded[1]["content"])
	}
	if _, ok := decoded[1]["images"]; !ok {
		t.Fatalf("merged assistant should carry images like Node: %+v", decoded[1])
	}
}

func TestReadClaudeMessagesKeepsCommandEchoInsideToolResult(t *testing.T) {
	home, projectDirName, sessionID := writeClaudeParitySession(t,
		claudeTranscriptRecord("user", "u1", "", "", "2026-10-29T11:32:13.031Z", "hello"),
		func() map[string]any {
			record := claudeTranscriptRecord("assistant", "a1", "u1", "request-1", "2026-10-29T11:32:24.000Z", []any{
				map[string]any{"type": "tool_use", "id": "tool-1", "name": "Bash", "input": map[string]any{"command": "cat notes.txt"}},
			})
			record["message"].(map[string]any)["model"] = "claude-opus-5.5"
			return record
		}(),
		claudeTranscriptRecord("user", "u2", "a1", "", "2026-10-29T11:32:25.000Z", []any{
			map[string]any{"type": "tool_result", "tool_use_id": "tool-1", "content": "prefix <command-name>/goal</command-name> suffix"},
		}),
		claudeAssistantTextRecord("a2", "u2", "request-2", "2026-10-29T11:32:26.000Z", "done", "claude-opus-5.5"),
	)
	messages, err := readClaudeMessages(home, projectDirName, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	decoded := decodeClaudeParityMessages(t, messages)
	if len(decoded) != 3 {
		t.Fatalf("messages=%d %+v", len(decoded), decoded)
	}
	content, _ := decoded[1]["content"].(string)
	if !strings.Contains(content, "<command-name>/goal</command-name>") || !strings.Contains(content, "cat notes.txt") {
		t.Fatalf("tool turn content=%q", content)
	}
	if decoded[2]["content"] != "done" {
		t.Fatalf("assistant=%+v", decoded[2])
	}
}

func TestReadClaudeMessagesStripsPairedSystemReminderBlocks(t *testing.T) {
	home, projectDirName, sessionID := writeClaudeParitySession(t,
		claudeTranscriptRecord("user", "u1", "", "", "2026-10-29T11:32:13.031Z", "hello"),
		claudeAssistantTextRecord("a1", "u1", "request-1", "2026-10-29T11:32:24.000Z", "before", "claude-opus-5.5"),
		func() map[string]any {
			record := claudeTranscriptRecord("assistant", "a2", "a1", "request-1", "2026-10-29T11:32:24.500Z", []any{
				map[string]any{"type": "tool_use", "id": "tool-1", "name": "Read", "input": map[string]any{"file_path": "/tmp/empty.output"}},
			})
			record["message"].(map[string]any)["model"] = "claude-opus-5.5"
			return record
		}(),
		claudeTranscriptRecord("user", "u2", "a2", "", "2026-10-29T11:32:25.000Z", []any{
			map[string]any{"type": "tool_result", "tool_use_id": "tool-1", "content": "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"},
		}),
	)
	messages, err := readClaudeMessages(home, projectDirName, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	decoded := decodeClaudeParityMessages(t, messages)
	if len(decoded) != 2 {
		t.Fatalf("messages=%d %+v", len(decoded), decoded)
	}
	content, _ := decoded[1]["content"].(string)
	want := "before\n\n:::tool{name=\"Read\"}\n/tmp/empty.output\n:::\n\n:::tool-result\n\n:::"
	if content != want {
		t.Fatalf("content=%q want=%q", content, want)
	}
}

func TestReadClaudeMessagesMergesAdjacentUserTranscripts(t *testing.T) {
	home, projectDirName, sessionID := writeClaudeParitySession(t,
		claudeTranscriptRecord("user", "u1", "", "", "2026-10-29T11:32:13.031Z", "hello"),
		claudeTranscriptRecord("user", "u2", "u1", "", "2026-10-29T11:32:13.500Z", "hello"),
	)
	messages, err := readClaudeMessages(home, projectDirName, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	decoded := decodeClaudeParityMessages(t, messages)
	if len(decoded) != 1 {
		t.Fatalf("messages=%d %+v", len(decoded), decoded)
	}
	if decoded[0]["content"] != "hello" {
		t.Fatalf("content=%q", decoded[0]["content"])
	}
	if _, ok := decoded[0]["images"]; !ok {
		t.Fatalf("merged user should carry images like Node: %+v", decoded[0])
	}
}
func TestHandlerServesClaudeProjectDirNameMessages(t *testing.T) {
	home, projectDirName, sessionID := writeClaudeParitySession(t,
		claudeTranscriptRecord("user", "u1", "", "", "2026-10-29T11:32:13.031Z", "hello"),
		claudeAssistantTextRecord("a1", "u1", "request-1", "2026-10-29T11:32:24.000Z", "world", "claude-opus-5.5"),
	)
	handler, err := NewHandler(Dependencies{Authorizer: allowAuth{}, HostHomeDir: home})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	mux := http.NewServeMux()
	mux.Handle("GET "+Path, handler)
	request := httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/claude/"+sessionID+"/messages?projectDirName="+projectDirName, nil)
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		OK       bool              `json:"ok"`
		Messages []json.RawMessage `json:"messages"`
		Total    int               `json:"total"`
		Cursor   int64             `json:"cursor"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Total != 2 || len(body.Messages) != 2 || body.Cursor <= 0 {
		t.Fatalf("body=%+v", body)
	}
}
