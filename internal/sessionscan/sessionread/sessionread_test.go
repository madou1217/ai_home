package sessionread

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func createTestSQLiteDB(t *testing.T, dbPath string, ddl string, execFn func(db *sql.DB) error) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(dbPath), err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite %s: %v", dbPath, err)
	}
	defer db.Close()
	if ddl != "" {
		if _, err := db.Exec(ddl); err != nil {
			t.Fatalf("exec ddl %s: %v", dbPath, err)
		}
	}
	if execFn != nil {
		if err := execFn(db); err != nil {
			t.Fatalf("seed sqlite %s: %v", dbPath, err)
		}
	}
}

func writeTestFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(p), err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
}

func decodeMessages(t *testing.T, raw []json.RawMessage) []map[string]any {
	t.Helper()
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		var m map[string]any
		if err := json.Unmarshal(item, &m); err != nil {
			t.Fatalf("unmarshal message %s: %v", string(item), err)
		}
		out = append(out, m)
	}
	return out
}

func TestAllKnownProvidersNoUnsupportedError(t *testing.T) {
	ctx := context.Background()
	opts := Options{HostHomeDir: t.TempDir(), AIHomeDir: t.TempDir()}
	known := []string{
		"claude", "codex", "gemini", "agy", "opencode",
		"qoder", "qodercn", "grok", "kiro", "zcode", "cline",
		"codebuddy", "codebuddycn", "workbuddy", "workbuddycn",
		"kimi", "chat",
	}
	for _, provider := range known {
		if !IsKnownProvider(provider) {
			t.Fatalf("expected known provider %q", provider)
		}
		if provider != "codex" {
			if _, err := ListProjects(ctx, opts, provider); err != nil {
				t.Fatalf("ListProjects(%q) error = %v", provider, err)
			}
			if _, err := ReadEventsNonCodex(ctx, opts, provider, "sess-1", "", 0); err != nil {
				t.Fatalf("ReadEventsNonCodex(%q) error = %v", provider, err)
			}
		}
		if provider != "chat" && provider != "codex" {
			if _, err := ReadMessagesSnapshot(ctx, opts, provider, "sess-1", ""); errors.Is(err, ErrUnsupportedProvider) {
				t.Fatalf("ReadMessagesSnapshot(%q) returned ErrUnsupportedProvider", provider)
			}
		}
		if _, err := ReadPreview(ctx, opts, provider, "sess-1", ""); errors.Is(err, ErrUnsupportedProvider) {
			t.Fatalf("ReadPreview(%q) returned ErrUnsupportedProvider", provider)
		}
	}
	if _, err := ListProjects(ctx, opts, "unknown_provider"); !errors.Is(err, ErrUnsupportedProvider) {
		t.Fatalf("expected ErrUnsupportedProvider for unknown provider, got %v", err)
	}
}

func TestGeminiListMessagesAndProjectMapping(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	opts := Options{HostHomeDir: hostHome, AIHomeDir: aiHome}

	writeTestFile(t, filepath.Join(hostHome, ".gemini", "history", "gemini-hash", ".project_root"), "/Users/demo/gemini-app")
	writeTestFile(t, filepath.Join(hostHome, ".gemini", "projects.json"), `{"projects":{"/Users/demo/gemini-app":"Friendly Gemini"}}`)
	writeTestFile(t, filepath.Join(hostHome, ".gemini", "tmp", "gemini-hash", "chats", "session-g1.json"), `{
		"sessionId": "g1",
		"messages": [
			{"type":"user","content":[{"text":"Analyze diagram"}],"timestamp":"2026-01-02T03:04:05Z"},
			{"type":"gemini","model":"gemini-2.5-pro","thoughts":[{"subject":"Plan","description":"Inspect"}],"content":"Done"}
		]
	}`)

	projects, err := ListProjects(ctx, opts, "gemini")
	if err != nil {
		t.Fatalf("ListProjects gemini: %v", err)
	}
	if len(projects) != 1 || projects[0].Path != "/Users/demo/gemini-app" || projects[0].Name != "Friendly Gemini" || projects[0].Sessions[0].ID != "g1" {
		t.Fatalf("unexpected gemini projects: %+v", projects)
	}

	snap, err := ReadMessagesSnapshot(ctx, opts, "gemini", "g1", "gemini-hash")
	if err != nil {
		t.Fatalf("ReadMessagesSnapshot gemini: %v", err)
	}
	msgs := decodeMessages(t, snap.Messages)
	if len(msgs) != 2 || msgs[0]["role"] != "user" || !strings.Contains(msgs[1]["content"].(string), ":::thinking\n## Plan\n\nInspect\n:::") || !strings.Contains(msgs[1]["content"].(string), "Done") {
		t.Fatalf("unexpected gemini messages: %+v", msgs)
	}
}

func TestAgyTurnModelTimelineAndBrainTranscript(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	opts := Options{HostHomeDir: hostHome, AIHomeDir: aiHome}

	dbPath := filepath.Join(aiHome, "app-state.db")
	createTestSQLiteDB(t, dbPath, `CREATE TABLE model_usage_records (id INTEGER PRIMARY KEY, provider TEXT, session_id TEXT, model TEXT, source_kind TEXT, timestamp_ms INTEGER)`, func(db *sql.DB) error {
		_, err := db.Exec(`INSERT INTO model_usage_records(provider, session_id, model, source_kind, timestamp_ms) VALUES ('agy','agy-1','claude-sonnet-4-6','native_session_done',2000), ('agy','agy-1','gpt-4o','manual_proxy',3000)`)
		return err
	})

	brainDir := filepath.Join(hostHome, ".gemini", "antigravity", "brain", "agy-1")
	writeTestFile(t, filepath.Join(hostHome, ".gemini", "antigravity-cli", "aih-session-projects.json"), `{"agy-1":{"projectPath":"/Users/demo/agy-ws","updatedAt":5000}}`)
	writeTestFile(t, filepath.Join(brainDir, ".system_generated", "logs", "transcript.jsonl"),
		`{"type":"USER_INPUT","content":"<USER_REQUEST>\nAGY prompt\n</USER_REQUEST>","created_at":"1970-01-01T00:00:02.000Z"}`+"\n"+
			`{"type":"PLANNER_RESPONSE","content":"AGY reply","created_at":"1970-01-01T00:00:02.500Z"}`+"\n")

	projects, err := ListProjects(ctx, opts, "agy")
	if err != nil {
		t.Fatalf("ListProjects agy: %v", err)
	}
	if len(projects) != 1 || projects[0].Sessions[0].Title != "AGY prompt" {
		t.Fatalf("unexpected agy projects: %+v", projects)
	}

	snap, err := ReadMessagesSnapshot(ctx, opts, "agy", "agy-1", "")
	if err != nil {
		t.Fatalf("ReadMessagesSnapshot agy: %v", err)
	}
	msgs := decodeMessages(t, snap.Messages)
	if len(msgs) != 2 || msgs[0]["model"] != "claude-sonnet-4-6" || msgs[1]["content"] != "AGY reply" {
		t.Fatalf("unexpected agy messages: %+v", msgs)
	}

	preview, err := ReadPreview(ctx, opts, "agy", "agy-1", "")
	if err != nil {
		t.Fatalf("ReadPreview agy: %v", err)
	}
	if preview.Model != "gpt-4o" || preview.Preview != "AGY reply" {
		t.Fatalf("unexpected agy preview: %+v", preview)
	}
}

func TestOpenCodeV2LegacyAndSubagents(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	opts := Options{HostHomeDir: hostHome, AIHomeDir: filepath.Join(hostHome, ".ai_home")}

	dbPath := filepath.Join(hostHome, ".local", "share", "opencode", "opencode.db")
	createTestSQLiteDB(t, dbPath, `
		CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
	`, func(db *sql.DB) error {
		if _, err := db.Exec(`INSERT INTO session_v2 VALUES ('oc-parent','/repo/oc','Main Session','claude-opus-4-1',1000,5000,NULL,NULL), ('oc-child','/repo/oc','Child Task','',2000,4000,NULL,'oc-parent')`); err != nil {
			return err
		}
		if _, err := db.Exec(`INSERT INTO message VALUES
			('m1','oc-parent','','1100','{"role":"user","model":{"providerID":"anthropic","modelID":"claude-opus-4-1"}}'),
			('m2','oc-parent','','1200','{"role":"assistant","providerID":"anthropic","modelID":"claude-opus-4-1"}'),
			('m3','oc-child','','2100','{"role":"assistant"}')`); err != nil {
			return err
		}
		_, err := db.Exec(`INSERT INTO part VALUES
			('p1','m1','oc-parent',1101,'{"type":"text","text":"Run task"}'),
			('p2','m2','oc-parent',1201,'{"type":"reasoning","text":"Thinking..."}'),
			('p3','m2','oc-parent',1202,'{"type":"tool","tool":"task","state":{"status":"completed","input":{"description":"Explore code","subagent_type":"explorer"},"metadata":{"sessionId":"oc-child"},"output":""}}'),
			('p4','m3','oc-child',2101,'{"type":"text","text":"Child detailed result"}')`)
		return err
	})

	projects, err := ListProjects(ctx, opts, "opencode")
	if err != nil {
		t.Fatalf("ListProjects opencode: %v", err)
	}
	if len(projects) != 1 || len(projects[0].Sessions) != 1 || projects[0].Sessions[0].ID != "oc-parent" {
		t.Fatalf("expected child session excluded from opencode project list, got %+v", projects)
	}

	snap, err := ReadMessagesSnapshot(ctx, opts, "opencode", "oc-parent", "")
	if err != nil {
		t.Fatalf("ReadMessagesSnapshot opencode: %v", err)
	}
	msgs := decodeMessages(t, snap.Messages)
	if len(msgs) != 2 {
		t.Fatalf("unexpected opencode messages: %+v", msgs)
	}
	content := msgs[1]["content"].(string)
	if !strings.Contains(content, ":::thinking\nThinking...\n:::") || !strings.Contains(content, "Child detailed result") {
		t.Fatalf("expected thinking and child subagent result in opencode content, got %q", content)
	}
	if got := ReadSessionModel(ctx, opts, "opencode", "oc-parent"); got != "claude-opus-4-1" {
		t.Fatalf("ReadSessionModel opencode = %q, want claude-opus-4-1", got)
	}
}

func TestQoderGrokKiroClineZcodeCodebuddyAndChat(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	opts := Options{HostHomeDir: hostHome, AIHomeDir: aiHome}

	// Qoder under auth-projection
	qoderRt := filepath.Join(aiHome, "run", "auth-projections", "qoder", "acct-q")
	writeTestFile(t, filepath.Join(qoderRt, "projects", "-tmp-q", "q1.jsonl"),
		`{"type":"user","cwd":"/tmp/q","timestamp":1000,"message":{"role":"user","content":"Hello Qoder"}}`+"\n"+
			`{"type":"assistant","model":"qwen3-coder","timestamp":2000,"message":{"role":"assistant","content":[{"type":"text","text":"Hi Qoder"}]}}`+"\n")

	// Grok under auth-projection (prompt_index marks real user prompt)
	grokRt := filepath.Join(aiHome, "run", "auth-projections", "grok", "acct-g")
	writeTestFile(t, filepath.Join(grokRt, ".grok", "sessions", "projg", ".cwd"), "/tmp/grok")
	writeTestFile(t, filepath.Join(grokRt, ".grok", "sessions", "projg", "g1", "summary.json"), `{"title":"Grok Chat","updatedAt":"2026-01-01T00:00:00Z"}`)
	writeTestFile(t, filepath.Join(grokRt, ".grok", "sessions", "projg", "g1", "chat_history.jsonl"),
		`{"role":"user","prompt_index":0,"content":"Ask Grok","timestamp":"2026-01-01T00:00:00Z"}`+"\n"+
			`{"role":"assistant","model":"grok-3","content":"Grok reply","timestamp":"2026-01-01T00:00:01Z"}`+"\n")

	// Kiro SQLite
	kiroDB := filepath.Join(hostHome, ".local", "share", "kiro-cli", "data.sqlite3")
	createTestSQLiteDB(t, kiroDB, `CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER)`, func(db *sql.DB) error {
		val := `{"model_info":{"model_id":"claude-sonnet-4"},"history":[{"user":{"content":{"Prompt":{"prompt":"Kiro ask"}}},"assistant":{"Response":{"content":"Kiro answer"}}}]}`
		_, err := db.Exec(`INSERT INTO conversations_v2 VALUES ('/tmp/kiro','k1',?,1000,2000)`, val)
		return err
	})

	// Cline
	clineDataDir := filepath.Join(aiHome, "run", "auth-projections", "cline", "acct-c", ".cline", "data")
	clineSID := "1700000000000_c1ab"
	writeTestFile(t, filepath.Join(clineDataDir, "sessions", clineSID, clineSID+".json"), `{"session_id":"`+clineSID+`","cwd":"/tmp/cline","prompt":"Fix tests","model":"claude-3.7-sonnet","updated_at":5000}`)
	writeTestFile(t, filepath.Join(clineDataDir, "sessions", clineSID, clineSID+".messages.json"), `{"messages":[{"role":"user","content":[{"type":"text","text":"Cline go"}],"ts":4900},{"role":"assistant","content":[{"type":"text","text":"Cline done"}],"ts":5000}]}`)

	// ZCode
	createTestSQLiteDB(t, filepath.Join(hostHome, ".zcode", "cli", "db", "db.sqlite"), `
		CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, path TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, time_created INTEGER, data TEXT);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT);
	`, func(db *sql.DB) error {
		_, _ = db.Exec(`INSERT INTO session VALUES ('z1','','/tmp/zcode','','ZCode Run',1000,2000,'')`)
		_, _ = db.Exec(`INSERT INTO message VALUES ('zm1','z1',1,1100,'{"role":"user"}'), ('zm2','z1',2,1200,'{"role":"assistant","modelID":"glm-5"}')`)
		_, err := db.Exec(`INSERT INTO part VALUES ('zp1','zm1','z1',1,'{"type":"text","text":"Z prompt"}'), ('zp2','zm2','z1',1,'{"type":"text","text":"Z answer"}')`)
		return err
	})

	// WorkBuddy with workbuddy.db metadata
	wbRoot := filepath.Join(hostHome, ".workbuddy", "projects")
	writeTestFile(t, filepath.Join(wbRoot, "projwb", "wb1.jsonl"), `{"type":"session_meta","cwd":"/tmp/wb"}`+"\n"+`{"type":"message","role":"user","content":"WB go","timestamp":8000}`+"\n"+`{"type":"message","role":"assistant","model":"hunyuan","content":"WB ok","timestamp":9000}`+"\n")
	createTestSQLiteDB(t, filepath.Join(hostHome, ".workbuddy", "workbuddy.db"), `CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT, updated_at INTEGER, last_activity_at INTEGER)`, func(db *sql.DB) error {
		_, err := db.Exec(`INSERT INTO sessions VALUES ('wb1','/tmp/wb','Default','WB Custom Title',9000,9000)`)
		return err
	})

	// Chat session
	writeTestFile(t, filepath.Join(aiHome, "chat-sessions", "chat-1.json"), `{"messages":[{"role":"user","content":"Hello chat"},{"role":"assistant","content":"Reply chat","model":"gpt-4.1"}]}`)

	checks := []struct {
		provider string
		sid      string
		wantText string
	}{
		{"qoder", "q1", "Hi Qoder"},
		{"grok", "g1", "Grok reply"},
		{"kiro", "k1", "Kiro answer"},
		{"cline", "1700000000000_c1ab", "Cline done"},
		{"zcode", "z1", "Z answer"},
		{"workbuddy", "wb1", "WB ok"},
		{"chat", "chat-1", "Reply chat"},
	}
	for _, tc := range checks {
		projs, err := ListProjects(ctx, opts, tc.provider)
		if err != nil {
			t.Fatalf("ListProjects(%s): %v", tc.provider, err)
		}
		if tc.provider != "chat" && len(projs) == 0 {
			t.Fatalf("expected non-empty projects for %s", tc.provider)
		}
		if tc.provider == "workbuddy" && projs[0].Sessions[0].Title != "WB Custom Title" {
			t.Fatalf("expected workbuddy.db custom title, got %q", projs[0].Sessions[0].Title)
		}
		snap, err := ReadMessagesSnapshot(ctx, opts, tc.provider, tc.sid, "")
		if err != nil {
			t.Fatalf("ReadMessagesSnapshot(%s, %s): %v", tc.provider, tc.sid, err)
		}
		msgs := decodeMessages(t, snap.Messages)
		if len(msgs) != 2 || msgs[1]["content"] != tc.wantText {
			t.Fatalf("provider %s unexpected msgs: %+v", tc.provider, msgs)
		}
	}

	if prev, err := ReadPreview(ctx, opts, "kiro", "k1", ""); err != nil || prev.Model != "claude-sonnet-4" {
		t.Fatalf("expected kiro preview model claude-sonnet-4, got %+v err=%v", prev, err)
	}
	if prev, err := ReadPreview(ctx, opts, "zcode", "z1", ""); err != nil || prev.Model != "glm-5" {
		t.Fatalf("expected zcode preview model glm-5, got %+v err=%v", prev, err)
	}
	if prev, err := ReadPreview(ctx, opts, "cline", "1700000000000_c1ab", ""); err != nil || prev.Model != "claude-3.7-sonnet" {
		t.Fatalf("expected cline preview model claude-3.7-sonnet, got %+v err=%v", prev, err)
	}
}

func TestCodebuddyIDEVscdbSessionMessages(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	opts := Options{HostHomeDir: hostHome, AIHomeDir: aiHome}

	claims, _ := json.Marshal(map[string]any{
		"iss": "https://www.codebuddy.cn/auth/realms/copilot",
		"sub": "uid-42",
	})
	fakeJWT := "hdr." + base64.RawURLEncoding.EncodeToString(claims) + ".sig"
	createTestSQLiteDB(t, filepath.Join(aiHome, "app-state.db"), `
		CREATE TABLE account_refs (account_ref TEXT, provider TEXT);
		CREATE TABLE account_credentials (provider TEXT, account_ref TEXT, native_auth_json TEXT);
	`, func(db *sql.DB) error {
		_, _ = db.Exec(`INSERT INTO account_refs VALUES ('acct-cb','codebuddycn')`)
		payload, _ := json.Marshal(map[string]any{
			"credentials": map[string]any{
				"auth":    map[string]any{"accessToken": fakeJWT, "refreshToken": "rt-42"},
				"account": map[string]any{"uid": "uid-42"},
			},
		})
		_, err := db.Exec(`INSERT INTO account_credentials VALUES ('codebuddycn','acct-cb',?)`, string(payload))
		return err
	})

	projHex := "11111111111111111111111111111111"
	convHex := "22222222222222222222222222222222"
	msgHex1 := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	msgHex2 := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

	histProj := filepath.Join(resolveCodebuddyExtensionDataRoot(hostHome), "uid-42", "CodeBuddyIDE", "uid-42", "history", projHex)
	writeTestFile(t, filepath.Join(histProj, "index.json"),
		`{"conversations":[{"id":"`+convHex+`","name":"IDE Chat","lastMessageAt":7000}]}`)
	writeTestFile(t, filepath.Join(histProj, convHex, "index.json"),
		`{"messages":[{"id":"`+msgHex1+`"},{"id":"`+msgHex2+`"}],"requests":[{"startedAt":7000}]}`)
	writeTestFile(t, filepath.Join(histProj, convHex, "messages", msgHex1+".json"),
		`{"id":"`+msgHex1+`","role":"user","message":{"content":"IDE Q"},"createdAt":6900}`)
	writeTestFile(t, filepath.Join(histProj, convHex, "messages", msgHex2+".json"),
		`{"id":"`+msgHex2+`","role":"assistant","message":{"content":"IDE A"},"extra":{"modelId":"deepseek-v3"},"createdAt":7000}`)

	createTestSQLiteDB(t, filepath.Join(hostHome, "electron-user-data", "codebuddy-sessions.vscdb"),
		`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)`,
		func(db *sql.DB) error {
			val, _ := json.Marshal(map[string]any{
				"conversationId": convHex,
				"userId":         "uid-42",
				"cwd":            "/tmp/ide-ws",
				"title":          "IDE Native Title",
				"updatedAt":      7500,
			})
			_, err := db.Exec(`INSERT INTO ItemTable VALUES (?, ?)`, "session:"+convHex, string(val))
			return err
		},
	)

	projects, err := ListProjects(ctx, opts, "codebuddycn")
	if err != nil {
		t.Fatalf("ListProjects codebuddycn IDE: %v", err)
	}
	if len(projects) != 1 || projects[0].Path != "/tmp/ide-ws" || projects[0].Sessions[0].ID != convHex {
		t.Fatalf("unexpected codebuddycn IDE projects: %+v", projects)
	}
	snap, err := ReadMessagesSnapshot(ctx, opts, "codebuddycn", convHex, "")
	if err != nil {
		t.Fatalf("ReadMessagesSnapshot codebuddycn IDE: %v", err)
	}
	msgs := decodeMessages(t, snap.Messages)
	if len(msgs) != 2 || msgs[1]["content"] != "IDE A" {
		t.Fatalf("unexpected codebuddycn IDE msgs: %+v", msgs)
	}
}

func TestCanonicalizeAndNonCodexEvents(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	opts := Options{HostHomeDir: hostHome, AIHomeDir: aiHome}

	projImg := filepath.Join(aiHome, "run", "auth-projections", "codex", "a1", ".codex", "img.png")
	privAuth := filepath.Join(aiHome, "run", "auth-projections", "codex", "a1", ".codex", "auth.json")
	writeTestFile(t, projImg, "png")
	writeTestFile(t, privAuth, "{}")

	rawMsg, _ := json.Marshal(map[string]any{
		"role":    "user",
		"content": "Img " + projImg + " and cred " + privAuth,
		"images": []map[string]any{
			{"dataUrl": "file://" + projImg},
			{"dataUrl": "file://" + privAuth},
		},
	})
	out := CanonicalizeMessages([]json.RawMessage{rawMsg}, "codex", aiHome, hostHome)
	var decoded map[string]any
	if err := json.Unmarshal(out[0], &decoded); err != nil {
		t.Fatalf("decode canonicalized: %v", err)
	}
	wantHostImg := filepath.Join(hostHome, ".codex", "img.png")
	if !strings.Contains(decoded["content"].(string), wantHostImg) || !strings.Contains(decoded["content"].(string), privAuth) {
		t.Fatalf("unexpected canonicalized content: %q", decoded["content"])
	}
	imgs := decoded["images"].([]any)
	if imgs[0].(map[string]any)["dataUrl"].(string) != "file://"+wantHostImg {
		t.Fatalf("expected projected image rewritten to %s, got %v", wantHostImg, imgs[0])
	}
	if imgs[1].(map[string]any)["dataUrl"].(string) != "file://"+privAuth {
		t.Fatalf("expected private auth.json preserved, got %v", imgs[1])
	}

	writeTestFile(t, filepath.Join(hostHome, ".gemini", "tmp", "p1", "chats", "session-e1.json"), `{"sessionId":"e1","messages":[{"type":"user","content":"hi"}]}`)
	res1, err := ReadEventsNonCodex(ctx, opts, "gemini", "e1", "p1", 0)
	if err != nil {
		t.Fatalf("ReadEventsNonCodex: %v", err)
	}
	if res1.Cursor == 0 || !res1.RequiresSnapshot || len(res1.Events) != 0 {
		t.Fatalf("unexpected res1: %+v", res1)
	}
	res2, err := ReadEventsNonCodex(ctx, opts, "gemini", "e1", "p1", res1.Cursor)
	if err != nil {
		t.Fatalf("ReadEventsNonCodex steady: %v", err)
	}
	if res2.RequiresSnapshot {
		t.Fatalf("expected RequiresSnapshot=false when cursor unchanged, got %+v", res2)
	}
}

func TestCodexStateDBAndSubagentSnapshot(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	opts := Options{HostHomeDir: hostHome, AIHomeDir: aiHome}

	rollout := filepath.Join(hostHome, ".codex", "sessions", "2026", "01", "rollout-2026-sess-c1.jsonl")
	writeTestFile(t, rollout,
		`{"type":"session_meta","payload":{"id":"sess-c1","cwd":"/tmp/c1","source":"cli"}}`+"\n"+
			`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Launch helper"}]}}`+"\n"+
			`{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call_1","arguments":"{\"message\":\"check files\"}"}}`+"\n"+
			`{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"{\"agent_id\":\"child-1\"}"}}`+"\n"+
			`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"All done"}]}}`+"\n")

	childRollout := filepath.Join(hostHome, ".codex", "sessions", "2026", "01", "rollout-2026-child-1.jsonl")
	writeTestFile(t, childRollout,
		`{"type":"session_meta","payload":{"id":"child-1","cwd":"/tmp/c1"}}`+"\n"+
			`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Subagent finished"}]}}`+"\n")

	createTestSQLiteDB(t, filepath.Join(hostHome, ".codex", "state_5.sqlite"), `
		CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, source TEXT, agent_role TEXT, updated_at INTEGER);
		CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
	`, func(db *sql.DB) error {
		_, _ = db.Exec(`INSERT INTO threads VALUES ('sess-c1',?,'/tmp/c1','cli','',2000), ('child-1',?,'/tmp/c1','{"subagent":"thread_spawn"}','explorer',1900)`, rollout, childRollout)
		_, err := db.Exec(`INSERT INTO thread_spawn_edges VALUES ('sess-c1','child-1','completed')`)
		return err
	})

	resolved := ResolveCodexSessionPath(ctx, hostHome, "sess-c1")
	if resolved != rollout {
		t.Fatalf("ResolveCodexSessionPath = %q, want %q", resolved, rollout)
	}
	snap, err := ReadMessagesSnapshot(ctx, opts, "codex", "sess-c1", "")
	if err != nil {
		t.Fatalf("ReadMessagesSnapshot codex: %v", err)
	}
	msgs := decodeMessages(t, snap.Messages)
	if len(msgs) != 2 || !strings.Contains(msgs[1]["content"].(string), `"child_session_id":"child-1"`) || !strings.Contains(msgs[1]["content"].(string), "All done") {
		t.Fatalf("unexpected codex messages: %+v", msgs)
	}
}
