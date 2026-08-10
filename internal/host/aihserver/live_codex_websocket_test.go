package aihserver_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

const (
	// realCodexWebSocketSmokeEnvironment 是产生真实 WS Token 消耗的显式开关。
	realCodexWebSocketSmokeEnvironment = "AIH_REAL_CODEX_WS_SMOKE"
	// realCodexWebSocketHomeEnvironment 指向包含真实账号快照的 AIH_HOME。
	realCodexWebSocketHomeEnvironment = "AIH_REAL_CODEX_WS_HOME"
	// realCodexWebSocketDatabaseLimit 防止误把异常大文件复制到测试目录。
	realCodexWebSocketDatabaseLimit = 128 * 1024 * 1024
	realCodexWebSocketFirstMarker   = "AIH_REAL_WS_ONE"
	realCodexWebSocketSecondMarker  = "AIH_REAL_WS_TWO"
	realCodexWebSocketTimeout       = 2 * time.Minute
)

// liveCodexWebSocketRequest 与当前官方 Codex ResponseCreateWsRequest 字段对齐。
// 测试不添加 max_output_tokens，也不通过自定义字段影响 Provider 语义。
type liveCodexWebSocketRequest struct {
	Type               string                      `json:"type"`
	Model              string                      `json:"model"`
	Instructions       string                      `json:"instructions"`
	PreviousResponseID string                      `json:"previous_response_id,omitempty"`
	Input              []liveCodexWebSocketMessage `json:"input"`
	ToolChoice         string                      `json:"tool_choice"`
	ParallelToolCalls  bool                        `json:"parallel_tool_calls"`
	Reasoning          any                         `json:"reasoning"`
	Store              bool                        `json:"store"`
	Stream             bool                        `json:"stream"`
	Include            []string                    `json:"include"`
	ClientMetadata     map[string]string           `json:"client_metadata,omitempty"`
}

// liveCodexWebSocketMessage 是官方 Responses 用户消息输入项。
type liveCodexWebSocketMessage struct {
	Type    string                      `json:"type"`
	Role    string                      `json:"role"`
	Content []liveCodexWebSocketContent `json:"content"`
}

// liveCodexWebSocketContent 是官方 Responses input_text 内容项。
type liveCodexWebSocketContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// liveCodexWebSocketTurn 保存可安全记录的真实终态摘要。
type liveCodexWebSocketTurn struct {
	responseID string
	eventTypes []string
	output     string
}

// TestRealCodexResponsesWebSocketEndToEnd 通过真实 TCP Go Gateway 和真实 OAuth
// 账号验收同连接双轮 Responses WS，以及 previous_response_id 增量续接。
//
// 默认跳过。显式打开开关后，测试只复制账号库并产生两轮固定短文本请求；不会
// 修改源数据库、输出凭据或记录完整上游帧。
func TestRealCodexResponsesWebSocketEndToEnd(t *testing.T) {
	if os.Getenv(realCodexWebSocketSmokeEnvironment) != "1" {
		t.Skip(realCodexWebSocketSmokeEnvironment + " 未设置，跳过真实 Codex WS 验收")
	}
	sourceHome := strings.TrimSpace(os.Getenv(
		realCodexWebSocketHomeEnvironment,
	))
	if sourceHome == "" {
		t.Fatal(realCodexWebSocketHomeEnvironment + " 未设置")
	}

	aiHomeDir := copyRealCodexWebSocketDatabase(t, sourceHome)
	// 普通 Responses HTTP 意外进入该路径时必须在本地失败；原生 WS 使用独立
	// Dialer，因此只有已确认的一次握手和两轮帧会触达真实上游。
	httpClient := &http.Client{Transport: realCodexRoundTripperFunc(func(
		_ *http.Request,
	) (*http.Response, error) {
		return nil, errUnexpectedRealCodexRequest
	})}
	baseURL, _ := startRealCodexServer(
		t,
		aiHomeDir,
		httpClient,
		accountmodels.NewDiscoverers(),
	)

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
		newLiveCodexWebSocketRequest(
			realCodexWebSocketFirstMarker,
			"",
		),
	)
	second := executeRealCodexWebSocketTurn(
		t,
		ctx,
		connection,
		newLiveCodexWebSocketRequest(
			realCodexWebSocketSecondMarker,
			first.responseID,
		),
	)
	if first.responseID == second.responseID {
		t.Fatal("真实 Codex WS 双轮返回了相同 response.id")
	}

	t.Logf(
		strings.Join([]string{
			"真实 Codex Go WebSocket 验收通过",
			"ws: %s",
			"authorization: Bearer <local-test-key-redacted>",
			"turn_1: payload={type:response.create,model:%s,input:<fixed-text>,stream:true} response_id=%s events=%s output=%q",
			"turn_2: payload={type:response.create,model:%s,previous_response_id:%s,input:<incremental-fixed-text>,stream:true} response_id=%s events=%s output=%q",
			"source_database: copied=true source_unchanged=true",
		}, "\n"),
		strings.Replace(baseURL, "http://", "ws://", 1)+
			openairesponsesapi.Path,
		realCodexModel,
		first.responseID,
		strings.Join(first.eventTypes, " -> "),
		first.output,
		realCodexModel,
		first.responseID,
		second.responseID,
		strings.Join(second.eventTypes, " -> "),
		second.output,
	)
}

// newLiveCodexWebSocketRequest 创建与官方 Codex 源码一致的最小生成帧。
func newLiveCodexWebSocketRequest(
	marker string,
	previousResponseID string,
) liveCodexWebSocketRequest {
	return liveCodexWebSocketRequest{
		Type:               "response.create",
		Model:              realCodexModel,
		Instructions:       "Return only the exact marker requested by the user.",
		PreviousResponseID: previousResponseID,
		Input: []liveCodexWebSocketMessage{{
			Type: "message",
			Role: "user",
			Content: []liveCodexWebSocketContent{{
				Type: "input_text",
				Text: "Reply with exactly: " + marker,
			}},
		}},
		ToolChoice:        "auto",
		ParallelToolCalls: true,
		Reasoning:         nil,
		Store:             false,
		Stream:            true,
		Include:           []string{},
		ClientMetadata: map[string]string{
			"test_scope": "aih-real-codex-ws-e2e",
		},
	}
}

// executeRealCodexWebSocketTurn 发送一轮请求并只保留事件类型、ID 和文本摘要。
func executeRealCodexWebSocketTurn(
	t *testing.T,
	ctx context.Context,
	connection *websocket.Conn,
	request liveCodexWebSocketRequest,
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
			Error  struct {
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
		case "error", "response.failed", "response.incomplete":
			t.Fatalf(
				"真实 Codex WS 终态失败: type=%s status=%d code=%s message=%q",
				event.Type,
				event.Status,
				event.Error.Code,
				event.Error.Message,
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
			want := strings.TrimPrefix(
				request.Input[0].Content[0].Text,
				"Reply with exactly: ",
			)
			if turn.responseID == "" ||
				event.Response.Status != "completed" ||
				turn.output != want {
				t.Fatalf(
					"真实 Codex WS 结果异常: id=%t status=%q output=%q want=%q events=%s",
					turn.responseID != "",
					event.Response.Status,
					turn.output,
					want,
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

// copyRealCodexWebSocketDatabase 复制真实账号快照，让迁移、刷新与运行态写入只
// 发生在一次性目录，不修改操作者显式提供的源数据库。
func copyRealCodexWebSocketDatabase(t *testing.T, sourceHome string) string {
	t.Helper()
	sourcePath := filepath.Join(sourceHome, "aih.db")
	info, err := os.Stat(sourcePath)
	if err != nil || !info.Mode().IsRegular() ||
		info.Size() <= 0 || info.Size() > realCodexWebSocketDatabaseLimit {
		t.Fatalf("真实 Codex WS 数据库无效: %v", err)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatalf("打开真实 Codex WS 数据库失败: %v", err)
	}
	defer func() {
		_ = source.Close()
	}()

	targetHome := newDisposableRealCodexHome(t)
	targetPath := filepath.Join(targetHome, "aih.db")
	target, err := os.OpenFile(
		targetPath,
		os.O_WRONLY|os.O_CREATE|os.O_EXCL,
		0o600,
	)
	if err != nil {
		t.Fatalf("创建真实 Codex WS 数据库副本失败: %v", err)
	}
	copied, copyErr := io.Copy(target, io.LimitReader(
		source,
		realCodexWebSocketDatabaseLimit+1,
	))
	syncErr := target.Sync()
	closeErr := target.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil ||
		copied != info.Size() {
		t.Fatalf(
			"复制真实 Codex WS 数据库失败: copied=%d want=%d error=%v",
			copied,
			info.Size(),
			errors.Join(copyErr, syncErr, closeErr),
		)
	}
	return targetHome
}
