package webuisessionwatchapi

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
)

type stubAuthorizer struct {
	allow bool
}

func (auth stubAuthorizer) Authorized(*http.Request) bool {
	return auth.allow
}

func TestSessionWatchValidationAndAuth(t *testing.T) {
	bus := sessionevents.NewBus(sessionevents.BusOptions{})
	defer bus.Close()

	unauthHandler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: false}, Bus: bus})
	if err != nil {
		t.Fatal(err)
	}
	unauthRec := httptest.NewRecorder()
	unauthReq := httptest.NewRequest(http.MethodGet, Path+"?provider=claude&sessionId=s1", nil)
	unauthHandler.ServeHTTP(unauthRec, unauthReq)
	if unauthRec.Code != http.StatusUnauthorized {
		t.Fatalf("未鉴权状态码 = %d, want 401", unauthRec.Code)
	}

	handler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: true}, Bus: bus})
	if err != nil {
		t.Fatal(err)
	}
	badMethodRec := httptest.NewRecorder()
	handler.ServeHTTP(badMethodRec, httptest.NewRequest(http.MethodPost, Path, nil))
	if badMethodRec.Code != http.StatusMethodNotAllowed || badMethodRec.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("方法校验失败: code=%d allow=%q", badMethodRec.Code, badMethodRec.Header().Get("Allow"))
	}

	missingRec := httptest.NewRecorder()
	handler.ServeHTTP(missingRec, httptest.NewRequest(http.MethodGet, Path+"?provider=claude", nil))
	if missingRec.Code != http.StatusBadRequest {
		t.Fatalf("缺参状态码 = %d, want 400", missingRec.Code)
	}
	var errBody map[string]any
	if err := json.Unmarshal(missingRec.Body.Bytes(), &errBody); err != nil || errBody["error"] != "missing_params" {
		t.Fatalf("缺参响应体异常: %v", errBody)
	}
}

func TestSessionWatchSSEConnectedPublishedUpdateAndFileChange(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := t.TempDir()
	projDir := filepath.Join(hostHome, ".claude", "projects", "proj-a")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(projDir, "sess-watch.jsonl")
	if err := os.WriteFile(transcript, []byte(`{"type":"user"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	bus := sessionevents.NewBus(sessionevents.BusOptions{
		HostHomeDir: hostHome,
		AIHomeDir:   aiHome,
		Debounce:    20 * time.Millisecond,
	})
	defer bus.Close()

	handler, err := NewHandler(Dependencies{
		Authorizer:        stubAuthorizer{allow: true},
		Bus:               bus,
		HostHomeDir:       hostHome,
		AIHomeDir:         aiHome,
		HeartbeatInterval: 40 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(handler)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+Path+"?provider=claude&sessionId=sess-watch&projectDirName=proj-a", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("SSE 响应头异常: status=%d ct=%q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}

	scanner := bufio.NewScanner(resp.Body)
	readDataFrame := func() map[string]any {
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var payload map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload); err != nil {
				t.Fatalf("解析 SSE data 失败: %v (line=%q)", err, line)
			}
			return payload
		}
		t.Fatalf("SSE 流提前结束: err=%v", scanner.Err())
		return nil
	}

	first := readDataFrame()
	if first["type"] != "connected" {
		t.Fatalf("首帧应为 connected，got=%v", first)
	}

	projectedPath := filepath.Join(aiHome, "run", "auth-projections", "claude", "acct_1111", ".claude", "projects", "proj-a")
	wantPath := filepath.Join(hostHome, ".claude", "projects", "proj-a")
	bus.Publish(sessionevents.Session{
		Provider:       "claude",
		SessionID:      "sess-watch",
		ProjectDirName: "proj-a",
		ProjectPath:    projectedPath,
	}, sessionevents.Event{
		Type:      "session:turn-completed",
		Source:    "official-hook",
		EventName: "Stop",
		Phase:     "turn-completed",
		RunID:     "run-42",
	})

	second := readDataFrame()
	if second["type"] != "update" || second["eventType"] != "session:turn-completed" || second["runId"] != "run-42" || second["projectPath"] != wantPath {
		t.Fatalf("推送 update 帧不符: %v", second)
	}

	// 验证 fsnotify 文件追加也会收到 file-changed update 帧
	f, err := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"type":"assistant"}` + "\n")
	_ = f.Close()

	third := readDataFrame()
	if third["type"] != "update" || third["eventType"] != "session:file-changed" || third["source"] != "watcher" {
		t.Fatalf("文件变更 update 帧不符: %v", third)
	}
}
