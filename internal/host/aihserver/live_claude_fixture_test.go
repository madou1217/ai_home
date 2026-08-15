package aihserver_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sub2api"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
)

const (
	// realClaudeHTTPEnv 显式授权三种公开 HTTP 协议访问真实 Claude 上游。
	realClaudeHTTPEnv = "AIH_REAL_CLAUDE_HTTP"
	// realClaudeHTTPAccountHomeEnv 指向只读来源的隔离 AIH_HOME。
	realClaudeHTTPAccountHomeEnv = "AIH_REAL_CLAUDE_ACCOUNT_HOME"
	// realClaudeHTTPAccountIDEnv 精确选择隔离库中的 Claude CLI 数字别名。
	realClaudeHTTPAccountIDEnv = "AIH_REAL_CLAUDE_ACCOUNT_ID"
	// realClaudeHTTPNativeCredentialsEnv 显式选择只读的官方 credentials.json。
	realClaudeHTTPNativeCredentialsEnv = "AIH_REAL_CLAUDE_NATIVE_CREDENTIALS_FILE"
	// realClaudeHTTPNativeConfigEnv 显式选择只读的官方全局配置 JSON。
	realClaudeHTTPNativeConfigEnv = "AIH_REAL_CLAUDE_NATIVE_CONFIG_FILE"
	// realClaudeContinuityMarker 是两轮连续性请求唯一允许新增的低敏文本。
	realClaudeContinuityMarker = "AIH_REAL_CLAUDE_CONTINUITY_OK"
	// realClaudeToolName 是三种客户端协议共享的固定函数工具。
	realClaudeToolName = "get_weather"
	// realClaudeSourceDatabaseMaxBytes 限制测试只读复制的数据库大小。
	realClaudeSourceDatabaseMaxBytes = 64 * 1024 * 1024
	// realClaudeSourceArtifactMaxBytes 限制单个官方认证 artifact 的读取大小。
	realClaudeSourceArtifactMaxBytes = 1024 * 1024
)

var (
	// realClaudeTransferModel 是真实账号目录经过校验后选出的普通请求模型。
	realClaudeTransferModel = "claude-opus-5"
	// realClaudeReasoningModel 与普通请求共用真实目录中的模型，避免凭空假设 thinking 模型。
	realClaudeReasoningModel = "claude-sonnet-5"
)

// realClaudeFixture 保存临时 Server 的公开地址和非敏感导入结果。
// 凭据只存在于导出缓冲区和临时 aih.db，不进入该值对象。
type realClaudeFixture struct {
	aiHomeDir    string
	baseURL      string
	client       *http.Client
	budget       *realClaudeRequestBudget
	accountRef   string
	importStatus int
	modelsStatus int
	modelCount   int
}

// startRealClaudeFixture 从源隔离库只读导出一个账号，再导入一次性 Go Server。
func startRealClaudeFixture(
	t *testing.T,
	budget *realClaudeRequestBudget,
) realClaudeFixture {
	t.Helper()

	models := newRealClaudeModelCatalog(t, budget)
	aiHomeDir := newDisposableRealCodexHome(t)
	baseURL, client := startRealClaudeRelayServer(
		t,
		aiHomeDir,
		budget,
		[]accountapp.ProviderModelDiscoverer{models},
	)
	imported := importRealClaudeFixtureAccount(t, baseURL, client)
	assertRealStatus(t, imported, http.StatusCreated)
	accountRef := decodeRealTransferAccountRef(t, imported.body)

	modelDocument := waitForRealModelCatalog(t, client, baseURL+modelsapi.Path)
	selectedModel, modelCount := selectRealClaudeModelFromCatalog(t, modelDocument.body)
	realClaudeTransferModel = selectedModel
	realClaudeReasoningModel = selectedModel
	if counts := budget.snapshot(); counts != (realClaudeRequestCounts{
		models:     1,
		lastStatus: http.StatusOK,
	}) {
		t.Fatalf("Claude fixture 导入阶段真实请求预算错误: %+v", counts)
	}

	return realClaudeFixture{
		aiHomeDir:    aiHomeDir,
		baseURL:      baseURL,
		client:       client,
		budget:       budget,
		accountRef:   accountRef,
		importStatus: imported.status,
		modelsStatus: modelDocument.status,
		modelCount:   modelCount,
	}
}

// selectRealClaudeModelFromCatalog 只从真实 Claude 目录选择 claude-* 模型。
// 偏好列表不构成能力事实，最终模型必须来自本次账号返回的目录。
func selectRealClaudeModelFromCatalog(t *testing.T, body string) (string, int) {
	t.Helper()
	var document struct {
		Object string `json:"object"`
		Data   []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	decodeRealJSON(t, body, &document)
	if document.Object != "list" || len(document.Data) == 0 {
		t.Fatalf("真实 Claude 本地模型目录无效: object=%q count=%d", document.Object, len(document.Data))
	}
	models := make([]string, 0, len(document.Data))
	for _, item := range document.Data {
		modelID := strings.TrimSpace(item.ID)
		if strings.HasPrefix(modelID, "claude-") {
			models = append(models, modelID)
		}
	}
	if len(models) == 0 {
		t.Fatalf("真实 Claude 模型目录没有可用于协议验收的 claude 模型: count=%d", len(document.Data))
	}
	preferred := []string{
		"claude-opus-5",
		"claude-sonnet-5",
		"claude-3-7-sonnet",
		"claude-3-5-sonnet",
	}
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

// importRealClaudeFixtureAccount 选择一个明确来源导入一次性 Server。原生
// artifact 优先用于临期数据库快照，但必须成对指定，且源文件保持只读。
func importRealClaudeFixtureAccount(
	t *testing.T,
	baseURL string,
	client *http.Client,
) httpExchange {
	t.Helper()

	credentialsPath := strings.TrimSpace(os.Getenv(realClaudeHTTPNativeCredentialsEnv))
	configPath := strings.TrimSpace(os.Getenv(realClaudeHTTPNativeConfigEnv))
	if credentialsPath != "" || configPath != "" {
		if credentialsPath == "" || configPath == "" {
			t.Fatalf(
				"%s 和 %s 必须同时指定",
				realClaudeHTTPNativeCredentialsEnv,
				realClaudeHTTPNativeConfigEnv,
			)
		}
		return importRealClaudeNativeArtifacts(
			t,
			baseURL,
			client,
			credentialsPath,
			configPath,
		)
	}
	if strings.TrimSpace(os.Getenv(realClaudeSub2APIFileEnv)) != "" ||
		strings.TrimSpace(os.Getenv(realClaudeSub2APIEmailEnv)) != "" {
		externalDocument := readRealClaudeSub2APIDocument(t)
		defer clear(externalDocument)
		externalHash := sha256.Sum256(externalDocument)
		singleAccount := selectRealClaudeSub2APIAccount(t, externalDocument)
		defer clear(singleAccount)
		assertRealSub2APIDocument(t, singleAccount)
		assertRealClaudeCredentialFresh(t, singleAccount)
		imported := performRequest(
			t,
			client,
			http.MethodPost,
			baseURL+accountsapi.Sub2APIImportPath,
			testManagementKey,
			singleAccount,
		)
		if sha256.Sum256(externalDocument) != externalHash {
			t.Fatal("外部标准导出文档在只读导入期间发生变化")
		}
		return imported
	}

	document := exportRealClaudeAccountFromDatabaseCopy(t)
	defer clear(document)
	assertRealSub2APIDocument(t, document)
	assertRealClaudeCredentialFresh(t, document)
	return performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.Sub2APIImportPath,
		testManagementKey,
		document,
	)
}

// realClaudeNativeArtifactSourceConfigured 报告当前真实夹具是否选择原生来源。
func realClaudeNativeArtifactSourceConfigured() bool {
	return strings.TrimSpace(os.Getenv(realClaudeHTTPNativeCredentialsEnv)) != "" &&
		strings.TrimSpace(os.Getenv(realClaudeHTTPNativeConfigEnv)) != ""
}

// realClaudeFixtureSourceConfigured 报告三种成对真实来源中是否有一种完整可用。
func realClaudeFixtureSourceConfigured() bool {
	if realClaudeNativeArtifactSourceConfigured() {
		return true
	}
	if strings.TrimSpace(os.Getenv(realClaudeSub2APIFileEnv)) != "" &&
		strings.TrimSpace(os.Getenv(realClaudeSub2APIEmailEnv)) != "" {
		return true
	}
	return strings.TrimSpace(os.Getenv(realClaudeHTTPAccountHomeEnv)) != "" &&
		strings.TrimSpace(os.Getenv(realClaudeHTTPAccountIDEnv)) != ""
}

// importRealClaudeNativeArtifacts 把两个官方 JSON 对象原样包装为原生导入 DTO。
// 哈希校验保证读取和导入没有写回正式认证文件。
func importRealClaudeNativeArtifacts(
	t *testing.T,
	baseURL string,
	client *http.Client,
	credentialsPath string,
	configPath string,
) httpExchange {
	t.Helper()

	credentials, credentialsHash := readBoundedPrivateClaudeArtifact(
		t,
		credentialsPath,
	)
	defer clear(credentials)
	config, configHash := readBoundedPrivateClaudeArtifact(t, configPath)
	defer clear(config)
	payload, err := json.Marshal(struct {
		ProviderID string `json:"provider_id"`
		Artifacts  struct {
			Credentials json.RawMessage `json:"credentials_json"`
			Config      json.RawMessage `json:"global_config_json"`
		} `json:"artifacts"`
	}{
		ProviderID: "claude",
		Artifacts: struct {
			Credentials json.RawMessage `json:"credentials_json"`
			Config      json.RawMessage `json:"global_config_json"`
		}{
			Credentials: credentials,
			Config:      config,
		},
	})
	if err != nil {
		t.Fatalf("构造 Claude 原生导入请求失败: %v", err)
	}
	defer clear(payload)

	imported := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.NativeImportPath,
		testManagementKey,
		payload,
	)
	assertPrivateClaudeArtifactUnchanged(t, credentialsPath, credentialsHash)
	assertPrivateClaudeArtifactUnchanged(t, configPath, configHash)
	return imported
}

// readBoundedPrivateClaudeArtifact 有界读取权限为 0600 的官方 JSON 文件。
func readBoundedPrivateClaudeArtifact(
	t *testing.T,
	path string,
) ([]byte, [sha256.Size]byte) {
	t.Helper()

	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 ||
		info.Size() <= 0 || info.Size() > realClaudeSourceArtifactMaxBytes {
		t.Fatalf("Claude 原生 artifact 必须是 0600 的有界普通文件: %v", err)
	}
	payload, err := os.ReadFile(path)
	if err != nil || len(payload) == 0 ||
		len(payload) > realClaudeSourceArtifactMaxBytes || !json.Valid(payload) {
		clear(payload)
		t.Fatalf("读取 Claude 原生 artifact 失败: %v", err)
	}
	return payload, sha256.Sum256(payload)
}

// assertPrivateClaudeArtifactUnchanged 校验真实测试没有写回源认证文件。
func assertPrivateClaudeArtifactUnchanged(
	t *testing.T,
	path string,
	want [sha256.Size]byte,
) {
	t.Helper()
	payload, got := readBoundedPrivateClaudeArtifact(t, path)
	clear(payload)
	if got != want {
		t.Fatal("Claude 原生 artifact 在只读导入期间发生变化")
	}
}

// databasePath 返回一次性 Server 的精确数据库路径。
func (fixture realClaudeFixture) databasePath() string {
	return filepath.Join(fixture.aiHomeDir, sqliteaccount.DatabaseFileName)
}

// exportRealClaudeAccountFromDatabaseCopy 只读取源 aih.db，并在私有临时副本上
// 运行正式 Store/ExportReader/Exporter，避免 migration 或 pragma 写入源文件。
func exportRealClaudeAccountFromDatabaseCopy(t *testing.T) []byte {
	t.Helper()

	sourceHome := strings.TrimSpace(os.Getenv(realClaudeHTTPAccountHomeEnv))
	rawID := strings.TrimSpace(os.Getenv(realClaudeHTTPAccountIDEnv))
	if sourceHome == "" || rawID == "" {
		t.Fatalf("%s 和 %s 必须同时指定", realClaudeHTTPAccountHomeEnv, realClaudeHTTPAccountIDEnv)
	}
	accountID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || accountID <= 0 {
		t.Fatalf("%s 必须是正整数", realClaudeHTTPAccountIDEnv)
	}
	alias, err := accountcore.NewCLIAccountID(accountID)
	if err != nil {
		t.Fatalf("创建 Claude 测试账号别名失败: %v", err)
	}

	sourcePath, err := sqliteaccount.DatabasePath(sourceHome)
	if err != nil {
		t.Fatalf("解析 Claude 源数据库路径失败: %v", err)
	}
	sourceBefore := readBoundedPrivateClaudeDatabase(t, sourcePath)
	defer clear(sourceBefore)
	sourceHash := sha256.Sum256(sourceBefore)

	copyHome := t.TempDir()
	copyPath, err := sqliteaccount.DatabasePath(copyHome)
	if err != nil {
		t.Fatalf("解析 Claude 数据库副本路径失败: %v", err)
	}
	if err := os.WriteFile(copyPath, sourceBefore, 0o600); err != nil {
		t.Fatalf("创建 Claude 数据库私有副本失败: %v", err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("创建 Provider Catalog 失败: %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: copyHome,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("打开 Claude 数据库副本失败: %v", err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Errorf("关闭 Claude 数据库副本失败: %v", err)
		}
	}()
	account, err := store.GetByCLIAccountID(context.Background(), "claude", alias)
	if err != nil || !account.Enabled() {
		t.Fatalf("读取启用的 Claude 测试账号失败: enabled=%t error=%v", account.Enabled(), err)
	}
	models, err := store.ListAccountModels(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("读取 Claude 账号模型目录失败: %v", err)
	}
	selectedModel, err := selectRealClaudeModelFromAccountModels(models)
	if err != nil {
		t.Fatal(err)
	}
	realClaudeTransferModel = selectedModel
	realClaudeReasoningModel = selectedModel
	reader, err := accountapp.NewExportReader(store, store, store)
	if err != nil {
		t.Fatalf("创建 Claude 导出读取器失败: %v", err)
	}
	exporter, err := sub2api.NewExporter(reader, func() time.Time {
		return time.Now().UTC()
	})
	if err != nil {
		t.Fatalf("创建 Claude 标准导出器失败: %v", err)
	}
	document, err := exporter.ExportAccount(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("从 Claude 数据库副本导出账号失败: %v", err)
	}

	sourceAfter := readBoundedPrivateClaudeDatabase(t, sourcePath)
	defer clear(sourceAfter)
	if sha256.Sum256(sourceAfter) != sourceHash {
		clear(document)
		t.Fatal("Claude 源隔离数据库在只读导出期间发生变化")
	}
	return document
}

// selectRealClaudeModelFromAccountModels 只从源账号已有的有效正排模型中选择模型。
func selectRealClaudeModelFromAccountModels(models []accountapp.AccountModel) (string, error) {
	available := make([]string, 0, len(models))
	for _, model := range models {
		if !model.IsValid() {
			return "", accountapp.ErrInvalidAccountModel
		}
		if model.UpstreamAvailable() && model.Effective() {
			modelID := model.ModelID().String()
			if strings.HasPrefix(modelID, "claude-") {
				available = append(available, modelID)
			}
		}
	}
	if len(available) == 0 {
		return "", accountapp.ErrInvalidAccountModel
	}
	preferred := []string{
		"claude-opus-5",
		"claude-sonnet-5",
		"claude-3-7-sonnet",
		"claude-3-5-sonnet",
	}
	for _, candidate := range preferred {
		for _, modelID := range available {
			if modelID == candidate {
				return candidate, nil
			}
		}
	}
	sort.Strings(available)
	return available[0], nil
}

// readBoundedPrivateClaudeDatabase 有界读取权限为 0600 的普通 SQLite 文件。
func readBoundedPrivateClaudeDatabase(t *testing.T, path string) []byte {
	t.Helper()

	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 ||
		info.Size() <= 0 || info.Size() > realClaudeSourceDatabaseMaxBytes {
		t.Fatalf("Claude 源数据库必须是 0600 的有界普通文件: %v", err)
	}
	payload, err := os.ReadFile(path)
	if err != nil || len(payload) == 0 || len(payload) > realClaudeSourceDatabaseMaxBytes {
		clear(payload)
		t.Fatalf("读取 Claude 源数据库失败: %v", err)
	}
	return payload
}

// marshalRealClaudePayload 编码固定请求并拒绝测试夹具写入本协议之外的模型。
func marshalRealClaudePayload(t *testing.T, payload map[string]any) []byte {
	return marshalRealClaudePayloadForModel(t, realClaudeTransferModel, payload)
}

// marshalRealClaudePayloadForModel 编码固定请求并要求模型来自显式验收集合。
func marshalRealClaudePayloadForModel(
	t *testing.T,
	model string,
	payload map[string]any,
) []byte {
	t.Helper()
	if model != realClaudeTransferModel && model != realClaudeReasoningModel {
		t.Fatalf("真实 Claude 请求模型未声明: %s", model)
	}
	if payload["model"] != model {
		t.Fatalf("真实 Claude 请求模型必须来自账号物化目录: %v", payload["model"])
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("编码真实 Claude HTTP 请求失败: %v", err)
	}
	return data
}
