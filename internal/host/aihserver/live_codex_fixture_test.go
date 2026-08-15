package aihserver_test

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
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
	models := waitForRealModelCatalog(t, client, baseURL+modelsapi.Path)
	selectedModel, modelCount := selectRealCodexModelFromCatalog(t, models.body)
	realCodexModel = selectedModel
	upstream.SetExpectedModel(selectedModel)
	if counts := upstream.snapshot(); counts != (realCodexRequestCounts{
		models:     1,
		lastStatus: http.StatusOK,
	}) {
		t.Fatalf("异步模型刷新阶段真实请求计数错误: %+v", counts)
	}

	return realCodexFixture{
		aiHomeDir:    aiHomeDir,
		baseURL:      baseURL,
		client:       client,
		accountRef:   importDocument.Data.AccountRef,
		importStatus: imported.status,
		authKind:     importDocument.Data.AuthKind,
		modelsStatus: models.status,
		modelCount:   modelCount,
	}
}

// selectRealCodexModelFromCatalog 只从已物化且可用的 gpt 模型中选择本次模型。
// 偏好列表只是排序策略；最终结果必须来自 Server 返回的真实目录，不能凭空指定。
func selectRealCodexModelFromCatalog(t *testing.T, body string) (string, int) {
	t.Helper()
	var document struct {
		Object string `json:"object"`
		Data   []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	decodeRealJSON(t, body, &document)
	if document.Object != "list" || len(document.Data) == 0 {
		t.Fatalf("真实 Codex 本地模型目录无效: object=%q count=%d", document.Object, len(document.Data))
	}
	models := make([]string, 0, len(document.Data))
	for _, item := range document.Data {
		modelID := strings.TrimSpace(item.ID)
		if strings.HasPrefix(modelID, "gpt-") {
			models = append(models, modelID)
		}
	}
	if len(models) == 0 {
		t.Fatalf("真实 Codex 模型目录没有可用于协议验收的 gpt 模型: count=%d", len(document.Data))
	}
	preferred := []string{"gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex"}
	for _, candidate := range preferred {
		for _, modelID := range models {
			if modelID == candidate {
				return candidate, len(document.Data)
			}
		}
	}
	sort.Strings(models)
	return models[0], len(document.Data)
}

// databasePath 返回当前临时账号库的精确路径。
func (fixture realCodexFixture) databasePath() string {
	return filepath.Join(fixture.aiHomeDir, "aih.db")
}
