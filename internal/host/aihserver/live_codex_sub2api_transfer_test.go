package aihserver_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

// TestRealCodexSub2APITransferEndToEnd 通过两个隔离 Server 验证标准文档原样迁移。
//
// 默认跳过；显式提供 AIH_REAL_CODEX_AUTH_FILE 后会请求两次真实模型目录和一次
// Responses 推理。正式 auth.json 只读，两个 aih.db 与 0600 迁移文档均在测试后删除。
func TestRealCodexSub2APITransferEndToEnd(t *testing.T) {
	authJSON := readRealCodexAuthFromEnvironment(t)
	defer clear(authJSON)
	_ = assertRealCodexAuthReady(t, authJSON)

	sourceUpstream := newRealCodexUpstreamBudget(1)
	source := startRealCodexFixture(t, authJSON, sourceUpstream)
	exported := performRequest(
		t,
		source.client,
		http.MethodGet,
		source.baseURL+accountsapi.CollectionPath+"/"+source.accountRef+"/export",
		testManagementKey,
		nil,
	)
	assertStatus(t, exported, http.StatusOK)
	document := []byte(exported.body)
	assertRealSub2APIDocument(t, document)
	documentHash := sha256.Sum256(document)

	transferPath := writeRealTransferDocument(t, document)
	importDocument, err := os.ReadFile(transferPath)
	if err != nil {
		t.Fatalf("读取临时 sub2api 文档失败: %v", err)
	}
	defer clear(importDocument)
	if !bytes.Equal(document, importDocument) {
		t.Fatal("临时 sub2api 文档在导入前发生变化")
	}

	targetUpstream := newRealCodexUpstreamBudget(1)
	targetModels, err := codexresponses.NewModelCatalogSource(targetUpstream)
	if err != nil {
		t.Fatalf("创建目标 Codex 模型目录源失败: %v", err)
	}
	targetHome := newDisposableRealCodexHome(t)
	targetURL, targetClient := startRealCodexServer(
		t,
		targetHome,
		targetUpstream,
		[]accountapp.ProviderModelDiscoverer{targetModels},
	)
	imported := performRequest(
		t,
		targetClient,
		http.MethodPost,
		targetURL+accountsapi.Sub2APIImportPath,
		testManagementKey,
		importDocument,
	)
	assertStatus(t, imported, http.StatusCreated)
	accountRef := decodeRealTransferAccountRef(t, imported.body)

	models := performRequest(
		t,
		targetClient,
		http.MethodGet,
		targetURL+modelsapi.Path,
		testClientKey,
		nil,
	)
	assertStatus(t, models, http.StatusOK)
	modelCount := assertRealCodexModelAvailable(t, models.body)

	requestPayload := marshalRealCodexPayload(t, map[string]any{
		"model":        realCodexModel,
		"instructions": realCodexInstructions,
		"input":        "Reply with exactly: " + realCodexMarker,
		"metadata": map[string]string{
			"test_scope": "aih-real-codex-e2e",
		},
	}, false)
	response := performRequest(
		t,
		targetClient,
		http.MethodPost,
		targetURL+openairesponsesapi.Path,
		testClientKey,
		requestPayload,
	)
	clear(requestPayload)
	assertStatus(t, response, http.StatusOK)
	responseDocument := decodeRealResponsesDocument(t, []byte(response.body))
	assertCompletedRealCodexResponse(t, responseDocument)
	if !strings.Contains(response.body, realCodexMarker) {
		t.Fatal("真实迁移推理响应缺少固定标记")
	}

	reexported := performRequest(
		t,
		targetClient,
		http.MethodGet,
		targetURL+accountsapi.CollectionPath+"/"+accountRef+"/export",
		testManagementKey,
		nil,
	)
	assertStatus(t, reexported, http.StatusOK)
	assertRealSub2APIDocument(t, []byte(reexported.body))
	if got := sha256.Sum256(importDocument); got != documentHash {
		t.Fatal("原始迁移文档在闭环期间发生变化")
	}

	wantSource := realCodexRequestCounts{models: 1}
	if got := sourceUpstream.snapshot(); got != wantSource {
		t.Fatalf("源 Server 真实请求预算错误: got=%+v want=%+v", got, wantSource)
	}
	wantTarget := realCodexRequestCounts{models: 1, responses: 1}
	if got := targetUpstream.snapshot(); got != wantTarget {
		t.Fatalf("目标 Server 真实请求预算错误: got=%+v want=%+v", got, wantTarget)
	}

	t.Logf(
		strings.Join([]string{
			"真实 Codex sub2api 迁移验收通过",
			"source_export: GET %s/v1/management/accounts/{account_ref}/export status=200",
			"document: mode=0600 version=1 sha256_prefix=%s local_identity_fields=false",
			"target_import: POST %s payload=<original-0600-sub2api-document> status=%d",
			"models: GET %s status=%d count=%d contains_%s=true",
			"inference: POST %s payload={model:%s,input:<fixed-marker>,stream:false} status=%d marker_present=true",
			"target_reexport: GET %s/v1/management/accounts/{account_ref}/export status=%d version=1",
			"upstream_requests: source_models=1 target_models=1 target_responses=1 unexpected=0",
			"formal_auth: read_only=true temporary_databases=2 cleanup=registered",
		}, "\n"),
		source.baseURL,
		hex.EncodeToString(documentHash[:6]),
		targetURL+accountsapi.Sub2APIImportPath,
		imported.status,
		targetURL+modelsapi.Path,
		models.status,
		modelCount,
		realCodexModel,
		targetURL+openairesponsesapi.Path,
		realCodexModel,
		response.status,
		targetURL,
		reexported.status,
	)
}

// writeRealTransferDocument 独占创建权限 0600 的临时标准迁移文件。
func writeRealTransferDocument(t *testing.T, document []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sub2api-data.json")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatalf("创建临时 sub2api 文档失败: %v", err)
	}
	if _, err = file.Write(document); err != nil {
		_ = file.Close()
		t.Fatalf("写入临时 sub2api 文档失败: %v", err)
	}
	if err = file.Close(); err != nil {
		t.Fatalf("关闭临时 sub2api 文档失败: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("读取临时 sub2api 文档权限失败: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("临时 sub2api 文档权限错误: mode=%v", info.Mode().Perm())
	}
	return path
}

// assertRealSub2APIDocument 校验版本和禁止迁移的 AIH 本地字段。
func assertRealSub2APIDocument(t *testing.T, document []byte) {
	t.Helper()
	var root map[string]json.RawMessage
	if err := json.Unmarshal(document, &root); err != nil {
		t.Fatalf("sub2api 文档 JSON 无效: %v", err)
	}
	if string(root["type"]) != `"sub2api-data"` || string(root["version"]) != "1" {
		t.Fatal("sub2api 文档类型或版本无效")
	}
	for _, forbidden := range []string{
		"account_ref",
		"accountRef",
		"cli_account_id",
		"cliAccountId",
		"models",
		"usage",
		"runtime",
		"cooldown",
	} {
		if bytes.Contains(document, []byte(`"`+forbidden+`"`)) {
			t.Fatalf("sub2api 文档包含禁止字段 %q", forbidden)
		}
	}
}

// decodeRealTransferAccountRef 只把目标 Server 新生成的身份用于后续本地请求。
func decodeRealTransferAccountRef(t *testing.T, body string) string {
	t.Helper()
	var document struct {
		Data struct {
			AccountRef string `json:"account_ref"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &document); err != nil || document.Data.AccountRef == "" {
		t.Fatalf("迁移导入响应缺少 AccountRef: %v", err)
	}
	return document.Data.AccountRef
}
