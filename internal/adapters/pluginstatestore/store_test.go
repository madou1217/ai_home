package pluginstatestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

func newTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	home := t.TempDir()
	store, err := NewStore(home)
	if err != nil {
		t.Fatalf("创建状态存储失败: %v", err)
	}
	return store, home
}

func readRawState(t *testing.T, home string) string {
	t.Helper()
	database, err := sql.Open("sqlite", filepath.Join(home, DatabaseFileName))
	if err != nil {
		t.Fatalf("打开 app-state.db 失败: %v", err)
	}
	defer func() { _ = database.Close() }()
	var value string
	if err := database.QueryRow("SELECT value FROM app_kv WHERE key = ?", ControlStateKey).Scan(&value); err != nil {
		t.Fatalf("读取控制状态失败: %v", err)
	}
	return value
}

func seedRawState(t *testing.T, home string, value string) {
	t.Helper()
	database, err := sql.Open("sqlite", filepath.Join(home, DatabaseFileName))
	if err != nil {
		t.Fatalf("打开 app-state.db 失败: %v", err)
	}
	defer func() { _ = database.Close() }()
	if _, err := database.Exec("CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		t.Fatalf("创建 app_kv 失败: %v", err)
	}
	if _, err := database.Exec("INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, 1)", ControlStateKey, value); err != nil {
		t.Fatalf("写入控制状态失败: %v", err)
	}
}

func TestUpdateCreatesStateAndIncrementsRevision(t *testing.T) {
	store, home := newTestStore(t)
	state, err := store.Update(context.Background(), func(state *plugincontrol.State) error {
		if state.Revision != 0 || len(state.Installed) != 0 || len(state.Instances) != 0 {
			t.Fatalf("首次更新前的状态不是空状态: %+v", state)
		}
		state.Installed = append(state.Installed, json.RawMessage("{\"pluginId\":\"echo\",\"version\":\"1.0.0\"}"))
		return nil
	}, nil)
	if err != nil {
		t.Fatalf("首次写入失败: %v", err)
	}
	if state.Revision != 1 || len(state.Installed) != 1 {
		t.Fatalf("写入结果不符: %+v", state)
	}
	if state.Generations == nil || state.Instances == nil {
		t.Fatalf("空数组必须归一成 []: %+v", state)
	}
	raw := readRawState(t, home)
	var document map[string]any
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("状态文档不是合法 JSON: %v", err)
	}
	if document["schemaVersion"] != float64(1) || document["revision"] != float64(1) {
		t.Fatalf("文档顶层字段不符: %s", raw)
	}
}

func TestUpdateCAS(t *testing.T) {
	store, home := newTestStore(t)
	if _, err := store.Update(context.Background(), func(*plugincontrol.State) error { return nil }, nil); err != nil {
		t.Fatalf("首次写入失败: %v", err)
	}
	stale := int64(0)
	_, err := store.Update(context.Background(), func(*plugincontrol.State) error { return nil }, &stale)
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != plugincontrol.CodeRevisionConflict {
		t.Fatalf("CAS 冲突错误 = %v", err)
	}
	if raw := readRawState(t, home); raw == "" || !containsRevision(t, raw, 1) {
		t.Fatalf("CAS 冲突后状态不应变化: %s", raw)
	}
	current := int64(1)
	state, err := store.Update(context.Background(), func(*plugincontrol.State) error { return nil }, &current)
	if err != nil || state.Revision != 2 {
		t.Fatalf("新 revision 写入失败: %+v %v", state, err)
	}
}

func containsRevision(t *testing.T, raw string, revision int) bool {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("解析状态失败: %v", err)
	}
	return document["revision"] == float64(revision)
}

func TestMutatorErrorRollsBack(t *testing.T) {
	store, home := newTestStore(t)
	if _, err := store.Update(context.Background(), func(*plugincontrol.State) error { return nil }, nil); err != nil {
		t.Fatalf("首次写入失败: %v", err)
	}
	_, err := store.Update(context.Background(), func(*plugincontrol.State) error {
		return pluginerr.New(plugincontrol.CodeInUse, "")
	}, nil)
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != plugincontrol.CodeInUse {
		t.Fatalf("mutator 错误未透传: %v", err)
	}
	if raw := readRawState(t, home); !containsRevision(t, raw, 1) {
		t.Fatalf("回滚后 revision 应保持 1: %s", raw)
	}
}

func TestNormalizesLegacyDocument(t *testing.T) {
	store, home := newTestStore(t)
	seedRawState(t, home, "{\"schemaVersion\":9,\"revision\":-3,\"installed\":{\"bad\":true},\"instances\":\"nope\",\"generations\":null,\"activeGeneration\":-5,\"extra\":\"drop-me\"}")
	state, err := store.Update(context.Background(), func(state *plugincontrol.State) error {
		if state.SchemaVersion != 1 || state.Revision != 0 {
			t.Fatalf("旧文档归一不符: %+v", state)
		}
		if len(state.Installed) != 0 || len(state.Instances) != 0 || len(state.Generations) != 0 {
			t.Fatalf("非法数组字段应归一为 []: %+v", state)
		}
		if state.ActiveGeneration != 0 {
			t.Fatalf("activeGeneration 应归一为 0: %+v", state)
		}
		return nil
	}, nil)
	if err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if state.Revision != 1 {
		t.Fatalf("revision 应从 0 递增: %+v", state)
	}
	raw := readRawState(t, home)
	var document map[string]any
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("状态不是合法 JSON: %v", err)
	}
	if _, present := document["extra"]; present {
		t.Fatalf("未知顶层字段应被丢弃（与 Node normalizeState 一致）: %s", raw)
	}
}

func TestCorruptStateFailsClosed(t *testing.T) {
	store, home := newTestStore(t)
	seedRawState(t, home, "{broken")
	_, err := store.Update(context.Background(), func(*plugincontrol.State) error { return nil }, nil)
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != plugincontrol.CodeStateInvalid {
		t.Fatalf("损坏状态必须 fail closed: %v", err)
	}
}

func TestMaintenanceGateBlocksStateWrite(t *testing.T) {
	store, home := newTestStore(t)
	gate := filepath.Join(home, "run", "maintenance", "oauth-rekey.lock")
	if err := os.MkdirAll(filepath.Dir(gate), 0o700); err != nil {
		t.Fatalf("创建闸门失败: %v", err)
	}
	if err := os.WriteFile(gate, []byte("x"), 0o600); err != nil {
		t.Fatalf("写入闸门失败: %v", err)
	}
	_, err := store.Update(context.Background(), func(*plugincontrol.State) error { return nil }, nil)
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != "account_maintenance_in_progress" {
		t.Fatalf("维护闸门未阻止写入: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, DatabaseFileName)); !os.IsNotExist(err) {
		t.Fatalf("维护期间不应创建 app-state.db: %v", err)
	}
}
