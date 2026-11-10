package webuiopenaimodelsapi

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

// testCatalog 覆盖三种有效性、跨账号同 ID 聚合，以及「探测成功但目录为空」的账号。
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
				// 故意乱序传入，验证响应稳定排序。
				Models: []accountapp.AccountModel{
					mustModel(t, claudeRef, "shared-model", true, accountapp.ModelPolicyInherit, modelTime),
					mustModel(t, claudeRef, "claude-sonnet-4", true, accountapp.ModelPolicyInherit, modelTime),
					mustModel(t, claudeRef, "claude-opus-4", true, accountapp.ModelPolicyForceDisable, modelTime),
					mustModel(t, claudeRef, "claude-haiku-4", false, accountapp.ModelPolicyForceEnable, modelTime),
				},
				LastAttemptAt:  attemptAt,
				LastSource:     accountapp.ModelProbeSourceRemote,
				LastModelCount: 4,
			},
			{
				AccountRef:     emptyRef,
				ProviderID:     "codex",
				LastAttemptAt:  attemptAt,
				LastSource:     accountapp.ModelProbeSourceRemote,
				LastModelCount: 0,
			},
			{
				AccountRef: codexRef,
				ProviderID: "codex",
				Models: []accountapp.AccountModel{
					mustModel(t, codexRef, "gpt-5", false, accountapp.ModelPolicyInherit, modelTime),
					mustModel(t, codexRef, "shared-model", true, accountapp.ModelPolicyForceDisable, modelTime),
				},
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

func TestPath(t *testing.T) {
	if Path != "/v1/management/webui/openai-models" {
		t.Fatalf("Path = %q", Path)
	}
}

func TestHandlerProjectsGoAccountModelFacts(t *testing.T) {
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
	if len(body.Models) != 5 {
		t.Fatalf("models = %+v", body.Models)
	}
	assertModel(t, body.Models[0], "claude-haiku-4", []string{"claude"}, []string{claudeAccountRef}, false, true)
	assertModel(t, body.Models[1], "claude-opus-4", []string{"claude"}, []string{claudeAccountRef}, true, false)
	assertModel(t, body.Models[2], "claude-sonnet-4", []string{"claude"}, []string{claudeAccountRef}, true, true)
	assertModel(t, body.Models[3], "gpt-5", []string{"codex"}, []string{codexAccountRef}, false, false)
	// 同 ID 跨账号：providers/account_refs 聚合，effective 是「任一账号有效」。
	assertModel(t, body.Models[4], "shared-model",
		[]string{"claude", "codex"}, []string{claudeAccountRef, codexAccountRef}, true, true)

	if len(body.AccountModels) != 3 {
		t.Fatalf("account_models = %+v", body.AccountModels)
	}
	claude := body.AccountModels[0]
	if claude.ProviderID != "claude" || claude.AccountRef != claudeAccountRef {
		t.Fatalf("claude account = %+v", claude)
	}
	assertStrings(t, "claude model_ids", claude.ModelIDs,
		[]string{"claude-haiku-4", "claude-opus-4", "claude-sonnet-4", "shared-model"})
	assertStrings(t, "claude effective_model_ids", claude.EffectiveModelIDs,
		[]string{"claude-haiku-4", "claude-sonnet-4", "shared-model"})
	if claude.LastAttemptAtMS != lastAttemptAtMS ||
		claude.LastSource != accountapp.ModelProbeSourceRemote ||
		claude.LastModelCount != 4 {
		t.Fatalf("claude probe facts = %+v", claude)
	}

	codex := body.AccountModels[1]
	if codex.ProviderID != "codex" || codex.AccountRef != codexAccountRef {
		t.Fatalf("codex account = %+v", codex)
	}
	assertStrings(t, "codex model_ids", codex.ModelIDs, []string{"gpt-5", "shared-model"})
	assertStrings(t, "codex effective_model_ids", codex.EffectiveModelIDs, []string{})
	if codex.LastErrorCode != "probe_failed" ||
		codex.LastErrorMessage != "upstream 500" ||
		codex.LastSource != accountapp.ModelProbeSourceError {
		t.Fatalf("codex probe facts = %+v", codex)
	}

	empty := body.AccountModels[2]
	if empty.ProviderID != "codex" || empty.AccountRef != emptyAccountRef {
		t.Fatalf("empty account = %+v", empty)
	}
	assertStrings(t, "empty model_ids", empty.ModelIDs, []string{})
	assertStrings(t, "empty effective_model_ids", empty.EffectiveModelIDs, []string{})
	if empty.LastAttemptAtMS != lastAttemptAtMS || empty.LastModelCount != 0 {
		t.Fatalf("empty account probe facts = %+v", empty)
	}
}

func TestResponseDoesNotFakeNodeModelKeys(t *testing.T) {
	handler := newTestHandler(t, fakeReader{catalog: testCatalog(t)}, true)
	recorder := doRequest(handler, http.MethodGet, Path)
	var raw map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatalf("解码原始响应失败: %v", err)
	}
	for _, key := range []string{
		"data", "managedData", "metadata", "labels", "accounts",
		"byProvider", "byAccountRef", "errorsByAccountRef", "accountProbedAt",
		"accountScope", "cached", "source", "sources", "scannedAccounts",
		"firstError", "settingsUpdatedAt", "endpoint",
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
	for _, key := range []string{"data", "managedData", "metadata", "labels", "settingsUpdatedAt", "accountScope"} {
		if !containsAny(unfilled, key) {
			t.Fatalf("unfilled_fields 缺少 %q: %v", key, unfilled)
		}
	}
}

func TestEmptyCatalogReturnsArrays(t *testing.T) {
	handler := newTestHandler(t, fakeReader{}, true)
	recorder := doRequest(handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", recorder.Code, recorder.Body.String())
	}
	var raw map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatalf("解码响应失败: %v", err)
	}
	for _, key := range []string{"models", "account_models"} {
		items, ok := raw[key].([]any)
		if !ok || len(items) != 0 {
			t.Fatalf("%s = %#v, want []", key, raw[key])
		}
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
		for _, target := range []string{
			Path + "?accountRef=" + claudeAccountRef,
			Path + "?unexpected=1",
		} {
			recorder := doRequest(handler, http.MethodGet, target)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("%s status = %d; body=%s", target, recorder.Code, recorder.Body.String())
			}
			var body errorResponse
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("解码错误响应失败: %v", err)
			}
			if body.Error.Code != "invalid_query" {
				t.Fatalf("error = %+v", body.Error)
			}
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
	if body.Error.Code != "webui_openai_models_failed" {
		t.Fatalf("error = %+v", body.Error)
	}
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("error = %v, want %v", err, ErrInvalidDependencies)
	}
}

func TestNewAccountModelViewNeverProbedKeepsZeroTimestampAndArrays(t *testing.T) {
	view := newAccountModelView(accountapp.AccountModelSet{
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

// TestFilledFieldsCoverEveryDataKey 防止新增字段时忘了归类：
// 每个数据键必须且只能出现在 filled_fields / unfilled_fields 之一。
func TestFilledFieldsCoverEveryDataKey(t *testing.T) {
	expected := []string{"generation", "catalog_updated_at_ms", "models", "account_models"}
	expected = append(expected, jsonFieldNames(reflect.TypeOf(modelView{}))...)
	expected = append(expected, jsonFieldNames(reflect.TypeOf(accountModelView{}))...)
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
	for _, key := range []string{"data", "managedData", "metadata", "labels", "settingsUpdatedAt", "accountScope"} {
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

func assertModel(
	t *testing.T,
	got modelView,
	id string,
	providers []string,
	accountRefs []string,
	upstreamAvailable bool,
	effective bool,
) {
	t.Helper()
	if got.ID != id ||
		!slices.Equal(got.Providers, providers) ||
		!slices.Equal(got.AccountRefs, accountRefs) ||
		got.UpstreamAvailable != upstreamAvailable ||
		got.Effective != effective {
		t.Fatalf("model = %+v, want id=%s providers=%v refs=%v upstream=%v effective=%v",
			got, id, providers, accountRefs, upstreamAvailable, effective)
	}
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
