package webuisessioneventsapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileReaderRejectsNonCodex(t *testing.T) {
	reader := &FileReader{HostHomeDir: t.TempDir()}
	_, err := reader.ReadEvents(context.Background(), EventRequest{Provider: "unknown", SessionID: "s1"})
	if err != ErrUnsupportedProvider {
		t.Fatalf("error = %v, want ErrUnsupportedProvider", err)
	}
}

func TestFileReaderMissingSession(t *testing.T) {
	reader := &FileReader{HostHomeDir: t.TempDir()}
	// Go 找不到 rollout 时必须显式报错：Node 的 state DB 可能定位到别的路径，
	// 返回空事件会把真实增量吞掉。
	if _, err := reader.ReadEvents(context.Background(), EventRequest{Provider: "codex", SessionID: "missing"}); err != ErrSessionNotFound {
		t.Fatalf("error = %v, want ErrSessionNotFound", err)
	}
}

func TestFileReaderInlinesAbsoluteImage(t *testing.T) {
	home := t.TempDir()
	sessionID := "11111111-2222-4333-8444-555555555555"
	imagePath := filepath.Join(home, "shot.png")
	imageBytes := []byte{0x89, 0x50, 0x4e, 0x47}
	if err := os.WriteFile(imagePath, imageBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	textPath := filepath.Join(home, "note.txt")
	if err := os.WriteFile(textPath, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	record := map[string]any{
		"type":      "event_msg",
		"timestamp": "2026-11-12T10:00:00.000Z",
		"payload": map[string]any{
			"type":         "user_message",
			"message":      "see image",
			"local_images": []any{imagePath, textPath},
		},
	}
	content, _ := json.Marshal(record)
	writeCodexRollout(t, home, sessionID, string(content)+"\n")

	reader := &FileReader{HostHomeDir: home}
	result, err := reader.ReadEvents(context.Background(), EventRequest{Provider: "codex", SessionID: sessionID})
	if err != nil {
		t.Fatalf("ReadEvents() error = %v", err)
	}
	if len(result.Events) != 1 {
		t.Fatalf("events = %#v", result.Events)
	}
	images := result.Events[0].Images
	if len(images) != 2 {
		t.Fatalf("images = %#v", images)
	}
	wantImage := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageBytes)
	if images[0] != wantImage {
		t.Fatalf("image = %q, want %q", images[0], wantImage)
	}
	if images[1] != textPath {
		t.Fatalf("非图片文件应原样保留: %q", images[1])
	}
}

func TestCodexEventOverflowRequiresSnapshot(t *testing.T) {
	home := t.TempDir()
	sessionID := "11111111-2222-4333-8444-666666666666"
	record := map[string]any{
		"type":      "response_item",
		"timestamp": "2026-11-12T10:00:00.000Z",
		"payload": map[string]any{
			"role":    "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": strings.Repeat("x", 512)}},
		},
	}
	content, _ := json.Marshal(record)
	writeCodexRollout(t, home, sessionID, string(content)+"\n")

	reader := &FileReader{HostHomeDir: home, MaxEventBytes: 128}
	result, err := reader.ReadEvents(context.Background(), EventRequest{Provider: "codex", SessionID: sessionID})
	if err != nil {
		t.Fatalf("ReadEvents() error = %v", err)
	}
	if len(result.Events) != 0 {
		t.Fatalf("溢出后不应返回半截事件: %#v", result.Events)
	}
	if result.RequiresSnapshot == nil || !*result.RequiresSnapshot {
		t.Fatalf("溢出必须要求 snapshot")
	}
	if result.Cursor != int64(len(content)+1) {
		t.Fatalf("cursor = %d, want %d", result.Cursor, len(content)+1)
	}
}

func TestCleanCodexExecCommandOutputFallback(t *testing.T) {
	input := "line-1\r\nOutput: first\r\nsecond\r\n"
	got := cleanCodexExecCommandOutput(input)
	if got != "first\nsecond" {
		t.Fatalf("got %q", got)
	}
	chunked := "noise\nChunk ID: a\nOutput: alpha\nbeta\nChunk ID: b\nignored\nChunk ID: c\nOutput: gamma\n"
	if got := cleanCodexExecCommandOutput(chunked); got != "alpha\nbeta\n\ngamma" {
		t.Fatalf("chunked got %q", got)
	}
}

func TestNormalizeFunctionCallSkipsInteractiveTools(t *testing.T) {
	for _, name := range []string{"write_stdin", "send_input", "resize_run_terminal", "read_thread_terminal"} {
		if _, ok := normalizeCodexFunctionCall(map[string]any{"name": name, "arguments": "{}"}, nil); ok {
			t.Fatalf("%s 应被跳过", name)
		}
	}
}
