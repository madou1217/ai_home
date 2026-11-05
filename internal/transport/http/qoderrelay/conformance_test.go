package qoderrelay

// 本文件是 qoder relay 的协议契约测试（conformance）：用 httptest 假上游把
// RewriteRequest → Endpoint/DecorateUpstream → 真发 HTTP → TransformResponse 整条链路跑通，
// 同时断言「上游收到了什么」与「客户端拿到了什么」。
//
// 为什么需要这一层：真机链路被 Free 账号的 500 卡住、通道又尚未接线，签名 / zstd 压缩 /
// 信封拆包任何一处偏差都只能等真机复现；而真机调用有风控与额度成本。这里用零成本的假上游
// 把「协议形状」固定下来：签名覆盖的内容必须等于实际压缩发送的内容，上游错误必须透出而不是
// 被洗成一次成功的空回答。

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
	"github.com/madou1217/ai_home/internal/adapters/qoder/modelcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const (
	// conformanceProviderID 是本用例覆盖的 Provider 分支。
	conformanceProviderID = QoderProviderID
	// conformanceModel 是客户端点名的模型（目录里按 display_name 命中）。
	conformanceModel = "Qwen3.8-Flash"
	// conformanceModelKey 是目录条目的 key，wasm 签名用的是它而不是 display_name。
	conformanceModelKey = "qfmodel"
	// conformancePrompt 是请求正文；假上游会在 BuildBody 产物里核对它，证明改写没丢对话。
	conformancePrompt = "ping conformance"
	// conformancePath / conformanceQuery 与 Node 侧推理路径同形：wasm 产出的 URL 必须原样发出。
	conformancePath  = "/algo/api/v2/service/pro/sse/agent_chat_generation"
	conformanceQuery = "Encode=1"
	// conformanceInferenceHost 是 qoder 的**推理**主机。账号面的 openapi.qoder.sh 用错会 500。
	conformanceInferenceHost = "https://api3.qoder.sh"
	// conformanceChunkID 是上游 chunk 的 id，拆信封后必须逐帧保留。
	conformanceChunkID = "chatcmpl-conformance"

	conformanceMachineToken = "conformance-machine-token-88-chars"
	conformanceMachineType  = "MacOS"
)

// conformanceSigner 模拟 wasm 签名运行时。
//
// 关键约定：X-Conformance-Signature 是**明文** body 的 sha256，假上游会自己重算一遍，
// 于是「签名时看到的内容」与「实际压缩发送的内容」必须逐字节一致——Provider 若在签名后
// 又改了 body（或压错了对象），上游会直接拒绝。
type conformanceSigner struct {
	baseURL  string
	endpoint string
	bodyJSON string
	modelKey string
	contexts int
}

func (signer *conformanceSigner) NewContext(context.Context, string, string, string) (uint32, error) {
	signer.contexts++
	return 7, nil
}

func (signer *conformanceSigner) PrepareInferRequest(
	_ context.Context, _ uint32, endpoint, bodyJSON, modelKey, _ string,
) (qodercred.PreparedRequest, error) {
	signer.endpoint = endpoint
	signer.bodyJSON = bodyJSON
	signer.modelKey = modelKey
	digest := sha256.Sum256([]byte(bodyJSON))
	return qodercred.PreparedRequest{
		URL: signer.baseURL + conformancePath + "?" + conformanceQuery,
		Headers: map[string]string{
			"Authorization":           "Bearer conformance-token",
			"Cosy-Version":            "1.1.81",
			"X-Conformance-Signature": hex.EncodeToString(digest[:]),
			"X-Conformance-Model-Key": modelKey,
			// wasm 也会给 Host / Content-Length；Provider 必须跳过它们，
			// 否则真实客户端会发出与连接不符的 Host 或错误的长度。
			"Host":           "api3.qoder.sh",
			"Content-Length": "1",
		},
		Body: "ENCODED:" + bodyJSON,
	}, nil
}

func (*conformanceSigner) FreeContext(uint32) {}

// upstreamProbe 记录假上游收到的请求，并在**服务端 goroutine** 里做校验。
//
// 校验错误不能直接 t.Fatalf（那只能在测试 goroutine 调用），所以先攒进 failures，
// 由测试 goroutine 在链路结束后一次性断言。
type upstreamProbe struct {
	mu            sync.Mutex
	failures      []string
	requests      int
	method        string
	path          string
	query         string
	headers       http.Header
	contentLength int64
	decoded       []byte
}

// inspect 校验请求形状，并返回 zstd 解压后的 body。
func (probe *upstreamProbe) inspect(request *http.Request) ([]byte, bool) {
	var problems []string
	fail := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }

	if request.Method != http.MethodPost {
		fail("method = %q, want POST", request.Method)
	}
	if got := request.URL.Path; got != conformancePath {
		fail("path = %q, want %q（签名 URL 必须原样发出）", got, conformancePath)
	}
	if got := request.URL.RawQuery; got != conformanceQuery {
		fail("query = %q, want %q", got, conformanceQuery)
	}
	if got := request.Header.Get("Content-Encoding"); got != "zstd" {
		fail("Content-Encoding = %q, want zstd", got)
	}
	if got := request.Header.Get("Authorization"); got != "Bearer conformance-token" {
		fail("Authorization = %q，签名头未透传", got)
	}
	if got := request.Header.Get("Cosy-Version"); got != "1.1.81" {
		fail("Cosy-Version = %q，签名头未透传", got)
	}
	if got := request.Header.Get("X-Conformance-Model-Key"); got != conformanceModelKey {
		fail("X-Conformance-Model-Key = %q, want %q（wasm 应拿到目录 key）", got, conformanceModelKey)
	}
	if got := request.Header.Get("Accept"); got != "text/event-stream" {
		fail("Accept = %q, want text/event-stream", got)
	}
	if got := request.Header.Get("Content-Type"); got != "application/json" {
		fail("Content-Type = %q, want application/json", got)
	}
	// 设备令牌缺失时上游会直接 500（2026-11-05 实测），必须来自 umid 缓存而不是 wasm 占位。
	if got := request.Header.Get("Cosy-MachineToken"); got != conformanceMachineToken {
		fail("Cosy-MachineToken = %q，未使用 umid 缓存里的真实令牌", got)
	}
	if got := request.Header.Get("Cosy-MachineType"); got != conformanceMachineType {
		fail("Cosy-MachineType = %q, want %q", got, conformanceMachineType)
	}

	body, err := io.ReadAll(io.LimitReader(request.Body, 16<<20))
	if err != nil {
		fail("读取请求体失败: %v", err)
	}
	if request.ContentLength != int64(len(body)) {
		fail("Content-Length = %d, 实际压缩体长度 = %d（必须按压缩体重算）", request.ContentLength, len(body))
	}

	var decoded []byte
	if len(body) > 0 {
		decoded, err = decodeZstdBody(body)
		if err != nil {
			fail("zstd 解压失败: %v", err)
		}
	}
	if decoded != nil {
		plain, ok := bytes.CutPrefix(decoded, []byte("ENCODED:"))
		if !ok {
			fail("压缩体不是 wasm 编码后的形态: %.64q", decoded)
		} else {
			digest := sha256.Sum256(plain)
			if got := request.Header.Get("X-Conformance-Signature"); got != hex.EncodeToString(digest[:]) {
				fail("签名与压缩体不一致：签的是另一份内容")
			}
			var built map[string]any
			if err := json.Unmarshal(plain, &built); err != nil {
				fail("BuildBody 产物不是 JSON: %v", err)
			} else {
				if key := nestedString(built, "model_config", "key"); key != conformanceModelKey {
					fail("model_config.key = %q, want %q", key, conformanceModelKey)
				}
				if text := nestedString(built, "chat_context", "text"); text != conformancePrompt {
					fail("chat_context.text = %q, want %q", text, conformancePrompt)
				}
			}
		}
	}

	probe.mu.Lock()
	probe.requests++
	probe.method = request.Method
	probe.path = request.URL.Path
	probe.query = request.URL.RawQuery
	probe.headers = request.Header.Clone()
	probe.contentLength = request.ContentLength
	probe.decoded = decoded
	if len(problems) > 0 {
		probe.failures = append(probe.failures, problems...)
	}
	probe.mu.Unlock()
	return decoded, len(problems) == 0
}

// assertClean 断言假上游接受了这次请求，且只收到一次。
func (probe *upstreamProbe) assertClean(t *testing.T) {
	t.Helper()
	probe.mu.Lock()
	defer probe.mu.Unlock()
	if len(probe.failures) > 0 {
		t.Fatalf("假上游拒绝了请求（%d 条）: %s", len(probe.failures), strings.Join(probe.failures, " | "))
	}
	if probe.requests != 1 {
		t.Fatalf("上游请求数 = %d, want 1", probe.requests)
	}
}

// conformanceSetup 是一次契约用例的装配结果。
type conformanceSetup struct {
	provider *Provider
	probe    *upstreamProbe
	signer   *conformanceSigner
}

// newConformanceSetup 装配：隔离的客户端家目录、假上游、假签名运行时、请求级 Provider。
func newConformanceSetup(t *testing.T, status int, frames []byte) *conformanceSetup {
	t.Helper()
	// 用临时家目录隔离 umid / 端点缓存：既不读开发机真实客户端状态，也能稳定复现
	// 「必须带真实设备令牌」这条上游要求。
	home := t.TempDir()
	writeConformanceUMIDCache(t, home)
	t.Setenv("AIH_HOST_HOME", home)

	probe := &upstreamProbe{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if _, ok := probe.inspect(request); !ok {
			http.Error(writer, "conformance: 假上游拒绝了请求", http.StatusBadRequest)
			return
		}
		contentType := "application/json"
		if status >= http.StatusOK && status < http.StatusMultipleChoices {
			contentType = "text/event-stream"
		}
		writer.Header().Set("Content-Type", contentType)
		writer.WriteHeader(status)
		_, _ = writer.Write(frames)
	}))
	t.Cleanup(server.Close)

	signer := &conformanceSigner{baseURL: server.URL}
	installConformanceFakes(t, signer)

	resolved, ok := NewProvider().Resolve(relaycore.ResolveInput{
		ProviderID: conformanceProviderID,
		Credential: nativeCredential(t, conformanceProviderID),
	})
	if !ok {
		t.Fatalf("Resolve(%q) 未认领", conformanceProviderID)
	}
	provider, ok := resolved.(*Provider)
	if !ok {
		t.Fatalf("Resolve 返回类型 %T, want *Provider", resolved)
	}
	return &conformanceSetup{provider: provider, probe: probe, signer: signer}
}

// run 走 Provider 暴露给 Handler 的四个扩展点，并真发一次 HTTP。
func (setup *conformanceSetup) run(t *testing.T) *http.Response {
	t.Helper()
	rewritten, err := setup.provider.RewriteRequest(conformanceRequestPayload())
	if err != nil {
		t.Fatalf("RewriteRequest() error = %v", err)
	}
	endpoint, ok := setup.provider.Endpoint()
	if !ok {
		t.Fatal("Endpoint() 未给出 URL")
	}
	if endpoint != setup.signer.baseURL+conformancePath+"?"+conformanceQuery {
		t.Fatalf("Endpoint() = %q, want wasm 签出的完整 URL", endpoint)
	}

	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(rewritten.Body))
	if err != nil {
		t.Fatalf("构造上游请求失败: %v", err)
	}
	setup.provider.DecorateUpstream(request, "")
	if got := request.Header.Get("Content-Encoding"); got != "zstd" {
		t.Fatalf("Content-Encoding = %q, want zstd", got)
	}
	// wasm 的 Host 头不能出现在 Header 里：Go 用 URL 决定 Host，复制过去等于伪造主机。
	if got := request.Header.Get("Host"); got != "" {
		t.Fatalf("DecorateUpstream 复制了 Host 头: %q", got)
	}
	if got := request.Header.Get("Content-Length"); got != "" {
		t.Fatalf("DecorateUpstream 复制了 Content-Length 头: %q", got)
	}
	if request.ContentLength != int64(len(rewritten.Body)) {
		t.Fatalf("ContentLength = %d, want 压缩体长度 %d", request.ContentLength, len(rewritten.Body))
	}

	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("上游请求失败: %v", err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	return response
}

// assertUpstreamContract 断言签名运行时收到的入参。
func (setup *conformanceSetup) assertUpstreamContract(t *testing.T) {
	t.Helper()
	setup.probe.assertClean(t)
	if setup.signer.contexts != 1 {
		t.Fatalf("NewContext 调用 = %d, want 1（每次尝试一个新上下文）", setup.signer.contexts)
	}
	if setup.signer.modelKey != conformanceModelKey {
		t.Fatalf("wasm 收到的 modelKey = %q, want %q", setup.signer.modelKey, conformanceModelKey)
	}
	if setup.signer.endpoint != conformanceInferenceHost {
		t.Fatalf("wasm 收到的端点 = %q, want %q（账号面主机会被上游 500）", setup.signer.endpoint, conformanceInferenceHost)
	}
}

func TestConformanceStreamingRoundTrip(t *testing.T) {
	setup := newConformanceSetup(t, http.StatusOK, conformanceSuccessStream(t))
	response := setup.run(t)
	setup.assertUpstreamContract(t)

	recorder := httptest.NewRecorder()
	handled, err := setup.provider.TransformResponse(recorder, response, true)
	if !handled {
		t.Fatal("TransformResponse(stream) 未接管")
	}
	if err != nil {
		t.Fatalf("TransformResponse(stream) error = %v", err)
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("客户端状态码 = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "text/event-stream; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	// 流式响应必须去掉长度，否则中间层会攒满整个响应再发，逐帧刷新失效。
	if got := recorder.Header().Get("Content-Length"); got != "" {
		t.Fatalf("流式响应仍带 Content-Length = %q", got)
	}

	body := recorder.Body.String()
	frames := conformanceClientFrames(t, body)
	if len(frames) != 5 {
		t.Fatalf("客户端帧数 = %d, want 4 个 chunk + [DONE]: %q", len(frames), frames)
	}
	if frames[len(frames)-1] != "[DONE]" {
		t.Fatalf("最后一帧 = %q, want [DONE]", frames[len(frames)-1])
	}

	content := strings.Builder{}
	finishReason := ""
	for index, frame := range frames[:len(frames)-1] {
		var chunk struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			Model   string `json:"model"`
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(frame), &chunk); err != nil {
			t.Fatalf("第 %d 帧不是合法 JSON chunk: %v (%q)", index, err, frame)
		}
		if chunk.Object != "chat.completion.chunk" {
			t.Fatalf("第 %d 帧 object = %q, want chat.completion.chunk", index, chunk.Object)
		}
		// 上游 chunk 里是内部模型名；客户端认定的是自己点名的模型，必须对齐。
		if chunk.Model != conformanceModel {
			t.Fatalf("第 %d 帧 model = %q, want %q", index, chunk.Model, conformanceModel)
		}
		if chunk.ID != conformanceChunkID {
			t.Fatalf("第 %d 帧 id = %q, want %q", index, chunk.ID, conformanceChunkID)
		}
		for _, choice := range chunk.Choices {
			content.WriteString(choice.Delta.Content)
			if choice.FinishReason != nil {
				finishReason = *choice.FinishReason
			}
		}
	}
	if got := content.String(); got != "Hello, world" {
		t.Fatalf("拼出的正文 = %q, want %q", got, "Hello, world")
	}
	if finishReason != "stop" {
		t.Fatalf("finish_reason = %q, want stop", finishReason)
	}

	// 信封元数据与计时帧都不该出现在客户端可见的流里。
	for _, leaked := range []string{"statusCodeValue", "statusCode", "firstTokenDuration", "x-request-id"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("信封字段 %q 泄漏到客户端流: %s", leaked, body)
		}
	}
}

func TestConformanceNonStreamAggregation(t *testing.T) {
	setup := newConformanceSetup(t, http.StatusOK, conformanceSuccessStream(t))
	response := setup.run(t)
	setup.assertUpstreamContract(t)

	recorder := httptest.NewRecorder()
	handled, err := setup.provider.TransformResponse(recorder, response, false)
	if !handled {
		t.Fatal("TransformResponse(aggregate) 未接管")
	}
	if err != nil {
		t.Fatalf("TransformResponse(aggregate) error = %v", err)
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("客户端状态码 = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	body := recorder.Body.String()
	if strings.Contains(body, "data:") {
		t.Fatalf("非流式响应仍是 SSE 原文: %s", body)
	}

	var completion struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &completion); err != nil {
		t.Fatalf("聚合结果不是合法 JSON: %v (%s)", err, body)
	}
	if completion.Object != "chat.completion" {
		t.Fatalf("object = %q, want chat.completion", completion.Object)
	}
	if completion.ID != conformanceChunkID {
		t.Fatalf("id = %q, want %q（聚合不得改写上游 id）", completion.ID, conformanceChunkID)
	}
	if completion.Model != conformanceModel {
		t.Fatalf("model = %q, want %q", completion.Model, conformanceModel)
	}
	if len(completion.Choices) != 1 {
		t.Fatalf("choices 数 = %d, want 1", len(completion.Choices))
	}
	choice := completion.Choices[0]
	if choice.Message.Role != "assistant" || choice.Message.Content != "Hello, world" {
		t.Fatalf("message = %q/%q", choice.Message.Role, choice.Message.Content)
	}
	if choice.FinishReason != "stop" {
		t.Fatalf("finish_reason = %q, want stop", choice.FinishReason)
	}
}

func TestConformanceUpstreamErrorEnvelope(t *testing.T) {
	partialChunk := `{"id":"` + conformanceChunkID + `","object":"chat.completion.chunk","model":"qwen3-internal","choices":[{"index":0,"delta":{"content":"partial"}}]}`
	cases := []struct {
		name        string
		frames      []byte
		wantStatus  int
		wantCode    string
		wantMessage string
	}{
		{
			name: "状态信封 529",
			frames: []byte(
				conformanceEnvelope(t, map[string]any{"body": partialChunk, "statusCodeValue": 200}) +
					conformanceEnvelope(t, map[string]any{
						"body":            `{"error":{"code":"RESOURCE_LIMIT","message":"queue full"}}`,
						"statusCodeValue": 529,
					}) +
					"data: [DONE]\n\n",
			),
			wantStatus:  529,
			wantCode:    "RESOURCE_LIMIT",
			wantMessage: "queue full",
		},
		{
			name: "200 信封内嵌 error",
			frames: []byte(conformanceEnvelope(t, map[string]any{
				"statusCodeValue": 200,
				"error":           map[string]string{"code": "AUTH", "message": "denied"},
			}) + "data: [DONE]\n\n"),
			wantStatus:  200,
			wantCode:    "AUTH",
			wantMessage: "denied",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name+"/stream", func(t *testing.T) {
			setup := newConformanceSetup(t, http.StatusOK, testCase.frames)
			response := setup.run(t)
			setup.assertUpstreamContract(t)

			recorder := httptest.NewRecorder()
			handled, err := setup.provider.TransformResponse(recorder, response, true)
			if !handled {
				t.Fatal("TransformResponse(stream) 未接管")
			}
			assertStreamError(t, err, testCase.wantStatus, testCase.wantCode, testCase.wantMessage)

			body := recorder.Body.String()
			// 错误不得伪装成回答正文，也不得补一个假的完成信号。
			if strings.Contains(body, testCase.wantMessage) {
				t.Fatalf("上游错误文案被当成模型内容下发: %s", body)
			}
			if strings.Contains(body, "[DONE]") {
				t.Fatalf("错误信封之后仍下发了 [DONE]: %s", body)
			}
			if strings.Contains(body, `"finish_reason":"stop"`) {
				t.Fatalf("错误信封之后伪造了结束帧: %s", body)
			}
		})

		t.Run(testCase.name+"/aggregate", func(t *testing.T) {
			setup := newConformanceSetup(t, http.StatusOK, testCase.frames)
			response := setup.run(t)
			setup.assertUpstreamContract(t)

			recorder := httptest.NewRecorder()
			handled, err := setup.provider.TransformResponse(recorder, response, false)
			if !handled {
				t.Fatal("TransformResponse(aggregate) 未接管")
			}
			assertStreamError(t, err, testCase.wantStatus, testCase.wantCode, testCase.wantMessage)
			// 非流式必须一个字都不写：否则客户端会把错误读成「模型没说话」的成功回答。
			if recorder.Body.Len() != 0 {
				t.Fatalf("错误信封被聚合成成功载荷: %s", recorder.Body.String())
			}
		})
	}
}

// TestConformanceHTTPErrorIsLeftToHandler 覆盖上游直接拒绝（4xx/5xx，非 SSE 信封）。
//
// 新契约：非 2xx 的正文不是推理流（真实 4xx/5xx 是 JSON 错误体），Provider 必须交还
// Handler，由后者按上游状态码原样转发正文。Provider 一旦「接管」就会把正文当 SSE 解析，
// 整段错误详情被吃掉，客户端只剩状态码 + 空 body。
func TestConformanceHTTPErrorIsLeftToHandler(t *testing.T) {
	cases := []struct {
		name string
		body []byte
	}{
		{
			name: "普通 JSON 错误正文",
			body: []byte(`{"code":"invalid_token","message":"token expired"}`),
		},
		{
			// 形状看着像 qoder 信封，但它是**错误正文**：不能因为像 SSE 就拆包。
			name: "qoder 信封形状的错误正文",
			body: []byte(`data: {"statusCodeValue":401,"body":"{\"error\":{\"code\":\"AUTH\",\"message\":\"denied\"}}"}` + "\n\n"),
		},
	}

	for _, testCase := range cases {
		for _, stream := range []bool{true, false} {
			mode := "stream"
			if !stream {
				mode = "aggregate"
			}
			t.Run(testCase.name+"/"+mode, func(t *testing.T) {
				setup := newConformanceSetup(t, http.StatusUnauthorized, testCase.body)
				response := setup.run(t)
				setup.assertUpstreamContract(t)

				recorder := httptest.NewRecorder()
				handled, err := setup.provider.TransformResponse(recorder, response, stream)
				if err != nil {
					t.Fatalf("交还 Handler 时不应报解析错误: %v", err)
				}
				if handled {
					t.Fatal("非 2xx 被接管：上游错误正文会被当 SSE 吃掉")
				}
				// 交还时不能有任何写入：状态码与正文由 Handler 按上游响应决定。
				if recorder.Code != http.StatusOK {
					t.Fatalf("recorder 状态码 = %d, want 200（未写 header 的默认值）", recorder.Code)
				}
				if recorder.Body.Len() != 0 {
					t.Fatalf("交还前已开始写正文: %s", recorder.Body.String())
				}
				if strings.Contains(recorder.Body.String(), "chat.completion") {
					t.Fatalf("把上游错误伪装成了成功载荷: %s", recorder.Body.String())
				}

				// Handler 的回退路径是 WriteHeader(上游状态) + 原样拷贝正文；
				// 这里复现它，确认 Provider 没有提前读走 body。
				forwarded, readErr := io.ReadAll(response.Body)
				if readErr != nil {
					t.Fatalf("读取上游错误正文失败: %v", readErr)
				}
				if !bytes.Equal(forwarded, testCase.body) {
					t.Fatalf("错误正文被改动或提前消费:\n got: %q\nwant: %q", forwarded, testCase.body)
				}
			})
		}
	}
}

// conformanceSuccessStream 造一条完整的 qoder 上游流：4 个信封 chunk + 1 个计时帧 + [DONE]。
func conformanceSuccessStream(t *testing.T) []byte {
	t.Helper()
	chunks := []string{
		`{"id":"` + conformanceChunkID + `","object":"chat.completion.chunk","created":1700000000,"model":"qwen3-internal","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
		`{"id":"` + conformanceChunkID + `","object":"chat.completion.chunk","created":1700000000,"model":"qwen3-internal","choices":[{"index":0,"delta":{"content":"Hello"}}]}`,
		`{"id":"` + conformanceChunkID + `","object":"chat.completion.chunk","created":1700000000,"model":"qwen3-internal","choices":[{"index":0,"delta":{"content":", world"}}]}`,
		`{"id":"` + conformanceChunkID + `","object":"chat.completion.chunk","created":1700000000,"model":"qwen3-internal","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
	}
	builder := strings.Builder{}
	for _, chunk := range chunks {
		builder.WriteString(conformanceEnvelope(t, map[string]any{
			"headers":         map[string]string{"x-request-id": "req-conformance"},
			"body":            chunk,
			"statusCodeValue": 200,
		}))
	}
	// 计时帧只有元数据：下游不需要，必须丢弃。
	builder.WriteString(conformanceEnvelope(t, map[string]any{
		"firstTokenDuration": 21,
		"totalDuration":      84,
		"statusCodeValue":    200,
	}))
	builder.WriteString("data: [DONE]\n\n")
	return []byte(builder.String())
}

// conformanceEnvelope 把内层 chunk 包成 qoder 的 SSE 信封。
func conformanceEnvelope(t *testing.T, fields map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("编码信封失败: %v", err)
	}
	return "data: " + string(raw) + "\n\n"
}

// conformanceClientFrames 解析客户端实际收到的 SSE，只接受 data 帧。
func conformanceClientFrames(t *testing.T, body string) []string {
	t.Helper()
	trimmed := strings.TrimSuffix(body, "\n\n")
	if trimmed == "" {
		return nil
	}
	blocks := strings.Split(trimmed, "\n\n")
	frames := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if !strings.HasPrefix(block, "data: ") {
			t.Fatalf("客户端收到非 data 帧: %q", block)
		}
		frames = append(frames, strings.TrimPrefix(block, "data: "))
	}
	return frames
}

func assertStreamError(t *testing.T, err error, wantStatus int, wantCode, wantMessage string) {
	t.Helper()
	if err == nil {
		t.Fatal("错误信封被当成成功处理")
	}
	var streamErr *StreamError
	if !errors.As(err, &streamErr) {
		t.Fatalf("error 类型 = %T, want *StreamError: %v", err, err)
	}
	if streamErr.StatusCode != wantStatus {
		t.Fatalf("错误状态码 = %d, want %d", streamErr.StatusCode, wantStatus)
	}
	if streamErr.Code != wantCode {
		t.Fatalf("错误码 = %q, want %q（上游错误码必须透出）", streamErr.Code, wantCode)
	}
	if streamErr.Message != wantMessage {
		t.Fatalf("错误文案 = %q, want %q", streamErr.Message, wantMessage)
	}
	// Handler 只通过这个结构接口读取上游状态码/错误码；不再满足它就退化成通用 502。
	typed, ok := err.(handlerTransformerError)
	if !ok {
		t.Fatalf("error 类型 %T 未实现 Handler 的上游错误契约", err)
	}
	if typed.UpstreamStatusCode() != wantStatus || typed.UpstreamErrorCode() != wantCode {
		t.Fatalf("契约返回值 = %d/%q, want %d/%q",
			typed.UpstreamStatusCode(), typed.UpstreamErrorCode(), wantStatus, wantCode)
	}
}

// handlerTransformerError 是 relaycore 内部 transformerError 的结构镜像。
//
// 这里不引用未导出类型，固定的是**形状**：Handler 用这个接口把上游状态码与错误码
// 映射成 429/502 和 JSON 错误体（见 relaycore.writeTransformerError）。Provider 的
// StreamError 一旦不再满足它，客户端只能看到通用的 502 relay_upstream_error，
// 额度 / 限流 / 鉴权原因全部丢失。
type handlerTransformerError interface {
	UpstreamStatusCode() int
	UpstreamErrorCode() string
}

var _ handlerTransformerError = (*StreamError)(nil)

func TestConformanceStreamErrorSatisfiesHandlerContract(t *testing.T) {
	// 用 error 接口断言，与 Handler 的断言方式一致（不是直接对具体类型断言）。
	var err error = &StreamError{StatusCode: 529, Code: "RESOURCE_LIMIT", Message: "queue full"}
	typed, ok := err.(handlerTransformerError)
	if !ok {
		t.Fatalf("error 类型 %T 未实现 Handler 的上游错误契约", err)
	}
	if got := typed.UpstreamStatusCode(); got != 529 {
		t.Fatalf("UpstreamStatusCode() = %d, want 529", got)
	}
	if got := typed.UpstreamErrorCode(); got != "RESOURCE_LIMIT" {
		t.Fatalf("UpstreamErrorCode() = %q, want RESOURCE_LIMIT", got)
	}
	// 空错误码由 Handler 兜底成 relay_upstream_error；Getter 不能 panic 或返回脏值。
	if got := (&StreamError{}).UpstreamErrorCode(); got != "" {
		t.Fatalf("空 StreamError 的 UpstreamErrorCode() = %q, want 空串", got)
	}
}

// conformanceRequestPayload 是客户端发给本通道的原始 OpenAI 请求。
func conformanceRequestPayload() []byte {
	return []byte(`{"model":"` + conformanceModel + `","stream":true,"messages":[{"role":"user","content":"` + conformancePrompt + `"}]}`)
}

// writeConformanceUMIDCache 写一份与真实客户端同形的设备令牌缓存。
func writeConformanceUMIDCache(t *testing.T, home string) {
	t.Helper()
	// 目录名照抄官方客户端（~/.qoder），不引用 clientDirs：
	// 这里要固定的是**真实路径**，而不是和实现共用同一张表。
	dir := filepath.Join(home, ".qoder")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("创建 umid 目录失败: %v", err)
	}
	payload, err := json.Marshal(map[string]any{
		"info": map[string]any{
			"machineToken": conformanceMachineToken,
			"machineType":  conformanceMachineType,
		},
	})
	if err != nil {
		t.Fatalf("编码 umid 缓存失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "umid-cache.json"), payload, 0o644); err != nil {
		t.Fatalf("写入 umid 缓存失败: %v", err)
	}
}

// installConformanceFakes 替换签名运行时、目录缓存、凭据解密与版本号，并清空签名运行时缓存。
//
// signerFor 按 providerID 缓存运行时（生产里是为了 wasm 只编译一次），如果不清空，
// 本用例会复用别的用例留下的 signer，假上游就收不到 X-Conformance-Signature。
func installConformanceFakes(t *testing.T, signer *conformanceSigner) {
	t.Helper()
	previousSigner, previousEntries := newSigner, cachedEntries
	previousDecrypt, previousVersion := decryptNative, cliVersion

	newSigner = func(string) (Signer, error) { return signer, nil }
	cachedEntries = func(string, map[string]any) ([]modelcatalog.Entry, bool) {
		return []modelcatalog.Entry{
			{Key: "auto", DisplayName: "Auto", Format: "openai", Source: "system", MaxInputTokens: 200000},
			{
				Key: conformanceModelKey, DisplayName: conformanceModel, Format: "openai",
				Source: "system", IsReasoning: true, MaxInputTokens: 128000,
			},
		}, true
	}
	decryptNative = func(string, map[string]any, qodercred.Options) (string, bool) {
		return `{"uid":"uid-1","security_oauth_token":"token"}`, true
	}
	cliVersion = func(string, qodercred.Options) string { return "1.1.81" }

	signerMu.Lock()
	previousCache := signerCache
	signerCache = map[string]Signer{}
	signerMu.Unlock()

	t.Cleanup(func() {
		newSigner, cachedEntries = previousSigner, previousEntries
		decryptNative, cliVersion = previousDecrypt, previousVersion
		signerMu.Lock()
		signerCache = previousCache
		signerMu.Unlock()
	})
}

func decodeZstdBody(body []byte) ([]byte, error) {
	decoder, err := zstd.NewReader(nil)
	if err != nil {
		return nil, err
	}
	defer decoder.Close()
	return decoder.DecodeAll(body, nil)
}

// nestedString 取嵌套对象里的字符串字段；类型不符时返回空串。
func nestedString(root map[string]any, path ...string) string {
	current := any(root)
	for _, key := range path {
		fields, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current, ok = fields[key]
		if !ok {
			return ""
		}
	}
	text, _ := current.(string)
	return text
}
