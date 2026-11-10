package webuiaccountimportapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

type allowAll struct{}

func (allowAll) Authorized(*http.Request) bool { return true }

type denyAll struct{}

func (denyAll) Authorized(*http.Request) bool { return false }

// recordingImport 记录转发进来的请求，并按配置写出响应。
type recordingImport struct {
	calls  int
	method string
	path   string
	uri    string
	body   string

	status      int
	contentType string
	payload     string
}

func (endpoint *recordingImport) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	endpoint.calls++
	endpoint.method = request.Method
	endpoint.path = request.URL.Path
	endpoint.uri = request.RequestURI
	body, err := io.ReadAll(request.Body)
	if err != nil {
		response.WriteHeader(http.StatusInternalServerError)
		return
	}
	endpoint.body = string(body)
	if endpoint.contentType != "" {
		response.Header().Set("Content-Type", endpoint.contentType)
	}
	status := endpoint.status
	if status == 0 {
		status = http.StatusOK
	}
	response.WriteHeader(status)
	_, _ = response.Write([]byte(endpoint.payload))
}

func mustHandler(t *testing.T, dependencies Dependencies) *Handler {
	t.Helper()
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder) errorResponse {
	t.Helper()
	var body errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是错误 envelope: %v (%s)", err, recorder.Body.String())
	}
	return body
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	cases := []struct {
		name         string
		dependencies Dependencies
	}{
		{name: "缺少鉴权", dependencies: Dependencies{Import: &recordingImport{}}},
		{name: "缺少导入端点", dependencies: Dependencies{Authorizer: allowAll{}}},
		{name: "全缺", dependencies: Dependencies{}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, err := NewHandler(testCase.dependencies)
			if err == nil || handler != nil {
				t.Fatalf("期望依赖校验失败，得到 handler=%v err=%v", handler, err)
			}
		})
	}
}

func TestServeHTTPFailsClosedWithoutEndpoint(t *testing.T) {
	var handler *Handler
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader("{}")))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("期望 503，得到 %d", recorder.Code)
	}
	body := decodeError(t, recorder)
	if body.OK || body.Error.Code != "webui_accounts_import_unavailable" {
		t.Fatalf("错误 envelope 不符: %+v", body)
	}

	// 依赖被绕过（零值字段）时同样失败关闭，不能因为 authorizer 为 nil 就放行。
	zero := &Handler{}
	recorder = httptest.NewRecorder()
	zero.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader("{}")))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("零值 Handler 期望 503，得到 %d", recorder.Code)
	}
}

func TestServeHTTPRequiresAuthorization(t *testing.T) {
	endpoint := &recordingImport{}
	handler := mustHandler(t, Dependencies{Authorizer: denyAll{}, Import: endpoint})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader("{}")))

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("期望 401，得到 %d", recorder.Code)
	}
	if got := recorder.Header().Get("WWW-Authenticate"); got != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q", got)
	}
	if endpoint.calls != 0 {
		t.Fatalf("未鉴权时不应转发，实际调用 %d 次", endpoint.calls)
	}
	if body := decodeError(t, recorder); body.Error.Code != "unauthorized" {
		t.Fatalf("错误码 = %q", body.Error.Code)
	}
}

func TestServeHTTPRejectsNonPost(t *testing.T) {
	endpoint := &recordingImport{}
	handler := mustHandler(t, Dependencies{Authorizer: allowAll{}, Import: endpoint})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("期望 405，得到 %d", recorder.Code)
	}
	if got := recorder.Header().Get("Allow"); got != http.MethodPost {
		t.Fatalf("Allow = %q", got)
	}
	if endpoint.calls != 0 {
		t.Fatalf("方法不符时不应转发，实际调用 %d 次", endpoint.calls)
	}
}

func TestServeHTTPForwardsToAihAccountsImport(t *testing.T) {
	endpoint := &recordingImport{status: http.StatusOK, payload: "{}"}
	handler := mustHandler(t, Dependencies{Authorizer: allowAll{}, Import: endpoint})
	document := `{"kind":"aih-accounts","version":1,"accounts":[]}`
	request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(document))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if endpoint.calls != 1 {
		t.Fatalf("转发次数 = %d", endpoint.calls)
	}
	if endpoint.path != accountsapi.NativeImportPath+"/aih-accounts" {
		t.Fatalf("上游路径 = %q", endpoint.path)
	}
	if endpoint.method != http.MethodPost {
		t.Fatalf("上游方法 = %q", endpoint.method)
	}
	if endpoint.uri != "" {
		t.Fatalf("转发时 RequestURI 应为空，得到 %q", endpoint.uri)
	}
	if endpoint.body != document {
		t.Fatalf("请求体未原样转发: %q", endpoint.body)
	}
	// 入站请求本身不能被改写：中间件与访问日志读到的仍是 WebUI 路径。
	if request.URL.Path != Path {
		t.Fatalf("入站 URL 被改写为 %q", request.URL.Path)
	}
}

// TestServeHTTPReturnsPerAccountResults 固定复用端点的逐账号结果形状：
// Node 依赖 summary 计数与 accounts[].status 判断是否写入成功。
func TestServeHTTPReturnsPerAccountResults(t *testing.T) {
	payload := `{"ok":false,"summary":{"total":2,"created":1,"updated":0,"failed":1,"skipped":0},"accounts":[{"provider":"codex","accountRef":"codex:abc","status":"created"},{"provider":"claude","accountRef":"","status":"failed","reason":"credential_shape_unsupported"}]}`
	endpoint := &recordingImport{
		status:      http.StatusOK,
		contentType: "application/json; charset=utf-8",
		payload:     payload,
	}
	handler := mustHandler(t, Dependencies{Authorizer: allowAll{}, Import: endpoint})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader("{}")))

	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if recorder.Body.String() != payload {
		t.Fatalf("响应体被改写:\n%s", recorder.Body.String())
	}
	var result struct {
		OK       bool             `json:"ok"`
		Summary  map[string]int   `json:"summary"`
		Accounts []map[string]any `json:"accounts"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatalf("响应不是逐账号结果: %v", err)
	}
	if result.OK || result.Summary["failed"] != 1 || len(result.Accounts) != 2 {
		t.Fatalf("逐账号结果不符: %+v", result)
	}
	if result.Accounts[1]["reason"] != "credential_shape_unsupported" {
		t.Fatalf("失败原因未透传: %+v", result.Accounts[1])
	}
}

// TestServeHTTPPassesThroughDocumentErrors 保证文档级拒绝（非 aih-accounts v1）
// 由导入端点决定，适配层不改写状态码与错误码。
func TestServeHTTPPassesThroughDocumentErrors(t *testing.T) {
	payload := `{"ok":false,"error":{"code":"unsupported_import_document","message":"仅支持 aih-accounts v1"}}`
	endpoint := &recordingImport{status: http.StatusBadRequest, payload: payload}
	handler := mustHandler(t, Dependencies{Authorizer: allowAll{}, Import: endpoint})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"kind":"other"}`)))

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("期望 400，得到 %d", recorder.Code)
	}
	if recorder.Body.String() != payload {
		t.Fatalf("错误体被改写: %s", recorder.Body.String())
	}
}
