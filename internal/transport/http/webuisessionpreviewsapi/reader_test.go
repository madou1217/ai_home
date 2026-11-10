package webuisessionpreviewsapi

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTranscript(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	body := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("写会话文件失败: %v", err)
	}
}

func readPreview(t *testing.T, reader *FileReader, request PreviewRequest) (Preview, error) {
	t.Helper()
	return reader.ReadPreview(context.Background(), request)
}

func TestFileReaderReadsClaudeTranscript(t *testing.T) {
	home := t.TempDir()
	writeTranscript(t, filepath.Join(home, ".claude", "projects", "proj", "s1.jsonl"),
		`{"type":"user","message":{"role":"user","content":"帮我看看这个 bug"}}`,
		`{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-1","content":[{"type":"text","text":"先跑一下单测"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"第一行\n\n  第二行   结束"}]}}`,
	)
	preview, err := readPreview(t, NewFileReader(home), PreviewRequest{
		Provider: "claude", SessionID: "s1", ProjectDirName: "proj",
	})
	if err != nil {
		t.Fatalf("ReadPreview() error = %v", err)
	}
	if preview.Model != "claude-sonnet-4-5" {
		t.Fatalf("model = %q, want 最后出现的 claude-sonnet-4-5", preview.Model)
	}
	if preview.Preview != "第一行 第二行 结束" {
		t.Fatalf("preview = %q, want 折叠空白后的助手文本", preview.Preview)
	}
}

func TestFileReaderFallsBackToLastUserMessage(t *testing.T) {
	home := t.TempDir()
	writeTranscript(t, filepath.Join(home, ".claude", "projects", "proj", "s1.jsonl"),
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"旧回复"}]}}`,
		`{"type":"user","message":{"role":"user","content":"那再试一次"}}`,
	)
	preview, err := readPreview(t, NewFileReader(home), PreviewRequest{
		Provider: "claude", SessionID: "s1", ProjectDirName: "proj",
	})
	if err != nil {
		t.Fatalf("ReadPreview() error = %v", err)
	}
	if preview.Preview != "旧回复" {
		t.Fatalf("preview = %q, want 优先助手文本", preview.Preview)
	}

	// 没有助手文本时才回落到用户消息。
	writeTranscript(t, filepath.Join(home, ".claude", "projects", "proj", "s2.jsonl"),
		`{"type":"user","message":{"role":"user","content":"只有我问的话"}}`,
	)
	preview, err = readPreview(t, NewFileReader(home), PreviewRequest{
		Provider: "claude", SessionID: "s2", ProjectDirName: "proj",
	})
	if err != nil {
		t.Fatalf("ReadPreview() error = %v", err)
	}
	if preview.Preview != "只有我问的话" {
		t.Fatalf("preview = %q, want 回落用户消息", preview.Preview)
	}
}

func TestFileReaderScansProjectDirsWithoutProjectDirName(t *testing.T) {
	home := t.TempDir()
	writeTranscript(t, filepath.Join(home, ".claude", "projects", "-Users-model-projects-other", "s9.jsonl"),
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"模糊定位命中"}]}}`,
	)
	preview, err := readPreview(t, NewFileReader(home), PreviewRequest{Provider: "claude", SessionID: "s9"})
	if err != nil {
		t.Fatalf("ReadPreview() error = %v", err)
	}
	if preview.Preview != "模糊定位命中" {
		t.Fatalf("preview = %q", preview.Preview)
	}
}

func TestFileReaderReadsCodebuddyFamilyRoot(t *testing.T) {
	home := t.TempDir()
	writeTranscript(t, filepath.Join(home, ".workbuddy-ai", "projects", "proj", "w1.jsonl"),
		`{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-5","content":"家族会话"}}`,
	)
	preview, err := readPreview(t, NewFileReader(home), PreviewRequest{
		Provider: "workbuddy", SessionID: "w1", ProjectDirName: "proj",
	})
	if err != nil {
		t.Fatalf("ReadPreview() error = %v", err)
	}
	if preview.Model != "claude-sonnet-4-5" || preview.Preview != "家族会话" {
		t.Fatalf("preview = %+v", preview)
	}
}

func TestFileReaderReadsCodexTranscript(t *testing.T) {
	home := t.TempDir()
	const sessionID = "01a1a68a-8bc5-71e1-b284-34145701c47a"
	writeTranscript(t, filepath.Join(home, ".codex", "sessions", "2026", "11", "04",
		"rollout-2026-11-04T20-31-00-"+sessionID+".jsonl"),
		`{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}`,
		`{"type":"event_msg","payload":{"type":"user_message","message":"reply with exactly: PONG"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"PONG"}]}}`,
	)
	preview, err := readPreview(t, NewFileReader(home), PreviewRequest{Provider: "codex", SessionID: sessionID})
	if err != nil {
		t.Fatalf("ReadPreview() error = %v", err)
	}
	if preview.Model != "gpt-6.1-sol" {
		t.Fatalf("model = %q, want gpt-6.1-sol", preview.Model)
	}
	if preview.Preview != "PONG" {
		t.Fatalf("preview = %q, want PONG", preview.Preview)
	}
}

func TestFileReaderRejectsUnsafeRefs(t *testing.T) {
	home := t.TempDir()
	reader := NewFileReader(home)
	cases := []PreviewRequest{
		{Provider: "claude", SessionID: "../../etc/passwd"},
		{Provider: "claude", SessionID: "s1", ProjectDirName: "../.."},
		{Provider: "claude", SessionID: "s1", ProjectDirName: "a/b"},
	}
	for _, request := range cases {
		if _, err := readPreview(t, reader, request); !errors.Is(err, ErrInvalidSessionRef) {
			t.Fatalf("%+v error = %v, want ErrInvalidSessionRef", request, err)
		}
	}
}

func TestFileReaderMissingAndUnsupported(t *testing.T) {
	home := t.TempDir()
	reader := NewFileReader(home)
	if _, err := readPreview(t, reader, PreviewRequest{Provider: "claude", SessionID: "nope", ProjectDirName: "proj"}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("缺失会话 error = %v, want ErrSessionNotFound", err)
	}
	if _, err := readPreview(t, reader, PreviewRequest{Provider: "gemini", SessionID: "g1"}); !errors.Is(err, ErrUnsupportedProvider) {
		t.Fatalf("未承接 Provider error = %v, want ErrUnsupportedProvider", err)
	}
	if _, err := readPreview(t, reader, PreviewRequest{Provider: "claude", SessionID: ""}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("空 sessionId error = %v, want ErrSessionNotFound", err)
	}
}

func TestFileReaderReadsOnlyTailWindow(t *testing.T) {
	home := t.TempDir()
	padding := strings.Repeat("x", 2000)
	writeTranscript(t, filepath.Join(home, ".claude", "projects", "proj", "big.jsonl"),
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"旧回复"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"`+padding+`"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"新回复"}]}}`,
	)
	reader := &FileReader{HostHomeDir: home, MaxFileBytes: 400}
	preview, err := readPreview(t, reader, PreviewRequest{Provider: "claude", SessionID: "big", ProjectDirName: "proj"})
	if err != nil {
		t.Fatalf("ReadPreview() error = %v", err)
	}
	if preview.Preview != "新回复" {
		t.Fatalf("preview = %q, want 只读尾部窗口里的新回复", preview.Preview)
	}
}

func TestFileReaderTruncatesPreviewToRunes(t *testing.T) {
	home := t.TempDir()
	longText := strings.Repeat("预", 200)
	writeTranscript(t, filepath.Join(home, ".claude", "projects", "proj", "long.jsonl"),
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"`+longText+`"}]}}`,
	)
	preview, err := readPreview(t, NewFileReader(home), PreviewRequest{Provider: "claude", SessionID: "long", ProjectDirName: "proj"})
	if err != nil {
		t.Fatalf("ReadPreview() error = %v", err)
	}
	if got := len([]rune(preview.Preview)); got != previewMaxRunes {
		t.Fatalf("preview rune 数 = %d, want %d", got, previewMaxRunes)
	}
}

func TestFileReaderRespectsCancelledContext(t *testing.T) {
	home := t.TempDir()
	writeTranscript(t, filepath.Join(home, ".claude", "projects", "proj", "s1.jsonl"),
		`{"type":"assistant","message":{"role":"assistant","content":"hi"}}`,
	)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewFileReader(home).ReadPreview(ctx, PreviewRequest{Provider: "claude", SessionID: "s1", ProjectDirName: "proj"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestCodexSessionIDFromFileName(t *testing.T) {
	const sessionID = "01a1a68a-8bc5-71e1-b284-34145701c47a"
	if got := codexSessionIDFromFileName("rollout-2026-11-04T20-31-00-" + sessionID + ".jsonl"); got != sessionID {
		t.Fatalf("got %q, want %q", got, sessionID)
	}
	if got := codexSessionIDFromFileName("rollout-2026-11-04T20-31-00.jsonl"); got != "" {
		t.Fatalf("非 UUID 文件名 got %q, want 空", got)
	}
}

func TestHandlerUsesFileReaderWithHostHomeDir(t *testing.T) {
	home := t.TempDir()
	writeTranscript(t, filepath.Join(home, ".claude", "projects", "proj", "s1.jsonl"),
		`{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-1","content":[{"type":"text","text":"真实文件读取"}]}}`,
	)
	handler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer(true), HostHomeDir: home})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := doRequest(t, handler, "POST", `{"sessions":[{"provider":"claude","id":"s1","projectDirName":"proj"}]}`)
	payload := decodeResponse(t, recorder)
	if len(payload.Previews) != 1 {
		t.Fatalf("previews = %+v", payload.Previews)
	}
	item := payload.Previews[0]
	if item.Model != "claude-opus-4-1" || item.Preview != "真实文件读取" || item.Error != "" {
		t.Fatalf("item = %+v", item)
	}
}
