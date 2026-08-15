package aihserver_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

const (
	// realCodexWebSocketSmokeEnvironment 是产生真实 WS Token 消耗的显式开关。
	realCodexWebSocketSmokeEnvironment = "AIH_REAL_CODEX_WS_SMOKE"
	// realCodexWebSocketAuthFileEnvironment 指向操作者明确提供的官方 auth.json。
	realCodexWebSocketAuthFileEnvironment = realCodexAuthFileEnvironment
	realCodexWebSocketFirstMarker         = "AIH_REAL_WS_ONE"
	realCodexWebSocketSecondMarker        = "AIH_REAL_WS_TWO"
	realCodexWebSocketToolResult          = "AIH_REAL_WS_TOOL_DONE"
	realCodexWebSocketToolName            = "aih_lookup_weather"
	realCodexWebSocketTimeout             = 2 * time.Minute
)

// liveCodexWebSocketRequest 与当前官方 Codex ResponseCreateWsRequest 字段对齐。
// 测试不添加 max_output_tokens，也不通过自定义字段影响 Provider 语义。Input
// 使用 RawMessage 是为了同时覆盖 message 与 function_call_output 两类官方项。
type liveCodexWebSocketRequest struct {
	Type               string            `json:"type"`
	Model              string            `json:"model"`
	Instructions       string            `json:"instructions,omitempty"`
	PreviousResponseID string            `json:"previous_response_id,omitempty"`
	Input              json.RawMessage   `json:"input"`
	Tools              json.RawMessage   `json:"tools,omitempty"`
	ToolChoice         string            `json:"tool_choice"`
	ParallelToolCalls  bool              `json:"parallel_tool_calls"`
	Reasoning          any               `json:"reasoning,omitempty"`
	Store              bool              `json:"store"`
	Stream             bool              `json:"stream"`
	Include            []string          `json:"include"`
	Generate           *bool             `json:"generate,omitempty"`
	ClientMetadata     map[string]string `json:"client_metadata,omitempty"`
}

// liveCodexWebSocketTurn 保存可安全记录的真实终态摘要。
type liveCodexWebSocketTurn struct {
	responseID     string
	eventTypes     []string
	output         string
	functionCallID string
	functionName   string
}

// TestRealCodexResponsesWebSocketEndToEnd 通过真实 TCP Go Gateway 和真实 OAuth
// 账号验收同连接双轮 Responses WS，以及 previous_response_id 增量续接。
//
// 默认跳过。显式打开开关后，测试只把操作者提供的 auth.json 导入一次性账号库，
// 不修改源文件、不输出凭据，也不记录完整上游帧。
func TestRealCodexResponsesWebSocketEndToEnd(t *testing.T) {
	if os.Getenv(realCodexWebSocketSmokeEnvironment) != "1" {
		t.Skip(realCodexWebSocketSmokeEnvironment + " 未设置，跳过真实 Codex WS 验收")
	}
	authPath := strings.TrimSpace(os.Getenv(realCodexWebSocketAuthFileEnvironment))
	if authPath == "" {
		t.Fatal(realCodexWebSocketAuthFileEnvironment + " 未设置")
	}
	authJSON := readProtectedRealCodexAuth(t, authPath)
	defer clear(authJSON)
	assertRealCodexAuthReady(t, authJSON)

	// 模型目录与 WebSocket 共用同一真实请求预算；账号导入后只从本地目录
	// 选择实际存在的模型，禁止硬编码未经验证的模型 ID。
	upstream := newRealCodexUpstreamBudget(2)
	catalog, err := codexresponses.NewModelCatalogSource(upstream)
	if err != nil {
		t.Fatalf("创建真实 Codex 模型目录源失败: %v", err)
	}
	aiHomeDir := newDisposableRealCodexHome(t)
	baseURL, _ := startRealCodexServer(
		t,
		aiHomeDir,
		upstream,
		[]accountapp.ProviderModelDiscoverer{catalog},
		upstream.WebSocketHTTPClient(),
	)
	importRealCodexWebSocketAccount(t, baseURL, authJSON)
	model := discoverRealCodexWebSocketModel(t, baseURL)
	upstream.SetExpectedModel(model)

	ctx, cancel := context.WithTimeout(
		context.Background(),
		realCodexWebSocketTimeout,
	)
	defer cancel()
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+testClientKey)
	header.Set("thread-id", "aih-real-codex-ws-e2e")
	connection, response, err := websocket.Dial(
		ctx,
		strings.Replace(baseURL, "http://", "ws://", 1)+
			openairesponsesapi.Path,
		&websocket.DialOptions{
			HTTPHeader:      header,
			CompressionMode: websocket.CompressionContextTakeover,
		},
	)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("真实 Codex WS 握手失败: http_status=%d error=%v", status, err)
	}
	defer connection.CloseNow()

	first := executeRealCodexWebSocketTurn(
		t,
		ctx,
		connection,
		newLiveCodexWebSocketToolRequest(model),
		"",
		upstream,
	)
	second := executeRealCodexWebSocketTurn(
		t,
		ctx,
		connection,
		newLiveCodexWebSocketFunctionOutputRequest(model, first.responseID, first.functionCallID),
		realCodexWebSocketSecondMarker,
		upstream,
	)
	if first.responseID == second.responseID || first.functionCallID == "" {
		t.Fatal("真实 Codex WS 双轮返回了相同 response.id")
	}
	if first.functionName != realCodexWebSocketToolName {
		t.Fatalf("真实 Codex WS 工具名错误: got=%q want=%q", first.functionName, realCodexWebSocketToolName)
	}

	t.Logf(
		strings.Join([]string{
			"真实 Codex Go WebSocket 验收通过",
			"ws: %s",
			"authorization: Bearer <local-test-key-redacted>",
			"model_catalog: GET %s status=200 selected_model=%s",
			"turn_1: payload={type:response.create,model:%s,tools:[%s],stream:true} response_id_present=true function_call_id_present=true events=%s",
			"turn_2: payload={type:response.create,model:%s,previous_response_id:<turn-1>,input:function_call_output,stream:true} response_id_present=true response_id_rotated=true events=%s marker_present=true",
			"temporary_database: imported_from_auth_json=true cleanup=registered",
		}, "\n"),
		strings.Replace(baseURL, "http://", "ws://", 1)+
			openairesponsesapi.Path,
		baseURL+modelsapi.Path,
		model,
		model,
		realCodexWebSocketToolName,
		strings.Join(first.eventTypes, " -> "),
		model,
		strings.Join(second.eventTypes, " -> "),
	)
}

// TestRealCodexResponsesWebSocketPrewarmAndReuse 使用真实 OAuth 账号验收官方
// generate:false 预热合同：预热请求本身不计入账号成功/失败运行态，随后同一条
// 连接使用 previous_response_id 和空 input 继续真实文本请求。
func TestRealCodexResponsesWebSocketPrewarmAndReuse(t *testing.T) {
	if os.Getenv(realCodexWebSocketSmokeEnvironment) != "1" {
		t.Skip(realCodexWebSocketSmokeEnvironment + " 未设置，跳过真实 Codex WS 预热验收")
	}
	authPath := strings.TrimSpace(os.Getenv(realCodexWebSocketAuthFileEnvironment))
	if authPath == "" {
		t.Fatal(realCodexWebSocketAuthFileEnvironment + " 未设置")
	}
	authJSON := readProtectedRealCodexAuth(t, authPath)
	defer clear(authJSON)
	assertRealCodexAuthReady(t, authJSON)

	// 预热不产生模型推理额度；预算仍限制模型目录与唯一一次真实 WS 握手，
	// 防止测试因实现错误自动建立第二条连接或旁路访问其它上游地址。
	upstream := newRealCodexUpstreamBudget(0)
	catalog, err := codexresponses.NewModelCatalogSource(upstream)
	if err != nil {
		t.Fatalf("创建真实 Codex 预热模型目录源失败: %v", err)
	}
	aiHomeDir := newDisposableRealCodexHome(t)
	baseURL, _ := startRealCodexServer(
		t,
		aiHomeDir,
		upstream,
		[]accountapp.ProviderModelDiscoverer{catalog},
		upstream.WebSocketHTTPClient(),
	)
	importRealCodexWebSocketAccount(t, baseURL, authJSON)
	model := discoverRealCodexWebSocketModel(t, baseURL)
	upstream.SetExpectedModel(model)

	ctx, cancel := context.WithTimeout(
		context.Background(),
		realCodexWebSocketTimeout,
	)
	defer cancel()
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+testClientKey)
	header.Set("thread-id", "aih-real-codex-ws-prewarm")
	connection, response, err := websocket.Dial(
		ctx,
		strings.Replace(baseURL, "http://", "ws://", 1)+openairesponsesapi.Path,
		&websocket.DialOptions{
			HTTPHeader:      header,
			CompressionMode: websocket.CompressionContextTakeover,
		},
	)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("真实 Codex WS 预热握手失败: http_status=%d error=%v", status, err)
	}
	defer connection.CloseNow()

	warmup := newLiveCodexWebSocketTextRequest(
		model,
		realCodexWebSocketFirstMarker,
	)
	warmup.Generate = boolPointer(false)
	first := executeRealCodexWebSocketTurn(t, ctx, connection, warmup, "", upstream)
	if first.responseID == "" {
		t.Fatal("真实 Codex WS 预热没有返回 response.id")
	}
	second := executeRealCodexWebSocketTurn(
		t,
		ctx,
		connection,
		liveCodexWebSocketRequest{
			Type:               "response.create",
			Model:              model,
			Instructions:       "Return only the exact marker requested by the user.",
			PreviousResponseID: first.responseID,
			Input:              marshalLiveCodexWebSocketValue([]any{}),
			ToolChoice:         "auto",
			ParallelToolCalls:  true,
			Store:              false,
			Stream:             true,
			Include:            []string{},
		},
		realCodexWebSocketFirstMarker,
		upstream,
	)
	if second.responseID == first.responseID {
		t.Fatal("真实 Codex WS 预热续接复用了相同 response.id")
	}
	if counts := upstream.snapshot(); counts != (realCodexRequestCounts{
		models:              1,
		websocketHandshakes: 1,
		lastStatus:          http.StatusSwitchingProtocols,
	}) {
		t.Fatalf("真实 Codex WS 预热请求预算错误: %+v", counts)
	}
	t.Logf(
		"真实 Codex WS 预热验收通过: model=%s warmup_response_id_present=true turn_response_id_present=true response_id_rotated=true events=%s",
		model,
		strings.Join(second.eventTypes, " -> "),
	)
}

// newLiveCodexWebSocketToolRequest 创建官方 Responses function tool 首轮请求。
func newLiveCodexWebSocketToolRequest(model string) liveCodexWebSocketRequest {
	return liveCodexWebSocketRequest{
		Type:         "response.create",
		Model:        model,
		Instructions: "Call the provided function exactly once. Do not answer with text before the function call.",
		Input: marshalLiveCodexWebSocketValue([]map[string]any{{
			"type": "message", "role": "user",
			"content": []map[string]string{{"type": "input_text", "text": "Look up the weather for Shanghai."}},
		}}),
		Tools: marshalLiveCodexWebSocketValue([]map[string]any{{
			"type": "function", "name": realCodexWebSocketToolName,
			"description": "Look up weather for a city.",
			"strict":      false,
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{"city": map[string]string{"type": "string"}},
				"required":   []string{"city"}, "additionalProperties": false,
			},
		}}),
		ToolChoice: "auto", ParallelToolCalls: false,
		Store: false, Stream: true, Include: []string{},
		ClientMetadata: map[string]string{"test_scope": "aih-real-codex-ws-e2e"},
	}
}

// newLiveCodexWebSocketTextRequest 创建预热和文本续接共用的官方文本请求。
func newLiveCodexWebSocketTextRequest(model string, marker string) liveCodexWebSocketRequest {
	return liveCodexWebSocketRequest{
		Type:         "response.create",
		Model:        model,
		Instructions: "Return only the exact marker requested by the user.",
		Input: marshalLiveCodexWebSocketValue([]map[string]any{{
			"type": "message", "role": "user",
			"content": []map[string]string{{"type": "input_text", "text": "Reply with exactly: " + marker}},
		}}),
		Tools:             marshalLiveCodexWebSocketValue([]any{}),
		ToolChoice:        "auto",
		ParallelToolCalls: true,
		Store:             false,
		Stream:            true,
		Include:           []string{},
	}
}

// boolPointer 为官方 generate:false 字段构造显式指针，避免 false 被当作缺省值。
func boolPointer(value bool) *bool {
	return &value
}

// newLiveCodexWebSocketFunctionOutputRequest 创建工具执行后的增量续接请求。
func newLiveCodexWebSocketFunctionOutputRequest(
	model string, previousResponseID string, callID string,
) liveCodexWebSocketRequest {
	return liveCodexWebSocketRequest{
		Type: "response.create", Model: model,
		Instructions:       "After receiving the function result, reply with exactly: " + realCodexWebSocketSecondMarker,
		PreviousResponseID: previousResponseID,
		Input: marshalLiveCodexWebSocketValue([]map[string]any{{
			"type": "function_call_output", "call_id": callID, "output": realCodexWebSocketToolResult,
		}}),
		ToolChoice: "auto", ParallelToolCalls: false,
		Store: false, Stream: true, Include: []string{},
		ClientMetadata: map[string]string{"test_scope": "aih-real-codex-ws-e2e"},
	}
}

// marshalLiveCodexWebSocketValue 编码固定测试值；夹具编码失败应直接终止测试。
func marshalLiveCodexWebSocketValue(value any) json.RawMessage {
	payload, err := json.Marshal(value)
	if err != nil {
		panic("编码 Codex WebSocket 测试输入失败")
	}
	return payload
}

// executeRealCodexWebSocketTurn 发送一轮请求并只保留事件类型、ID 和文本摘要。
func executeRealCodexWebSocketTurn(
	t *testing.T,
	ctx context.Context,
	connection *websocket.Conn,
	request liveCodexWebSocketRequest,
	wantOutput string,
	budget *realCodexRequestBudget,
) liveCodexWebSocketTurn {
	t.Helper()
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("编码真实 Codex WS 请求失败: %v", err)
	}
	if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
		clear(payload)
		t.Fatalf("发送真实 Codex WS 请求失败: %v", err)
	}
	clear(payload)

	turn := liveCodexWebSocketTurn{
		eventTypes: make([]string, 0, 16),
	}
	var output strings.Builder
	for frameIndex := 0; frameIndex < 512; frameIndex++ {
		messageType, frame, readErr := connection.Read(ctx)
		if readErr != nil {
			t.Fatalf("读取真实 Codex WS 事件失败: %v", readErr)
		}
		if messageType != websocket.MessageText {
			t.Fatalf("真实 Codex WS 返回非文本帧: type=%d", messageType)
		}
		var event struct {
			Type   string `json:"type"`
			Delta  string `json:"delta"`
			Status int    `json:"status"`
			Item   struct {
				Type   string `json:"type"`
				CallID string `json:"call_id"`
				Name   string `json:"name"`
			} `json:"item"`
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
			Response struct {
				ID     string            `json:"id"`
				Status string            `json:"status"`
				Output []json.RawMessage `json:"output"`
			} `json:"response"`
		}
		if json.Unmarshal(frame, &event) != nil || event.Type == "" {
			t.Fatal("真实 Codex WS 返回无效事件")
		}
		turn.eventTypes = appendConsecutiveEventType(
			turn.eventTypes,
			event.Type,
		)
		switch event.Type {
		case "response.output_text.delta":
			output.WriteString(event.Delta)
		case "response.output_item.added", "response.output_item.done":
			if event.Item.Type == "function_call" && event.Item.CallID != "" {
				turn.functionCallID = event.Item.CallID
				turn.functionName = event.Item.Name
			}
		case "error", "response.failed", "response.incomplete":
			t.Fatalf(
				"真实 Codex WS 终态失败: type=%s status=%d code=%s upstream_budget=%+v",
				event.Type,
				event.Status,
				event.Error.Code,
				budget.snapshot(),
			)
		case "response.completed":
			turn.responseID = event.Response.ID
			turn.output = strings.TrimSpace(output.String())
			if turn.output == "" {
				turn.output = strings.TrimSpace(realResponsesOutputText(
					t,
					event.Response.Output,
				))
			}
			if turn.responseID == "" ||
				event.Response.Status != "completed" ||
				(wantOutput != "" && turn.output != wantOutput) {
				t.Fatalf(
					"真实 Codex WS 结果异常: id=%t status=%q output=%q want=%q events=%s",
					turn.responseID != "",
					event.Response.Status,
					turn.output,
					wantOutput,
					strings.Join(turn.eventTypes, " -> "),
				)
			}
			return turn
		}
	}
	t.Fatal("真实 Codex WS 事件超过安全上限且没有终态")
	return liveCodexWebSocketTurn{}
}

// appendConsecutiveEventType 压缩连续 delta 事件，避免日志随输出长度膨胀。
func appendConsecutiveEventType(types []string, eventType string) []string {
	if len(types) == 0 || types[len(types)-1] != eventType {
		return append(types, eventType)
	}
	return types
}

// importRealCodexWebSocketAccount 通过正式原生导入 API 写入临时账号库。
func importRealCodexWebSocketAccount(t *testing.T, baseURL string, authJSON []byte) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"provider_id": "codex",
		"artifacts":   map[string]json.RawMessage{"auth_json": authJSON},
	})
	if err != nil {
		t.Fatalf("构造真实 Codex WS 导入请求失败: %v", err)
	}
	response := performRequest(t, &http.Client{Timeout: 15 * time.Second}, http.MethodPost,
		baseURL+accountsapi.NativeImportPath, testManagementKey, payload)
	clear(payload)
	assertRealStatus(t, response, http.StatusCreated)
}

// discoverRealCodexWebSocketModel 只从本地已物化目录选实际存在的 gpt 模型。
func discoverRealCodexWebSocketModel(t *testing.T, baseURL string) string {
	t.Helper()
	response := waitForRealModelCatalog(
		t,
		&http.Client{Timeout: 15 * time.Second},
		baseURL+modelsapi.Path,
	)
	var document struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	decodeRealJSON(t, response.body, &document)
	models := make([]string, 0, len(document.Data))
	for _, item := range document.Data {
		if strings.HasPrefix(item.ID, "gpt-") {
			models = append(models, item.ID)
		}
	}
	if len(models) == 0 {
		t.Fatalf("真实 Codex 模型目录没有可用 gpt 模型: count=%d", len(document.Data))
	}
	preferred := []string{"gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex"}
	for _, candidate := range preferred {
		for _, model := range models {
			if model == candidate {
				return model
			}
		}
	}
	sort.Strings(models)
	return models[0]
}
