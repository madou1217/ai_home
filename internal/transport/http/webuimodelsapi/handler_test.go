package webuimodelsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	claudeAccountRef = "acct_11111111111111111111"
	codexAccountRef  = "acct_22222222222222222222"
	emptyAccountRef  = "acct_33333333333333333333"

	modelUpdatedAtMS = int64(1700000000000)
	lastAttemptAtMS  = int64(1794000000000)
)

type stubAuthorizer bool

func (authorizer stubAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

type fakeReader struct {
	catalog accountapp.AccountModelCatalog
	err     error
}

func (reader fakeReader) ListAllAccountModels(context.Context) (accountapp.AccountModelCatalog, error) {
	return reader.catalog, reader.err
}

func newTestHandler(t *testing.T, reader Reader, allowed bool) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer(allowed),
		Reader:     reader,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func doRequest(handler *Handler, method, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeResponse(t *testing.T, recorder *httptest.ResponseRecorder) response {
	t.Helper()
	var body response
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("解码响应失败: %v; body=%s", err, recorder.Body.String())
	}
	return body
}

func mustAccountRef(t *testing.T, value string) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(value)
	if err != nil {
		t.Fatalf("ParseAccountRef(%q) error = %v", value, err)
	}
	return accountRef
}

func mustModel(
	t *testing.T,
	accountRef accountcore.AccountRef,
	modelID string,
	upstreamAvailable bool,
	policy accountapp.ModelManualPolicy,
	updatedAt time.Time,
) accountapp.AccountModel {
	t.Helper()
	model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accountRef,
		ModelID:           modelID,
		UpstreamAvailable: upstreamAvailable,
		ManualPolicy:      policy,
		UpdatedAt:         updatedAt,
	})
	if err != nil {
		t.Fatalf("NewAccountModel(%q) error = %v", modelID, err)
	}
	return model
}

// testCatalog 覆盖三种有效性：inherit+可用、force_disable、force_enable；
// 另有一个「探测成功但目录为空」的账号，用来验证空集合仍是 JSON 数组。
func testCatalog(t *testing.T) accountapp.AccountModelCatalog {
	t.Helper()
	claudeRef := mustAccountRef(t, claudeAccountRef)
	codexRef := mustAccountRef(t, codexAccountRef)
	emptyRef := mustAccountRef(t, emptyAccountRef)
	modelTime := time.UnixMilli(modelUpdatedAtMS).UTC()
	attemptAt := time.UnixMilli(lastAttemptAtMS).UTC()
	return accountapp.AccountModelCatalog{
		Sets: []accountapp.AccountModelSet{
			{
				AccountRef: claudeRef,
				ProviderID: "claude",
				// 故意乱序传入，验证响应按模型 ID 稳定排序。
				Models: []accountapp.AccountModel{
					mustModel(t, claudeRef, "claude-sonnet", true, accountapp.ModelPolicyInherit, modelTime),
					mustModel(t, claudeRef, "claude-opus", true, accountapp.ModelPolicyForceDisable, modelTime),
					mustModel(t, claudeRef, "claude-haiku", false, accountapp.ModelPolicyForceEnable, modelTime),
				},
				LastAttemptAt:  attemptAt,
				LastSource:     accountapp.ModelProbeSourceRemote,
				LastModelCount: 2,
			},
			{
				AccountRef:     emptyRef,
				ProviderID:     "codex",
				LastAttemptAt:  attemptAt,
				LastSource:     accountapp.ModelProbeSourceRemote,
				LastModelCount: 0,
			},
			{
				AccountRef:       codexRef,
				ProviderID:       "codex",
				Models:           []accountapp.AccountModel{mustModel(t, codexRef, "gpt-5", false, accountapp.ModelPolicyInherit, modelTime)},
				LastAttemptAt:    attemptAt,
				LastErrorCode:    "probe_failed",
				LastErrorMessage: "upstream 500",
				LastSource:       accountapp.ModelProbeSourceError,
				LastModelCount:   0,
			},
		},
		Generation:  42,
		UpdatedAtMS: 1700000000123,
	}
}

func TestHandlerProjectsProviderAccountModelIDs(t *testing.T) {
	handler := newTestHandler(t, fakeReader{catalog: testCatalog(t)}, true)
	recorder := doRequest(handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	body := decodeResponse(t, recorder)
	if !body.OK || body.DerivedBy != "go_partial" || body.DataSource != "account_models" {
		t.Fatalf("envelope = %+v", body)
	}
	if body.Generation != 42 || body.CatalogUpdatedAtMS != 1700000000123 {
		t.Fatalf("catalog stamp = %d/%d", body.Generation, body.CatalogUpdatedAtMS)
	}
	if len(body.Providers) != 2 ||
		body.Providers[0].ProviderID != "claude" ||
		body.Providers[1].ProviderID != "codex" {
		t.Fatalf("providers = %+v", body.Providers)
	}

	claude := body.Providers[0].Accounts
	if len(claude) != 1 || claude[0].AccountRef != claudeAccountRef {
		t.Fatalf("claude accounts = %+v", claude)
	}
	assertStrings(t, "claude model_ids", claude[0].ModelIDs,
		[]string{"claude-haiku", "claude-opus", "claude-sonnet"})
	assertStrings(t, "claude effective_model_ids", claude[0].EffectiveModelIDs,
		[]string{"claude-haiku", "claude-sonnet"})
	if claude[0].LastAttemptAtMS != lastAttemptAtMS ||
		claude[0].LastSource != accountapp.ModelProbeSourceRemote ||
		claude[0].LastModelCount != 2 {
		t.Fatalf("claude probe facts = %+v", claude[0])
	}

	codex := body.Providers[1].Accounts
	if len(codex) != 2 ||
		codex[0].AccountRef != codexAccountRef ||
		codex[1].AccountRef != emptyAccountRef {
		t.Fatalf("codex accounts = %+v", codex)
	}
	assertStrings(t, "codex model_ids", codex[0].ModelIDs, []string{"gpt-5"})
	assertStrings(t, "codex effective_model_ids", codex[0].EffectiveModelIDs, []string{})
	if codex[0].LastErrorCode != "probe_failed" ||
		codex[0].LastErrorMessage != "upstream 500" ||
		codex[0].LastSource != accountapp.ModelProbeSourceError {
		t.Fatalf("codex probe facts = %+v", codex[0])
	}
	assertStrings(t, "empty model_ids", codex[1].ModelIDs, []string{})
	assertStrings(t, "empty effective_model_ids", codex[1].EffectiveModelIDs, []string{})
	if codex[1].LastAttemptAtMS != lastAttemptAtMS || codex[1].LastModelCount != 0 {
		t.Fatalf("empty account probe facts = %+v", codex[1])
	}
}

// TestResponseDoesNotFakeNodeModelKeys 证明本接口没有用 Node 的键名占位：
// labels/metadata/可选集都必须走 unfilled_fields，而不是返回空对象冒充全量形状。
func TestResponseDoesNotFakeNodeModelKeys(t *testing.T) {
	handler := newTestHandler(t, fakeReader{catalog: testCatalog(t)}, true)
	recorder := doRequest(handler, http.MethodGet, Path)
	var raw map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatalf("解码原始响应失败: %v", err)
	}
	for _, key := range []string{
		"models", "labels", "metadata",
		"selectableByAccountRef", "defaultByAccountRef",
		"errorsByAccountRef", "accountProbedAt", "accountScope",
	} {
		if _, found := raw[key]; found {
			t.Errorf("响应不应包含 Node 键 %q", key)
		}
	}
	filled, _ := raw["filled_fields"].([]any)
	if len(filled) == 0 {
		t.Fatal("filled_fields 缺失")
	}
	unfilled, _ := raw["unfilled_fields"].([]any)
	if !containsAny(unfilled, "selectableByAccountRef") ||
		!containsAny(unfilled, "labels") ||
		!containsAny(unfilled, "metadata") {
		t.Fatalf("unfilled_fields 未标注设置/展示缺口: %v", unfilled)
	}
}

func TestNewAccountViewNeverProbedKeepsZeroTimestamp(t *testing.T) {
	view := newAccountView(accountapp.AccountModelSet{
		AccountRef: mustAccountRef(t, claudeAccountRef),
		ProviderID: "claude",
	})
	if view.LastAttemptAtMS != 0 {
		t.Fatalf("LastAttemptAtMS = %d, want 0", view.LastAttemptAtMS)
	}
	if view.ModelIDs == nil || view.EffectiveModelIDs == nil {
		t.Fatalf("空集合必须是空数组而不是 nil: %+v", view)
	}
}

func TestHandlerEmptyCatalogReturnsArray(t *testing.T) {
	handler := newTestHandler(t, fakeReader{}, true)
	recorder := doRequest(handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", recorder.Code, recorder.Body.String())
	}
	var raw map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatalf("解码响应失败: %v", err)
	}
	providers, ok := raw["providers"].([]any)
	if !ok || len(providers) != 0 {
		t.Fatalf("providers = %#v, want []", raw["providers"])
	}
}

func TestHandlerRejectsUnauthorizedMethodAndQuery(t *testing.T) {
	t.Run("unauthorized", func(t *testing.T) {
		handler := newTestHandler(t, fakeReader{}, false)
		recorder := doRequest(handler, http.MethodGet, Path)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d", recorder.Code)
		}
		if recorder.Header().Get("WWW-Authenticate") != "Bearer" {
			t.Fatalf("WWW-Authenticate = %q", recorder.Header().Get("WWW-Authenticate"))
		}
		var body errorResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("解码错误响应失败: %v", err)
		}
		if body.Error.Code != "unauthorized" {
			t.Fatalf("error = %+v", body.Error)
		}
	})

	t.Run("method", func(t *testing.T) {
		handler := newTestHandler(t, fakeReader{}, true)
		recorder := doRequest(handler, http.MethodPost, Path)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d", recorder.Code)
		}
		if recorder.Header().Get("Allow") != http.MethodGet {
			t.Fatalf("Allow = %q", recorder.Header().Get("Allow"))
		}
	})

	t.Run("query", func(t *testing.T) {
		handler := newTestHandler(t, fakeReader{}, true)
		recorder := doRequest(handler, http.MethodGet, Path+"?accountRef="+claudeAccountRef)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("status = %d; body=%s", recorder.Code, recorder.Body.String())
		}
		var body errorResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("解码错误响应失败: %v", err)
		}
		if body.Error.Code != "invalid_query" {
			t.Fatalf("error = %+v", body.Error)
		}
	})
}

func TestHandlerReportsReaderFailure(t *testing.T) {
	handler := newTestHandler(t, fakeReader{err: errors.New("db down")}, true)
	recorder := doRequest(handler, http.MethodGet, Path)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d; body=%s", recorder.Code, recorder.Body.String())
	}
	var body errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("解码错误响应失败: %v", err)
	}
	if body.Error.Code != "webui_models_failed" {
		t.Fatalf("error = %+v", body.Error)
	}
}

// TestFilledFieldsCoverEveryDataKey 防止新增字段时忘了归类：
// 每个数据键必须且只能出现在 filled_fields / unfilled_fields 之一。
func TestFilledFieldsCoverEveryDataKey(t *testing.T) {
	expected := []string{"generation", "catalog_updated_at_ms", "providers"}
	expected = append(expected, jsonFieldNames(reflect.TypeOf(providerView{}))...)
	expected = append(expected, jsonFieldNames(reflect.TypeOf(accountView{}))...)
	got := append([]string(nil), filledFields...)
	sort.Strings(got)
	sort.Strings(expected)
	if !slices.Equal(got, expected) {
		t.Fatalf("filled_fields = %v, want %v", got, expected)
	}

	seen := make(map[string]bool, len(filledFields))
	for _, field := range filledFields {
		if field == "" || seen[field] {
			t.Fatalf("filled_fields 存在空值或重复项: %v", filledFields)
		}
		seen[field] = true
	}
	for _, field := range unfilledFields {
		if field == "" {
			t.Fatal("unfilled_fields 存在空值")
		}
		if seen[field] {
			t.Fatalf("字段 %q 同时出现在 filled 与 unfilled", field)
		}
	}
	for _, key := range []string{"labels", "metadata", "selectableByAccountRef", "defaultByAccountRef"} {
		if !slices.Contains(unfilledFields, key) {
			t.Fatalf("unfilled_fields 缺少 %q", key)
		}
	}
}

func jsonFieldNames(structType reflect.Type) []string {
	names := make([]string, 0, structType.NumField())
	for index := 0; index < structType.NumField(); index++ {
		name, _, _ := strings.Cut(structType.Field(index).Tag.Get("json"), ",")
		if name == "" || name == "-" {
			continue
		}
		names = append(names, name)
	}
	return names
}

func assertStrings(t *testing.T, label string, got, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("%s = %v, want %v", label, got, want)
	}
}

func containsAny(values []any, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
