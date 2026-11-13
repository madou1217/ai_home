package webuichatapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

type denyAllAuthorizer struct{}

func (denyAllAuthorizer) Authorized(*http.Request) bool { return false }

type runtimeTestAccountPool struct {
	models accountapp.AccountModelCatalog
}

func (p *runtimeTestAccountPool) ListAllAccountModels(_ context.Context) (accountapp.AccountModelCatalog, error) {
	return p.models, nil
}

func (p *runtimeTestAccountPool) ListAccountOverviews(_ context.Context, _ accountapp.OverviewQuery) ([]accountapp.AccountOverview, error) {
	return nil, nil
}

func sseBodyResponse(chunks ...string) *http.Response {
	var buf strings.Builder
	for _, c := range chunks {
		buf.WriteString(c)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream; charset=utf-8"}},
		Body:       io.NopCloser(strings.NewReader(buf.String())),
	}
}

func newCanonicalRuntimeTestRig(t *testing.T, heartbeat time.Duration) (*Handler, *chatruntime.Service, *testUsage, *testAttempts) {
	t.Helper()
	tmp := t.TempDir()
	ref, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	am, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        ref,
		ModelID:           "gpt-4o",
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         time.UnixMilli(1_700_000_000_000),
	})
	if err != nil {
		t.Fatalf("NewAccountModel: %v", err)
	}

	client := &testClient{
		respond: func(_ *http.Request) (*http.Response, error) {
			return sseBodyResponse(
				"data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n",
				"data: {\"choices\":[{\"delta\":{\"content\":\"Go!\"}}]}\n\n",
				"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10}}\n\n",
				"data: [DONE]\n\n",
			), nil
		},
	}
	attempts := &testAttempts{}
	usage := &testUsage{}
	seqClock := int64(1_700_000_000_000)

	handler, err := NewHandler(Dependencies{
		Authorizer:        allowAllAuthorizer{},
		PathPrefix:        ManagementCollectionPath,
		Accounts:          &testAccounts{refs: []accountcore.AccountRef{accountA}},
		Credentials:       &testCredentials{provider: "opencode"},
		Provider:          &testProvider{BaseProvider: relaycore.NewBaseProvider("opencode", "https://upstream.test/v1/chat/completions"), accessToken: "test-token"},
		Client:            client,
		Attempts:          attempts,
		Usage:             usage,
		Clock:             func() time.Time { seqClock += 600; return time.UnixMilli(seqClock) },
		HeartbeatInterval: heartbeat,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	svc, err := chatruntime.NewService(context.Background(), chatruntime.ServiceOptions{
		DBPath:      filepath.Join(tmp, "app-state.db"),
		AIHomeDir:   filepath.Join(tmp, ".ai_home"),
		HostHomeDir: tmp,
		AccountStore: &runtimeTestAccountPool{
			models: accountapp.AccountModelCatalog{
				Sets: []accountapp.AccountModelSet{{
					AccountRef: ref,
					ProviderID: "opencode",
					Models:     []accountapp.AccountModel{am},
				}},
			},
		},
		ChatStreamer:        handler.InProcessChatTurnStreamer(),
		EventRetentionLimit: 3,
		ArtifactReader: chatruntime.ArtifactReaderFunc(func(_ context.Context, artifactID string) (*chatruntime.Artifact, error) {
			if artifactID == "art-1" {
				return &chatruntime.Artifact{ContentType: "text/plain; charset=utf-8", Body: []byte("artifact body")}, nil
			}
			return nil, nil
		}),
	})
	if err != nil {
		t.Fatalf("chatruntime.NewService: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })
	handler.AttachRuntime(svc, nil)
	return handler, svc, usage, attempts
}

func newCanonicalHTTPMux(handler *Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc(strings.TrimSuffix(ManagementCollectionPath, "/"), handler.ServeSessionsCollection)
	mux.Handle(ManagementCollectionPath, handler)
	mux.HandleFunc(ArtifactCollectionPath+"{artifactId}", handler.ServeArtifact)
	return mux
}

func doJSONRequest(t *testing.T, h http.Handler, method, target string, payload any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var bodyReader io.Reader
	if payload != nil {
		switch v := payload.(type) {
		case string:
			bodyReader = strings.NewReader(v)
		default:
			raw, err := json.Marshal(v)
			if err != nil {
				t.Fatalf("marshal payload: %v", err)
			}
			bodyReader = bytes.NewReader(raw)
		}
	}
	req := httptest.NewRequest(method, target, bodyReader)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeJSONBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal response (status=%d): %v body=%s", rec.Code, err, rec.Body.String())
	}
	return out
}

func TestRuntimeRoutesAuthAndLegacyFallback(t *testing.T) {
	// 1. Runtime == nil 保持 legacy 行为 & collection/artifact 返回 503
	r := newRig(t, []accountcore.AccountRef{accountA}, func(_ *http.Request) (*http.Response, error) {
		return sseBodyResponse(
			"data: {\"choices\":[{\"delta\":{\"content\":\"legacy\"}}]}\n\n",
			"data: [DONE]\n\n",
		), nil
	}, nil)

	colRec := doJSONRequest(t, http.HandlerFunc(r.handler.ServeSessionsCollection), http.MethodGet, ManagementCollectionPath, nil, nil)
	if colRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when runtime nil, got %d (%s)", colRec.Code, colRec.Body.String())
	}
	artRec := doJSONRequest(t, http.HandlerFunc(r.handler.ServeArtifact), http.MethodGet, ArtifactCollectionPath+"art-1", nil, nil)
	if artRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when runtime nil, got %d (%s)", artRec.Code, artRec.Body.String())
	}
	legacyRec := doJSONRequest(t, r.handler, http.MethodPost, commandPath, map[string]any{
		"commandId": "cmd-legacy",
		"type":      "turn.submit",
		"payload":   map[string]any{"content": "hi", "model": "gpt-4o"},
	}, nil)
	if legacyRec.Code != http.StatusOK || !strings.Contains(legacyRec.Body.String(), "legacy") {
		t.Fatalf("expected legacy inline SSE 200, got %d (%s)", legacyRec.Code, legacyRec.Body.String())
	}

	// 2. 鉴权拒绝返回 401
	denied, err := NewHandler(Dependencies{
		Authorizer:  denyAllAuthorizer{},
		Accounts:    r.accounts,
		Credentials: r.credentials,
		Provider:    newTestProvider("https://upstream.test/v1/chat/completions"),
		Client:      r.client,
		Attempts:    r.attempts,
		Clock:       func() time.Time { return time.Unix(1_700_000_000, 0) },
	})
	if err != nil {
		t.Fatalf("NewHandler denied: %v", err)
	}
	for _, rec := range []*httptest.ResponseRecorder{
		doJSONRequest(t, http.HandlerFunc(denied.ServeSessionsCollection), http.MethodGet, "/v1/management/webui/chat/sessions", nil, nil),
		doJSONRequest(t, http.HandlerFunc(denied.ServeArtifact), http.MethodGet, ArtifactCollectionPath+"art-1", nil, nil),
		doJSONRequest(t, denied, http.MethodGet, CollectionPath+"s1/snapshot", nil, nil),
	} {
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d (%s)", rec.Code, rec.Body.String())
		}
	}
}

func TestRuntimeRoutesSessionLifecycleTurnAndSSE(t *testing.T) {
	handler, svc, usage, attempts := newCanonicalRuntimeTestRig(t, 25*time.Millisecond)
	mux := newCanonicalHTTPMux(handler)

	// POST /sessions 创建 chat 会话 -> 201
	createRec := doJSONRequest(t, mux, http.MethodPost, "/v1/management/webui/chat/sessions", map[string]any{
		"provider":            "codex",
		"executionAccountRef": "gateway:default",
	}, nil)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("POST /sessions status=%d body=%s", createRec.Code, createRec.Body.String())
	}
	createBody := decodeJSONBody(t, createRec)
	sessMap, _ := createBody["session"].(map[string]any)
	sessionID, _ := sessMap["sessionId"].(string)
	if sessionID == "" {
		t.Fatalf("missing sessionId in %v", createBody)
	}

	// GET /sessions?provider=openai
	listRec := doJSONRequest(t, mux, http.MethodGet, "/v1/management/webui/chat/sessions?provider=codex", nil, nil)
	if listRec.Code != http.StatusOK {
		t.Fatalf("GET /sessions status=%d body=%s", listRec.Code, listRec.Body.String())
	}
	listBody := decodeJSONBody(t, listRec)
	sessions, _ := listBody["sessions"].([]any)
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session in list, got %v", listBody)
	}

	// GET /snapshot, /timeline, /commands/catalog, /composer/catalog
	for _, path := range []string{
		ManagementCollectionPath + sessionID + "/snapshot",
		ManagementCollectionPath + sessionID + "/timeline?limit=10",
		ManagementCollectionPath + sessionID + "/commands/catalog",
		ManagementCollectionPath + sessionID + "/composer/catalog",
	} {
		rec := doJSONRequest(t, mux, http.MethodGet, path, nil, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
	}

	// POST /attachments 上传合法 PNG -> 201
	pngBytes := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	attRec := doJSONRequest(t, mux, http.MethodPost, ManagementCollectionPath+sessionID+"/attachments", map[string]any{
		"attachments": []map[string]any{{
			"name":     "screen.png",
			"mimeType": "image/png",
			"dataUrl":  "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes),
		}},
	}, nil)
	if attRec.Code != http.StatusCreated {
		t.Fatalf("POST /attachments status=%d body=%s", attRec.Code, attRec.Body.String())
	}
	attBody := decodeJSONBody(t, attRec)
	atts, _ := attBody["attachments"].([]any)
	if len(atts) != 1 {
		t.Fatalf("expected 1 attachment, got %v", attBody)
	}

	// 非法 JSON 负载 -> 400
	badJSONRec := doJSONRequest(t, mux, http.MethodPost, ManagementCollectionPath+sessionID+"/commands", "[1,2]", nil)
	if badJSONRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on array body, got %d (%s)", badJSONRec.Code, badJSONRec.Body.String())
	}

	// 开启真实 HTTP Server 测试 SSE live 推送 + 心跳 + 回放 + 游标断层
	ts := httptest.NewServer(mux)
	defer ts.Close()

	streamCtx, cancelStream := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelStream()
	sseReq, err := http.NewRequestWithContext(streamCtx, http.MethodGet, ts.URL+ManagementCollectionPath+sessionID+"/events?after=0", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	sseResp, err := ts.Client().Do(sseReq)
	if err != nil {
		t.Fatalf("GET /events: %v", err)
	}
	defer sseResp.Body.Close()
	if sseResp.StatusCode != http.StatusOK || !strings.Contains(sseResp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("unexpected SSE response: status=%d header=%v", sseResp.StatusCode, sseResp.Header)
	}

	// 提交 turn.submit -> 202 并触发 InProcessChatTurnStreamer
	cmdRes, err := ts.Client().Post(
		ts.URL+ManagementCollectionPath+sessionID+"/commands",
		"application/json",
		strings.NewReader(`{"commandId":"cmd-http-turn-1","type":"turn.submit","payload":{"content":"say hi","model":"gpt-4o"}}`),
	)
	if err != nil {
		t.Fatalf("POST /commands: %v", err)
	}
	cmdRes.Body.Close()
	if cmdRes.StatusCode != http.StatusAccepted {
		t.Fatalf("POST /commands status=%d, expected 202", cmdRes.StatusCode)
	}

	scanner := bufio.NewScanner(sseResp.Body)
	var sseLines []string
	var (
		sawHeartbeat bool
		sawDelta     bool
		sawCompleted bool
	)
	for scanner.Scan() {
		line := scanner.Text()
		if line != "" && line != ": heartbeat" {
			sseLines = append(sseLines, line)
		}
		if line == ": heartbeat" {
			sawHeartbeat = true
		}
		if strings.Contains(line, "Hello ") || strings.Contains(line, "Go!") {
			sawDelta = true
		}
		if strings.Contains(line, "\"type\":\"turn.completed\"") {
			sawCompleted = true
		}
		if sawHeartbeat && sawDelta && sawCompleted {
			break
		}
	}
	if !sawCompleted || !sawDelta || !sawHeartbeat {
		t.Fatalf("missing SSE frames: lines=%q heartbeat=%v delta=%v completed=%v err=%v", sseLines, sawHeartbeat, sawDelta, sawCompleted, scanner.Err())
	}
	cancelStream()

	// 验证用量与尝试记录确实落到 Handler 端口
	if err := svc.WaitForActorIdle(context.Background(), sessionID); err != nil {
		t.Fatalf("WaitForActorIdle: %v", err)
	}
	if len(usage.collected()) != 1 {
		t.Fatalf("expected 1 usage entry recorded, got %d", len(usage.collected()))
	}
	succCount, _ := attempts.counts()
	if succCount != 1 {
		t.Fatalf("expected 1 attempt success, got %d", succCount)
	}

	// 验证 ?after=9999 覆盖 Last-Event-ID 并触发 gap session.snapshot.reset
	gapCtx, cancelGap := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelGap()
	gapReq, err := http.NewRequestWithContext(gapCtx, http.MethodGet, ts.URL+ManagementCollectionPath+sessionID+"/events?after=9999", nil)
	if err != nil {
		t.Fatalf("gap NewRequest: %v", err)
	}
	gapReq.Header.Set("Last-Event-ID", "1")
	gapResp, err := ts.Client().Do(gapReq)
	if err != nil {
		t.Fatalf("gap GET /events: %v", err)
	}
	sawSnapshotReset := false
	gapScanner := bufio.NewScanner(gapResp.Body)
	for gapScanner.Scan() {
		if strings.Contains(gapScanner.Text(), "event: session.snapshot.reset") {
			sawSnapshotReset = true
			break
		}
	}
	gapResp.Body.Close()
	cancelGap()
	if !sawSnapshotReset {
		t.Fatalf("expected gap session.snapshot.reset (?after overrides Last-Event-ID), err=%v", gapScanner.Err())
	}

	// 验证 Last-Event-ID=0 重放最近保留窗口事件
	replayCtx, cancelReplay := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelReplay()
	replayReq, err := http.NewRequestWithContext(replayCtx, http.MethodGet, ts.URL+ManagementCollectionPath+sessionID+"/events", nil)
	if err != nil {
		t.Fatalf("replay NewRequest: %v", err)
	}
	replayReq.Header.Set("Last-Event-ID", "0")
	replayResp, err := ts.Client().Do(replayReq)
	if err != nil {
		t.Fatalf("replay GET /events: %v", err)
	}
	sawReplayEvent := false
	replayScanner := bufio.NewScanner(replayResp.Body)
	for replayScanner.Scan() {
		line := replayScanner.Text()
		if strings.HasPrefix(line, "event: ") {
			sawReplayEvent = true
			break
		}
	}
	replayResp.Body.Close()
	cancelReplay()
	if !sawReplayEvent {
		t.Fatalf("expected replay event from Last-Event-ID, err=%v", replayScanner.Err())
	}

	// GET /artifacts/{id} -> 200 & 404
	artOK := doJSONRequest(t, mux, http.MethodGet, ArtifactCollectionPath+"art-1", nil, nil)
	if artOK.Code != http.StatusOK || artOK.Body.String() != "artifact body" {
		t.Fatalf("GET /artifacts/art-1 status=%d body=%q", artOK.Code, artOK.Body.String())
	}
	artMissing := doJSONRequest(t, mux, http.MethodGet, ArtifactCollectionPath+"missing", nil, nil)
	if artMissing.Code != http.StatusNotFound {
		t.Fatalf("GET /artifacts/missing status=%d, expected 404", artMissing.Code)
	}

	// DELETE /sessions/{id} -> 200 {"ok":true,"deleted":true,"sessionId":...,"provider":...}
	delRec := doJSONRequest(t, mux, http.MethodDelete, ManagementCollectionPath+sessionID, nil, nil)
	if delRec.Code != http.StatusOK {
		t.Fatalf("DELETE /sessions/%s status=%d body=%s", sessionID, delRec.Code, delRec.Body.String())
	}
	delBody := decodeJSONBody(t, delRec)
	if delBody["deleted"] != true || delBody["sessionId"] != sessionID {
		t.Fatalf("unexpected delete payload: %v", delBody)
	}
}

func TestRuntimeRoutesResolveAndCheckpoints(t *testing.T) {
	handler, svc, _, _ := newCanonicalRuntimeTestRig(t, -1)
	mux := newCanonicalHTTPMux(handler)

	workDir := t.TempDir()
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = workDir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v (%s)", args, err, string(out))
		}
	}
	runGit("init")
	runGit("config", "user.email", "test@example.com")
	runGit("config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(workDir, "README.md"), []byte("v1\n"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	runGit("add", "README.md")
	runGit("commit", "-m", "init")

	// POST /sessions/resolve -> created (201), second time -> adopted (200)
	resolvePayload := map[string]any{
		"provider":            "claude",
		"executionAccountRef": "acct_0123456789abcdef0123",
		"projectPath":         workDir,
		"nativeSessionId":     "native-work-1",
	}
	r1 := doJSONRequest(t, mux, http.MethodPost, ManagementCollectionPath+"resolve", resolvePayload, nil)
	if r1.Code != http.StatusCreated {
		t.Fatalf("first resolve status=%d body=%s", r1.Code, r1.Body.String())
	}
	b1 := decodeJSONBody(t, r1)
	if b1["status"] != "created" {
		t.Fatalf("expected status=created, got %v", b1)
	}
	sessMap, _ := b1["session"].(map[string]any)
	sessionID, _ := sessMap["sessionId"].(string)

	r2 := doJSONRequest(t, mux, http.MethodPost, ManagementCollectionPath+"resolve", resolvePayload, nil)
	if r2.Code != http.StatusOK {
		t.Fatalf("second resolve status=%d body=%s", r2.Code, r2.Body.String())
	}
	b2 := decodeJSONBody(t, r2)
	if b2["status"] != "adopted" {
		t.Fatalf("expected status=adopted, got %v", b2)
	}

	_ = svc
	// 创建一条检查点并经 HTTP 读取 list / changes / restore
	localCP, err := chatruntime.OpenWorkspaceCheckpoints(context.Background(), t.TempDir(), "", workDir, nil)
	if err != nil {
		t.Fatalf("NewWorkspaceCheckpoints: %v", err)
	}
	snapRes, err := localCP.Snapshot(context.Background(), sessionID, "before edit")
	if err != nil || snapRes.Commit == "" {
		t.Fatalf("Snapshot commit=%q err=%v", snapRes.Commit, err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "README.md"), []byte("v2\n"), 0o600); err != nil {
		t.Fatalf("WriteFile v2: %v", err)
	}

	cpList := doJSONRequest(t, mux, http.MethodGet, ManagementCollectionPath+sessionID+"/checkpoints", nil, nil)
	if cpList.Code != http.StatusOK {
		t.Fatalf("GET /checkpoints status=%d body=%s", cpList.Code, cpList.Body.String())
	}
	cpListBody := decodeJSONBody(t, cpList)
	cps, _ := cpListBody["checkpoints"].([]any)
	if len(cps) != 1 {
		t.Fatalf("expected 1 checkpoint, got %v", cpListBody)
	}

	cpChanges := doJSONRequest(t, mux, http.MethodGet, ManagementCollectionPath+sessionID+"/checkpoints/changes?commit="+snapRes.Commit, nil, nil)
	if cpChanges.Code != http.StatusOK {
		t.Fatalf("GET /checkpoints/changes status=%d body=%s", cpChanges.Code, cpChanges.Body.String())
	}
	cpRestore := doJSONRequest(t, mux, http.MethodPost, ManagementCollectionPath+sessionID+"/checkpoints/restore", map[string]any{
		"commit": snapRes.Commit,
	}, nil)
	if cpRestore.Code != http.StatusOK {
		t.Fatalf("POST /checkpoints/restore status=%d body=%s", cpRestore.Code, cpRestore.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(workDir, "README.md"))
	if err != nil || string(content) != "v1\n" {
		t.Fatalf("expected README restored to v1\\n, got %q (err=%v)", string(content), err)
	}
}
