package accountrefmap

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	nodeRefA = "acct_aaaaaaaaaaaaaaaaaaaa"
	nodeRefB = "acct_bbbbbbbbbbbbbbbbbbbb"
	goRefA   = "goref_1111111111111111111"
	goRefB   = "goref_2222222222222222222"
)

func seedState(t *testing.T, value string, withRow bool) string {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, appstate.DatabaseFileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	if withRow {
		if _, err := db.Exec(`INSERT INTO app_kv VALUES (?, ?, 1)`, SyncStateKey, value); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}
	return directory
}

// TestParseLinks 锁住 state 文档的解析边界：空 goRef 不入表，损坏 JSON 报错。
func TestParseLinks(t *testing.T) {
	table, err := Parse(`{"links":{"` + nodeRefA + `":{"goRef":"` + goRefA + `","print":"p1"},"` + nodeRefB + `":{"goRef":""}},"validatorVersion":3}`)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if table.Len() != 1 {
		t.Fatalf("Len() = %d, want 1（空 goRef 应被忽略）", table.Len())
	}
	if got := table.GoRef(nodeRefA); got != goRefA {
		t.Fatalf("GoRef(linked) = %q, want %q", got, goRefA)
	}
	if got := table.GoRef(nodeRefB); got != nodeRefB {
		t.Fatalf("GoRef(empty goRef link) = %q, want identity %q", got, nodeRefB)
	}
	for _, raw := range []string{"", "   ", "null"} {
		empty, err := Parse(raw)
		if err != nil || empty.Len() != 0 {
			t.Fatalf("Parse(%q) = len %d, err %v", raw, empty.Len(), err)
		}
	}
	if _, err := Parse("{not json"); err == nil {
		t.Fatal("Parse(corrupt) error = nil, want error")
	}
}

// TestDirectionalLookupFallsBackToIdentity 锁住「无链接按恒等」的语义。
func TestDirectionalLookupFallsBackToIdentity(t *testing.T) {
	table, err := Parse(`{"links":{"` + nodeRefA + `":{"goRef":"` + goRefA + `"}}}`)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"go linked", table.GoRef(nodeRefA), goRefA},
		{"go identity", table.GoRef(nodeRefB), nodeRefB},
		{"go trimmed", table.GoRef("  " + nodeRefA + "  "), goRefA},
		{"go empty", table.GoRef("   "), ""},
		{"node reverse", table.NodeRef(goRefA), nodeRefA},
		{"node identity", table.NodeRef(goRefB), goRefB},
		{"node empty", table.NodeRef(""), ""},
	}
	for _, item := range cases {
		if item.got != item.want {
			t.Fatalf("%s = %q, want %q", item.name, item.got, item.want)
		}
	}
}

// TestResolverDisabledKeepsIdentity 验证关掉同步后两侧引用原样透传，批量表为 nil。
func TestResolverDisabledKeepsIdentity(t *testing.T) {
	table, err := Parse(`{"links":{"` + nodeRefA + `":{"goRef":"` + goRefA + `"}}}`)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	resolver := NewResolver(false, table)
	if got := resolver.GoRef(nodeRefA); got != nodeRefA {
		t.Fatalf("disabled GoRef = %q, want %q", got, nodeRefA)
	}
	if got := resolver.NodeRef(goRefA); got != goRefA {
		t.Fatalf("disabled NodeRef = %q, want %q", got, goRefA)
	}
	if links := resolver.Links(); links != nil {
		t.Fatalf("disabled Links() = %v, want nil", links)
	}
	enabled := NewResolver(true, table)
	if got := enabled.NodeRef(goRefA); got != nodeRefA {
		t.Fatalf("enabled NodeRef = %q, want %q", got, nodeRefA)
	}
	if links := enabled.Links(); len(links) != 1 || links[nodeRefA] != goRefA {
		t.Fatalf("enabled Links() = %v", links)
	}
}

// TestLoadReadsAppState 用真实 app-state.db 验证读库路径与缺失/损坏降级。
func TestLoadReadsAppState(t *testing.T) {
	ctx := context.Background()
	root := seedState(t, `{"links":{"`+nodeRefA+`":{"goRef":"`+goRefA+`"},"`+nodeRefB+`":{"goRef":"`+goRefB+`"}}}`, true)
	table, err := Load(ctx, root)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if table.Len() != 2 {
		t.Fatalf("Len() = %d, want 2", table.Len())
	}
	if got := table.NodeRef(goRefB); got != nodeRefB {
		t.Fatalf("NodeRef() = %q, want %q", got, nodeRefB)
	}

	missingKey, err := Load(ctx, seedState(t, "", false))
	if err != nil || missingKey.Len() != 0 {
		t.Fatalf("Load(no row) = len %d, err %v", missingKey.Len(), err)
	}
	corrupt, err := Load(ctx, seedState(t, "{not json", true))
	if err != nil || corrupt.Len() != 0 {
		t.Fatalf("Load(corrupt) = len %d, err %v（应与 Node 一样退化为恒等）", corrupt.Len(), err)
	}
	absent, err := Load(ctx, filepath.Join(t.TempDir(), "empty-root"))
	if err != nil || absent.Len() != 0 {
		t.Fatalf("Load(no db) = len %d, err %v", absent.Len(), err)
	}
}
