package webuichatsessionsapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

type stubAuth struct{ allow bool }

func (s stubAuth) Authorized(_ *http.Request) bool { return s.allow }

func newTestMuxHandler(t *testing.T, aiHome, hostHome string) (*Handler, http.Handler) {
	t.Helper()
	fixedNow := time.UnixMilli(1700000100000)
	h, err := NewHandler(Dependencies{
		Authorizer:  stubAuth{allow: true},
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Now:         func() time.Time { return fixedNow },
	})
	if err != nil {
		t.Fatalf("NewHandler 失败: %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle(CollectionPath, h)
	mux.Handle(ItemPath, h)
	return h, mux
}

func doReq(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != "" {
		reader = bytes.NewReader([]byte(body))
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func createRuntimeSchemaAndSeed(t *testing.T, dbPath string, fn func(ctx context.Context, exec func(string, ...any))) {
	t.Helper()
	ctx := context.Background()
	db, err := appstate.OpenWritable(ctx, dbPath)
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	defer func() { _ = db.Close() }()
	schema := `
	PRAGMA foreign_keys = ON;
	CREATE TABLE IF NOT EXISTS chat_runtime_sessions (
		session_id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		execution_account_ref TEXT NOT NULL,
		project_path TEXT NOT NULL,
		state TEXT NOT NULL,
		runtime_binding_json TEXT NOT NULL,
		capability_snapshot_json TEXT NOT NULL,
		policy_json TEXT NOT NULL,
		active_turn_json TEXT,
		last_event_seq INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS chat_runtime_commands (
		command_id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
		type TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		status TEXT NOT NULL,
		result_json TEXT,
		accepted_seq INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS chat_runtime_attachments (
		attachment_id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
		file_path TEXT NOT NULL,
		name TEXT NOT NULL,
		mime_type TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS chat_runtime_events (
		event_id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
		seq INTEGER NOT NULL,
		schema TEXT NOT NULL,
		type TEXT NOT NULL,
		at INTEGER NOT NULL,
		turn_id TEXT,
		run_id TEXT,
		item_id TEXT,
		source_json TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		UNIQUE(session_id, seq)
	);`
	if _, err := db.ExecContext(ctx, schema); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if fn != nil {
		fn(ctx, func(q string, args ...any) {
			if _, err := db.ExecContext(ctx, q, args...); err != nil {
				t.Fatalf("执行 SQL 失败 %s: %v", q, err)
			}
		})
	}
}

func TestGuardsAuthMethodAndMissingDeps(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("缺少依赖应当报错")
	}
	unauth, err := NewHandler(Dependencies{Authorizer: stubAuth{allow: false}, HostHomeDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	rec := doReq(t, unauth, http.MethodGet, CollectionPath, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("期望 401，实际 %d", rec.Code)
	}
	_, mux := newTestMuxHandler(t, filepath.Join(t.TempDir(), ".ai_home"), "")
	if delRec := doReq(t, mux, http.MethodDelete, CollectionPath, ""); delRec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("集合 DELETE 期望 405，实际 %d", delRec.Code)
	}
	if postItem := doReq(t, mux, http.MethodPost, CollectionPath+"/abc", "{}"); postItem.Code != http.StatusMethodNotAllowed {
		t.Fatalf("单条 POST 期望 405，实际 %d", postItem.Code)
	}
}

func TestLegacyCreateReadListDeleteLifecycle(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	_, mux := newTestMuxHandler(t, aiHome, hostHome)

	// 空列表不报错，也不凭空创建目录，返回非 nil []。
	emptyRec := doReq(t, mux, http.MethodGet, CollectionPath, "")
	if emptyRec.Code != http.StatusOK {
		t.Fatalf("空列表期望 200，实际 %d", emptyRec.Code)
	}
	if !bytes.Contains(emptyRec.Body.Bytes(), []byte(`"sessions":[]`)) {
		t.Fatalf("空列表应序列化为 []，实际 %s", emptyRec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(aiHome, "chat-sessions")); !os.IsNotExist(err) {
		t.Fatalf("仅读取列表不应创建 chat-sessions 目录")
	}

	// 非法 JSON 与路径穿越 ID 拒绝
	if badJSON := doReq(t, mux, http.MethodPost, CollectionPath, "{bad"); badJSON.Code != http.StatusBadRequest {
		t.Fatalf("非法 JSON 期望 400，实际 %d", badJSON.Code)
	}
	if badID := doReq(t, mux, http.MethodPost, CollectionPath, `{"id":"../escape"}`); badID.Code != http.StatusBadRequest {
		t.Fatalf("非法 ID 期望 400，实际 %d", badID.Code)
	}

	// 空请求体创建默认会话
	createdDefault := doReq(t, mux, http.MethodPost, CollectionPath, "")
	if createdDefault.Code != http.StatusCreated {
		t.Fatalf("创建默认会话期望 201，实际 %d body=%s", createdDefault.Code, createdDefault.Body.String())
	}
	var createResp struct {
		OK      bool              `json:"ok"`
		Session legacyChatSession `json:"session"`
	}
	if err := json.Unmarshal(createdDefault.Body.Bytes(), &createResp); err != nil {
		t.Fatal(err)
	}
	if !createResp.OK || createResp.Session.Title != "新对话" || createResp.Session.Provider != "claude" || createResp.Session.Messages == nil {
		t.Fatalf("默认创建字段不符: %+v", createResp)
	}

	// 自定义字段创建
	createdCustom := doReq(t, mux, http.MethodPost, CollectionPath, `{"id":"leg-1","title":"讨论架构","provider":"codex","model":"gpt-5","accountRef":"acct_1","createdAt":1000}`)
	if createdCustom.Code != http.StatusCreated {
		t.Fatalf("自定义创建期望 201，实际 %d", createdCustom.Code)
	}

	// 单条读取 + 404
	gotSingle := doReq(t, mux, http.MethodGet, CollectionPath+"/leg-1", "")
	if gotSingle.Code != http.StatusOK || !bytes.Contains(gotSingle.Body.Bytes(), []byte(`"讨论架构"`)) {
		t.Fatalf("单条读取失败: code=%d body=%s", gotSingle.Code, gotSingle.Body.String())
	}
	missing := doReq(t, mux, http.MethodGet, CollectionPath+"/does-not-exist", "")
	if missing.Code != http.StatusNotFound || !bytes.Contains(missing.Body.Bytes(), []byte(`"chat_session_not_found"`)) {
		t.Fatalf("缺失读取期望 404，实际 code=%d body=%s", missing.Code, missing.Body.String())
	}

	// 列表按 updatedAt 降序包含这两条
	listRec := doReq(t, mux, http.MethodGet, CollectionPath, "")
	if listRec.Code != http.StatusOK {
		t.Fatal(listRec.Code)
	}
	var listResp struct {
		OK       bool             `json:"ok"`
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listResp); err != nil {
		t.Fatal(err)
	}
	if len(listResp.Sessions) != 2 {
		t.Fatalf("期望 2 条会话，实际 %d", len(listResp.Sessions))
	}

	// 删除 legacy-only 会话
	del1 := doReq(t, mux, http.MethodDelete, CollectionPath+"/leg-1", "")
	if del1.Code != http.StatusOK || !bytes.Contains(del1.Body.Bytes(), []byte(`"deleted":true`)) {
		t.Fatalf("删除期望 deleted:true，实际 %d %s", del1.Code, del1.Body.String())
	}
	del2 := doReq(t, mux, http.MethodDelete, CollectionPath+"/leg-1", "")
	if del2.Code != http.StatusOK || !bytes.Contains(del2.Body.Bytes(), []byte(`"deleted":false`)) {
		t.Fatalf("二次删除期望 deleted:false，实际 %d %s", del2.Code, del2.Body.String())
	}
}

func TestCanonicalMergeExclusionAndCascadeDelete(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	if err := os.MkdirAll(aiHome, 0o755); err != nil {
		t.Fatal(err)
	}
	_, mux := newTestMuxHandler(t, aiHome, hostHome)

	// 创建 3 条 legacy JSON：leg-migrated (已被 canonical 导入)、leg-archived (已被归档 canonical 导入)、leg-free (未迁移)
	for _, spec := range []struct {
		id      string
		updated int64
	}{
		{"leg-migrated", 100},
		{"leg-archived", 200},
		{"leg-free", 250},
	} {
		rec := doReq(t, mux, http.MethodPost, CollectionPath, `{"id":"`+spec.id+`","title":"旧会话-`+spec.id+`"}`)
		if rec.Code != http.StatusCreated {
			t.Fatal(rec.Code)
		}
		// 改写 updatedAt 让排序可控
		p := filepath.Join(aiHome, "chat-sessions", spec.id+".json")
		raw, _ := os.ReadFile(p)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		m["updatedAt"] = spec.updated
		b, _ := json.Marshal(m)
		_ = os.WriteFile(p, b, 0o600)
	}

	attachDir := t.TempDir()
	attachFile := filepath.Join(attachDir, "clip.png")
	framesDir := attachFile + ".frames"
	_ = os.WriteFile(attachFile, []byte("img"), 0o600)
	_ = os.MkdirAll(framesDir, 0o755)
	_ = os.WriteFile(filepath.Join(framesDir, "f1.jpg"), []byte("frm"), 0o600)

	dbPath, err := appstate.DatabasePath(aiHome)
	if err != nil {
		t.Fatal(err)
	}
	createRuntimeSchemaAndSeed(t, dbPath, func(_ context.Context, exec func(string, ...any)) {
		// 1. 应展示的 canonical 会话（关联 leg-migrated）
		exec(`INSERT INTO chat_runtime_sessions VALUES (?, 'codex', 'acct_c1', '', 'idle', '{"nativeSessionId":"nat-1"}', '{}', '{"archived":false,"legacySessionId":"leg-migrated","title":"迁移后的会话","model":"gpt-5"}', NULL, 1, 50, 500)`, "can-1")
		exec(`INSERT INTO chat_runtime_commands VALUES ('cmd-1', 'can-1', 'prompt', '{}', 'done', NULL, 1, 50, 50)`)
		exec(`INSERT INTO chat_runtime_events VALUES ('evt-1', 'can-1', 1, 'v1', 'timeline.item.completed', 50, NULL, NULL, 'item-1', '{}', '{}')`)
		exec(`INSERT INTO chat_runtime_attachments VALUES ('att-1', 'can-1', ?, 'clip.png', 'image/png', 50)`, attachFile)

		// 2. 空壳默认 canonical（无 nativeSessionId / legacySessionId，title 为 新对话）：不展示
		exec(`INSERT INTO chat_runtime_sessions VALUES (?, 'claude', '', '', 'idle', '{}', '{}', '{"archived":false,"title":"新对话"}', NULL, 0, 10, 999)`, "can-blank")

		// 3. 归档 canonical（关联 leg-archived）：canonical 与 legacy 都不应展示
		exec(`INSERT INTO chat_runtime_sessions VALUES (?, 'claude', '', '', 'idle', '{"nativeSessionId":"nat-2"}', '{}', '{"archived":true,"legacySessionId":"leg-archived","title":"已归档"}', NULL, 0, 10, 400)`, "can-arch")

		// 4. 工作区项目会话：不展示
		exec(`INSERT INTO chat_runtime_sessions VALUES (?, 'claude', '', '/tmp/proj', 'idle', '{"nativeSessionId":"nat-3"}', '{}', '{"archived":false,"title":"项目会话"}', NULL, 0, 10, 800)`, "can-proj")

		// 5. 运行中 canonical：列表可见但删除返回 409 chat_session_busy
		exec(`INSERT INTO chat_runtime_sessions VALUES (?, 'claude', '', '', 'running', '{"nativeSessionId":"nat-4"}', '{}', '{"archived":false,"title":"运行中"}', NULL, 0, 10, 300)`, "can-busy")
	})

	listRec := doReq(t, mux, http.MethodGet, CollectionPath, "")
	if listRec.Code != http.StatusOK {
		t.Fatalf("列表失败 %d %s", listRec.Code, listRec.Body.String())
	}
	var listResp struct {
		OK       bool             `json:"ok"`
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listResp); err != nil {
		t.Fatal(err)
	}
	// 期望顺序: can-1 (500), can-busy (300), leg-free (250)
	if len(listResp.Sessions) != 3 {
		t.Fatalf("合并去重后期望 3 条会话，实际 %d: %s", len(listResp.Sessions), listRec.Body.String())
	}
	gotIDs := []string{
		listResp.Sessions[0]["id"].(string),
		listResp.Sessions[1]["id"].(string),
		listResp.Sessions[2]["id"].(string),
	}
	wantIDs := []string{"can-1", "can-busy", "leg-free"}
	for i := range wantIDs {
		if gotIDs[i] != wantIDs[i] {
			t.Fatalf("顺序不符 got=%v want=%v", gotIDs, wantIDs)
		}
	}
	if listResp.Sessions[0]["runtimeSessionId"] != "can-1" || listResp.Sessions[0]["status"] != "idle" {
		t.Fatalf("canonical 摘要字段不符: %+v", listResp.Sessions[0])
	}

	// 运行中会话拒绝删除
	busyDel := doReq(t, mux, http.MethodDelete, CollectionPath+"/can-busy", "")
	if busyDel.Code != http.StatusConflict || !bytes.Contains(busyDel.Body.Bytes(), []byte(`"chat_session_busy"`)) {
		t.Fatalf("运行中会话期望 409 chat_session_busy，实际 %d %s", busyDel.Code, busyDel.Body.String())
	}

	// 静止 canonical 删除：级联子表 + 清理附件与 frames + 清理 legacy 来源文件
	canDel := doReq(t, mux, http.MethodDelete, CollectionPath+"/can-1", "")
	if canDel.Code != http.StatusOK || !bytes.Contains(canDel.Body.Bytes(), []byte(`"deleted":true`)) {
		t.Fatalf("canonical 删除失败 %d %s", canDel.Code, canDel.Body.String())
	}

	if _, err := os.Stat(attachFile); !os.IsNotExist(err) {
		t.Fatalf("附件文件应已被清理")
	}
	if _, err := os.Stat(framesDir); !os.IsNotExist(err) {
		t.Fatalf("视频帧目录应已被清理")
	}
	if _, err := os.Stat(filepath.Join(aiHome, "chat-sessions", "leg-migrated.json")); !os.IsNotExist(err) {
		t.Fatalf("legacy 来源文件应已被清理")
	}

	// 验证子表确实级联删除
	db, err := appstate.OpenReadOnly(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, tbl := range []string{"chat_runtime_sessions", "chat_runtime_commands", "chat_runtime_events", "chat_runtime_attachments"} {
		var cnt int
		if err := db.QueryRow("SELECT COUNT(1) FROM "+tbl+" WHERE session_id = ?", "can-1").Scan(&cnt); err != nil {
			t.Fatal(err)
		}
		if cnt != 0 {
			t.Fatalf("表 %s 期望级联清零，实际剩余 %d 行", tbl, cnt)
		}
	}
}
