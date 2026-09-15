package imagesapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/imageblob"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/transport/http/imagesapi"
)

// pngBase64 是带 PNG 魔数的最小载荷。
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAf/AAAAAElFTkSuQmCC"

// testAPIKey 是本文件独立使用的客户端密钥。
const testAPIKey = "synthetic-images-key"

// passthroughDoer 返回固定的 OpenAI 图片响应。
type passthroughDoer struct {
	status int
	body   string
	calls  int
}

// Do 实现 images.HTTPDoer。
func (doer *passthroughDoer) Do(*http.Request) (*http.Response, error) {
	doer.calls++
	status := doer.status
	if status == 0 {
		status = http.StatusOK
	}
	body := doer.body
	if body == "" {
		body = `{"data":[{"b64_json":"` + pngBase64 + `"}]}`
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{},
	}, nil
}

// fixedSource 返回固定候选账号。
type fixedSource struct {
	accounts []images.Account
}

// Candidates 实现 images.AccountSource。
func (source fixedSource) Candidates(
	_ context.Context,
	_ string,
	_ string,
	exclude []string,
) ([]images.Account, error) {
	for _, account := range source.accounts {
		skip := false
		for _, raw := range exclude {
			if raw == account.AccountRef {
				skip = true
				break
			}
		}
		if !skip {
			return []images.Account{account}, nil
		}
	}
	return nil, nil
}

// fixedProviders 返回固定的 Provider。
type fixedProviders struct{ provider string }

// ResolveProvider 实现 imagesapi.ProviderResolver。
func (resolver fixedProviders) ResolveProvider(
	context.Context,
	string,
	string,
) (string, error) {
	return resolver.provider, nil
}

// testAuthorizer 只接受固定客户端密钥。
type testAuthorizer struct{}

// Authorized 实现 imagesapi.Authorizer。
func (testAuthorizer) Authorized(request *http.Request) bool {
	return request.Header.Get("x-api-key") == testAPIKey
}

// newTestHandler 创建使用 api-key passthrough 账号的图片 Handler。
func newTestHandler(t *testing.T, doer images.HTTPDoer, blobs images.BlobWriter) http.Handler {
	t.Helper()

	handler, err := imagesapi.NewHandler(imagesapi.Dependencies{
		Registry: images.NewRegistry("https://codex.example.test", ""),
		Accounts: fixedSource{accounts: []images.Account{{
			Provider:   "codex",
			AccountRef: "acct_1",
			APIKey:     "key-1",
			BaseURL:    "https://upstream.example.test",
			APIKeyMode: true,
		}}},
		Providers:  fixedProviders{provider: "codex"},
		HTTP:       doer,
		Authorizer: testAuthorizer{},
		Blobs:      blobs,
	})
	if err != nil {
		t.Fatalf("imagesapi.NewHandler() error = %v", err)
	}
	return handler
}

// TestHandlerServesJSONGeneration 验证 JSON 入口的响应形状与诊断头。
func TestHandlerServesJSONGeneration(t *testing.T) {
	t.Parallel()

	doer := &passthroughDoer{}
	handler := newTestHandler(t, doer, nil)
	request := httptest.NewRequest(
		http.MethodPost,
		imagesapi.GenerationsPath,
		strings.NewReader(`{"model":"dall-e-3","prompt":"a cat"}`),
	)
	request.Header.Set("x-api-key", testAPIKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	var document struct {
		Created int64 `json:"created"`
		Data    []struct {
			B64JSON string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v body=%s", err, response.Body)
	}
	if document.Created <= 0 || len(document.Data) != 1 || document.Data[0].B64JSON == "" {
		t.Fatalf("document = %#v", document)
	}
	if got := response.Header().Get("x-aih-server-provider"); got != "codex" {
		t.Fatalf("provider header = %q", got)
	}
	if got := response.Header().Get("x-aih-server-account-ref"); got != "acct_1" {
		t.Fatalf("account header = %q", got)
	}
}

// TestHandlerRendersBlobURLForURLFormat 验证 response_format=url 返回可取的 blob 地址。
func TestHandlerRendersBlobURLForURLFormat(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(0)
	handler := newTestHandler(t, &passthroughDoer{}, images.BlobStoreAdapter{Store: store})
	request := httptest.NewRequest(
		http.MethodPost,
		imagesapi.GenerationsPath,
		strings.NewReader(`{"model":"dall-e-3","prompt":"a cat","response_format":"url"}`),
	)
	request.Header.Set("x-api-key", testAPIKey)
	request.Host = "127.0.0.1:9527"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	var document struct {
		Data []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	const prefix = "http://127.0.0.1:9527/v1/blobs/"
	if len(document.Data) != 1 || !strings.HasPrefix(document.Data[0].URL, prefix) {
		t.Fatalf("data = %#v", document.Data)
	}
	id := strings.TrimPrefix(document.Data[0].URL, prefix)
	if _, found := store.Get(id); !found {
		t.Fatalf("blob %q was not stored", id)
	}
}

// TestHandlerAcceptsMultipartEdit 验证 multipart 编辑入口与 JSON 入口共用同一套解析。
func TestHandlerAcceptsMultipartEdit(t *testing.T) {
	t.Parallel()

	doer := &passthroughDoer{}
	handler := newTestHandler(t, doer, nil)

	buffer := &bytes.Buffer{}
	writer := multipart.NewWriter(buffer)
	if err := writer.WriteField("model", "dall-e-3"); err != nil {
		t.Fatalf("WriteField() error = %v", err)
	}
	if err := writer.WriteField("prompt", "make it blue"); err != nil {
		t.Fatalf("WriteField() error = %v", err)
	}
	// 显式声明图片媒体类型：CreateFormFile 会写成 application/octet-stream，
	// 而声明了非图片类型时网关按 Node 的规则拒绝，不属于本用例要覆盖的路径。
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="image"; filename="input.png"`)
	header.Set("Content-Type", "image/png")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("CreatePart() error = %v", err)
	}
	bytesPayload, err := base64.StdEncoding.DecodeString(pngBase64)
	if err != nil {
		t.Fatalf("DecodeString() error = %v", err)
	}
	if _, err := part.Write(bytesPayload); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, imagesapi.EditsPath, buffer)
	request.Header.Set("x-api-key", testAPIKey)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if doer.calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", doer.calls)
	}
}

// TestHandlerRejectsMultipartMissingImage 验证 multipart 编辑缺少图片时报 400。
func TestHandlerRejectsMultipartMissingImage(t *testing.T) {
	t.Parallel()

	handler := newTestHandler(t, &passthroughDoer{}, nil)
	buffer := &bytes.Buffer{}
	writer := multipart.NewWriter(buffer)
	_ = writer.WriteField("model", "dall-e-3")
	_ = writer.WriteField("prompt", "make it blue")
	_ = writer.Close()

	request := httptest.NewRequest(http.MethodPost, imagesapi.EditsPath, buffer)
	request.Header.Set("x-api-key", testAPIKey)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), `"code":"image_required"`) {
		t.Fatalf("body = %s", response.Body)
	}
}

// TestHandlerMapsUpstreamFailureToErrorEnvelope 验证上游失败映射为 OpenAI 错误体。
func TestHandlerMapsUpstreamFailureToErrorEnvelope(t *testing.T) {
	t.Parallel()

	handler := newTestHandler(t, &passthroughDoer{
		status: http.StatusBadRequest,
		body:   `{"error":{"message":"bad prompt"}}`,
	}, nil)
	request := httptest.NewRequest(
		http.MethodPost,
		imagesapi.GenerationsPath,
		strings.NewReader(`{"model":"dall-e-3","prompt":"a cat"}`),
	)
	request.Header.Set("x-api-key", testAPIKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	var document struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if document.Error.Type != "invalid_request_error" ||
		document.Error.Code != "upstream_failed" ||
		!strings.Contains(document.Error.Message, "bad prompt") {
		t.Fatalf("error = %#v", document.Error)
	}
}

// TestHandlerRejectsUnauthorizedWrongPathAndMethod 验证失败关闭顺序。
func TestHandlerRejectsUnauthorizedWrongPathAndMethod(t *testing.T) {
	t.Parallel()

	handler := newTestHandler(t, &passthroughDoer{}, nil)

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(
		unauthorized,
		httptest.NewRequest(
			http.MethodPost,
			imagesapi.GenerationsPath,
			strings.NewReader(`{}`),
		),
	)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", unauthorized.Code)
	}

	notFound := httptest.NewRecorder()
	notFoundRequest := httptest.NewRequest(
		http.MethodPost,
		"/v1/images/unknown",
		strings.NewReader(`{}`),
	)
	notFoundRequest.Header.Set("x-api-key", testAPIKey)
	handler.ServeHTTP(notFound, notFoundRequest)
	if notFound.Code != http.StatusNotFound {
		t.Fatalf("not found status=%d", notFound.Code)
	}

	wrongMethod := httptest.NewRecorder()
	wrongMethodRequest := httptest.NewRequest(
		http.MethodGet,
		imagesapi.GenerationsPath,
		nil,
	)
	wrongMethodRequest.Header.Set("x-api-key", testAPIKey)
	handler.ServeHTTP(wrongMethod, wrongMethodRequest)
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("wrong method status=%d", wrongMethod.Code)
	}
}

// TestHandlerRejectsCapabilityViolationBeforeUpstream 验证能力闸门在上游调用前生效。
func TestHandlerRejectsCapabilityViolationBeforeUpstream(t *testing.T) {
	t.Parallel()

	doer := &passthroughDoer{}
	// passthrough 支持 output_format，因此换成 codex 原生账号来触发闸门。
	handler, err := imagesapi.NewHandler(imagesapi.Dependencies{
		Registry: images.NewRegistry("https://codex.example.test", ""),
		Accounts: fixedSource{accounts: []images.Account{{
			Provider:    "codex",
			AccountRef:  "acct_codex",
			AccessToken: "token",
		}}},
		Providers:  fixedProviders{provider: "codex"},
		HTTP:       doer,
		Authorizer: testAuthorizer{},
	})
	if err != nil {
		t.Fatalf("imagesapi.NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		imagesapi.GenerationsPath,
		strings.NewReader(`{"model":"gpt-image-2","prompt":"p","output_format":"webp"}`),
	)
	request.Header.Set("x-api-key", testAPIKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), "unsupported_image_output_format") {
		t.Fatalf("body = %s", response.Body)
	}
	if doer.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", doer.calls)
	}
}

// TestParseRejectsUnknownModelWithoutProvider 验证无法反查 Provider 时报 503。
func TestParseRejectsUnknownModelWithoutProvider(t *testing.T) {
	t.Parallel()

	handler, err := imagesapi.NewHandler(imagesapi.Dependencies{
		Registry:   images.NewRegistry("https://codex.example.test", ""),
		Accounts:   fixedSource{},
		Providers:  failingProviders{},
		HTTP:       &passthroughDoer{},
		Authorizer: testAuthorizer{},
	})
	if err != nil {
		t.Fatalf("imagesapi.NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		imagesapi.GenerationsPath,
		strings.NewReader(`{"model":"unknown-image-model","prompt":"p"}`),
	)
	request.Header.Set("x-api-key", testAPIKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), `"code":"no_available_account"`) {
		t.Fatalf("body = %s", response.Body)
	}
}

// failingProviders 模拟无法解析 Provider。
type failingProviders struct{}

// ResolveProvider 始终返回错误。
func (failingProviders) ResolveProvider(context.Context, string, string) (string, error) {
	return "", context.DeadlineExceeded
}
