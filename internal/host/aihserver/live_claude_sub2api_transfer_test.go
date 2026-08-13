package aihserver_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
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
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
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
	// realClaudeToolMarker 只允许固定工具参数进入真实上游。
	realClaudeToolMarker = "AIH_REAL_CLAUDE_TOOL_OK"
	// realClaudeReasoningMarker 是公开 reasoning 验收的固定主结果。
	realClaudeReasoningMarker = "AIH_REAL_CLAUDE_REASONING_OK"
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
	models            int
	messages          int
	streamMessages    int
	nonStreamMessages int
	toolMessages      int
	thinkingMessages  int
	unexpected        int
	lastStatus        int
}

// realClaudeMessageShape 是安全预算从请求中提取的低敏协议形状。
type realClaudeMessageShape struct {
	stream   bool
	tool     bool
	thinking bool
}

// realClaudeStreamObservation 只保存 Claude SSE 的稳定终态或错误标识。
// Provider message、文本、thinking、signature 和凭据均不会进入该值。
type realClaudeStreamObservation struct {
	terminal  string
	errorType string
	errorCode string
}

// realClaudeRequestBudget 在网络前验证官方端点、认证形态、客户端身份和固定正文。
type realClaudeRequestBudget struct {
	client      *http.Client
	maxMessages int
	mu          sync.Mutex
	counts      realClaudeRequestCounts
	stream      realClaudeStreamObservation
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
	response, err := budget.client.Do(request)
	budget.recordResponse(response)
	budget.observeStream(response)
	return response, err
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
	case request.Method == http.MethodPost && request.URL.Path == "/v1/messages":
		if reason := validateRealClaudeMessagesEnvelope(request); reason != "" {
			return budget.reject(reason)
		}
		if budget.counts.messages >= budget.maxMessages {
			return budget.reject("messages_budget")
		}
		if !validRealClaudeMessagesQuery(request.URL.RawQuery) {
			return budget.reject("messages_query")
		}
		shape, reason, err := validateRealClaudeMessagesBodyWithReason(request)
		if err != nil {
			budget.counts.unexpected++
			budget.lastRejection = reason
			return err
		}
		budget.counts.messages++
		if shape.stream {
			budget.counts.streamMessages++
		} else {
			budget.counts.nonStreamMessages++
		}
		if shape.tool {
			budget.counts.toolMessages++
		}
		if shape.thinking {
			budget.counts.thinkingMessages++
		}
		return nil
	default:
		return budget.reject("request_shape_or_budget")
	}
}

// validateRealClaudeMessagesEnvelope 返回固定低敏类别，定位真实合同漂移时不保存
// Header 值、URL、凭据或正文。
func validateRealClaudeMessagesEnvelope(request *http.Request) string {
	switch {
	case request.Header.Get("Content-Type") != "application/json":
		return "messages_content_type"
	case request.Header.Get("x-app") != "cli":
		return "messages_x_app"
	case request.Header.Get("anthropic-dangerous-direct-browser-access") != "true":
		return "messages_direct_access"
	case request.Header.Get("User-Agent") != "claude-cli/2.1.229 (external, sdk-cli)":
		return "messages_user_agent"
	case !hasHeaderToken(request.Header.Get("anthropic-beta"), "claude-code-20250219"):
		return "messages_claude_code_beta"
	default:
		return ""
	}
}

// validRealClaudeMessagesQuery 只接受两种已证明的官方端点形态。空 query 既可能
// 来自 Canonical Adapter，也可能来自普通 Messages 客户端的 Native Relay。
func validRealClaudeMessagesQuery(rawQuery string) bool {
	return rawQuery == "" || rawQuery == "beta=true"
}

// recordResponse 只保存最近一次真实上游状态，不记录正文、URL 或凭据。
func (budget *realClaudeRequestBudget) recordResponse(response *http.Response) {
	if budget == nil || response == nil {
		return
	}
	budget.mu.Lock()
	budget.counts.lastStatus = response.StatusCode
	budget.mu.Unlock()
}

// observeStream 用透明 Reader 观察真实 SSE 的稳定协议终态。
// 它不预读、不改变分块和关闭语义，也不保存任意 Provider 正文。
func (budget *realClaudeRequestBudget) observeStream(response *http.Response) {
	if budget == nil || response == nil || response.Body == nil {
		return
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/event-stream" {
		return
	}
	observer := &realClaudeSSEObserver{}
	response.Body = &realClaudeObservedBody{
		ReadCloser: response.Body,
		observer:   observer,
		record:     budget.recordStream,
	}
}

// recordStream 原子替换最近一次 SSE 的低敏终态观察值。
func (budget *realClaudeRequestBudget) recordStream(
	observation realClaudeStreamObservation,
) {
	if budget == nil {
		return
	}
	budget.mu.Lock()
	budget.stream = observation
	budget.mu.Unlock()
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

// streamObservation 返回最近一次真实 SSE 的低敏终态。
func (budget *realClaudeRequestBudget) streamObservation() realClaudeStreamObservation {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	return budget.stream
}

// realClaudeObservedBody 保持原 Body 的读取和关闭行为，并在完成时提交观察值。
type realClaudeObservedBody struct {
	io.ReadCloser
	observer *realClaudeSSEObserver
	record   func(realClaudeStreamObservation)
	once     sync.Once
}

// Read 先返回原始字节，再仅从同一字节提取稳定终态字段。
func (body *realClaudeObservedBody) Read(payload []byte) (int, error) {
	read, err := body.ReadCloser.Read(payload)
	if read > 0 {
		body.observer.Write(payload[:read])
	}
	if err != nil {
		body.finish()
	}
	return read, err
}

// Close 保持上游关闭结果，并确保未读到 EOF 时也完成低敏记录。
func (body *realClaudeObservedBody) Close() error {
	err := body.ReadCloser.Close()
	body.finish()
	return err
}

// finish 只执行一次，并立即清除尚未形成完整 SSE 行的临时字节。
func (body *realClaudeObservedBody) finish() {
	body.once.Do(func() {
		observation := body.observer.finish()
		body.record(observation)
	})
}

// realClaudeSSEObserver 增量识别 data 行，但最多暂存 Observer 允许的错误窗口。
// 超长行会整行丢弃，绝不因真实输出长度增长内存。
type realClaudeSSEObserver struct {
	line         []byte
	droppingLine bool
	observation  realClaudeStreamObservation
}

// Write 按换行切分 SSE；任意内容只在当前有界行内短暂存在。
func (observer *realClaudeSSEObserver) Write(payload []byte) {
	for len(payload) > 0 {
		newline := bytes.IndexByte(payload, '\n')
		if newline < 0 {
			observer.appendLine(payload)
			return
		}
		observer.appendLine(payload[:newline])
		observer.completeLine()
		payload = payload[newline+1:]
	}
}

// appendLine 在固定上限内累计跨 Read 的单行数据。
func (observer *realClaudeSSEObserver) appendLine(fragment []byte) {
	if observer.droppingLine || len(fragment) == 0 {
		return
	}
	if len(observer.line)+len(fragment) > sharedfailure.MaxErrorPayloadBytes {
		clear(observer.line)
		observer.line = nil
		observer.droppingLine = true
		return
	}
	observer.line = append(observer.line, fragment...)
}

// completeLine 仅解析 data JSON 的 type/error.type/error.code。
func (observer *realClaudeSSEObserver) completeLine() {
	defer func() {
		clear(observer.line)
		observer.line = nil
		observer.droppingLine = false
	}()
	if observer.droppingLine {
		return
	}
	line := bytes.TrimSpace(observer.line)
	if !bytes.HasPrefix(line, []byte("data:")) {
		return
	}
	var envelope struct {
		Type  string `json:"type"`
		Code  string `json:"code"`
		Error *struct {
			Type string `json:"type"`
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(bytes.TrimSpace(line[len("data:"):]), &envelope) != nil {
		return
	}
	if terminal, valid := sharedfailure.NormalizeErrorToken(envelope.Type); valid &&
		terminal == "message_stop" {
		observer.observation.terminal = terminal
	}
	if envelope.Error != nil {
		observer.observation.errorType, _ = sharedfailure.NormalizeErrorToken(
			envelope.Error.Type,
		)
		observer.observation.errorCode, _ = sharedfailure.NormalizeErrorToken(
			envelope.Error.Code,
		)
		return
	}
	if realClaudeTopLevelErrorType(envelope.Type) {
		observer.observation.errorType, _ = sharedfailure.NormalizeErrorToken(
			envelope.Type,
		)
	}
	if code, valid := sharedfailure.NormalizeErrorToken(envelope.Code); valid {
		observer.observation.errorCode = code
	}
}

// realClaudeTopLevelErrorType 与生产 Claude Observer 支持的顶层错误类型一致。
func realClaudeTopLevelErrorType(value string) bool {
	normalized, valid := sharedfailure.NormalizeErrorToken(value)
	if !valid {
		return false
	}
	switch normalized {
	case "api_error",
		"authentication_error",
		"billing_error",
		"invalid_request_error",
		"overloaded_error",
		"permission_error",
		"quota_error",
		"rate_limit_error":
		return true
	default:
		return false
	}
}

// finish 清除半行并返回不含任意正文的观察值。
func (observer *realClaudeSSEObserver) finish() realClaudeStreamObservation {
	if observer == nil {
		return realClaudeStreamObservation{}
	}
	clear(observer.line)
	observer.line = nil
	observer.droppingLine = false
	return observer.observation
}

// TestRealClaudeSSEObserverKeepsOnlyStableTerminal 验证观察器跨分块识别终态，
// 同时丢弃 Provider message、模型、正文和签名等任意敏感值。
func TestRealClaudeSSEObserverKeepsOnlyStableTerminal(t *testing.T) {
	t.Parallel()

	observer := &realClaudeSSEObserver{}
	for _, fragment := range [][]byte{
		[]byte("event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_"),
		[]byte("error\",\"code\":\"upstream_unavailable\",\"message\":\"secret-message\"}}\n\n"),
		[]byte("data: {\"type\":\"message_stop\",\"signature\":\"secret-signature\"}\n\n"),
	} {
		observer.Write(fragment)
	}
	got := observer.finish()
	want := realClaudeStreamObservation{
		terminal:  "message_stop",
		errorType: "api_error",
		errorCode: "upstream_unavailable",
	}
	if got != want {
		t.Fatalf("SSE 低敏观察值错误: got=%+v want=%+v", got, want)
	}
	encoded, err := json.Marshal(got)
	if err != nil || bytes.Contains(encoded, []byte("secret")) {
		t.Fatalf("SSE 观察值泄露任意正文: json=%s error=%v", encoded, err)
	}
}

// TestRealClaudeSSEObserverDropsOversizedLine 验证异常长内容行不会增长观察内存，
// 且下一条合法终态仍然可以被识别。
func TestRealClaudeSSEObserverDropsOversizedLine(t *testing.T) {
	t.Parallel()

	observer := &realClaudeSSEObserver{}
	observer.Write(bytes.Repeat(
		[]byte("x"),
		sharedfailure.MaxErrorPayloadBytes+1,
	))
	observer.Write([]byte("\ndata: {\"type\":\"message_stop\"}\n"))
	got := observer.finish()
	if got.terminal != "message_stop" || len(observer.line) != 0 {
		t.Fatalf("超长 SSE 行处理错误: observation=%+v retained=%d", got, len(observer.line))
	}
}

// TestRealClaudeSSEObserverKeepsTopLevelError 验证生产分类器允许的顶层
// api_error 不会在测试观察值中被误报为空。
func TestRealClaudeSSEObserverKeepsTopLevelError(t *testing.T) {
	t.Parallel()

	observer := &realClaudeSSEObserver{}
	observer.Write([]byte(
		"data: {\"type\":\"api_error\",\"code\":\"upstream_unavailable\",\"message\":\"secret\"}\n",
	))
	got := observer.finish()
	if got.errorType != "api_error" || got.errorCode != "upstream_unavailable" {
		t.Fatalf("顶层 SSE 错误观察值错误: %+v", got)
	}
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

// validateRealClaudeMessagesBodyWithReason 在固定字段类别上给出低敏失败原因。
func validateRealClaudeMessagesBodyWithReason(
	request *http.Request,
) (realClaudeMessageShape, string, error) {
	if request.Body == nil {
		return realClaudeMessageShape{}, "body_missing", errUnexpectedRealClaudeRequest
	}
	payload, err := io.ReadAll(io.LimitReader(
		request.Body,
		realClaudeTransferMaxFileBytes+1,
	))
	_ = request.Body.Close()
	if err != nil || len(payload) == 0 || len(payload) > realClaudeTransferMaxFileBytes {
		clear(payload)
		return realClaudeMessageShape{}, "body_read", errUnexpectedRealClaudeRequest
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
		Tools    []json.RawMessage `json:"tools"`
		Thinking json.RawMessage   `json:"thinking"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return realClaudeMessageShape{}, "json", errUnexpectedRealClaudeRequest
	}
	if document.Model != realClaudeTransferModel {
		if document.Model != realClaudeReasoningModel {
			return realClaudeMessageShape{}, "model", errUnexpectedRealClaudeRequest
		}
	}
	if document.MaxTokens != realClaudeExpectedMaxTokens &&
		document.MaxTokens != realAnthropicMaxTokens {
		return realClaudeMessageShape{}, "max_tokens", errUnexpectedRealClaudeRequest
	}
	wantAccept := "application/json"
	if document.Stream {
		wantAccept = "text/event-stream"
	}
	if request.Header.Get("Accept") != wantAccept {
		return realClaudeMessageShape{}, "stream", errUnexpectedRealClaudeRequest
	}
	if len(document.System) == 0 ||
		document.System[0].Type != "text" ||
		document.System[0].Text != "You are Claude Code, Anthropic's official CLI for Claude." {
		return realClaudeMessageShape{}, "system", errUnexpectedRealClaudeRequest
	}
	if !containsRealClaudeMarker(payload) {
		return realClaudeMessageShape{}, "marker", errUnexpectedRealClaudeRequest
	}
	return realClaudeMessageShape{
		stream:   document.Stream,
		tool:     len(document.Tools) > 0,
		thinking: len(document.Thinking) > 0 && string(document.Thinking) != "null",
	}, "", nil
}

// containsRealClaudeMarker 限制真实上游只能接收本测试声明的固定低敏文本。
func containsRealClaudeMarker(payload []byte) bool {
	for _, marker := range []string{
		realClaudeTransferMarker,
		realClaudeContinuityMarker,
		realClaudeToolMarker,
		realClaudeReasoningMarker,
	} {
		if bytes.Contains(payload, []byte(marker)) {
			return true
		}
	}
	return false
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
	want := realClaudeRequestCounts{
		messages:       1,
		streamMessages: 1,
		unexpected:     1,
		lastStatus:     http.StatusOK,
	}
	if got := budget.snapshot(); got != want || transportCalls != 1 {
		t.Fatalf("真实 Claude 请求预算失效: counts=%+v transport_calls=%d", got, transportCalls)
	}
}

// TestRealClaudeRequestBudgetAllowsCanonicalAndNativeStreams 验证同一安全边界
// 同时接受 Canonical Adapter 固定的流式上游合同，以及公开 Messages 非流式透传。
// 两种 max_tokens 都来自现有协议：跨协议缺省使用 Claude Code 当前默认值，
// Anthropic Messages 则保留客户端明确提供的必填上限。
func TestRealClaudeRequestBudgetAllowsCanonicalAndNativeStreams(t *testing.T) {
	t.Parallel()

	requests := []struct {
		name       string
		body       string
		accept     string
		rawQuery   string
		wantStream bool
	}{
		{
			name: "canonical stream",
			body: `{"model":"claude-opus-5","max_tokens":64000,"stream":true,` +
				`"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],` +
				`"messages":[{"role":"user","content":"AIH_REAL_CLAUDE_TRANSFER_OK"}]}`,
			accept:     "text/event-stream",
			wantStream: true,
		},
		{
			name: "native non stream",
			body: `{"model":"claude-opus-5","max_tokens":4096,"stream":false,` +
				`"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],` +
				`"messages":[{"role":"user","content":"AIH_REAL_CLAUDE_TRANSFER_OK"}]}`,
			accept:     "application/json",
			wantStream: false,
		},
		{
			name: "native beta non stream",
			body: `{"model":"claude-opus-5","max_tokens":4096,"stream":false,` +
				`"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],` +
				`"messages":[{"role":"user","content":"AIH_REAL_CLAUDE_TRANSFER_OK"}]}`,
			accept:     "application/json",
			rawQuery:   "beta=true",
			wantStream: false,
		},
	}
	transportCalls := 0
	budget := &realClaudeRequestBudget{
		maxMessages: len(requests),
		client: &http.Client{Transport: realCodexRoundTripperFunc(func(
			request *http.Request,
		) (*http.Response, error) {
			transportCalls++
			var document struct {
				Stream bool `json:"stream"`
			}
			if err := json.NewDecoder(request.Body).Decode(&document); err != nil {
				t.Fatalf("读取预算内请求失败: %v", err)
			}
			if document.Stream != requests[transportCalls-1].wantStream {
				t.Fatalf("stream=%t want=%t", document.Stream, requests[transportCalls-1].wantStream)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("{}")),
			}, nil
		})},
	}

	for _, testCase := range requests {
		t.Run(testCase.name, func(t *testing.T) {
			request := newBudgetClaudeMessagesRequest(t, testCase.body)
			request.Header.Set("Accept", testCase.accept)
			request.URL.RawQuery = testCase.rawQuery
			response, err := budget.Do(request)
			if err != nil || response == nil {
				t.Fatalf("预算内 Claude 请求被拒绝: %v", err)
			}
			_ = response.Body.Close()
		})
	}
	if got := budget.snapshot(); got != (realClaudeRequestCounts{
		messages:          3,
		streamMessages:    1,
		nonStreamMessages: 2,
		lastStatus:        http.StatusOK,
	}) ||
		transportCalls != 3 {
		t.Fatalf("流式/非流式预算错误: counts=%+v calls=%d", got, transportCalls)
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
	request.Header.Set("User-Agent", "claude-cli/2.1.229 (external, sdk-cli)")
	return request
}

// TestRealClaudeSub2APITransferEndToEnd 从只读原生 artifact 或真实标准导出
// 导入一个 OAuth 账号，再完成 Go 导出、sub2api 再导入、模型目录和推理闭环。
//
// 默认跳过；显式提供一种来源后最多产生两次目录请求与一次推理请求。
func TestRealClaudeSub2APITransferEndToEnd(t *testing.T) {
	if !realClaudeFixtureSourceConfigured() {
		t.Skip("设置一组真实 Claude 只读来源后才允许迁移验收")
	}
	sourceBudget := newRealClaudeRequestBudget(0)
	sourceModels := newRealClaudeModelCatalog(t, sourceBudget)
	sourceHome := newDisposableRealCodexHome(t)
	sourceURL, sourceClient := startRealCodexServer(
		t,
		sourceHome,
		sourceBudget,
		[]accountapp.ProviderModelDiscoverer{sourceModels},
	)
	sourceImported := importRealClaudeFixtureAccount(t, sourceURL, sourceClient)
	assertRealStatus(t, sourceImported, http.StatusCreated)
	sourceRef := decodeRealTransferAccountRef(t, sourceImported.body)
	sourceExported := performRequest(
		t,
		sourceClient,
		http.MethodGet,
		sourceURL+accountsapi.CollectionPath+"/"+sourceRef+"/export",
		testManagementKey,
		nil,
	)
	assertRealStatus(t, sourceExported, http.StatusOK)
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
	assertRealStatus(t, targetImported, http.StatusCreated)
	targetRef := decodeRealTransferAccountRef(t, targetImported.body)

	models := performRequest(
		t,
		targetClient,
		http.MethodGet,
		targetURL+modelsapi.Path,
		testClientKey,
		nil,
	)
	assertRealStatus(t, models, http.StatusOK)
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
	assertRealStatus(t, reexported, http.StatusOK)
	assertRealSub2APIDocument(t, []byte(reexported.body))
	wantSource := realClaudeRequestCounts{models: 1, lastStatus: http.StatusOK}
	if got := sourceBudget.snapshot(); got != wantSource {
		t.Fatalf("源 Server 真实请求预算错误: got=%+v want=%+v", got, wantSource)
	}
	wantTarget := realClaudeRequestCounts{
		models:         1,
		messages:       1,
		streamMessages: 1,
		lastStatus:     http.StatusOK,
	}
	if got := targetBudget.snapshot(); got != wantTarget {
		t.Fatalf("目标 Server 真实请求预算错误: got=%+v want=%+v", got, wantTarget)
	}

	sourceImportPath := accountsapi.Sub2APIImportPath
	sourcePayload := "<selected-standard-account>"
	if realClaudeNativeArtifactSourceConfigured() {
		sourceImportPath = accountsapi.NativeImportPath
		sourcePayload = "<readonly-native-artifacts>"
	}
	t.Logf(
		strings.Join([]string{
			"真实 Claude sub2api 迁移验收通过",
			"source_artifacts: path=<redacted> mode=0600 readonly=true local_identity_fields=false",
			"source_import: POST %s payload=%s status=%d",
			"source_export: GET %s/v1/management/accounts/{account_ref}/export status=%d version=1",
			"target_import: POST %s payload=<source-go-export> status=%d",
			"models: GET %s status=%d count=%d contains_%s=true",
			"inference: POST %s payload={model:%s,input:<fixed-marker>,stream:false} status=%d response={object:response,status:completed,marker_present:true}",
			"target_reexport: GET %s/v1/management/accounts/{account_ref}/export status=%d version=1",
			"upstream_requests: source_models=1 target_models=1 target_messages=1 unexpected=0",
			"temporary_databases=2 cleanup=registered formal_database_mutations=0",
		}, "\n"),
		sourceURL+sourceImportPath,
		sourcePayload,
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
	decodeRealJSON(t, body, &document)
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
