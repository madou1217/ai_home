package modelsapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
)

// TestHandlerReturnsUniqueLocalModels 验证目录鉴权、排序去重和 OpenAI envelope。
func TestHandlerReturnsUniqueLocalModels(t *testing.T) {
	t.Parallel()

	reader := &modelReaderStub{
		models: []accountapp.RoutableModel{
			newRoutableModel(t, "claude", "claude-opus-5"),
			newRoutableModel(t, "claude", "shared-model"),
			newRoutableModel(t, "codex", "shared-model"),
		},
	}
	handler := newTestHandler(t, reader)

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(
		unauthorized,
		httptest.NewRequest(http.MethodGet, modelsapi.Path, nil),
	)
	if unauthorized.Code != http.StatusUnauthorized || reader.calls != 0 {
		t.Fatalf(
			"unauthorized status=%d reader_calls=%d",
			unauthorized.Code,
			reader.calls,
		)
	}

	request := httptest.NewRequest(http.MethodGet, modelsapi.Path, nil)
	request.Header.Set("Authorization", "Bearer local-model-key")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET /v1/models status=%d body=%s", response.Code, response.Body)
	}
	var document struct {
		Object string `json:"object"`
		Data   []struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			Created int64  `json:"created"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if document.Object != "list" ||
		len(document.Data) != 2 ||
		document.Data[0].ID != "claude-opus-5" ||
		document.Data[0].OwnedBy != "claude" ||
		document.Data[1].ID != "shared-model" ||
		document.Data[1].OwnedBy != "aih" {
		t.Fatalf("models response = %#v", document)
	}
	var rawDocument struct {
		Data []map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &rawDocument); err != nil {
		t.Fatalf("json.Unmarshal(raw) error = %v", err)
	}
	if _, found := rawDocument.Data[0]["aih_modalities"]; found {
		t.Fatalf("default model leaked aih_modalities: %s", response.Body)
	}
}

// TestHandlerIncludesModalitiesOnlyWhenRequested 验证扩展字段显式 opt-in，未知模型保守降级。
func TestHandlerIncludesModalitiesOnlyWhenRequested(t *testing.T) {
	t.Parallel()

	reader := &modelReaderStub{
		models: []accountapp.RoutableModel{
			newRoutableModel(t, "claude", "claude-opus-5"),
			newRoutableModel(t, "codex", "future-unknown-model"),
		},
	}
	known, err := modelmetadata.NewModalities(
		[]string{"text", "image", "pdf"},
		[]string{"text"},
	)
	if err != nil {
		t.Fatalf("modelmetadata.NewModalities() error = %v", err)
	}
	handler := newTestHandlerWithModalities(t, reader, &modalityReaderStub{
		models: map[string]modelmetadata.Modalities{
			"claude/claude-opus-5": known,
		},
	})
	request := httptest.NewRequest(
		http.MethodGet,
		modelsapi.Path+"?include=modalities",
		nil,
	)
	request.Header.Set("Authorization", "Bearer local-model-key")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || reader.calls != 1 {
		t.Fatalf(
			"status=%d reader_calls=%d body=%s",
			response.Code,
			reader.calls,
			response.Body,
		)
	}
	var document struct {
		Data []struct {
			ID         string `json:"id"`
			Modalities struct {
				Input  []string `json:"input"`
				Output []string `json:"output"`
			} `json:"aih_modalities"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(document.Data) != 2 {
		t.Fatalf("models response = %s", response.Body)
	}
	if document.Data[0].ID != "claude-opus-5" {
		t.Fatalf("first model = %#v", document.Data[0])
	}
	assertStringSlice(t, document.Data[0].Modalities.Input, []string{"text", "image", "pdf"})
	assertStringSlice(t, document.Data[0].Modalities.Output, []string{"text"})
	if document.Data[1].ID != "future-unknown-model" {
		t.Fatalf("second model = %#v", document.Data[1])
	}
	assertStringSlice(t, document.Data[1].Modalities.Input, []string{"text"})
	assertStringSlice(t, document.Data[1].Modalities.Output, []string{"text"})
}

// TestHandlerProjectsCodexCatalogWithoutRefreshing 验证 client_version 只选择
// Codex envelope，且每个模型都从同一次本地物化目录读取中生成完整投影。
func TestHandlerProjectsCodexCatalogWithoutRefreshing(t *testing.T) {
	t.Parallel()

	reader := &modelReaderStub{
		models: []accountapp.RoutableModel{
			newRoutableModel(t, "claude", "claude-opus-5"),
			newRoutableModel(t, "codex", "gpt-5.6-sol"),
		},
	}
	handler := newTestHandler(t, reader)
	request := httptest.NewRequest(
		http.MethodGet,
		modelsapi.Path+"?client_version=future-client",
		nil,
	)
	request.Header.Set("Authorization", "Bearer local-model-key")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || reader.calls != 1 {
		t.Fatalf(
			"status=%d reader_calls=%d body=%s",
			response.Code,
			reader.calls,
			response.Body,
		)
	}
	var document struct {
		Models []struct {
			Slug                              string `json:"slug"`
			DisplayName                       string `json:"display_name"`
			SupportedReasoningLevels          []any  `json:"supported_reasoning_levels"`
			ShellType                         string `json:"shell_type"`
			Visibility                        string `json:"visibility"`
			SupportedInAPI                    bool   `json:"supported_in_api"`
			Priority                          int    `json:"priority"`
			BaseInstructions                  string `json:"base_instructions"`
			SupportsReasoningSummaryParameter bool   `json:"supports_reasoning_summary_parameter"`
			TruncationPolicy                  struct {
				Mode  string `json:"mode"`
				Limit int    `json:"limit"`
			} `json:"truncation_policy"`
			SupportsParallelToolCalls  bool     `json:"supports_parallel_tool_calls"`
			ExperimentalSupportedTools []string `json:"experimental_supported_tools"`
			InputModalities            []string `json:"input_modalities"`
			SupportsSearchTool         bool     `json:"supports_search_tool"`
		} `json:"models"`
		Object string `json:"object"`
		Data   []any  `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if document.Object != "" || document.Data != nil || len(document.Models) != 2 {
		t.Fatalf("codex envelope = %#v", document)
	}
	first := document.Models[0]
	if first.Slug != "claude-opus-5" ||
		first.DisplayName != first.Slug ||
		first.SupportedReasoningLevels == nil ||
		first.ShellType != "shell_command" ||
		first.Visibility != "list" ||
		!first.SupportedInAPI ||
		first.Priority != 1 ||
		first.BaseInstructions == "" ||
		!first.SupportsReasoningSummaryParameter ||
		first.TruncationPolicy.Mode != "bytes" ||
		first.TruncationPolicy.Limit != 10_000 ||
		!first.SupportsParallelToolCalls ||
		first.ExperimentalSupportedTools == nil ||
		len(first.InputModalities) != 2 ||
		!first.SupportsSearchTool ||
		document.Models[1].Priority != 2 {
		t.Fatalf("codex models = %#v", document.Models)
	}
}

// TestHandlerRejectsUnsupportedRequestsAndHidesReaderErrors 验证输入和内部错误合同。
func TestHandlerRejectsUnsupportedRequestsAndHidesReaderErrors(t *testing.T) {
	t.Parallel()

	reader := &modelReaderStub{err: errors.New("synthetic database detail")}
	handler := newTestHandler(t, reader)
	tests := []struct {
		name   string
		method string
		target string
		status int
		code   string
	}{
		{
			name:   "query",
			method: http.MethodGet,
			target: modelsapi.Path + "?refresh=true",
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "unknown include",
			method: http.MethodGet,
			target: modelsapi.Path + "?include=pricing",
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "repeated include",
			method: http.MethodGet,
			target: modelsapi.Path + "?include=modalities&include=modalities",
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "repeated client version",
			method: http.MethodGet,
			target: modelsapi.Path + "?client_version=0.146.0&client_version=0.145.0",
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "mixed protocol query",
			method: http.MethodGet,
			target: modelsapi.Path + "?client_version=0.146.0&include=modalities",
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "method",
			method: http.MethodPost,
			target: modelsapi.Path,
			status: http.StatusMethodNotAllowed,
			code:   "method_not_allowed",
		},
		{
			name:   "reader",
			method: http.MethodGet,
			target: modelsapi.Path,
			status: http.StatusInternalServerError,
			code:   "internal_error",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.target, nil)
			request.Header.Set("Authorization", "Bearer local-model-key")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body)
			}
			var document struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
				t.Fatalf("json.Unmarshal() error = %v", err)
			}
			if document.Error.Code != test.code ||
				response.Body.String() == reader.err.Error() {
				t.Fatalf("error response = %s", response.Body)
			}
		})
	}
}

// TestHandlerRejectsInvalidLocalSnapshot 验证内部读模型损坏不会被静默过滤或错误去重。
func TestHandlerRejectsInvalidLocalSnapshot(t *testing.T) {
	t.Parallel()

	handler := newTestHandler(t, &modelReaderStub{
		models: []accountapp.RoutableModel{
			newRoutableModel(t, "codex", "z-model"),
			newRoutableModel(t, "codex", "a-model"),
		},
	})
	request := httptest.NewRequest(http.MethodGet, modelsapi.Path, nil)
	request.Header.Set("Authorization", "Bearer local-model-key")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("invalid snapshot status=%d body=%s", response.Code, response.Body)
	}
}

// modelReaderStub 返回预设的本地目录快照。
type modelReaderStub struct {
	models []accountapp.RoutableModel
	err    error
	calls  int
}

// modalityReaderStub 返回按 Provider 和真实模型 ID 索引的测试模态。
type modalityReaderStub struct {
	models map[string]modelmetadata.Modalities
}

// LookupModalities 返回不可变测试值；未命中由 Handler 采用文本兜底。
func (reader *modalityReaderStub) LookupModalities(
	providerID string,
	modelID string,
) (modelmetadata.Modalities, bool) {
	modalities, found := reader.models[providerID+"/"+modelID]
	return modalities, found
}

func (reader *modelReaderStub) ListRoutableModels(
	context.Context,
) ([]accountapp.RoutableModel, error) {
	reader.calls++
	return reader.models, reader.err
}

// bearerAuthorizerStub 只接受测试使用的固定客户端密钥。
type bearerAuthorizerStub struct{}

func (bearerAuthorizerStub) Authorized(request *http.Request) bool {
	return request.Header.Get("Authorization") == "Bearer local-model-key"
}

// newTestHandler 创建使用本地 Reader 的模型目录 Handler。
func newTestHandler(t *testing.T, reader modelsapi.ModelReader) http.Handler {
	t.Helper()
	return newTestHandlerWithModalities(t, reader, &modalityReaderStub{})
}

// newTestHandlerWithModalities 创建可控制元数据命中的模型目录 Handler。
func newTestHandlerWithModalities(
	t *testing.T,
	reader modelsapi.ModelReader,
	modalities modelmetadata.Reader,
) http.Handler {
	t.Helper()

	handler, err := modelsapi.NewHandler(modelsapi.Dependencies{
		Models:     reader,
		Modalities: modalities,
		Authorizer: bearerAuthorizerStub{},
	})
	if err != nil {
		t.Fatalf("modelsapi.NewHandler() error = %v", err)
	}
	return handler
}

// newRoutableModel 创建模型目录测试使用的规范元组。
func newRoutableModel(
	t *testing.T,
	providerID string,
	modelID string,
) accountapp.RoutableModel {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	model, err := accountapp.NewRoutableModel(catalog, providerID, modelID)
	if err != nil {
		t.Fatalf("accounts.NewRoutableModel() error = %v", err)
	}
	return model
}

// assertStringSlice 验证 HTTP 传输数组保持数据源的稳定顺序。
func assertStringSlice(t *testing.T, got []string, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("strings = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("strings = %#v, want %#v", got, want)
		}
	}
}
