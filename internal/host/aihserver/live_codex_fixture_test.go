package aihserver_test

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
)

const realCodexToolName = "get_weather"

// realCodexFixture 保存一次真实 Codex 验收共享的本地 Server 与公开结果。
// 它不保存认证正文，避免测试辅助对象延长真实凭据的生命周期。
type realCodexFixture struct {
	aiHomeDir    string
	baseURL      string
	client       *http.Client
	accountRef   string
	importStatus int
	authKind     string
	modelsStatus int
	modelCount   int
}

// newRealCodexUpstreamBudget 创建禁用重定向且带总超时的真实请求边界。
func newRealCodexUpstreamBudget(maxResponses int) *realCodexRequestBudget {
	return &realCodexRequestBudget{
		maxResponses: maxResponses,
		client: &http.Client{
			Timeout: realCodexUpstreamTimeout,
			CheckRedirect: func(
				_ *http.Request,
				_ []*http.Request,
			) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// startRealCodexFixture 在临时 AIH_HOME 中导入一次账号并维护真实模型目录。
func startRealCodexFixture(
	t *testing.T,
	authJSON []byte,
	upstream *realCodexRequestBudget,
) realCodexFixture {
	t.Helper()

	codexModels, err := codexresponses.NewModelCatalogSource(upstream)
	if err != nil {
		t.Fatalf("创建真实 Codex 模型目录源失败: %v", err)
	}
	aiHomeDir := newDisposableRealCodexHome(t)
	baseURL, client := startRealCodexServer(
		t,
		aiHomeDir,
		upstream,
		[]accountapp.ProviderModelDiscoverer{codexModels},
	)

	importPayload, err := json.Marshal(map[string]any{
		"provider_id": "codex",
		"artifacts": map[string]json.RawMessage{
			"auth_json": authJSON,
		},
	})
	if err != nil {
		t.Fatalf("构造真实 Codex 导入命令失败: %v", err)
	}
	imported := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.NativeImportPath,
		testManagementKey,
		importPayload,
	)
	clear(importPayload)
	assertRealStatus(t, imported, http.StatusCreated)
	var importDocument struct {
		Data struct {
			AccountRef string `json:"account_ref"`
			AuthKind   string `json:"auth_kind"`
			AuthMode   string `json:"auth_mode"`
		} `json:"data"`
	}
	decodeRealJSON(t, imported.body, &importDocument)
	if importDocument.Data.AuthKind != "oauth" || importDocument.Data.AuthMode != "" {
		t.Fatalf(
			"真实账号认证投影错误: kind=%q mode=%q",
			importDocument.Data.AuthKind,
			importDocument.Data.AuthMode,
		)
	}
	if counts := upstream.snapshot(); counts != (realCodexRequestCounts{
		models:     1,
		lastStatus: http.StatusOK,
	}) {
		t.Fatalf("导入阶段真实请求计数错误: %+v", counts)
	}

	models := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+modelsapi.Path,
		testClientKey,
		nil,
	)
	assertRealStatus(t, models, http.StatusOK)

	return realCodexFixture{
		aiHomeDir:    aiHomeDir,
		baseURL:      baseURL,
		client:       client,
		accountRef:   importDocument.Data.AccountRef,
		importStatus: imported.status,
		authKind:     importDocument.Data.AuthKind,
		modelsStatus: models.status,
		modelCount:   assertRealCodexModelAvailable(t, models.body),
	}
}

// databasePath 返回当前临时账号库的精确路径。
func (fixture realCodexFixture) databasePath() string {
	return filepath.Join(fixture.aiHomeDir, "aih.db")
}
