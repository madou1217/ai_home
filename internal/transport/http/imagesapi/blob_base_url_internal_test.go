package imagesapi

import (
	"net/http/httptest"
	"testing"
)

// TestBlobBaseURLPrefersForwardedHost 验证经 Node 宿主转发时，blob URL 指向客户端访问的公开地址，
// 而不是 Go 的私有端点；非法的转发值回退到 Host。
func TestBlobBaseURLPrefersForwardedHost(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest("POST", "http://127.0.0.1:19550/v1/images/generations", nil)
	if got := blobBaseURL(request, ""); got != "http://127.0.0.1:19550" {
		t.Fatalf("direct = %q", got)
	}
	request.Header.Set("X-Forwarded-Host", "gateway.example:9527")
	if got := blobBaseURL(request, ""); got != "http://gateway.example:9527" {
		t.Fatalf("forwarded = %q", got)
	}
	request.Header.Set("X-Forwarded-Host", "evil.example/path")
	if got := blobBaseURL(request, ""); got != "http://127.0.0.1:19550" {
		t.Fatalf("invalid forwarded host must fall back, got %q", got)
	}
}
