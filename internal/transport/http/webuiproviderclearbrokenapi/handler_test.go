package webuiproviderclearbrokenapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprovidercliupgradeapi"
)

const fixedNowMS int64 = 1_700_000_000_000

// 契约要求 NewHandler 的产物可直接挂到 mux 上；*Handler 直接满足 http.Handler。
var _ http.Handler = (*Handler)(nil)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

// fakeVerifier 模拟「探测当前版本 + 验证该版本」两步；指针接收者用于记录调用。
type fakeVerifier struct {
	version      string
	probeErr     error
	verification Verification
	verifyErr    error
	probes       int
}

func (fake *fakeVerifier) ProbeInstalledVersion(context.Context, string) (string, error) {
	fake.probes++
	if fake.probeErr != nil {
		return "", fake.probeErr
	}
	return fake.version, nil
}

func (fake *fakeVerifier) Verify(context.Context, string, string) (Verification, error) {
	if fake.verifyErr != nil {
		return Verification{}, fake.verifyErr
	}
	return fake.verification, nil
}

func newTestCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

// newMux 按共享 wiring 的方式挂载：Path + ClearBrokenSuffix，靠 PathValue 取 provider。
func newMux(t *testing.T, aiHomeDir string, verifier Verifier, status func(context.Context) (any, error)) http.Handler {
	t.Helper()
	return newMuxWithAuth(t, aiHomeDir, verifier, status, fakeAuthorizer{allowed: true})
}

func newMuxWithAuth(
	t *testing.T,
	aiHomeDir string,
	verifier Verifier,
	status func(context.Context) (any, error),
	authorizer Authorizer,
) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle("POST "+Path+ClearBrokenSuffix, newTestHandler(t, aiHomeDir, verifier, status, authorizer))
	return mux
}

func newTestHandler(
	t *testing.T,
	aiHomeDir string,
	verifier Verifier,
	status func(context.Context) (any, error),
	authorizer Authorizer,
) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: authorizer,
		AIHomeDir:  aiHomeDir,
		Catalog:    newTestCatalog(t),
		Verifier:   verifier,
		Status:     status,
		Now:        func() time.Time { return time.UnixMilli(fixedNowMS) },
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func seedLedger(t *testing.T, aiHomeDir string, payload string) {
	t.Helper()
	directory := filepath.Join(aiHomeDir, "run")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, ledgerFileName), []byte(payload), 0o600); err != nil {
		t.Fatalf("write ledger: %v", err)
	}
}

func readLedgerFile(t *testing.T, aiHomeDir string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(aiHomeDir, "run", ledgerFileName))
	if err != nil {
		t.Fatalf("read ledger: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode %q: %v", string(raw), err)
	}
	return payload
}

func providerRecord(t *testing.T, aiHomeDir string, provider string) map[string]any {
	t.Helper()
	record := object(object(readLedgerFile(t, aiHomeDir)["providers"])[provider])
	if len(record) == 0 {
		t.Fatalf("ledger 里没有 %s 的记录", provider)
	}
	return record
}

func postClear(t *testing.T, handler http.Handler, provider string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path+"/"+provider+"/clear-broken", nil))
	var payload map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, payload
}

const brokenLedger = `{"schemaVersion":1,"global":{"enabled":false,"disabledReason":"paused"},"providers":{` +
	`"codex":{"state":"broken","channel":"npm_global","enabled":false,"disabledReason":"verify_failed",` +
	`"installedVersion":"1.0.0","targetVersion":"2.0.0","knownGoodVersion":"0.9.0",` +
	`"knownGoodRollbackable":false,"baselineHealthy":false,"blockedVersions":["2.0.0","2.1.0"],` +
	`"lastApplyError":"boom","consecutiveFailures":2,"consecutiveDefers":1,"consecutiveQuiescentTicks":3,` +
	`"lastDeferReason":"waiting","history":[{"at":1,"outcome":"apply_failed"}]},` +
	`"claude":{"state":"healthy","enabled":true,"installedVersion":"1.2.3"}}}`

// 契约路径必须与只读接口同一个前缀，否则共享 wiring 会挂出两条不同的路由。
func TestPathMatchesReadContract(t *testing.T) {
	if Path != webuiprovidercliupgradeapi.Path {
		t.Fatalf("Path = %q, 读接口 = %q", Path, webuiprovidercliupgradeapi.Path)
	}
}

func TestAuthAndMethod(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedLedger(t, aiHomeDir, brokenLedger)

	unauthorized := newMuxWithAuth(t, aiHomeDir, nil, nil, fakeAuthorizer{})
	recorder, _ := postClear(t, unauthorized, "codex")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("401 = %d body = %s", recorder.Code, recorder.Body.String())
	}

	// 直接调 Handler：mux 自己也会对方法不符回 405，绕开它才能验证本包的分支。
	handler := newTestHandler(t, aiHomeDir, nil, nil, fakeAuthorizer{allowed: true})
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/codex/clear-broken", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET = %d", recorder.Code)
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q", allow)
	}
	if providerRecord(t, aiHomeDir, "codex")["state"] != "broken" {
		t.Fatalf("405 不该动账本")
	}
}

func TestUnknownAndInvalidProvider(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedLedger(t, aiHomeDir, brokenLedger)
	handler := newMux(t, aiHomeDir, nil, nil)

	// grok 在 catalog 里但没有 CLI 包，不是升级候选。
	for _, provider := range []string{"grok", "no-such-provider"} {
		recorder, payload := postClear(t, handler, provider)
		if recorder.Code != http.StatusBadRequest || payload["error"] != ReasonUnknownProvider {
			t.Fatalf("%s = %d %#v", provider, recorder.Code, payload)
		}
	}

	recorder, payload := postClear(t, handler, "BAD%20ID")
	if recorder.Code != http.StatusBadRequest || payload["error"] != "invalid_provider" {
		t.Fatalf("非法 provider = %d %#v", recorder.Code, payload)
	}
}

func TestNotBroken(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedLedger(t, aiHomeDir, `{"schemaVersion":1,"providers":{"codex":{"state":"healthy","enabled":true,"installedVersion":"2.0.0"}}}`)
	before := providerRecord(t, aiHomeDir, "codex")

	verifier := &fakeVerifier{version: "2.0.0", verification: Verification{Verdict: VerdictPass}}
	recorder, payload := postClear(t, newMux(t, aiHomeDir, verifier, nil), "codex")
	if recorder.Code != http.StatusConflict || payload["ok"] != false || payload["reason"] != ReasonNotBroken {
		t.Fatalf("409 = %d %#v", recorder.Code, payload)
	}
	if verifier.probes != 0 {
		t.Fatalf("没熔断就不该起验证，probes = %d", verifier.probes)
	}
	if after := providerRecord(t, aiHomeDir, "codex"); after["state"] != before["state"] || after["installedVersion"] != before["installedVersion"] {
		t.Fatalf("409 不该动账本: %#v", after)
	}
}

func TestVerifyFailuresKeepBroken(t *testing.T) {
	cases := []struct {
		name     string
		verifier *fakeVerifier
		code     int
		reason   string
	}{
		{
			name:     "探测失败",
			verifier: &fakeVerifier{probeErr: errors.New("which 失败")},
			code:     http.StatusUnprocessableEntity,
			reason:   ReasonInstalledVersionUnknown,
		},
		{
			name:     "探测为空",
			verifier: &fakeVerifier{version: "  "},
			code:     http.StatusUnprocessableEntity,
			reason:   ReasonInstalledVersionUnknown,
		},
		{
			name:     "明确不可用",
			verifier: &fakeVerifier{version: "2.0.0", verification: Verification{Verdict: VerdictFail, Detail: "app_server_exit_1"}},
			code:     http.StatusUnprocessableEntity,
			reason:   ReasonVerifyFailed,
		},
		{
			name:     "无法确证",
			verifier: &fakeVerifier{version: "2.0.0", verification: Verification{Verdict: VerdictInconclusive, Detail: "timeout"}},
			code:     http.StatusUnprocessableEntity,
			reason:   ReasonVerifyInconclusive,
		},
		{
			name:     "验证抛错",
			verifier: &fakeVerifier{version: "2.0.0", verifyErr: errors.New("spawn 失败")},
			code:     http.StatusUnprocessableEntity,
			reason:   ReasonVerifyInconclusive,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			aiHomeDir := t.TempDir()
			seedLedger(t, aiHomeDir, brokenLedger)
			recorder, payload := postClear(t, newMux(t, aiHomeDir, testCase.verifier, nil), "codex")
			if recorder.Code != testCase.code || payload["ok"] != false || payload["reason"] != testCase.reason {
				t.Fatalf("%d %#v", recorder.Code, payload)
			}
			record := providerRecord(t, aiHomeDir, "codex")
			if record["state"] != "broken" || record["enabled"] != false {
				t.Fatalf("验证没过却动了账本: %#v", record)
			}
		})
	}
}

func TestClearBrokenWritesLedger(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedLedger(t, aiHomeDir, brokenLedger)
	verifier := &fakeVerifier{version: "2.0.0", verification: Verification{Verdict: VerdictPass, Detail: "app_server_ok"}}

	recorder, payload := postClear(t, newMux(t, aiHomeDir, verifier, nil), "codex")
	if recorder.Code != http.StatusOK {
		t.Fatalf("200 = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if payload["ok"] != true || payload["reason"] != ReasonCleared || payload["verified"] != true {
		t.Fatalf("payload = %#v", payload)
	}
	if payload["version"] != "2.0.0" || payload["detail"] != "app_server_ok" {
		t.Fatalf("payload = %#v", payload)
	}
	if payload["status"] != nil {
		t.Fatalf("未接线 status 应为 null: %#v", payload["status"])
	}

	document := readLedgerFile(t, aiHomeDir)
	if number(document["schemaVersion"]) != ledgerSchemaVersion {
		t.Fatalf("schemaVersion = %#v", document["schemaVersion"])
	}
	global := object(document["global"])
	if global["enabled"] != false || global["disabledReason"] != "paused" {
		t.Fatalf("global 应原样保留: %#v", global)
	}

	record := providerRecord(t, aiHomeDir, "codex")
	expectations := map[string]any{
		"state": "healthy", "enabled": true, "disabledReason": "",
		"installedVersion": "2.0.0", "knownGoodVersion": "2.0.0",
		"knownGoodRollbackable": true, "baselineHealthy": true,
		"targetVersion": "", "lastApplyError": "", "lastDeferReason": "",
	}
	for key, want := range expectations {
		if record[key] != want {
			t.Fatalf("%s = %#v, 期望 %#v", key, record[key], want)
		}
	}
	for _, key := range []string{"consecutiveFailures", "consecutiveDefers", "consecutiveQuiescentTicks"} {
		if number(record[key]) != 0 {
			t.Fatalf("%s = %#v", key, record[key])
		}
	}
	// 验证通过的版本从黑名单移除，其它拉黑版本保持不动。
	blocked := stringList(record["blockedVersions"])
	if len(blocked) != 1 || blocked[0] != "2.1.0" {
		t.Fatalf("blockedVersions = %#v", blocked)
	}

	history := anyList(record["history"])
	if len(history) != 2 {
		t.Fatalf("history = %#v", history)
	}
	entry := object(history[1])
	if entry["outcome"] != "cleared" || entry["from"] != "1.0.0" || entry["to"] != "2.0.0" {
		t.Fatalf("history entry = %#v", entry)
	}
	if entry["detail"] != "manual_clear:app_server_ok" || number(entry["at"]) != fixedNowMS {
		t.Fatalf("history entry = %#v", entry)
	}

	// 其它 provider 不受影响。
	claude := providerRecord(t, aiHomeDir, "claude")
	if claude["state"] != "healthy" || claude["installedVersion"] != "1.2.3" {
		t.Fatalf("claude = %#v", claude)
	}

	// 二次清除：账本已解除，应当 409。
	recorder, payload = postClear(t, newMux(t, aiHomeDir, verifier, nil), "codex")
	if recorder.Code != http.StatusConflict || payload["reason"] != ReasonNotBroken {
		t.Fatalf("二次清除 = %d %#v", recorder.Code, payload)
	}
}

// 半解除账本（state 已改回但 enabled 仍为 false）也算熔断，自动升级照样停着。
func TestClearBrokenWithoutVerifier(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedLedger(t, aiHomeDir, `{"schemaVersion":1,"providers":{"codex":{"state":"healthy","enabled":false,"channel":"standalone_release","installedVersion":"3.0.0"}}}`)

	recorder, payload := postClear(t, newMux(t, aiHomeDir, nil, nil), "codex")
	if recorder.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("%d %#v", recorder.Code, payload)
	}
	if payload["verified"] != false || payload["version"] != "3.0.0" {
		t.Fatalf("payload = %#v", payload)
	}
	record := providerRecord(t, aiHomeDir, "codex")
	if record["enabled"] != true || record["knownGoodVersion"] != "3.0.0" || record["knownGoodRollbackable"] != true {
		t.Fatalf("record = %#v", record)
	}
	entry := object(anyList(record["history"])[0])
	if entry["detail"] != "manual_clear:skipped" {
		t.Fatalf("跳过验证的 history = %#v", entry)
	}
}

// history 上限与 Node 一致：只保留最近 20 条。
func TestHistoryLimit(t *testing.T) {
	aiHomeDir := t.TempDir()
	entries := make([]any, 0, historyLimit)
	for index := 0; index < historyLimit; index++ {
		entries = append(entries, map[string]any{"at": index, "outcome": "soak_ok"})
	}
	payload, err := json.Marshal(map[string]any{
		"schemaVersion": 1,
		"providers": map[string]any{
			"codex": map[string]any{"state": "broken", "enabled": false, "installedVersion": "1.0.0", "history": entries},
		},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	seedLedger(t, aiHomeDir, string(payload))

	if recorder, _ := postClear(t, newMux(t, aiHomeDir, nil, nil), "codex"); recorder.Code != http.StatusOK {
		t.Fatalf("200 = %d", recorder.Code)
	}
	history := anyList(providerRecord(t, aiHomeDir, "codex")["history"])
	if len(history) != historyLimit {
		t.Fatalf("history 长度 = %d", len(history))
	}
	if object(history[len(history)-1])["outcome"] != "cleared" {
		t.Fatalf("最后一条 = %#v", history[len(history)-1])
	}
}

// status 由调用方注入，原样嵌入响应；读失败按缺席处理，不盖掉写操作结果。
func TestStatusSource(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedLedger(t, aiHomeDir, brokenLedger)
	status := func(context.Context) (any, error) {
		return map[string]any{"ok": true, "scheduler": nil, "providers": []any{}}, nil
	}
	recorder, payload := postClear(t, newMux(t, aiHomeDir, nil, status), "codex")
	if recorder.Code != http.StatusOK {
		t.Fatalf("200 = %d", recorder.Code)
	}
	view := object(payload["status"])
	if view["ok"] != true {
		t.Fatalf("status = %#v", payload["status"])
	}

	failing := func(context.Context) (any, error) { return nil, errors.New("读账本失败") }
	recorder, payload = postClear(t, newMux(t, aiHomeDir, nil, failing), "codex")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status 读失败不该改变业务结论: %d", recorder.Code)
	}
	if payload["status"] != nil {
		t.Fatalf("status = %#v", payload["status"])
	}
}

func TestInvalidDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("err = %v", err)
	}
}
