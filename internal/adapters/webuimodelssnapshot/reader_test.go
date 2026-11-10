package webuimodelssnapshot

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

const happySnapshot = `{
  "updatedAt": 1762345678901,
  "accountProbeVersion": 2,
  "contextLimits": {
    "acct_a": {"model-1": 200000, "model-2": 128000, "model-3": 0, "model-4": 1.5},
    "acct_b": {},
    "  ": {"model-1": 1000}
  },
  "byAccount": {
    "acct_a": ["model-1", "model-2"],
    "acct_b": [],
    "acct_c": [" model-3 ", "model-3", ""]
  },
  "errorsByAccount": {
    "acct_a": "   ",
    "acct_d": "upstream timeout"
  },
  "labels": {
    "gemini": {"gemini-3-flash": "Gemini 3.5 Flash (High)"},
    "empty": {}
  },
  "accountUpdatedAt": {
    "acct_a": 1762345600000,
    "acct_b": 0,
    "acct_c": "1762345000000"
  }
}`

// seed 建一个真实 app-state.db，写入指定 KV 值，返回 AIH 数据根目录。
func seed(t *testing.T, key string, value string) string {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, appstate.DatabaseFileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatalf("create app_kv: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO app_kv VALUES (?, ?, 1)`, key, value); err != nil {
		t.Fatalf("insert app_kv: %v", err)
	}
	return directory
}

func readSnapshot(t *testing.T, aiHomeDir string) *Snapshot {
	t.Helper()
	reader, err := NewReader(aiHomeDir)
	if err != nil {
		t.Fatalf("NewReader() error = %v", err)
	}
	snapshot, err := reader.Read(context.Background())
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	return snapshot
}

// TestReadNormalizesTypedLookups 锁住完整快照的归一语义与五个类型化查找。
func TestReadNormalizesTypedLookups(t *testing.T) {
	snapshot := readSnapshot(t, seed(t, CacheKey, happySnapshot))
	if !snapshot.Available {
		t.Fatal("Available = false, want true")
	}
	if snapshot.UpdatedAtMS != 1762345678901 {
		t.Fatalf("UpdatedAtMS = %d", snapshot.UpdatedAtMS)
	}
	if snapshot.ProbeVersion != 2 {
		t.Fatalf("ProbeVersion = %d", snapshot.ProbeVersion)
	}

	models, ok := snapshot.Models("acct_a")
	if !ok || len(models) != 2 || models[0] != "model-1" || models[1] != "model-2" {
		t.Fatalf("Models(acct_a) = %v, %v", models, ok)
	}
	models[0] = "mutated"
	if again, _ := snapshot.Models("acct_a"); again[0] != "model-1" {
		t.Fatalf("Models() 返回了内部切片: %v", again)
	}
	if _, ok := snapshot.Models("acct_b"); ok {
		t.Fatal("空模型清单不应有条目")
	}
	trimmed, ok := snapshot.Models("acct_c")
	if !ok || len(trimmed) != 1 || trimmed[0] != "model-3" {
		t.Fatalf("Models(acct_c) = %v, %v", trimmed, ok)
	}

	if message, ok := snapshot.LastError("acct_d"); !ok || message != "upstream timeout" {
		t.Fatalf("LastError(acct_d) = %q, %v", message, ok)
	}
	if _, ok := snapshot.LastError("acct_a"); ok {
		t.Fatal("空白错误消息不应有条目")
	}

	if tokens, ok := snapshot.ContextLimit("acct_a", "model-1"); !ok || tokens != 200000 {
		t.Fatalf("ContextLimit(acct_a, model-1) = %d, %v", tokens, ok)
	}
	for _, model := range []string{"model-3", "model-4", "missing"} {
		if _, ok := snapshot.ContextLimit("acct_a", model); ok {
			t.Fatalf("ContextLimit(acct_a, %s) 应被丢弃", model)
		}
	}
	if _, ok := snapshot.ContextLimit("acct_b", "model-1"); ok {
		t.Fatal("空 contextLimits 条目不应保留")
	}

	if label, ok := snapshot.Label("gemini", "gemini-3-flash"); !ok || label != "Gemini 3.5 Flash (High)" {
		t.Fatalf("Label(gemini, gemini-3-flash) = %q, %v", label, ok)
	}
	if _, ok := snapshot.Label("empty", "gemini-3-flash"); ok {
		t.Fatal("空 labels 分组不应保留")
	}

	probedAt, ok := snapshot.ProbedAt("acct_a")
	if !ok || !probedAt.Equal(time.UnixMilli(1762345600000).UTC()) {
		t.Fatalf("ProbedAt(acct_a) = %v, %v", probedAt, ok)
	}
	if _, ok := snapshot.ProbedAt("acct_b"); ok {
		t.Fatal("0 时刻不应保留")
	}
	if _, ok := snapshot.ProbedAt("acct_c"); ok {
		t.Fatal("字符串时间戳不应保留")
	}
}

// TestLegacyProbeVersionDropsProbedAt 验证 v1/缺失版本快照的戳整表丢弃。
func TestLegacyProbeVersionDropsProbedAt(t *testing.T) {
	for _, raw := range []string{
		`{"accountProbeVersion": 1, "accountUpdatedAt": {"acct_a": 1762345600000}, "byAccount": {"acct_a": ["model-1"]}}`,
		`{"accountUpdatedAt": {"acct_a": 1762345600000}, "byAccount": {"acct_a": ["model-1"]}}`,
	} {
		snapshot := Parse([]byte(raw))
		if !snapshot.Available {
			t.Fatalf("Available = false for %s", raw)
		}
		if len(snapshot.AccountUpdatedAt) != 0 {
			t.Fatalf("旧版本 accountUpdatedAt 未被丢弃: %v", snapshot.AccountUpdatedAt)
		}
		if _, ok := snapshot.ProbedAt("acct_a"); ok {
			t.Fatal("ProbedAt 不应命中旧版本戳")
		}
		if models, ok := snapshot.Models("acct_a"); !ok || len(models) != 1 {
			t.Fatalf("其它字段应保留: %v, %v", models, ok)
		}
	}
}

// TestParseDropsInvalidEntriesPerField 验证单个字段坏掉不拖垮整份快照。
func TestParseDropsInvalidEntriesPerField(t *testing.T) {
	snapshot := Parse([]byte(`{
	  "updatedAt": "not-a-number",
	  "accountProbeVersion": true,
	  "contextLimits": {"acct_a": {"model-1": -1}, "acct_b": "nope"},
	  "byAccount": {"acct_a": "not-an-array", "acct_b": ["model-2", 42]},
	  "errorsByAccount": {"acct_a": {"nested": true}},
	  "labels": {"gemini": {"model-1": 42}},
	  "accountUpdatedAt": {"acct_a": -5}
	}`))
	if !snapshot.Available {
		t.Fatal("Available = false, want true")
	}
	if snapshot.UpdatedAtMS != 0 || snapshot.ProbeVersion != 0 {
		t.Fatalf("标量未降级: %d, %d", snapshot.UpdatedAtMS, snapshot.ProbeVersion)
	}
	if len(snapshot.ContextLimits) != 0 || len(snapshot.ErrorsByAccount) != 0 || len(snapshot.Labels) != 0 {
		t.Fatalf("非法条目未丢弃: %v %v %v", snapshot.ContextLimits, snapshot.ErrorsByAccount, snapshot.Labels)
	}
	models, ok := snapshot.Models("acct_b")
	if !ok || len(models) != 1 || models[0] != "model-2" {
		t.Fatalf("合法模型应保留: %v, %v", models, ok)
	}
}

// TestReadFailSoft 覆盖快照缺失、JSON 损坏与非对象输入。
func TestReadFailSoft(t *testing.T) {
	ctx := context.Background()

	missing := readSnapshot(t, t.TempDir())
	if missing.Available || len(missing.ByAccount) != 0 {
		t.Fatalf("缺失数据库应为空快照: %+v", missing)
	}
	if _, ok := missing.Models("acct_a"); ok {
		t.Fatal("空快照查找应返回 false")
	}

	otherKey := readSnapshot(t, seed(t, "cache:other.json", happySnapshot))
	if otherKey.Available {
		t.Fatal("其它键不应被当成快照")
	}

	for _, raw := range []string{
		"",
		"   ",
		"null",
		"[]",
		`{"byAccount": {"acct_a": ["model-1"`,
	} {
		snapshot := Parse([]byte(raw))
		if snapshot.Available {
			t.Fatalf("输入 %q 应为不可用快照", raw)
		}
		if _, ok := snapshot.Models("acct_a"); ok {
			t.Fatalf("输入 %q 的查找应返回 false", raw)
		}
	}

	reader, err := NewReaderAt(filepath.Join(t.TempDir(), appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("NewReaderAt() error = %v", err)
	}
	if snapshot, err := reader.Read(ctx); err != nil || snapshot.Available {
		t.Fatalf("文件不存在: %+v, %v", snapshot, err)
	}
}

// TestReaderRejectsEmptyPaths 验证构造器对空路径失败关闭。
func TestReaderRejectsEmptyPaths(t *testing.T) {
	if _, err := NewReader("  "); !errors.Is(err, appstate.ErrInvalidRoot) {
		t.Fatalf("NewReader(blank) error = %v", err)
	}
	if _, err := NewReaderAt("  "); !errors.Is(err, ErrInvalidDatabasePath) {
		t.Fatalf("NewReaderAt(blank) error = %v", err)
	}
	var nilSnapshot *Snapshot
	if models, ok := nilSnapshot.Models("acct_a"); ok || models != nil {
		t.Fatal("nil 快照查找应返回零值")
	}
}
