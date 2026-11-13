package managementops

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

func writeFileMkdir(t *testing.T, targetPath, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s) error = %v", targetPath, err)
	}
	if err := os.WriteFile(targetPath, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%s) error = %v", targetPath, err)
	}
}

func buildTestCodebuddyJWT(iss, sub string) string {
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, _ := json.Marshal(map[string]any{"iss": iss, "sub": sub, "iat": 1700000000})
	pld := base64.RawURLEncoding.EncodeToString(body)
	return hdr + "." + pld + ".sig"
}

func TestScanModelUsageSourcesMultiProvider(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	hostHome := filepath.Join(tmpDir, "host")
	aiHome := filepath.Join(tmpDir, "ai_home")
	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	acctStore, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: aiHome, Catalog: cat})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	defer func() { _ = acctStore.Close() }()

	dbPath, _ := appstate.DatabasePath(aiHome)
	usageStore, err := NewUsageStore(ctx, dbPath, nil, func() time.Time { return time.UnixMilli(1700001000000) })
	if err != nil {
		t.Fatalf("NewUsageStore() error = %v", err)
	}
	defer func() { _ = usageStore.Close() }()

	refCodex := "acct_11111111111111111111"
	refZcode := "acct_22222222222222222222"

	// 1) Codex + persistent session owner
	threadUUID := "018f2b40-1234-7000-8000-000000000001"
	writeFileMkdir(t, filepath.Join(aiHome, "run", "persistent-sessions", "codex-1.json"),
		`{"provider":"codex","nativeSessionId":"`+threadUUID+`","accountRef":"`+refCodex+`","gateway":false,"createdAt":"2026-01-01T00:00:00Z"}`)
	codexSessionFile := filepath.Join(hostHome, ".codex", "sessions", "2026", "01", "01", "rollout-"+threadUUID+".jsonl")
	writeFileMkdir(t, codexSessionFile, stringsJoinLines(
		`{"timestamp":"2026-01-01T00:01:00Z","type":"session_meta","payload":{"id":"`+threadUUID+`","cwd":"/repo/codex","cli_version":"0.1.0"}}`,
		`{"timestamp":"2026-01-01T00:01:01Z","type":"turn_context","payload":{"model":"gpt-5"}}`,
		`{"timestamp":"2026-01-01T00:01:02Z","type":"response_item","payload":{"type":"user_message","message":"hi codex"}}`,
		`{"timestamp":"2026-01-01T00:01:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":120,"cached_input_tokens":20,"output_tokens":30,"reasoning_output_tokens":5,"total_tokens":150}}}}`,
	))

	// 2) Claude
	writeFileMkdir(t, filepath.Join(hostHome, ".claude", "projects", "demo", "cs1.jsonl"), stringsJoinLines(
		`{"timestamp":"2026-01-01T01:00:00Z","type":"user","sessionId":"cs1","cwd":"/repo/claude","message":{"role":"user","content":"hello"}}`,
		`{"timestamp":"2026-01-01T01:00:01Z","type":"assistant","sessionId":"cs1","cwd":"/repo/claude","message":{"id":"msg_c1","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":40,"cache_read_input_tokens":10}}}`,
	))

	// 3) Gemini
	writeFileMkdir(t, filepath.Join(hostHome, ".gemini", "history", "proj1", ".project_root"), "/repo/gemini")
	writeFileMkdir(t, filepath.Join(hostHome, ".gemini", "tmp", "proj1", "chats", "session-g1.json"),
		`{"sessionId":"g1","startTime":"2026-01-01T02:00:00Z","lastUpdated":"2026-01-01T02:01:00Z","messages":[{"id":"u1","type":"user","timestamp":"2026-01-01T02:00:00Z"},{"id":"a1","type":"gemini","timestamp":"2026-01-01T02:00:05Z","model":"gemini-2.5-pro","tokens":{"input":80,"cached":20,"output":25,"thoughts":5,"total":110}}]}`)

	// 4) Kimi (wire.jsonl + session_index.jsonl)
	writeFileMkdir(t, filepath.Join(hostHome, ".kimi-code", "session_index.jsonl"),
		`{"sessionId":"ks1","accountRef":"`+refCodex+`"}`+"\n")
	writeFileMkdir(t, filepath.Join(hostHome, ".kimi-code", "sessions", "ks1", "agents", "default", "wire.jsonl"), stringsJoinLines(
		`{"type":"metadata","created_at":"2026-01-01T03:00:00Z"}`,
		`{"type":"profile.bind","time":"2026-01-01T03:00:01Z","environmentDisclosure":{"cwd":"/repo/kimi"}}`,
		`{"type":"turn.prompt","time":"2026-01-01T03:00:02Z","origin":{"kind":"user"}}`,
		`{"type":"usage.record","time":"2026-01-01T03:00:03Z","usageScope":"turn","model":"kimi-k2","usage":{"inputOther":200,"output":50,"inputCacheRead":30,"inputCacheCreation":10}}`,
	))

	// 5) OpenCode dual layout SQLite
	ocDBPath := filepath.Join(hostHome, ".local", "share", "opencode", "opencode.db")
	if err := os.MkdirAll(filepath.Dir(ocDBPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if ocDB, err := sql.Open("sqlite", ocDBPath); err != nil {
		t.Fatal(err)
	} else {
		_, err = ocDB.Exec(`
			CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, path TEXT, title TEXT, model TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
			CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
			INSERT INTO session_v2 VALUES ('ocs1', '', '/repo/oc', '', 'oc', 'openai/gpt-5', '2.0', 1700000000000, 1700000010000);
			INSERT INTO session_message VALUES ('m_u', 'ocs1', 'user', 1700000001000, 1700000001000, '{}');
			INSERT INTO session_message VALUES ('m_a', 'ocs1', 'assistant', 1700000002000, 1700000002000, '{"modelID":"gpt-5","providerID":"openai","tokens":{"input":90,"output":20,"cache":{"read":15}}}');
		`)
		_ = ocDB.Close()
		if err != nil {
			t.Fatal(err)
		}
	}

	// 6) Zcode single-OAuth account + SQLite
	nowT := time.UnixMilli(1700000000000).UTC()
	zAcct, err := accountcore.RestoreAccount(cat, accountcore.RestoreAccountInput{
		Ref:          accountcore.AccountRef(refZcode),
		ProviderID:   "zcode",
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    nowT,
		UpdatedAt:    nowT,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := acctStore.Create(ctx, zAcct); err != nil {
		t.Fatal(err)
	}
	zDBPath := filepath.Join(hostHome, ".zcode", "cli", "db", "db.sqlite")
	if err := os.MkdirAll(filepath.Dir(zDBPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if zDB, err := sql.Open("sqlite", zDBPath); err != nil {
		t.Fatal(err)
	} else {
		_, err = zDB.Exec(`
			CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
			CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, model_id TEXT, started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, provider_total_tokens INTEGER, computed_total_tokens INTEGER, parent_user_message_id TEXT);
			INSERT INTO session VALUES ('zs1', '/repo/zcode', '', 'z', 1700000000000, 1700000010000);
			INSERT INTO model_usage VALUES ('zu1', 'zs1', 'glm-5', 1700000001000, 1700000002000, 50, 20, 0, 0, 5, 75, 75, 'zp1');
		`)
		_ = zDB.Close()
		if err != nil {
			t.Fatal(err)
		}
	}

	// 7) Qoder estimated + Cline + Kiro + Grok
	writeFileMkdir(t, filepath.Join(hostHome, ".qoder", "projects", "qp", "qs1.jsonl"), stringsJoinLines(
		`{"type":"user","timestamp":"2026-01-01T04:00:00Z","sessionId":"qs1","cwd":"/repo/qoder","message":{"content":"hello"}}`,
		`{"type":"assistant","timestamp":"2026-01-01T04:00:02Z","sessionId":"qs1","message":{"id":"qm1","model":"qwen3-coder","content":[{"type":"text","text":"你好world"}],"usage":{"input_tokens":0,"output_tokens":0,"context_usage_ratio":0.1}}}`,
	))
	writeFileMkdir(t, filepath.Join(hostHome, ".cline", "data", "sessions", "cl1", "cl1.json"),
		`{"session_id":"cl1","cwd":"/repo/cline","started_at":"2026-01-01T05:00:00Z","model":"claude-sonnet-4-5"}`)
	writeFileMkdir(t, filepath.Join(hostHome, ".cline", "data", "sessions", "cl1", "cl1.messages.json"),
		`{"sessionId":"cl1","messages":[{"role":"user","ts":1767243600000},{"id":"clm1","role":"assistant","ts":1767243601000,"metrics":{"inputTokens":60,"outputTokens":20}}]}`)
	writeFileMkdir(t, filepath.Join(hostHome, ".kiro", "sessions", "0123456789abcdef", "sess_k1", "session.json"),
		`{"id":"sess_k1","modelId":"claude-sonnet-4.5","workspacePaths":["/repo/kiro"],"createdAt":"2026-01-01T06:00:00Z"}`)
	writeFileMkdir(t, filepath.Join(hostHome, ".kiro", "sessions", "0123456789abcdef", "sess_k1", "messages.jsonl"), stringsJoinLines(
		`{"id":"k1","timestamp":"2026-01-01T06:00:01Z","payload":{"type":"assistant","content":"hi"}}`,
		`{"id":"k2","timestamp":"2026-01-01T06:00:02Z","payload":{"type":"session_metadata","key":"contextUsage","value":{"usagePercentage":10}}}`,
	))
	writeFileMkdir(t, filepath.Join(aiHome, "run", "auth-projections", "grok", refCodex, "sessions", "projg", "gs1", "summary.json"),
		`{"created_at":"2026-01-01T07:00:00Z","info":{"cwd":"/repo/grok"}}`)
	writeFileMkdir(t, filepath.Join(aiHome, "run", "auth-projections", "grok", refCodex, "sessions", "projg", "gs1", "updates.jsonl"),
		`{"timestamp":"2026-01-01T07:00:05Z","params":{"update":{"sessionUpdate":"turn_completed","prompt_id":"gp1","usage":{"modelUsage":{"grok-3":{"inputTokens":70,"outputTokens":30,"costUsdTicks":200000000}}}}}}`+"\n")

	// 8) CodeBuddy CLI + NativeCredential
	cbIdentity, err := accountcore.NewNativeSubjectIdentity("codebuddy", "uid_123")
	if err != nil {
		t.Fatal(err)
	}
	jwt := buildTestCodebuddyJWT("https://www.codebuddy.ai/auth/realms/copilot", "uid_123")
	credPayload, _ := json.Marshal(map[string]any{
		"credentials": map[string]any{
			"auth":    map[string]any{"accessToken": jwt, "refreshToken": jwt, "domain": "www.codebuddy.ai"},
			"account": map[string]any{"uid": "uid_123"},
		},
	})
	natCred, err := nativeaccount.NewDecoder().DecodeNativeAuth("codebuddy", credPayload)
	if err != nil {
		t.Fatal(err)
	}
	cbAcct, err := accountcore.NewAccount(cat, accountcore.NewAccountInput{
		Identity:     cbIdentity,
		CLIAccountID: accountcore.CLIAccountID(2),
		CreatedAt:    nowT,
	})
	if err != nil {
		t.Fatal(err)
	}
	cbReg, err := accountapp.NewRegistration(cbAcct, natCred, nowT)
	if err != nil {
		t.Fatal(err)
	}
	if err := acctStore.Register(ctx, cbReg); err != nil {
		t.Fatal(err)
	}
	writeFileMkdir(t, filepath.Join(hostHome, ".codebuddy", "logs", "1970-01-20", "app.log"),
		`2026-01-01T08:00:00Z pid=99 {"userId":"uid_123"}`+"\n"+
			`2026-01-01T08:00:01Z pid=99 [addHistory] messageId=cbm1`+"\n")
	writeFileMkdir(t, filepath.Join(hostHome, ".codebuddy", "projects", "cbp", "cbsess1.jsonl"), stringsJoinLines(
		`{"id":"cbu1","type":"message","role":"user","timestamp":"2026-01-01T08:00:00Z","cwd":"/repo/cb"}`,
		`{"id":"cbm1","type":"message","role":"assistant","timestamp":"2026-01-01T08:00:02Z","providerData":{"model":"glm-5","rawUsage":{"prompt_tokens":45,"completion_tokens":15}}}`,
	))

	res, err := ScanModelUsageSources(ctx, ScanUsageOptions{
		AIHomeDir:    aiHome,
		HostHomeDir:  hostHome,
		Store:        usageStore,
		AccountStore: acctStore,
		Catalog:      cat,
		Now:          func() time.Time { return time.Date(1970, 1, 20, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("ScanModelUsageSources() error = %v", err)
	}
	if res.Status != "ok" || res.SchemaVersion != 1 || res.Kind != "usage.scan" {
		t.Fatalf("unexpected scan contract header: status=%s schema=%d kind=%s", res.Status, res.SchemaVersion, res.Kind)
	}
	for _, prov := range []string{"codex", "claude", "gemini", "kimi", "opencode", "zcode", "qoder", "cline", "kiro", "grok", "codebuddy"} {
		if pr, ok := res.Providers[prov]; !ok || pr.Records < 1 {
			t.Fatalf("provider %s expected >=1 record, got %+v", prov, pr)
		}
	}
	if agyRes := res.Providers["agy"]; agyRes.Status != "unavailable" || agyRes.Reason == "" {
		t.Fatalf("agy expected unavailable, got %+v", agyRes)
	}

	var codexAcctRef string
	if err := usageStore.DB().QueryRowContext(ctx, `SELECT COALESCE(account_ref, '') FROM model_usage_records WHERE provider = 'codex' LIMIT 1`).Scan(&codexAcctRef); err != nil {
		t.Fatalf("query codex account_ref error = %v", err)
	}
	if codexAcctRef != refCodex {
		t.Fatalf("codex account_ref = %q, want %q", codexAcctRef, refCodex)
	}

	var cbAcctRef string
	if err := usageStore.DB().QueryRowContext(ctx, `SELECT COALESCE(account_ref, '') FROM model_usage_records WHERE provider = 'codebuddy' LIMIT 1`).Scan(&cbAcctRef); err != nil {
		t.Fatalf("query codebuddy account_ref error = %v", err)
	}
	if cbAcctRef != cbAcct.Ref().String() {
		t.Fatalf("codebuddy account_ref = %q, want %q", cbAcctRef, cbAcct.Ref().String())
	}
}

func TestUsageJobManagerScanAndProgressiveQuery(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	hostHome := filepath.Join(tmpDir, "host")
	aiHome := filepath.Join(tmpDir, "ai_home")
	cat, _ := providers.NewCatalog(providers.BuiltinManifest())
	acctStore, _ := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: aiHome, Catalog: cat})
	defer func() { _ = acctStore.Close() }()
	dbPath, _ := appstate.DatabasePath(aiHome)
	usageStore, _ := NewUsageStore(ctx, dbPath, nil, nil)
	defer func() { _ = usageStore.Close() }()

	svc := NewManagementService(ManagementOptions{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Catalog:     cat,
		Store:       acctStore,
		UsageStore:  usageStore,
	})
	jobs := svc.UsageJobs()

	// 验证分片超过 16 天时上限锁定为 16 个逆时间序分片
	fromMS := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	toMS := time.Date(2026, 1, 25, 23, 59, 59, 999000000, time.UTC).UnixMilli()
	shards := splitDashboardShardsReverseChronological(UsageQuery{FromMS: fromMS, ToMS: toMS, Limit: 50}, toMS)
	if len(shards) > maxDashboardShards || len(shards) < 2 {
		t.Fatalf("shards len = %d, want [2..16]", len(shards))
	}
	if shards[0].ToMS < shards[len(shards)-1].ToMS {
		t.Fatalf("shards not reverse-chronological: first=%d last=%d", shards[0].ToMS, shards[len(shards)-1].ToMS)
	}

	// 启动扫描作业并监听 SSE
	scanCh, scanCancel := jobs.SubscribeScan(ctx)
	defer scanCancel()
	start1, err := jobs.StartScanJob(ctx, "claude")
	if err != nil || !start1.Accepted || start1.AlreadyRunning {
		t.Fatalf("StartScanJob() = %+v, err=%v", start1, err)
	}
	// 同 provider 运行期间或紧接调用应合理返回；等待 succeeded 事件
	deadline := time.After(5 * time.Second)
	sawDone := false
	for !sawDone {
		select {
		case raw := <-scanCh:
			var msg struct {
				Type string       `json:"type"`
				Job  UsageScanJob `json:"job"`
			}
			if json.Unmarshal(raw, &msg) == nil && msg.Type == "usage-scan-job" && (msg.Job.Status == "succeeded" || msg.Job.Status == "failed") {
				sawDone = true
			}
		case <-deadline:
			t.Fatalf("timed out waiting for scan job completion SSE")
		}
	}

	// 插入多天数据，运行渐进查询作业并验证最终状态
	if _, err := usageStore.InsertUsageBatch(ctx, []UsageRecordInput{
		{EventKey: "p:1", Provider: "codex", SessionID: "s1", SourceKind: "server_openai_proxy", Model: "gpt-5", InputTokens: 10, OutputTokens: 5, TotalTokens: 15, TimestampMS: fromMS + 1000},
		{EventKey: "p:2", Provider: "codex", SessionID: "s1", SourceKind: "server_openai_proxy", Model: "gpt-5", InputTokens: 20, OutputTokens: 10, TotalTokens: 30, TimestampMS: toMS - 1000},
	}); err != nil {
		t.Fatal(err)
	}

	qCh, qCancel := jobs.SubscribeDashboardQuery(ctx)
	defer qCancel()
	qJob, err := jobs.StartDashboardQuery(ctx, UsageQuery{FromMS: fromMS, ToMS: toMS, Limit: 50})
	if err != nil {
		t.Fatalf("StartDashboardQuery() error = %v", err)
	}
	qDeadline := time.After(5 * time.Second)
	var finalJob UsageDashboardQueryJob
	for {
		select {
		case raw := <-qCh:
			var msg struct {
				Type string                 `json:"type"`
				Job  UsageDashboardQueryJob `json:"job"`
			}
			if json.Unmarshal(raw, &msg) == nil && msg.Type == "usage-dashboard-query-job" && msg.Job.ID == qJob.ID && msg.Job.Status == "succeeded" {
				finalJob = msg.Job
				goto doneQuery
			}
		case <-qDeadline:
			t.Fatalf("timed out waiting for progressive dashboard query completion")
		}
	}
doneQuery:
	if finalJob.Dashboard == nil || finalJob.Dashboard.Stats.TotalCalls != 2 || finalJob.Dashboard.Stats.TotalSessions != 1 {
		t.Fatalf("unexpected progressive dashboard result: %+v", finalJob.Dashboard)
	}
}

func stringsJoinLines(lines ...string) string {
	out := ""
	for _, l := range lines {
		out += l + "\n"
	}
	return out
}
