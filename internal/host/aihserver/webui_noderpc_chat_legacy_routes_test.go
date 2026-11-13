package aihserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

type stubNodeRPCAuthorizer struct{ allow bool }

func (a stubNodeRPCAuthorizer) Authorized(*http.Request) bool { return a.allow }

func TestBuildWebUINodeRPCChatLegacyRoutes_RejectsMissingAuthorizer(t *testing.T) {
	if _, err := buildWebUINodeRPCChatLegacyRoutes(webuiRouteDependencies{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
	}); err == nil {
		t.Fatal("缺少 Authorizer 时应当拒绝装配")
	}
}

func TestBuildWebUINodeRPCChatLegacyRoutes_NoServeMuxConflictAndEndToEnd(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	if err := os.MkdirAll(aiHome, 0o755); err != nil {
		t.Fatal(err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: aiHome,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open 失败: %v", err)
	}
	defer func() { _ = store.Close() }()

	cred, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  "sk-noderpc-e2e",
		BaseURL: "https://api.example/v1",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth 失败: %v", err)
	}
	registrar, err := accountapp.NewRegistrar(catalog, store, func() time.Time {
		return time.UnixMilli(1_000).UTC()
	})
	if err != nil {
		t.Fatalf("NewRegistrar 失败: %v", err)
	}
	account, err := registrar.Register(context.Background(), cred, nil)
	if err != nil {
		t.Fatalf("Register 失败: %v", err)
	}

	deps := webuiRouteDependencies{
		Authorizer:  stubNodeRPCAuthorizer{allow: true},
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Catalog:     catalog,
		Store:       store,
	}

	newRoutes, err := buildWebUINodeRPCChatLegacyRoutes(deps)
	if err != nil {
		t.Fatalf("buildWebUINodeRPCChatLegacyRoutes 失败: %v", err)
	}

	// 预挂载相邻既有 ServeMux 模式（来自 webuiroutes.go 与 router.go），校验完全零冲突。
	mux := http.NewServeMux()
	adjacentPatterns := []string{
		"GET /v1/management/status",
		"GET /v1/management/accounts",
		"GET /v1/management/webui/accounts",
		"GET /v1/management/webui/slash-commands",
		"GET /v1/management/webui/chat-paste",
		"POST /v1/management/webui/chat-paste",
		"GET /v1/management/webui/fs/media",
		"GET /v1/management/webui/fs/read",
		"GET /v1/management/webui/fs/tree",
		"GET /v1/management/webui/fs/access",
		"GET /v1/management/webui/sessions/{provider}/{accountRef}",
		"GET /v1/management/webui/sessions/{provider}/{sessionId}/messages",
		"GET /v1/management/webui/sessions/{provider}/{sessionId}/events",
		"POST /v1/management/webui/session-previews",
		"GET /v1/management/webui/archived-sessions",
	}
	for _, pattern := range adjacentPatterns {
		mux.Handle(pattern, http.NotFoundHandler())
	}
	for _, r := range newRoutes {
		mux.Handle(r.Pattern, r.Handler)
	}

	// 1. 聊天附件（经宿主 .claude/artifacts 目录）
	imgPath := filepath.Join(hostHome, ".claude", "artifacts", "demo.png")
	if err := os.MkdirAll(filepath.Dir(imgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(imgPath, []byte("pngbytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	attReq := httptest.NewRequest(http.MethodGet, "/v1/management/webui/chat/attachments?path="+url.QueryEscape(imgPath), nil)
	attRec := httptest.NewRecorder()
	mux.ServeHTTP(attRec, attReq)
	if attRec.Code != http.StatusOK || attRec.Body.String() != "pngbytes" || attRec.Header().Get("Cache-Control") != "private, max-age=300" {
		t.Fatalf("附件端到端失败: code=%d headers=%v body=%s", attRec.Code, attRec.Header(), attRec.Body.String())
	}

	// 2. chat-sessions POST -> GET list -> GET item -> node-rpc -> DELETE
	createReq := httptest.NewRequest(http.MethodPost, "/v1/management/webui/chat-sessions", bytes.NewBufferString(`{"id":"e2e-1","title":"端到端会话","messages":[{"role":"user","content":"ping","timestamp":123}]}`))
	createRec := httptest.NewRecorder()
	mux.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("创建会话期望 201，实际 %d %s", createRec.Code, createRec.Body.String())
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/management/webui/chat-sessions", nil)
	listRec := httptest.NewRecorder()
	mux.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK || !bytes.Contains(listRec.Body.Bytes(), []byte(`"e2e-1"`)) {
		t.Fatalf("列表失败: code=%d body=%s", listRec.Code, listRec.Body.String())
	}

	getRec := httptest.NewRecorder()
	mux.ServeHTTP(getRec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/chat-sessions/e2e-1", nil))
	if getRec.Code != http.StatusOK || !bytes.Contains(getRec.Body.Bytes(), []byte(`"端到端会话"`)) {
		t.Fatalf("单条读取失败: code=%d body=%s", getRec.Code, getRec.Body.String())
	}

	// 3. node-rpc 两条前缀（直连 + WebUI 代理前缀）及未知 RPC 404 / 非 GET 405
	for _, prefix := range []string{"/v1/management/node-rpc/", "/v1/management/webui/node-rpc/"} {
		stRec := httptest.NewRecorder()
		mux.ServeHTTP(stRec, httptest.NewRequest(http.MethodGet, prefix+"device-status", nil))
		if stRec.Code != http.StatusOK {
			t.Fatalf("%sdevice-status 期望 200，实际 %d %s", prefix, stRec.Code, stRec.Body.String())
		}
		var statusPayload map[string]any
		if err := json.Unmarshal(stRec.Body.Bytes(), &statusPayload); err != nil || statusPayload["ok"] != true {
			t.Fatalf("%sdevice-status JSON 异常: %v %s", prefix, err, stRec.Body.String())
		}

		accRec := httptest.NewRecorder()
		mux.ServeHTTP(accRec, httptest.NewRequest(http.MethodGet, prefix+"device-accounts", nil))
		if accRec.Code != http.StatusOK || !bytes.Contains(accRec.Body.Bytes(), []byte(string(account.Ref()))) {
			t.Fatalf("%sdevice-accounts 未包含注册账号 %s: code=%d body=%s", prefix, account.Ref(), accRec.Code, accRec.Body.String())
		}

		msgRec := httptest.NewRecorder()
		mux.ServeHTTP(msgRec, httptest.NewRequest(http.MethodGet, prefix+"device-session-messages?sessionRef=e2e-1", nil))
		if msgRec.Code != http.StatusOK || !bytes.Contains(msgRec.Body.Bytes(), []byte(`"ping"`)) {
			t.Fatalf("%sdevice-session-messages 失败: %d %s", prefix, msgRec.Code, msgRec.Body.String())
		}

		postRec := httptest.NewRecorder()
		mux.ServeHTTP(postRec, httptest.NewRequest(http.MethodPost, prefix+"device-status", nil))
		if postRec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s POST 期望 405，实际 %d %s", prefix, postRec.Code, postRec.Body.String())
		}

		unkRec := httptest.NewRecorder()
		mux.ServeHTTP(unkRec, httptest.NewRequest(http.MethodGet, prefix+"unknown-rpc", nil))
		if unkRec.Code != http.StatusNotFound {
			t.Fatalf("%s unknown-rpc 期望 404，实际 %d %s", prefix, unkRec.Code, unkRec.Body.String())
		}
	}

	// 4. DELETE chat-session 后再读返回 404
	delRec := httptest.NewRecorder()
	mux.ServeHTTP(delRec, httptest.NewRequest(http.MethodDelete, "/v1/management/webui/chat-sessions/e2e-1", nil))
	if delRec.Code != http.StatusOK || !bytes.Contains(delRec.Body.Bytes(), []byte(`"deleted":true`)) {
		t.Fatalf("删除会话失败: %d %s", delRec.Code, delRec.Body.String())
	}

	afterDelRec := httptest.NewRecorder()
	mux.ServeHTTP(afterDelRec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/chat-sessions/e2e-1", nil))
	if afterDelRec.Code != http.StatusNotFound {
		t.Fatalf("删除后读取期望 404，实际 %d %s", afterDelRec.Code, afterDelRec.Body.String())
	}
}
