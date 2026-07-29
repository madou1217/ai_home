package responses

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	// codexReferenceBinaryEnv 显式选择用于本地合同抓取的官方 Codex 二进制。
	codexReferenceBinaryEnv = "AIH_CODEX_REFERENCE_BIN"
	// codexReferenceModelCacheEnv 显式选择与二进制配套的非敏感模型清单。
	codexReferenceModelCacheEnv = "AIH_CODEX_REFERENCE_MODEL_CACHE"
	// maxCodexReferenceRequestBytes 限制本地假上游接收的请求大小。
	maxCodexReferenceRequestBytes = 4 << 20
)

// TestCodexReferenceRequestContract 让官方 Codex 只访问本地假上游，
// 对比其真实请求结构与 Go Adapter；不使用真实凭据或外部网络。
func TestCodexReferenceRequestContract(t *testing.T) {
	binary := os.Getenv(codexReferenceBinaryEnv)
	modelCache := os.Getenv(codexReferenceModelCacheEnv)
	if binary == "" || modelCache == "" {
		t.Skip("设置官方 Codex 二进制和模型缓存后才运行参考合同测试")
	}

	cache := readCodexReferenceModelCache(t, modelCache)
	defer clear(cache)
	codexHome := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(codexHome, "models_cache.json"),
		cache,
		0o600,
	); err != nil {
		t.Fatalf("写入临时模型缓存失败: %v", err)
	}

	requests := make(chan codexReferenceRequest, 1)
	server := httptest.NewServer(codexReferenceHandler(t, requests))
	defer server.Close()

	runCodexReferenceCLI(t, binary, codexHome, server.URL)
	reference := receiveCodexReferenceRequest(t, requests)
	defer clear(reference.body)
	official := fingerprintCodexReferenceRequest(t, reference)
	adapter := fingerprintAdapterReferenceRequest(t)
	if official.verbosity != adapter.verbosity ||
		official.verbosity != "low" {
		t.Fatalf(
			"官方与 Adapter 的 verbosity 不一致: official=%q adapter=%q",
			official.verbosity,
			adapter.verbosity,
		)
	}
	t.Logf(
		"codex_reference_contract official=%s adapter=%s top_only_official=%v top_only_adapter=%v input_only_official=%v input_only_adapter=%v",
		official.summary(),
		adapter.summary(),
		stringDifference(official.topLevel, adapter.topLevel),
		stringDifference(adapter.topLevel, official.topLevel),
		stringDifference(official.inputKinds, adapter.inputKinds),
		stringDifference(adapter.inputKinds, official.inputKinds),
	)
}

// codexReferenceRequest 是本地假上游收到的单个有界请求。
type codexReferenceRequest struct {
	body        []byte
	headerNames []string
}

// codexReferenceHandler 只接受 Responses POST，并返回最小成功 SSE。
func codexReferenceHandler(
	t *testing.T,
	requests chan<- codexReferenceRequest,
) http.Handler {
	t.Helper()

	return http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodPost ||
			!strings.HasSuffix(request.URL.Path, "/responses") {
			http.NotFound(response, request)
			return
		}
		body, err := io.ReadAll(io.LimitReader(
			request.Body,
			maxCodexReferenceRequestBytes+1,
		))
		if err != nil || len(body) > maxCodexReferenceRequestBytes {
			http.Error(response, "invalid local reference request", http.StatusBadRequest)
			return
		}
		select {
		case requests <- codexReferenceRequest{
			body:        body,
			headerNames: safeCodexReferenceHeaderNames(request.Header),
		}:
		default:
			clear(body)
		}
		response.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(response, codexReferenceSuccessSSE())
	})
}

// safeCodexReferenceHeaderNames 只保留字段名并移除认证头。
func safeCodexReferenceHeaderNames(header http.Header) []string {
	names := make([]string, 0, len(header))
	for name := range header {
		if strings.EqualFold(name, "Authorization") {
			continue
		}
		names = append(names, strings.ToLower(name))
	}
	sort.Strings(names)
	return names
}

// runCodexReferenceCLI 禁止官方进程通过代理访问任何外部地址。
func runCodexReferenceCLI(
	t *testing.T,
	binary string,
	codexHome string,
	serverURL string,
) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	provider := `model_providers.aih_reference={name="OpenAI",base_url="` +
		serverURL +
		`/v1",env_key="AIH_REFERENCE_API_KEY",wire_api="responses",request_max_retries=0,stream_max_retries=0}`
	command := exec.CommandContext(
		ctx,
		binary,
		"exec",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"--skip-git-repo-check",
		"--color",
		"never",
		"-m",
		realCodexSmokeModel,
		"-c",
		`model_provider="aih_reference"`,
		"-c",
		provider,
		realCodexSmokePrompt,
	)
	command.Dir = t.TempDir()
	command.Env = []string{
		"AIH_REFERENCE_API_KEY=local-reference-only",
		"CODEX_HOME=" + codexHome,
		"HTTPS_PROXY=http://127.0.0.1:1",
		"HTTP_PROXY=http://127.0.0.1:1",
		"ALL_PROXY=http://127.0.0.1:1",
		"NO_PROXY=127.0.0.1,localhost",
		"PATH=" + os.Getenv("PATH"),
		"TMPDIR=" + os.TempDir(),
		"LANG=C.UTF-8",
	}
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		t.Fatalf("官方 Codex 本地参考调用失败: %T", err)
	}
}

// readCodexReferenceModelCache 有界读取本机非敏感模型元数据。
func readCodexReferenceModelCache(
	t *testing.T,
	path string,
) []byte {
	t.Helper()

	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("打开 Codex 模型缓存失败: %v", err)
	}
	defer func() {
		_ = file.Close()
	}()
	data, err := io.ReadAll(io.LimitReader(
		file,
		maxCodexReferenceRequestBytes+1,
	))
	if err != nil || len(data) > maxCodexReferenceRequestBytes {
		t.Fatal("Codex 模型缓存无效或超限")
	}
	return data
}

// receiveCodexReferenceRequest 等待本地唯一请求。
func receiveCodexReferenceRequest(
	t *testing.T,
	requests <-chan codexReferenceRequest,
) codexReferenceRequest {
	t.Helper()

	select {
	case request := <-requests:
		return request
	case <-time.After(2 * time.Second):
		t.Fatal("官方 Codex 没有向本地假上游发送请求")
		return codexReferenceRequest{}
	}
}

// codexRequestFingerprint 只描述字段和输入项类型，不保存文本值。
type codexRequestFingerprint struct {
	topLevel   []string
	inputKinds []string
	headers    []string
	verbosity  string
}

// summary 返回稳定的低敏结构摘要。
func (fingerprint codexRequestFingerprint) summary() string {
	return "top=" + strings.Join(fingerprint.topLevel, ",") +
		";input=" + strings.Join(fingerprint.inputKinds, ",") +
		";headers=" + strings.Join(fingerprint.headers, ",") +
		";verbosity=" + fingerprint.verbosity
}

// fingerprintCodexReferenceRequest 解析官方 CLI 的本地请求。
func fingerprintCodexReferenceRequest(
	t *testing.T,
	request codexReferenceRequest,
) codexRequestFingerprint {
	t.Helper()

	return fingerprintCodexRequestBody(
		t,
		request.body,
		request.headerNames,
	)
}

// fingerprintAdapterReferenceRequest 生成同等最小 Canonical 请求。
func fingerprintAdapterReferenceRequest(
	t *testing.T,
) codexRequestFingerprint {
	t.Helper()

	request := newRealCodexRequest(t)
	payload, err := encodeRequest(
		request,
		realCodexSmokeModel,
		codexauth.AuthKindOAuth,
		requestProfileForModel(realCodexSmokeModel),
	)
	if err != nil {
		t.Fatalf("编码 Go Adapter 参考请求失败: %v", err)
	}
	defer clear(payload)
	return fingerprintCodexRequestBody(t, payload, nil)
}

// fingerprintCodexRequestBody 只提取顶层键和 input 的 type/role。
func fingerprintCodexRequestBody(
	t *testing.T,
	payload []byte,
	headers []string,
) codexRequestFingerprint {
	t.Helper()

	var document map[string]json.RawMessage
	if json.Unmarshal(payload, &document) != nil {
		t.Fatal("参考请求不是有效 JSON 对象")
	}
	topLevel := make([]string, 0, len(document))
	for key := range document {
		topLevel = append(topLevel, key)
	}
	sort.Strings(topLevel)

	var input []struct {
		Type string `json:"type"`
		Role string `json:"role"`
	}
	if json.Unmarshal(document["input"], &input) != nil {
		t.Fatal("参考请求 input 无效")
	}
	inputKinds := make([]string, 0, len(input))
	for _, item := range input {
		inputKinds = append(
			inputKinds,
			item.Type+":"+item.Role,
		)
	}
	var textControl struct {
		Verbosity string `json:"verbosity"`
	}
	if rawText, found := document["text"]; found &&
		json.Unmarshal(rawText, &textControl) != nil {
		t.Fatal("参考请求 text 无效")
	}
	return codexRequestFingerprint{
		topLevel:   topLevel,
		inputKinds: inputKinds,
		headers:    append([]string(nil), headers...),
		verbosity:  textControl.Verbosity,
	}
}

// stringDifference 返回 left 中未出现在 right 的有序元素。
func stringDifference(left []string, right []string) []string {
	present := make(map[string]struct{}, len(right))
	for _, value := range right {
		present[value] = struct{}{}
	}
	difference := make([]string, 0)
	for _, value := range left {
		if _, found := present[value]; !found {
			difference = append(difference, value)
		}
	}
	return difference
}

// codexReferenceSuccessSSE 让官方 CLI 在捕获请求后正常结束。
func codexReferenceSuccessSSE() string {
	return strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_reference","status":"in_progress"}}`,
		"",
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","item":{"id":"msg_reference","type":"message","role":"assistant","content":[{"type":"output_text","text":"AIH_REFERENCE_OK"}]}}`,
		"",
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_reference","status":"completed","output":[],"usage":{"input_tokens":1,"input_tokens_details":{"cached_tokens":0},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":2}}}`,
		"",
		"",
	}, "\n")
}
