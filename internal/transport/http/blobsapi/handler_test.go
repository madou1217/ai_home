package blobsapi_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/imageblob"
	"github.com/madou1217/ai_home/internal/transport/http/blobsapi"
)

// TestPathPrefixMatchesPath 守住 PathPrefix 与 Path 的一致性。
//
// PathPrefix 为了能被路由采集器解析而写成字面量，因此这里显式断言二者仍然对应。
func TestPathPrefixMatchesPath(t *testing.T) {
	t.Parallel()

	if got, want := blobsapi.PathPrefix, blobsapi.Path+"/"; got != want {
		t.Fatalf("PathPrefix = %q, want %q", got, want)
	}
}

// TestHandlerServesBlobBytes 验证取回原图时逐字段与 Node 一致。
func TestHandlerServesBlobBytes(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(0)
	id := store.Put([]byte("\x89PNG-bytes"), "image/png")
	handler := newTestHandler(t, store)

	request := httptest.NewRequest(http.MethodGet, blobsapi.PathPrefix+id, nil)
	request.Header.Set("Authorization", "Bearer local-blob-key")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("GET blob status=%d body=%s", response.Code, response.Body)
	}
	if got := response.Body.String(); got != "\x89PNG-bytes" {
		t.Fatalf("blob body = %q", got)
	}
	if got := response.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("content-type = %q, want image/png", got)
	}
	if got := response.Header().Get("Cache-Control"); got != "private, max-age=3600" {
		t.Fatalf("cache-control = %q", got)
	}
	if got := response.Header().Get("Content-Length"); got != "10" {
		t.Fatalf("content-length = %q, want 10", got)
	}
}

// TestHandlerRequiresClientKey 验证 blob 路由与其它 /v1 路由共用同一客户端密钥闸门。
func TestHandlerRequiresClientKey(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(0)
	id := store.Put([]byte("guarded"), "image/png")
	handler := newTestHandler(t, store)

	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, blobsapi.PathPrefix+id, nil),
	)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d body=%s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), "unauthorized_client") {
		t.Fatalf("unauthorized body = %s", response.Body)
	}
}

// TestHandlerReportsMissingBlob 验证未命中返回与 Node 逐字段一致的 404。
func TestHandlerReportsMissingBlob(t *testing.T) {
	t.Parallel()

	handler := newTestHandler(t, imageblob.NewStore(0))
	for _, path := range []string{
		blobsapi.PathPrefix + "deadbeef",
		blobsapi.PathPrefix,
		blobsapi.PathPrefix + "a/b",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("Authorization", "Bearer local-blob-key")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("GET %s status=%d body=%s", path, response.Code, response.Body)
		}
		if !strings.Contains(response.Body.String(), `"error":"blob_not_found"`) {
			t.Fatalf("GET %s body = %s", path, response.Body)
		}
	}
}

// TestHandlerRejectsUnsupportedMethod 验证只有 GET 是 blob 取回路由。
func TestHandlerRejectsUnsupportedMethod(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(0)
	id := store.Put([]byte("bytes"), "image/png")
	handler := newTestHandler(t, store)

	request := httptest.NewRequest(http.MethodPost, blobsapi.PathPrefix+id, nil)
	request.Header.Set("Authorization", "Bearer local-blob-key")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST blob status=%d body=%s", response.Code, response.Body)
	}
	if got := response.Header().Get("Allow"); got != http.MethodGet {
		t.Fatalf("allow = %q, want GET", got)
	}
}

// TestHandlerServesEvictedBlobAsMissing 验证淘汰后的 ID 按未命中处理。
func TestHandlerServesEvictedBlobAsMissing(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(1)
	first := store.Put([]byte("first"), "image/png")
	store.Put([]byte("second"), "image/png")
	handler := newTestHandler(t, store)

	request := httptest.NewRequest(http.MethodGet, blobsapi.PathPrefix+first, nil)
	request.Header.Set("Authorization", "Bearer local-blob-key")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("evicted blob status=%d body=%s", response.Code, response.Body)
	}
}

// TestNewHandlerRejectsMissingDependencies 验证依赖缺失时不会创建半可用 Handler。
func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	t.Parallel()

	if _, err := blobsapi.NewHandler(blobsapi.Dependencies{}); err == nil {
		t.Fatal("expected error for missing dependencies")
	}
	if _, err := blobsapi.NewHandler(blobsapi.Dependencies{
		Blobs: imageblob.NewStore(0),
	}); err == nil {
		t.Fatal("expected error for missing authorizer")
	}
}

// blobAuthorizerStub 只接受测试使用的固定客户端密钥。
type blobAuthorizerStub struct{}

func (blobAuthorizerStub) Authorized(request *http.Request) bool {
	return request.Header.Get("Authorization") == "Bearer local-blob-key"
}

// newTestHandler 创建使用内存 blob 仓的取回 Handler。
func newTestHandler(t *testing.T, store *imageblob.Store) http.Handler {
	t.Helper()

	handler, err := blobsapi.NewHandler(blobsapi.Dependencies{
		Blobs:      store,
		Authorizer: blobAuthorizerStub{},
	})
	if err != nil {
		t.Fatalf("blobsapi.NewHandler() error = %v", err)
	}
	return handler
}
