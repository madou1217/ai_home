package aihserver

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestRouterMountsSub2APIImport 验证 Host 不会遗漏独立的标准迁移入口。
func TestRouterMountsSub2APIImport(t *testing.T) {
	t.Parallel()

	called := false
	accounts := http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		called = true
		response.WriteHeader(http.StatusNoContent)
	})
	fallback := http.NotFoundHandler()
	router := newRouter(serverHandlers{
		accounts:          accounts,
		accountAuth:       fallback,
		models:            fallback,
		inference:         fallback,
		claudeRelayLeases: fallback,
		claudeNativeRelay: fallback,
		catalogStatus: func() catalogReadiness {
			return catalogReadiness{}
		},
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(
		response,
		httptest.NewRequest(
			http.MethodPost,
			accountsapi.Sub2APIImportPath,
			nil,
		),
	)

	if !called || response.Code != http.StatusNoContent {
		t.Fatalf(
			"sub2api route called=%t status=%d",
			called,
			response.Code,
		)
	}
}
