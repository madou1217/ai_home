package aihserver

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestRouterMountsNativeImport 验证 Host 不会遗漏原生的账号 artifact 导入入口。
func TestRouterMountsNativeImport(t *testing.T) {
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
		blobs:             fallback,
		tokenCount:        fallback,
		images:            fallback,
		inference:         fallback,
		gemini:            fallback,
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
			accountsapi.NativeImportPath,
			nil,
		),
	)

	if !called || response.Code != http.StatusNoContent {
		t.Fatalf(
			"native import route called=%t status=%d",
			called,
			response.Code,
		)
	}
}
