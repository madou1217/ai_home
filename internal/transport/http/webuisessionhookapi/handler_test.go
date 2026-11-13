package webuisessionhookapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
)

type stubAuth struct{ allow bool }

func (s stubAuth) Authorized(*http.Request) bool { return s.allow }

type spyActivity struct {
	marked []string
	ended  []string
}

func (s *spyActivity) MarkSessionTurn(provider, ref string) {
	s.marked = append(s.marked, provider+":"+ref)
}
func (s *spyActivity) EndSessionTurn(provider, ref string) {
	s.ended = append(s.ended, provider+":"+ref)
}

type spyOutcomes struct {
	recorded []string
}

func (s *spyOutcomes) RecordHookOutcome(_ context.Context, provider, ref, outcome string, _ time.Time) {
	s.recorded = append(s.recorded, provider+":"+ref+":"+outcome)
}

type spyRecoverer struct {
	recovered bool
	calls     []string
}

func (s *spyRecoverer) RecoverOnHookSuccess(_ context.Context, provider, ref string, _ int64) bool {
	s.calls = append(s.calls, provider+":"+ref)
	return s.recovered
}

func doHookPost(handler http.Handler, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestProviderHookValidationAndAuth(t *testing.T) {
	bus := sessionevents.NewBus(sessionevents.BusOptions{})
	defer bus.Close()
	store := sessionevents.NewStateStore(sessionevents.StateStoreOptions{AIHomeDir: t.TempDir()})

	unauth, err := NewHandler(Dependencies{Authorizer: stubAuth{allow: false}, Bus: bus, StateStore: store})
	if err != nil {
		t.Fatal(err)
	}
	if rec := doHookPost(unauth, Path, `{}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("未鉴权状态码 = %d, want 401", rec.Code)
	}

	handler, err := NewHandler(Dependencies{Authorizer: stubAuth{allow: true}, Bus: bus, StateStore: store})
	if err != nil {
		t.Fatal(err)
	}
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, httptest.NewRequest(http.MethodGet, Path, nil))
	if getRec.Code != http.StatusMethodNotAllowed || getRec.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("方法校验失败: %d allow=%q", getRec.Code, getRec.Header().Get("Allow"))
	}

	for _, badBody := range []string{"", "[]", `"str"`, "{bad"} {
		rec := doHookPost(handler, Path, badBody)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body=%q 状态码 = %d, want 400", badBody, rec.Code)
		}
	}
}

func TestProviderHookIngestStateSideEffectsAndBroadcast(t *testing.T) {
	aiHome := t.TempDir()
	bus := sessionevents.NewBus(sessionevents.BusOptions{AIHomeDir: aiHome})
	defer bus.Close()
	now := int64(1700000200000)
	store := sessionevents.NewStateStore(sessionevents.StateStoreOptions{
		AIHomeDir: aiHome,
		Now:       func() time.Time { return time.UnixMilli(now) },
	})
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}

	// 准备 codex persistent-sessions 项，验证 correlationId 自动回写 nativeSessionId
	psDir := filepath.Join(aiHome, "run", "persistent-sessions")
	if err := os.MkdirAll(psDir, 0o700); err != nil {
		t.Fatal(err)
	}
	psPath := filepath.Join(psDir, "sock1--sess1.json")
	if err := os.WriteFile(psPath, []byte(`{"provider":"codex","socket":"sock1","session":"sess1","correlationId":"corr-codex-1","nativeSessionId":""}`), 0o600); err != nil {
		t.Fatal(err)
	}

	activity := &spyActivity{}
	outcomes := &spyOutcomes{}
	recoverer := &spyRecoverer{recovered: true}
	handler, err := NewHandler(Dependencies{
		Authorizer:       stubAuth{allow: true},
		Bus:              bus,
		StateStore:       store,
		Catalog:          catalog,
		AIHomeDir:        aiHome,
		Now:              func() time.Time { return time.UnixMilli(now) },
		AccountActivity:  activity,
		OutcomeRecorder:  outcomes,
		RuntimeRecoverer: recoverer,
	})
	if err != nil {
		t.Fatal(err)
	}

	subCh, _, unsub := bus.Subscribe(sessionevents.Session{Provider: "codex", SessionID: "thread-99"}, false)
	defer unsub()

	acct := "acct_0123456789abcdef0123"
	// 1. 回合开始：应标记 alive + 绑定 correlationId + 广播
	startRec := doHookPost(handler, Path, `{"provider":"codex","sessionId":"thread-99","eventName":"AppServerTurnStarted","correlationId":"corr-codex-1","accountRef":"`+acct+`","projectPath":"/tmp/demo"}`)
	if startRec.Code != http.StatusOK {
		t.Fatalf("TurnStarted 状态码 = %d, body=%s", startRec.Code, startRec.Body.String())
	}
	select {
	case ev := <-subCh:
		if ev.Type != "session:turn-started" || ev.EventName != "AppServerTurnStarted" {
			t.Fatalf("广播事件不符: %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("未收到 session:turn-started 广播")
	}

	// 验证 persistent-sessions 已被回写 nativeSessionId
	rawPS, err := os.ReadFile(psPath)
	if err != nil {
		t.Fatal(err)
	}
	var psDoc map[string]any
	if err := json.Unmarshal(rawPS, &psDoc); err != nil || psDoc["nativeSessionId"] != "thread-99" {
		t.Fatalf("persistent-sessions 未正确回写 nativeSessionId: %s", string(rawPS))
	}

	// 2. AihRetryStatus 广播并落入 state.retry
	retryRec := doHookPost(handler, Path, `{"eventName":"AihRetryStatus","correlationId":"corr-codex-1","retryStatus":{"attempt":2,"maxAttempts":4,"retryAfterMs":1200,"status":429,"reason":"rate_limit"}}`)
	if retryRec.Code != http.StatusOK {
		t.Fatalf("AihRetryStatus 状态码 = %d, body=%s", retryRec.Code, retryRec.Body.String())
	}
	select {
	case ev := <-subCh:
		if ev.Type != "session:retry-status" || ev.RetryStatus == nil || ev.RetryStatus.Attempt != 2 {
			t.Fatalf("重试广播事件不符: %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("未收到 retry-status 广播")
	}

	// 3. AihCliInteractionSync 提问与清除
	askRec := doHookPost(handler, Path, `{"eventName":"AihCliInteractionSync","correlationId":"corr-codex-1","promptRevision":1,"prompt":{"promptId":"p1","question":"Continue?","options":[{"value":"yes"},{"value":"no"}]}}`)
	if askRec.Code != http.StatusOK {
		t.Fatalf("InteractionSync ask 状态码 = %d, body=%s", askRec.Code, askRec.Body.String())
	}
	select {
	case ev := <-subCh:
		if ev.Type != "session:question-opened" || ev.PromptID != "p1" {
			t.Fatalf("question-opened 广播不符: %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("未收到 question-opened 广播")
	}

	// 4. Turn completed -> 结束活跃、记录 success 结果、触发 runtimeRecovered
	stopRec := doHookPost(handler, Path, `{"provider":"codex","sessionId":"thread-99","eventName":"AppServerTurnCompleted","correlationId":"corr-codex-1","accountRef":"`+acct+`","projectPath":"/tmp/demo"}`)
	if stopRec.Code != http.StatusOK {
		t.Fatalf("TurnCompleted 状态码 = %d, body=%s", stopRec.Code, stopRec.Body.String())
	}
	var stopResp map[string]any
	if err := json.Unmarshal(stopRec.Body.Bytes(), &stopResp); err != nil {
		t.Fatal(err)
	}
	if stopResp["published"] != true || stopResp["runtimeRecovered"] != true {
		t.Fatalf("TurnCompleted 响应字段不符: %v", stopResp)
	}
	if len(activity.marked) != 1 || len(activity.ended) != 1 || len(outcomes.recorded) != 1 || outcomes.recorded[0] != "codex:"+acct+":success" {
		t.Fatalf("旁路回调不符: marked=%v ended=%v outcomes=%v", activity.marked, activity.ended, outcomes.recorded)
	}

	// 验证磁盘快照存在且状态为 completed
	sum := sha256.Sum256([]byte(`{"provider":"codex","sessionId":"thread-99","projectPath":"/tmp/demo","projectDirName":""}`))
	stateFile := filepath.Join(aiHome, "run", "provider-session-state", hex.EncodeToString(sum[:])+".json")
	if _, err := os.Stat(stateFile); err != nil {
		t.Fatalf("状态文件应已创建 %s: %v", stateFile, err)
	}

	// 5. correlation 冲突与未就绪返回 409
	conflictRec := doHookPost(handler, Path, `{"provider":"codex","sessionId":"other-thread","eventName":"Stop","correlationId":"corr-codex-1"}`)
	if conflictRec.Code != http.StatusConflict {
		t.Fatalf("冲突应返回 409, got=%d", conflictRec.Code)
	}
	notReadyRec := doHookPost(handler, Path, `{"eventName":"AihRetryStatus","correlationId":"corr-unknown"}`)
	if notReadyRec.Code != http.StatusConflict {
		t.Fatalf("未就绪应返回 409, got=%d", notReadyRec.Code)
	}
}
