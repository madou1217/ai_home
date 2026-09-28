package aihserver

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/clientversion"
)

type stubAuthorizer bool

func (authorized stubAuthorizer) Authorized(*http.Request) bool { return bool(authorized) }

// TestObserveCodexClientVersionLearnsOnlyFromAuthorizedClients 验证未鉴权请求伪造的
// 版本不能抬高网关自报身份，鉴权通过的真实 Codex 客户端会被学习。
func TestObserveCodexClientVersionLearnsOnlyFromAuthorizedClients(t *testing.T) {
	t.Parallel()

	resolver, err := clientversion.NewResolver(clientversion.ResolverOptions{Provider: "codex", Floor: "0.158.0"})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	request.Header.Set("Originator", "codex_exec")
	request.Header.Set("User-Agent", "codex_exec/0.170.0 (Mac OS)")

	observeCodexClientVersion(resolver, stubAuthorizer(false))(request)
	if resolver.Current() != "0.158.0" {
		t.Fatalf("unauthorized request raised version to %q", resolver.Current())
	}
	observeCodexClientVersion(resolver, stubAuthorizer(true))(request)
	if resolver.Current() != "0.170.0" {
		t.Fatalf("authorized genuine client not learned: %q", resolver.Current())
	}
}
