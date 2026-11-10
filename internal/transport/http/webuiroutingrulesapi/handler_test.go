package webuiroutingrulesapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/appstate/rulesenv"
)

const (
	testRef = "acct_routing_rules_0001"
	// canonicalRef 是规范账号引用：运行态端口按规范键清理，非规范 ref 会被拒绝。
	canonicalRef       = "acct_0123456789abcdef0123"
	testProvider       = "claude"
	seededEnvUpdatedAt = int64(1700000000123)
)

type allowAllAuthorizer struct{ allow bool }

func (authorizer allowAllAuthorizer) Authorized(*http.Request) bool { return authorizer.allow }

type fixture struct {
	path     string
	db       *sql.DB
	store    *rulesenv.Store
	accounts AccountResolver
	catalog  *providers.Catalog
}

func newFixture(t *testing.T, envJSON string) *fixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), appstate.DatabaseFileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, statement := range []string{
		"CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		"CREATE TABLE account_credentials (account_ref TEXT PRIMARY KEY, env_json TEXT NOT NULL DEFAULT '{}', native_auth_json TEXT NOT NULL DEFAULT '{}', env_updated_at INTEGER NOT NULL DEFAULT 0, native_auth_updated_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	if _, err := db.Exec("INSERT INTO account_refs VALUES (?, ?, 1, 1)", testRef, testProvider); err != nil {
		t.Fatalf("insert account_refs: %v", err)
	}
	if _, err := db.Exec(
		"INSERT INTO account_credentials (account_ref, env_json, native_auth_json, env_updated_at, native_auth_updated_at, updated_at) VALUES (?, ?, '{}', ?, 1700000000111, 1700000000222)",
		testRef, envJSON, seededEnvUpdatedAt,
	); err != nil {
		t.Fatalf("insert account_credentials: %v", err)
	}
	store, err := rulesenv.Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open rulesenv: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("new catalog: %v", err)
	}
	return &fixture{
		path:     path,
		db:       db,
		store:    store,
		accounts: AppStateResolver{DatabasePath: path},
		catalog:  catalog,
	}
}

func (f *fixture) newHandler(t *testing.T, authorizer Authorizer) *Handler {
	t.Helper()
	return f.newHandlerWithRuntime(t, authorizer, nil)
}

func (f *fixture) newHandlerWithRuntime(
	t *testing.T,
	authorizer Authorizer,
	runtime RuntimeBlockClearer,
) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: authorizer,
		Store:      f.store,
		Accounts:   f.accounts,
		Catalog:    f.catalog,
		Runtime:    runtime,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

// seedAccount 追加一个额外的 account_refs + account_credentials 行。
func (f *fixture) seedAccount(t *testing.T, accountRef string, envJSON string) {
	t.Helper()
	if _, err := f.db.Exec("INSERT INTO account_refs VALUES (?, ?, 1, 1)", accountRef, testProvider); err != nil {
		t.Fatalf("insert account_refs: %v", err)
	}
	if _, err := f.db.Exec(
		"INSERT INTO account_credentials (account_ref, env_json, native_auth_json, env_updated_at, native_auth_updated_at, updated_at) VALUES (?, ?, '{}', ?, 1700000000111, 1700000000222)",
		accountRef, envJSON, seededEnvUpdatedAt,
	); err != nil {
		t.Fatalf("insert account_credentials: %v", err)
	}
}

// fakeBlockClearer 记录调用参数，并按配置返回证据或失败。
type fakeBlockClearer struct {
	calls    []accountcore.AccountRef
	evidence accountcore.StatusEventKind
	err      error
}

func (clearer *fakeBlockClearer) ClearManualAdminBlocks(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.StatusEventKind, error) {
	clearer.calls = append(clearer.calls, accountRef)
	if clearer.err != nil {
		return "", clearer.err
	}
	if clearer.evidence == "" {
		return accountcore.StatusEventManualAdminClear, nil
	}
	return clearer.evidence, nil
}

func (f *fixture) post(t *testing.T, handler *Handler, provider, accountRef, body string) *httptest.ResponseRecorder {
	t.Helper()
	target := "/v1/management/webui/accounts/" + provider + "/" + accountRef + "/routing-rules"
	request := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	request.SetPathValue("provider", provider)
	request.SetPathValue("accountRef", accountRef)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func (f *fixture) storedEnv(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	var raw string
	if err := f.db.QueryRow("SELECT env_json FROM account_credentials WHERE account_ref = ?", testRef).Scan(&raw); err != nil {
		t.Fatalf("read env_json: %v", err)
	}
	env := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatalf("decode env_json: %v", err)
	}
	return env
}

func (f *fixture) storedEnvUpdatedAt(t *testing.T) int64 {
	t.Helper()
	var value int64
	if err := f.db.QueryRow("SELECT env_updated_at FROM account_credentials WHERE account_ref = ?", testRef).Scan(&value); err != nil {
		t.Fatalf("read env_updated_at: %v", err)
	}
	return value
}

func envString(t *testing.T, env map[string]json.RawMessage, key string) string {
	t.Helper()
	raw, exists := env[key]
	if !exists {
		t.Fatalf("env key %s missing", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode env value %s: %v", key, err)
	}
	return value
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}

func decodeView(t *testing.T, recorder *httptest.ResponseRecorder) successView {
	t.Helper()
	var view successView
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode response %q: %v", recorder.Body.String(), err)
	}
	return view
}

func assertError(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", recorder.Code, status, recorder.Body.String())
	}
	var view errorView
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if view.OK {
		t.Fatalf("error response ok = true")
	}
	if view.Error != code {
		t.Fatalf("error code = %q, want %q (body %s)", view.Error, code, recorder.Body.String())
	}
}

func validRule() map[string]any {
	return map[string]any{
		"name":     "billing",
		"kind":     "billing_blocked",
		"enabled":  true,
		"statuses": []any{402},
		"matchers": []any{
			map[string]any{"source": "http_code", "operator": "equals", "value": 402},
		},
	}
}

func legacyRule() map[string]any {
	return map[string]any{
		"name": "legacy",
		"kind": "auth_invalid",
		"matchers": []any{
			map[string]any{"field": "message", "pattern": "^invalid.*key"},
		},
	}
}

func regexRule(pattern string) map[string]any {
	return map[string]any{
		"kind": "rate_limited",
		"matchers": []any{
			map[string]any{"source": "body", "operator": "regex", "value": pattern},
		},
	}
}

func TestPostWritesCanonicalRulesAndGroups(t *testing.T) {
	f := newFixture(t, `{"OTHER_KEY":"keep"}`)
	handler := f.newHandler(t, allowAllAuthorizer{allow: true})
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule(), legacyRule()},
		"upstreamErrorGroupIds": []string{"group-a", " group-a ", "group_b"},
		"clearErrorBlock":       false,
	})
	recorder := f.post(t, handler, testProvider, testRef, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
	}
	view := decodeView(t, recorder)
	if !view.OK || !view.Changed {
		t.Fatalf("view = %+v, want ok and changed", view)
	}
	if view.Provider != testProvider || view.AccountRef != testRef {
		t.Fatalf("view identity = %s/%s", view.Provider, view.AccountRef)
	}
	if view.EnvUpdatedAt != seededEnvUpdatedAt {
		t.Fatalf("envUpdatedAt = %d, want %d", view.EnvUpdatedAt, seededEnvUpdatedAt)
	}
	if len(view.UpstreamErrorRules) != 2 || len(view.UpstreamErrorGroupIDs) != 2 {
		t.Fatalf("view payload = %+v", view)
	}
	env := f.storedEnv(t)
	if _, exists := env["OTHER_KEY"]; !exists {
		t.Fatalf("credential key OTHER_KEY was dropped: %v", env)
	}
	var storedRules []map[string]any
	if err := json.Unmarshal([]byte(envString(t, env, rulesenv.RulesEnvKey)), &storedRules); err != nil {
		t.Fatalf("decode stored rules: %v", err)
	}
	if len(storedRules) != 2 || storedRules[0]["kind"] != "billing_blocked" {
		t.Fatalf("stored rules = %+v", storedRules)
	}
	if storedRules[1]["enabled"] != true {
		t.Fatalf("legacy rule enabled = %v, want default true", storedRules[1]["enabled"])
	}
	matchers, _ := storedRules[1]["matchers"].([]any)
	if len(matchers) != 1 || matchers[0].(map[string]any)["field"] != "message" {
		t.Fatalf("legacy matcher not preserved: %+v", storedRules[1]["matchers"])
	}
	var storedGroups []string
	if err := json.Unmarshal([]byte(envString(t, env, rulesenv.GroupIDsEnvKey)), &storedGroups); err != nil {
		t.Fatalf("decode stored groups: %v", err)
	}
	if len(storedGroups) != 2 || storedGroups[0] != "group-a" || storedGroups[1] != "group_b" {
		t.Fatalf("stored group ids = %v", storedGroups)
	}
	if got := f.storedEnvUpdatedAt(t); got != seededEnvUpdatedAt {
		t.Fatalf("env_updated_at = %d, want %d", got, seededEnvUpdatedAt)
	}
}

func TestPostEmptyCollectionsClearKeys(t *testing.T) {
	seed := map[string]string{
		"ANTHROPIC_API_KEY":     "sk-live",
		rulesenv.RulesEnvKey:    mustJSON(t, []any{legacyRule()}),
		rulesenv.GroupIDsEnvKey: mustJSON(t, []string{"old-group"}),
	}
	f := newFixture(t, mustJSON(t, seed))
	handler := f.newHandler(t, allowAllAuthorizer{allow: true})
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{},
		"upstreamErrorGroupIds": []string{},
	})
	recorder := f.post(t, handler, testProvider, testRef, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
	}
	env := f.storedEnv(t)
	if _, exists := env[rulesenv.RulesEnvKey]; exists {
		t.Fatalf("rules key still present: %v", env)
	}
	if _, exists := env[rulesenv.GroupIDsEnvKey]; exists {
		t.Fatalf("group ids key still present: %v", env)
	}
	if _, exists := env["ANTHROPIC_API_KEY"]; !exists {
		t.Fatalf("credential key was dropped: %v", env)
	}
}

func TestPostNullCollectionsAreEmpty(t *testing.T) {
	seed := map[string]string{
		rulesenv.RulesEnvKey:    mustJSON(t, []any{legacyRule()}),
		rulesenv.GroupIDsEnvKey: mustJSON(t, []string{"old-group"}),
	}
	f := newFixture(t, mustJSON(t, seed))
	handler := f.newHandler(t, allowAllAuthorizer{allow: true})
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    nil,
		"upstreamErrorGroupIds": nil,
	})
	recorder := f.post(t, handler, testProvider, testRef, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
	}
	if env := f.storedEnv(t); len(env) != 0 {
		t.Fatalf("env = %v, want empty", env)
	}
}

func TestPostIsIdempotent(t *testing.T) {
	f := newFixture(t, `{}`)
	handler := f.newHandler(t, allowAllAuthorizer{allow: true})
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule()},
		"upstreamErrorGroupIds": []string{"group-a"},
	})
	first := decodeView(t, f.post(t, handler, testProvider, testRef, body))
	if !first.Changed {
		t.Fatalf("first write changed = false")
	}
	second := decodeView(t, f.post(t, handler, testProvider, testRef, body))
	if second.Changed {
		t.Fatalf("second write changed = true, want false")
	}
	if second.EnvUpdatedAt != first.EnvUpdatedAt {
		t.Fatalf("envUpdatedAt changed: %d -> %d", first.EnvUpdatedAt, second.EnvUpdatedAt)
	}
}

// 未装配运行态端口时仍然整次拒绝，且不产生任何 env 写入。
func TestPostClearErrorBlockWithoutRuntimeIsRejectedWithoutWrite(t *testing.T) {
	f := newFixture(t, `{"OTHER_KEY":"keep"}`)
	handler := f.newHandler(t, allowAllAuthorizer{allow: true})
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule()},
		"upstreamErrorGroupIds": []string{"group-a"},
		"clearErrorBlock":       true,
	})
	recorder := f.post(t, handler, testProvider, testRef, body)
	assertError(t, recorder, http.StatusNotImplemented, "runtime_block_clear_unavailable")
	env := f.storedEnv(t)
	if len(env) != 1 {
		t.Fatalf("env = %v, want only the seeded key", env)
	}
	if _, exists := env[rulesenv.RulesEnvKey]; exists {
		t.Fatalf("rules were written despite rejected clearErrorBlock")
	}
}

// clearErrorBlock=true 走运行态端口，并在响应里回报实际证据名。
func TestPostClearErrorBlockClearsRuntimeAndWrites(t *testing.T) {
	f := newFixture(t, `{}`)
	f.seedAccount(t, canonicalRef, `{"OTHER_KEY":"keep"}`)
	clearer := &fakeBlockClearer{}
	handler := f.newHandlerWithRuntime(t, allowAllAuthorizer{allow: true}, clearer)
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule()},
		"upstreamErrorGroupIds": []string{"group-a"},
		"clearErrorBlock":       true,
	})
	recorder := f.post(t, handler, testProvider, canonicalRef, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
	}
	if len(clearer.calls) != 1 || clearer.calls[0].String() != canonicalRef {
		t.Fatalf("cleared refs = %v, want [%s]", clearer.calls, canonicalRef)
	}
	view := decodeView(t, recorder)
	if view.ClearEvidence != string(accountcore.StatusEventManualAdminClear) {
		t.Fatalf("clearEvidence = %q, want manual_admin_clear", view.ClearEvidence)
	}
	env := storedEnvFor(t, f.db, canonicalRef)
	if _, exists := env["OTHER_KEY"]; !exists {
		t.Fatalf("credential key dropped: %v", env)
	}
	if _, exists := env[rulesenv.RulesEnvKey]; !exists {
		t.Fatalf("rules key missing: %v", env)
	}
}

// 运行态清理失败必须整次失败，不能写 env。
func TestPostClearErrorBlockReportsRuntimeFailure(t *testing.T) {
	f := newFixture(t, `{"OTHER_KEY":"keep"}`)
	f.seedAccount(t, canonicalRef, `{}`)
	clearer := &fakeBlockClearer{err: errRuntimeBlockClear}
	handler := f.newHandlerWithRuntime(t, allowAllAuthorizer{allow: true}, clearer)
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule()},
		"upstreamErrorGroupIds": []string{"group-a"},
		"clearErrorBlock":       true,
	})
	recorder := f.post(t, handler, testProvider, canonicalRef, body)
	assertError(t, recorder, http.StatusInternalServerError, "runtime_block_clear_failed")
	if env := f.storedEnv(t); len(env) != 1 {
		t.Fatalf("env = %v, want only the seeded key", env)
	}
}

// 端口回报的证据名不是 manual_admin_clear 时不能当成清理成功。
func TestPostClearErrorBlockRejectsUnexpectedEvidence(t *testing.T) {
	f := newFixture(t, `{"OTHER_KEY":"keep"}`)
	f.seedAccount(t, canonicalRef, `{}`)
	clearer := &fakeBlockClearer{evidence: accountcore.StatusEventLoginSuccess}
	handler := f.newHandlerWithRuntime(t, allowAllAuthorizer{allow: true}, clearer)
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule()},
		"upstreamErrorGroupIds": []string{"group-a"},
		"clearErrorBlock":       true,
	})
	recorder := f.post(t, handler, testProvider, canonicalRef, body)
	assertError(t, recorder, http.StatusInternalServerError, "runtime_block_clear_failed")
	if env := f.storedEnv(t); len(env) != 1 {
		t.Fatalf("env = %v, want only the seeded key", env)
	}
}

// 非规范账号引用不能作为运行态键：按路径无效拒绝，且不写 env。
func TestPostClearErrorBlockRejectsNonCanonicalRef(t *testing.T) {
	f := newFixture(t, `{"OTHER_KEY":"keep"}`)
	clearer := &fakeBlockClearer{}
	handler := f.newHandlerWithRuntime(t, allowAllAuthorizer{allow: true}, clearer)
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule()},
		"upstreamErrorGroupIds": []string{"group-a"},
		"clearErrorBlock":       true,
	})
	recorder := f.post(t, handler, testProvider, testRef, body)
	assertError(t, recorder, http.StatusBadRequest, "invalid_account_path")
	if len(clearer.calls) != 0 {
		t.Fatalf("cleared refs = %v, want none", clearer.calls)
	}
	if env := f.storedEnv(t); len(env) != 1 {
		t.Fatalf("env = %v, want only the seeded key", env)
	}
}

func TestPostRejectsProviderMismatch(t *testing.T) {
	f := newFixture(t, `{}`)
	handler := f.newHandler(t, allowAllAuthorizer{allow: true})
	recorder := f.post(t, handler, "codex", testRef, `{"upstreamErrorRules":[]}`)
	assertError(t, recorder, http.StatusNotFound, "account_not_found")
	if env := f.storedEnv(t); len(env) != 0 {
		t.Fatalf("env = %v, want empty", env)
	}
}

func TestPostRejectsUnsupportedProvider(t *testing.T) {
	f := newFixture(t, `{}`)
	handler := f.newHandler(t, allowAllAuthorizer{allow: true})
	recorder := f.post(t, handler, "not-a-provider", testRef, `{"upstreamErrorRules":[]}`)
	assertError(t, recorder, http.StatusBadRequest, "unsupported_provider")
}

func TestPostRejectsUnknownAccount(t *testing.T) {
	f := newFixture(t, `{}`)
	handler := f.newHandler(t, allowAllAuthorizer{allow: true})
	recorder := f.post(t, handler, testProvider, "acct_missing", `{"upstreamErrorRules":[]}`)
	assertError(t, recorder, http.StatusNotFound, "account_not_found")
}

func TestPostRejectsInvalidRules(t *testing.T) {
	tooManyRules := make([]any, 21)
	for index := range tooManyRules {
		tooManyRules[index] = validRule()
	}
	cases := map[string]map[string]any{
		"unknown kind": {
			"kind":     "nope",
			"matchers": []any{map[string]any{"field": "message", "pattern": "x"}},
		},
		"no matchers": {
			"kind":     "rate_limited",
			"matchers": []any{},
		},
		"bad status": {
			"kind":     "rate_limited",
			"statuses": []any{200},
			"matchers": []any{map[string]any{"field": "message", "pattern": "x"}},
		},
		"grouped regex":     regexRule("(slow)+"),
		"backreference":     regexRule("slow\\1"),
		"unanchored repeat": regexRule("a+b"),
		"counted repeat":    regexRule("a{2}"),
	}
	for name, rule := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, `{}`)
			handler := f.newHandler(t, allowAllAuthorizer{allow: true})
			body := mustJSON(t, map[string]any{"upstreamErrorRules": []any{rule}})
			recorder := f.post(t, handler, testProvider, testRef, body)
			assertError(t, recorder, http.StatusBadRequest, "invalid_upstream_error_rules")
			if env := f.storedEnv(t); len(env) != 0 {
				t.Fatalf("env = %v, want empty", env)
			}
		})
	}
	t.Run("too many rules", func(t *testing.T) {
		f := newFixture(t, `{}`)
		handler := f.newHandler(t, allowAllAuthorizer{allow: true})
		body := mustJSON(t, map[string]any{"upstreamErrorRules": tooManyRules})
		recorder := f.post(t, handler, testProvider, testRef, body)
		assertError(t, recorder, http.StatusBadRequest, "invalid_upstream_error_rules")
	})
}

func TestPostRejectsInvalidGroupIDs(t *testing.T) {
	tooMany := make([]string, 21)
	for index := range tooMany {
		tooMany[index] = "group-" + string(rune('a'+index))
	}
	cases := map[string][]string{
		"space":    {"bad id"},
		"empty":    {""},
		"too many": tooMany,
	}
	for name, groupIDs := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, `{}`)
			handler := f.newHandler(t, allowAllAuthorizer{allow: true})
			body := mustJSON(t, map[string]any{"upstreamErrorGroupIds": groupIDs})
			recorder := f.post(t, handler, testProvider, testRef, body)
			assertError(t, recorder, http.StatusBadRequest, "invalid_upstream_error_group")
			if env := f.storedEnv(t); len(env) != 0 {
				t.Fatalf("env = %v, want empty", env)
			}
		})
	}
}

func TestPostRejectsMalformedPayload(t *testing.T) {
	cases := map[string]string{
		"broken json":   "{",
		"trailing junk": "{\"upstreamErrorRules\":[]} {}",
		"unknown field": "{\"nope\":1}",
		"oversize": mustJSON(t, map[string]any{
			"upstreamErrorRules": []any{},
			"padding":            strings.Repeat("a", maxBodyBytes),
		}),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, `{}`)
			handler := f.newHandler(t, allowAllAuthorizer{allow: true})
			recorder := f.post(t, handler, testProvider, testRef, body)
			assertError(t, recorder, http.StatusBadRequest, "invalid_routing_rules")
		})
	}
}

func TestPostRejectsInvalidStoredEnv(t *testing.T) {
	f := newFixture(t, `[]`)
	handler := f.newHandler(t, allowAllAuthorizer{allow: true})
	recorder := f.post(t, handler, testProvider, testRef, `{"upstreamErrorRules":[]}`)
	assertError(t, recorder, http.StatusConflict, "account_env_invalid")
}

func TestPostRequiresManagementKey(t *testing.T) {
	f := newFixture(t, `{}`)
	handler := f.newHandler(t, allowAllAuthorizer{})
	recorder := f.post(t, handler, testProvider, testRef, `{"upstreamErrorRules":[]}`)
	assertError(t, recorder, http.StatusUnauthorized, "unauthorized")
}

func TestPostRejectsOtherMethods(t *testing.T) {
	f := newFixture(t, `{}`)
	handler := f.newHandler(t, allowAllAuthorizer{allow: true})
	request := httptest.NewRequest(http.MethodGet, "/v1/management/webui/accounts/claude/"+testRef+"/routing-rules", nil)
	request.SetPathValue("provider", testProvider)
	request.SetPathValue("accountRef", testRef)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	assertError(t, recorder, http.StatusMethodNotAllowed, "method_not_allowed")
	if got := recorder.Header().Get("Allow"); got != http.MethodPost {
		t.Fatalf("Allow = %q, want POST", got)
	}
}

func TestCheckNodePattern(t *testing.T) {
	accepted := []string{"^a+b", "^a+b|c", "[()]", "foo|bar", "a?"}
	for _, pattern := range accepted {
		if err := checkNodePattern(pattern); err != nil {
			t.Errorf("checkNodePattern(%q) error = %v, want nil", pattern, err)
		}
	}
	rejected := []string{"(a)", "a\\1", "a{2}", "a+b", "a+b|c", "a?b?"}
	for _, pattern := range rejected {
		if err := checkNodePattern(pattern); err == nil {
			t.Errorf("checkNodePattern(%q) error = nil, want rejection", pattern)
		}
	}
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	authorizer := allowAllAuthorizer{allow: true}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("new catalog: %v", err)
	}
	cases := map[string]Dependencies{
		"authorizer": {},
		"store":      {Authorizer: authorizer, Accounts: AppStateResolver{DatabasePath: "x"}, Catalog: catalog},
		"accounts":   {Authorizer: authorizer, Store: stubStore{}, Catalog: catalog},
		"catalog":    {Authorizer: authorizer, Store: stubStore{}, Accounts: AppStateResolver{DatabasePath: "x"}},
	}
	for name, dependencies := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NewHandler(dependencies); err == nil {
				t.Fatalf("NewHandler() error = nil")
			}
		})
	}
}

type stubStore struct{}

func (stubStore) Update(context.Context, string, rulesenv.Change) (rulesenv.Result, error) {
	return rulesenv.Result{}, nil
}
