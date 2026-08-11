package aihserver_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sub2api"
	claudemessages "github.com/madou1217/ai_home/internal/adapters/claude/messages"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

const (
	// realClaudeSub2APIFileEnv 显式选择只读的真实标准导出文件。
	realClaudeSub2APIFileEnv = "AIH_REAL_CLAUDE_SUB2API_FILE"
	// realClaudeSub2APIEmailEnv 在多账号标准文件中精确选择一个公开身份。
	realClaudeSub2APIEmailEnv = "AIH_REAL_CLAUDE_SUB2API_EMAIL"
	// realClaudeTransferModel 是账号 9 已确认用于闭环的当前 Claude 模型。
	realClaudeTransferModel = "claude-opus-5"
	// realClaudeTransferMarker 是唯一允许进入真实推理的固定低敏文本。
	realClaudeTransferMarker = "AIH_REAL_CLAUDE_TRANSFER_OK"
	// realClaudeTransferMaxFileBytes 限制一次真实标准文档读取。
	realClaudeTransferMaxFileBytes = 8 * 1024 * 1024
	// realClaudeTransferTimeout 覆盖两次目录和一次推理的独立请求上限。
	realClaudeTransferTimeout = 2 * time.Minute
	// realClaudeExpectedMaxTokens 来自当前 Claude Code 对 Claude 5 的默认值。
	realClaudeExpectedMaxTokens uint64 = 64_000
)

var errUnexpectedRealClaudeRequest = errors.New("真实 Claude 请求超出验收白名单或预算")

// realClaudeRequestCounts 是不携带 URL、凭据和正文的真实请求计数。
type realClaudeRequestCounts struct {
	models     int
	messages   int
	unexpected int
}

// realClaudeRequestBudget 在网络前验证官方端点、认证形态、客户端身份和固定正文。
type realClaudeRequestBudget struct {
	client      *http.Client
	maxMessages int
	mu          sync.Mutex
	counts      realClaudeRequestCounts
	// lastRejection 只保存固定类别，便于真实验收定位而不暴露请求内容。
	lastRejection string
}

// Do 仅在白名单预算通过后委托标准库 HTTP 客户端。
func (budget *realClaudeRequestBudget) Do(request *http.Request) (*http.Response, error) {
	if budget == nil || budget.client == nil || request == nil {
		return nil, errUnexpectedRealClaudeRequest
	}
	if err := budget.reserve(request); err != nil {
		return nil, err
	}
	return budget.client.Do(request)
}

// reserve 原子限制一页模型目录和显式数量的 Messages 请求。
func (budget *realClaudeRequestBudget) reserve(request *http.Request) error {
	budget.mu.Lock()
	defer budget.mu.Unlock()

	validBearer := strings.HasPrefix(request.Header.Get("Authorization"), "Bearer ") &&
		request.Header.Get("Authorization") != "Bearer "
	validCommon := request.URL != nil &&
		request.URL.Scheme == "https" &&
		request.URL.Host == "api.anthropic.com" &&
		validBearer &&
		request.Header.Get("anthropic-version") == "2023-06-01" &&
		hasHeaderToken(request.Header.Get("anthropic-beta"), "oauth-2025-04-20")
	if !validCommon {
		return budget.reject("common_headers")
	}

	switch {
	case request.Method == http.MethodGet &&
		request.URL.Path == "/v1/models" &&
		request.URL.Query().Get("limit") == "100" &&
		request.URL.Query().Get("after_id") == "" &&
		len(request.URL.Query()) == 1 &&
		request.Header.Get("Accept") == "application/json" &&
		budget.counts.models == 0:
		budget.counts.models++
		return nil
	case request.Method == http.MethodPost &&
		request.URL.Path == "/v1/messages" &&
		request.URL.RawQuery == "" &&
		request.Header.Get("Accept") == "text/event-stream" &&
		request.Header.Get("Content-Type") == "application/json" &&
		request.Header.Get("x-app") == "cli" &&
		request.Header.Get("anthropic-dangerous-direct-browser-access") == "true" &&
		strings.HasPrefix(request.Header.Get("User-Agent"), "claude-cli/2.1.225 ") &&
		hasHeaderToken(request.Header.Get("anthropic-beta"), "claude-code-20250219") &&
		budget.counts.messages < budget.maxMessages:
		reason, err := validateRealClaudeMessagesBodyWithReason(request)
		if err != nil {
			budget.counts.unexpected++
			budget.lastRejection = reason
			return err
		}
		budget.counts.messages++
		return nil
	default:
		return budget.reject("request_shape_or_budget")
	}
}

// reject 记录固定拒绝类别并阻止本次真实网络请求。
func (budget *realClaudeRequestBudget) reject(reason string) error {
	budget.counts.unexpected++
	budget.lastRejection = reason
	return errUnexpectedRealClaudeRequest
}

// snapshot 返回线程安全的低敏请求计数。
func (budget *realClaudeRequestBudget) snapshot() realClaudeRequestCounts {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	return budget.counts
}

// rejection 返回最近一次低敏预算拒绝类别。
func (budget *realClaudeRequestBudget) rejection() string {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	return budget.lastRejection
}

// newRealClaudeRequestBudget 创建禁用重定向和有界超时的真实传输。
func newRealClaudeRequestBudget(maxMessages int) *realClaudeRequestBudget {
	return &realClaudeRequestBudget{
		maxMessages: maxMessages,
		client: &http.Client{
			Timeout: realClaudeTransferTimeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// hasHeaderToken 对逗号分隔的官方 beta 名称做精确匹配。
func hasHeaderToken(raw string, expected string) bool {
	for _, value := range strings.Split(raw, ",") {
		if strings.TrimSpace(value) == expected {
			return true
		}
	}
	return false
}

// validateRealClaudeMessagesBody 验证跨协议请求没有自造模型或输出上限。
func validateRealClaudeMessagesBody(request *http.Request) error {
	_, err := validateRealClaudeMessagesBodyWithReason(request)
	return err
}

// validateRealClaudeMessagesBodyWithReason 在固定字段类别上给出低敏失败原因。
func validateRealClaudeMessagesBodyWithReason(request *http.Request) (string, error) {
	if request.Body == nil {
		return "body_missing", errUnexpectedRealClaudeRequest
	}
	payload, err := io.ReadAll(io.LimitReader(
		request.Body,
		realClaudeTransferMaxFileBytes+1,
	))
	_ = request.Body.Close()
	if err != nil || len(payload) == 0 || len(payload) > realClaudeTransferMaxFileBytes {
		clear(payload)
		return "body_read", errUnexpectedRealClaudeRequest
	}
	request.Body = io.NopCloser(bytes.NewReader(append([]byte(nil), payload...)))
	defer clear(payload)

	var document struct {
		Model     string `json:"model"`
		MaxTokens uint64 `json:"max_tokens"`
		Stream    bool   `json:"stream"`
		System    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"system"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return "json", errUnexpectedRealClaudeRequest
	}
	if document.Model != realClaudeTransferModel {
		return "model", errUnexpectedRealClaudeRequest
	}
	if document.MaxTokens != realClaudeExpectedMaxTokens {
		return "max_tokens", errUnexpectedRealClaudeRequest
	}
	if !document.Stream {
		return "stream", errUnexpectedRealClaudeRequest
	}
	if len(document.System) == 0 ||
		document.System[0].Type != "text" ||
		document.System[0].Text != "You are Claude Code, Anthropic's official CLI for Claude." {
		return "system", errUnexpectedRealClaudeRequest
	}
	if !bytes.Contains(payload, []byte(realClaudeTransferMarker)) {
		return "marker", errUnexpectedRealClaudeRequest
	}
	return "", nil
}

// TestRealClaudeRequestBudgetBlocksExtraNetworkCalls 验证白名单观察不会修改
// 正文，且第二次 Messages 请求在委托网络传输前被拒绝。
func TestRealClaudeRequestBudgetBlocksExtraNetworkCalls(t *testing.T) {
	t.Parallel()

	wantBody := `{"model":"claude-opus-5","max_tokens":64000,"stream":true,` +
		`"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],` +
		`"messages":[{"role":"user","content":[{"type":"text","text":"AIH_REAL_CLAUDE_TRANSFER_OK"}]}]}`
	transportCalls := 0
	budget := &realClaudeRequestBudget{
		maxMessages: 1,
		client: &http.Client{Transport: realCodexRoundTripperFunc(func(
			request *http.Request,
		) (*http.Response, error) {
			transportCalls++
			payload, err := io.ReadAll(request.Body)
			if err != nil || string(payload) != wantBody {
				t.Fatalf("预算检查修改了真实请求正文: body=%q err=%v", payload, err)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("{}")),
			}, nil
		})},
	}

	first := newBudgetClaudeMessagesRequest(t, wantBody)
	response, err := budget.Do(first)
	if err != nil || response == nil {
		t.Fatalf("预算内 Claude 请求被拒绝: %v", err)
	}
	_ = response.Body.Close()
	second := newBudgetClaudeMessagesRequest(t, wantBody)
	response, err = budget.Do(second)
	if !errors.Is(err, errUnexpectedRealClaudeRequest) || response != nil {
		t.Fatalf("第二次 Claude 请求没有在本地被拒绝: response=%v err=%v", response, err)
	}
	want := realClaudeRequestCounts{messages: 1, unexpected: 1}
	if got := budget.snapshot(); got != want || transportCalls != 1 {
		t.Fatalf("真实 Claude 请求预算失效: counts=%+v transport_calls=%d", got, transportCalls)
	}
}

// newBudgetClaudeMessagesRequest 构造不触达网络的官方 OAuth Messages 请求。
func newBudgetClaudeMessagesRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	request, err := http.NewRequest(
		http.MethodPost,
		"https://api.anthropic.com/v1/messages",
		strings.NewReader(body),
	)
	if err != nil {
		t.Fatalf("构造预算测试请求失败: %v", err)
	}
	request.Header.Set("Authorization", "Bearer synthetic-budget-token")
	request.Header.Set("anthropic-version", "2023-06-01")
	request.Header.Set("anthropic-beta", "claude-code-20250219,oauth-2025-04-20")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-app", "cli")
	request.Header.Set("anthropic-dangerous-direct-browser-access", "true")
	request.Header.Set("User-Agent", "claude-cli/2.1.225 (external, sdk-cli)")
	return request
}

// TestRealClaudeSub2APITransferEndToEnd 从真实标准导出选择一个 OAuth 账号，
// 完成 Go 导入、导出、再次导入、模型目录和跨协议推理闭环。
//
// 默认跳过；显式提供文件和公开邮箱后最多产生两次目录请求与一次推理请求。
func TestRealClaudeSub2APITransferEndToEnd(t *testing.T) {
	externalDocument := readRealClaudeSub2APIDocument(t)
	defer clear(externalDocument)
	externalHash := sha256.Sum256(externalDocument)
	singleAccount := selectRealClaudeSub2APIAccount(t, externalDocument)
	defer clear(singleAccount)
	assertRealSub2APIDocument(t, singleAccount)
	assertRealClaudeCredentialFresh(t, singleAccount)

	sourceBudget := newRealClaudeRequestBudget(0)
	sourceModels := newRealClaudeModelCatalog(t, sourceBudget)
	sourceHome := newDisposableRealCodexHome(t)
	sourceURL, sourceClient := startRealCodexServer(
		t,
		sourceHome,
		sourceBudget,
		[]accountapp.ProviderModelDiscoverer{sourceModels},
	)
	sourceImported := performRequest(
		t,
		sourceClient,
		http.MethodPost,
		sourceURL+accountsapi.Sub2APIImportPath,
		testManagementKey,
		singleAccount,
	)
	assertStatus(t, sourceImported, http.StatusCreated)
	sourceRef := decodeRealTransferAccountRef(t, sourceImported.body)
	sourceExported := performRequest(
		t,
		sourceClient,
		http.MethodGet,
		sourceURL+accountsapi.CollectionPath+"/"+sourceRef+"/export",
		testManagementKey,
		nil,
	)
	assertStatus(t, sourceExported, http.StatusOK)
	assertRealSub2APIDocument(t, []byte(sourceExported.body))

	targetBudget := newRealClaudeRequestBudget(1)
	targetModels := newRealClaudeModelCatalog(t, targetBudget)
	targetHome := newDisposableRealCodexHome(t)
	targetURL, targetClient := startRealCodexServer(
		t,
		targetHome,
		targetBudget,
		[]accountapp.ProviderModelDiscoverer{targetModels},
	)
	targetImported := performRequest(
		t,
		targetClient,
		http.MethodPost,
		targetURL+accountsapi.Sub2APIImportPath,
		testManagementKey,
		[]byte(sourceExported.body),
	)
	assertStatus(t, targetImported, http.StatusCreated)
	targetRef := decodeRealTransferAccountRef(t, targetImported.body)

	models := performRequest(
		t,
		targetClient,
		http.MethodGet,
		targetURL+modelsapi.Path,
		testClientKey,
		nil,
	)
	assertStatus(t, models, http.StatusOK)
	modelCount := assertRealClaudeModelAvailable(t, models.body)

	inferencePayload := marshalRealCodexPayload(t, map[string]any{
		"model": realClaudeTransferModel,
		"input": "Reply with exactly: " + realClaudeTransferMarker,
	}, false)
	inferenceResponse := performRequest(
		t,
		targetClient,
		http.MethodPost,
		targetURL+openairesponsesapi.Path,
		testClientKey,
		inferencePayload,
	)
	clear(inferencePayload)
	if inferenceResponse.status != http.StatusOK {
		t.Fatalf(
			"真实 Claude Responses 失败: status=%d target_budget=%+v rejection=%s response_code=%s",
			inferenceResponse.status,
			targetBudget.snapshot(),
			targetBudget.rejection(),
			safeErrorCode(inferenceResponse.body),
		)
	}
	assertRealClaudeTransferResponse(t, inferenceResponse.body)

	reexported := performRequest(
		t,
		targetClient,
		http.MethodGet,
		targetURL+accountsapi.CollectionPath+"/"+targetRef+"/export",
		testManagementKey,
		nil,
	)
	assertStatus(t, reexported, http.StatusOK)
	assertRealSub2APIDocument(t, []byte(reexported.body))
	if sha256.Sum256(externalDocument) != externalHash {
		t.Fatal("外部标准导出文档在闭环期间发生变化")
	}

	wantSource := realClaudeRequestCounts{models: 1}
	if got := sourceBudget.snapshot(); got != wantSource {
		t.Fatalf("源 Server 真实请求预算错误: got=%+v want=%+v", got, wantSource)
	}
	wantTarget := realClaudeRequestCounts{models: 1, messages: 1}
	if got := targetBudget.snapshot(); got != wantTarget {
		t.Fatalf("目标 Server 真实请求预算错误: got=%+v want=%+v", got, wantTarget)
	}

	t.Logf(
		strings.Join([]string{
			"真实 Claude sub2api 迁移验收通过",
			"external_document: path=<redacted> mode=0600 selected_by_email=true local_identity_fields=false",
			"source_import: POST %s payload=<selected-standard-account> status=%d",
			"source_export: GET %s/v1/management/accounts/{account_ref}/export status=%d version=1",
			"target_import: POST %s payload=<source-go-export> status=%d",
			"models: GET %s status=%d count=%d contains_%s=true",
			"inference: POST %s payload={model:%s,input:<fixed-marker>,stream:false} status=%d response={object:response,status:completed,marker_present:true}",
			"target_reexport: GET %s/v1/management/accounts/{account_ref}/export status=%d version=1",
			"upstream_requests: source_models=1 target_models=1 target_messages=1 unexpected=0",
			"temporary_databases=2 cleanup=registered formal_database_mutations=0",
		}, "\n"),
		sourceURL+accountsapi.Sub2APIImportPath,
		sourceImported.status,
		sourceURL,
		sourceExported.status,
		targetURL+accountsapi.Sub2APIImportPath,
		targetImported.status,
		targetURL+modelsapi.Path,
		models.status,
		modelCount,
		realClaudeTransferModel,
		targetURL+openairesponsesapi.Path,
		realClaudeTransferModel,
		inferenceResponse.status,
		targetURL,
		reexported.status,
	)
}

// newRealClaudeModelCatalog 创建只复用同一白名单 HTTP 边界的真实目录源。
func newRealClaudeModelCatalog(
	t *testing.T,
	client *realClaudeRequestBudget,
) *claudemessages.ModelCatalogSource {
	t.Helper()
	source, err := claudemessages.NewModelCatalogSource(client)
	if err != nil {
		t.Fatalf("创建真实 Claude 模型目录源失败: %v", err)
	}
	return source
}

// readRealClaudeSub2APIDocument 有界读取显式文件并强制私有权限。
func readRealClaudeSub2APIDocument(t *testing.T) []byte {
	t.Helper()
	path := strings.TrimSpace(os.Getenv(realClaudeSub2APIFileEnv))
	email := strings.TrimSpace(os.Getenv(realClaudeSub2APIEmailEnv))
	if path == "" || email == "" {
		t.Skip("设置 AIH_REAL_CLAUDE_SUB2API_FILE 与 AIH_REAL_CLAUDE_SUB2API_EMAIL 后才允许真实迁移请求")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 ||
		info.Size() <= 0 || info.Size() > realClaudeTransferMaxFileBytes {
		t.Fatalf("真实 Claude 标准文档必须是 0600 的有界普通文件: %v", err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("打开真实 Claude 标准文档失败: %v", err)
	}
	defer func() { _ = file.Close() }()
	payload, err := io.ReadAll(io.LimitReader(file, realClaudeTransferMaxFileBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > realClaudeTransferMaxFileBytes {
		clear(payload)
		t.Fatalf("读取真实 Claude 标准文档失败: %v", err)
	}
	return payload
}

// selectRealClaudeSub2APIAccount 按公开邮箱选择一个账号，并保留标准顶层字段。
func selectRealClaudeSub2APIAccount(t *testing.T, payload []byte) []byte {
	t.Helper()
	var document struct {
		Type           string            `json:"type"`
		Version        int               `json:"version"`
		ExportedAt     string            `json:"exported_at"`
		Proxies        []json.RawMessage `json:"proxies"`
		Accounts       []json.RawMessage `json:"accounts"`
		SkippedShadows int               `json:"skipped_shadows,omitempty"`
	}
	if json.Unmarshal(payload, &document) != nil ||
		document.Type != "sub2api-data" ||
		document.Version != 1 ||
		len(document.Proxies) != 0 {
		t.Fatal("真实 Claude 标准文档顶层结构无效")
	}
	expectedEmail := strings.TrimSpace(os.Getenv(realClaudeSub2APIEmailEnv))
	var selected json.RawMessage
	for _, account := range document.Accounts {
		var summary struct {
			Platform    string `json:"platform"`
			Type        string `json:"type"`
			Credentials struct {
				Email             string `json:"email"`
				EmailAddressSnake string `json:"email_address"`
				EmailAddressCamel string `json:"emailAddress"`
				Account           struct {
					Email             string `json:"email"`
					EmailAddressSnake string `json:"email_address"`
					EmailAddressCamel string `json:"emailAddress"`
				} `json:"account"`
			} `json:"credentials"`
		}
		if json.Unmarshal(account, &summary) != nil ||
			summary.Platform != "anthropic" ||
			summary.Type != "oauth" {
			continue
		}
		candidate := firstNonEmpty(
			summary.Credentials.Email,
			summary.Credentials.EmailAddressSnake,
			summary.Credentials.EmailAddressCamel,
			summary.Credentials.Account.Email,
			summary.Credentials.Account.EmailAddressSnake,
			summary.Credentials.Account.EmailAddressCamel,
		)
		if strings.EqualFold(candidate, expectedEmail) {
			if selected != nil {
				t.Fatal("真实 Claude 标准文档包含重复公开身份")
			}
			selected = append(json.RawMessage(nil), account...)
		}
	}
	if selected == nil {
		t.Fatal("真实 Claude 标准文档没有匹配的 OAuth 公开身份")
	}
	document.Accounts = []json.RawMessage{selected}
	document.SkippedShadows = 0
	encoded, err := json.Marshal(document)
	clear(selected)
	if err != nil {
		t.Fatalf("编码单账号标准文档失败: %v", err)
	}
	return encoded
}

// firstNonEmpty 返回标准文档中第一个非空公开字段。
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// assertRealClaudeCredentialFresh 在任何网络请求前拒绝过期或临期标准文档。
func assertRealClaudeCredentialFresh(t *testing.T, payload []byte) {
	t.Helper()
	credential, _, err := sub2api.NewDecoder().DecodeAccount(payload)
	if err != nil {
		t.Fatalf("真实 Claude 标准账号无法由正式 Decoder 解析: %v", err)
	}
	oauth, valid := credential.(*claudeauth.OAuthAuth)
	if !valid || oauth == nil || oauth.ExpiresAtMS() <= 0 {
		t.Fatal("真实 Claude 标准账号不是可刷新的 OAuth")
	}
	expiresAt := time.UnixMilli(oauth.ExpiresAtMS())
	if expiresAt.Sub(time.Now()) <= accountcredentials.DefaultRefreshSkew {
		t.Fatalf("真实 Claude OAuth 已进入提前刷新窗口: expires_at=%s", expiresAt.UTC().Format(time.RFC3339))
	}
}

// assertRealClaudeModelAvailable 验证物化目录包含本次明确选择的模型。
func assertRealClaudeModelAvailable(t *testing.T, body string) int {
	t.Helper()
	var document struct {
		Object string `json:"object"`
		Data   []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	decodeJSON(t, body, &document)
	if document.Object != "list" || len(document.Data) == 0 {
		t.Fatalf("真实 Claude 本地模型目录无效: object=%q count=%d", document.Object, len(document.Data))
	}
	for _, model := range document.Data {
		if model.ID == realClaudeTransferModel {
			return len(document.Data)
		}
	}
	t.Fatalf("真实 Claude 账号目录不包含 %s", realClaudeTransferModel)
	return 0
}

// assertRealClaudeTransferResponse 校验 Responses 生命周期、模型、usage 和固定标记。
func assertRealClaudeTransferResponse(t *testing.T, body string) {
	t.Helper()
	var document struct {
		ID     string          `json:"id"`
		Object string          `json:"object"`
		Status string          `json:"status"`
		Model  string          `json:"model"`
		Output json.RawMessage `json:"output"`
		Usage  json.RawMessage `json:"usage"`
	}
	if json.Unmarshal([]byte(body), &document) != nil ||
		document.ID == "" ||
		document.Object != "response" ||
		document.Status != "completed" ||
		document.Model != realClaudeTransferModel ||
		len(document.Output) == 0 ||
		len(document.Usage) == 0 ||
		!strings.Contains(body, realClaudeTransferMarker) {
		t.Fatalf(
			"真实 Claude Responses 结果异常: id=%t object=%q status=%q model=%q output=%t usage=%t marker=%t",
			document.ID != "",
			document.Object,
			document.Status,
			document.Model,
			len(document.Output) > 0,
			len(document.Usage) > 0,
			strings.Contains(body, realClaudeTransferMarker),
		)
	}
}
