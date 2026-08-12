package messages

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	clientanthropic "github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
)

const (
	// realClaudeAccountHomeEnv 显式选择只用于真实测试的隔离 AIH 数据目录。
	realClaudeAccountHomeEnv = "AIH_REAL_CLAUDE_ACCOUNT_HOME"
	// realClaudeAccountIDEnv 显式选择隔离数据库中的 Claude CLI 账号 ID。
	realClaudeAccountIDEnv = "AIH_REAL_CLAUDE_ACCOUNT_ID"
	// realClaudeModelEnv 可显式选择该账号已物化且上游可用的模型。
	realClaudeModelEnv = "AIH_REAL_CLAUDE_MODEL"
	// realClaudeOAuthSmokeEnv 显式选择真实账号检查 OAuth 传输边界，不访问上游。
	realClaudeOAuthSmokeEnv = "AIH_REAL_CLAUDE_OAUTH_SMOKE"
	// realClaudeReasoningSmokeEnv 显式授权两轮 reasoning 连续性真实请求。
	realClaudeReasoningSmokeEnv = "AIH_REAL_CLAUDE_REASONING_SMOKE"
	// realClaudeToolSmokeEnv 显式授权一次只返回客户端工具调用的真实请求。
	realClaudeToolSmokeEnv = "AIH_REAL_CLAUDE_TOOL_SMOKE"
	// realClaudeRedactedThinkingSmokeEnv 显式授权两轮 redacted thinking 连续性请求。
	realClaudeRedactedThinkingSmokeEnv = "AIH_REAL_CLAUDE_REDACTED_THINKING_SMOKE"
	// realClaudeSmokeModel 是未显式覆盖时使用的真实验收模型。
	realClaudeSmokeModel = "claude-opus-5"
	// realClaudeSmokeAlias 确保真实请求必须先经过 RouteCatalog。
	realClaudeSmokeAlias = "aih-real-claude-route-smoke"
	// realClaudeSmokePrompt 是唯一允许发送给真实上游的固定低敏文本。
	realClaudeSmokePrompt = "Reply with exactly: AIH_REAL_CLAUDE_OK"
	// realClaudeSmokeExpected 是真实响应必须返回的固定文本。
	realClaudeSmokeExpected = "AIH_REAL_CLAUDE_OK"
	// realClaudeReasoningModel 是账号模型目录中用于 reasoning 验收的当前模型。
	realClaudeReasoningModel = "claude-sonnet-5"
	// realClaudeReasoningPrompt 触发最小推理，并要求公开回答包含固定标记。
	realClaudeReasoningPrompt = "Compute 17 * 19, then reply with exactly: AIH_REAL_CLAUDE_REASONING_OK"
	// realClaudeReasoningExpected 是第一轮公开回答的固定值。
	realClaudeReasoningExpected = "AIH_REAL_CLAUDE_REASONING_OK"
	// realClaudeReplayPrompt 要求第二轮只返回固定连续性验收值。
	realClaudeReplayPrompt = "Reply with exactly: AIH_REAL_CLAUDE_REPLAY_OK"
	// realClaudeReplayExpected 是第二轮公开回答的固定值。
	realClaudeReplayExpected = "AIH_REAL_CLAUDE_REPLAY_OK"
)

// TestLiveClaudeRouteCatalogSmoke 使用显式选择的 Claude OAuth 或 API Key 账号，
// 先验证账号物化模型目录，再贯通真实 Messages API。
func TestLiveClaudeRouteCatalogSmoke(t *testing.T) {
	if os.Getenv("AIH_REAL_CLAUDE_SMOKE") != "1" {
		t.Skip("设置 AIH_REAL_CLAUDE_SMOKE=1 后才允许真实上游请求")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	selection := loadRealClaudeCanonicalSelection(t, realClaudeSmokeModel)
	request := newRealClaudeRequest(t, selection.model)
	coordinator, recorder, transport := newRealClaudeCoordinator(
		t,
		selection.credential,
		selection.model,
	)
	events := make([]inference.StreamEvent, 0, 16)

	err := coordinator.Execute(
		ctx,
		request,
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("真实 Claude Execute() error = %v", err)
	}
	output := completedClaudeText(events)
	authKind := "unknown"
	if auth, ok := selection.credential.(claudeauth.Auth); ok {
		authKind = auth.Kind().String()
	}
	if recorder.successes != 1 ||
		len(recorder.failures) != 0 ||
		len(events) == 0 ||
		events[len(events)-1].Kind() != inference.EventResponseCompleted ||
		strings.TrimSpace(output) != realClaudeSmokeExpected {
		runtimeKind := "none"
		retryAfter := time.Duration(0)
		if len(recorder.failures) > 0 {
			runtimeKind = string(recorder.failures[0].RuntimeKind())
			retryAfter = recorder.failures[0].RetryAfter()
		}
		t.Fatalf(
			"真实 Claude 结果异常: method=%s endpoint=%s http_status=%d media_type=%s successes=%d failures=%d runtime_kind=%s retry_after=%s events=%s output=%q",
			transport.method,
			transport.endpoint,
			transport.statusCode,
			transport.mediaType,
			recorder.successes,
			len(recorder.failures),
			runtimeKind,
			retryAfter,
			eventKinds(events),
			output,
		)
	}
	t.Logf(
		"real_claude_route_smoke method=%s endpoint=%s model=%s max_tokens=%d stream=true http_status=%d media_type=%s auth=%s events=%s output=%q",
		transport.method,
		transport.endpoint,
		selection.model,
		request.MaxOutputTokens(),
		transport.statusCode,
		transport.mediaType,
		authKind,
		eventKinds(events),
		output,
	)
}

// TestLiveClaudeOAuthRouteCatalogDiagnostic 验证真实订阅 OAuth 账号可被
// Canonical Adapter 投影为官方 Bearer 合同，且能力判定不产生任何上游请求。
func TestLiveClaudeOAuthRouteCatalogDiagnostic(t *testing.T) {
	if os.Getenv(realClaudeOAuthSmokeEnv) != "1" {
		t.Skip("设置 AIH_REAL_CLAUDE_OAUTH_SMOKE=1 后检查真实 OAuth 传输边界")
	}

	selection := loadRealClaudeOAuthSelection(t, realClaudeSmokeModel)
	client := &claudeRecordingHTTPClient{}
	adapter, err := NewAdapter(client, time.Now)
	if err != nil {
		t.Fatalf("NewAdapter() error = %v", err)
	}
	profile, projectErr := projectAuth(selection.credential)
	summary := profile.safeSummary()
	if !adapter.SupportsCredential(selection.credential) ||
		projectErr != nil ||
		summary.HeaderName != "Authorization" ||
		!summary.OAuthBeta ||
		client.calls != 0 {
		t.Fatalf(
			"订阅 OAuth 传输边界错误: supported=%t error=%v summary=%+v calls=%d",
			adapter.SupportsCredential(selection.credential),
			projectErr,
			summary,
			client.calls,
		)
	}
	t.Logf(
		"real_claude_oauth_transport model=%s endpoint=%s auth_header=%s oauth_beta=%t canonical_upstream_calls=%d",
		selection.model,
		summary.Endpoint,
		summary.HeaderName,
		summary.OAuthBeta,
		client.calls,
	)
}

// TestLiveClaudeReasoningContinuitySmoke 使用可直连凭据做两轮受控请求：
// 第一轮验证 thinking/signature，第二轮验证 Responses 历史可回放到 Claude。
func TestLiveClaudeReasoningContinuitySmoke(t *testing.T) {
	if os.Getenv(realClaudeReasoningSmokeEnv) != "1" {
		t.Skip("设置 AIH_REAL_CLAUDE_REASONING_SMOKE=1 后才允许真实 reasoning 请求")
	}

	selection := loadRealClaudeCanonicalSelection(t, realClaudeReasoningModel)

	firstRequest := newRealClaudeReasoningRequest(t, selection.model)
	firstEvents, firstRecorder, firstTransport, firstErr := executeRealClaudeRequest(
		t,
		selection.credential,
		selection.model,
		firstRequest,
	)
	firstFingerprint := strings.Join(firstTransport.fingerprint(), "|")
	firstOutputMatch := strings.Contains(
		completedClaudeText(firstEvents),
		realClaudeReasoningExpected,
	)
	if firstErr != nil ||
		firstRecorder.successes != 1 ||
		len(firstRecorder.failures) != 0 ||
		!hasReasoningDelta(firstEvents, inference.ReasoningDeltaSignature) ||
		!hasCompletedThinking(firstEvents) ||
		!firstOutputMatch {
		t.Logf(
			"real_claude_reasoning_first method=%s endpoint=%s model=%s max_tokens=%d stream=true http_status=%d media_type=%s successes=%d failures=%d reasoning_deltas=%s events=%s fingerprint=%s output_match=%t",
			firstTransport.method,
			firstTransport.endpoint,
			selection.model,
			firstRequest.MaxOutputTokens(),
			firstTransport.statusCode,
			firstTransport.mediaType,
			firstRecorder.successes,
			len(firstRecorder.failures),
			reasoningDeltaKinds(firstEvents),
			eventKinds(firstEvents),
			firstFingerprint,
			firstOutputMatch,
		)
		if firstErr != nil {
			t.Fatalf("真实 Claude reasoning 第一轮失败: %v", firstErr)
		}
		t.Fatal("真实 Claude reasoning 第一轮未满足 thinking/signature 合同")
	}

	firstResponse := aggregateRealClaudeResponses(t, firstRequest, firstEvents)
	defer clear(firstResponse)
	replayRequest := decodeRealClaudeReplayRequest(
		t,
		firstResponse,
		selection.model,
	)
	secondEvents, secondRecorder, secondTransport, secondErr := executeRealClaudeRequest(
		t,
		selection.credential,
		selection.model,
		replayRequest,
	)
	secondFingerprint := strings.Join(secondTransport.fingerprint(), "|")
	secondOutputMatch := strings.TrimSpace(completedClaudeText(secondEvents)) ==
		realClaudeReplayExpected
	if secondErr != nil ||
		secondRecorder.successes != 1 ||
		len(secondRecorder.failures) != 0 ||
		!secondOutputMatch {
		t.Logf(
			"real_claude_reasoning_replay method=%s endpoint=%s model=%s max_tokens=%d stream=false http_status=%d media_type=%s successes=%d failures=%d reasoning_deltas=%s events=%s fingerprint=%s output_match=%t",
			secondTransport.method,
			secondTransport.endpoint,
			selection.model,
			replayRequest.MaxOutputTokens(),
			secondTransport.statusCode,
			secondTransport.mediaType,
			secondRecorder.successes,
			len(secondRecorder.failures),
			reasoningDeltaKinds(secondEvents),
			eventKinds(secondEvents),
			secondFingerprint,
			secondOutputMatch,
		)
		if secondErr != nil {
			t.Fatalf("真实 Claude reasoning 回放失败: %v", secondErr)
		}
		t.Fatal("真实 Claude reasoning 回放未满足成功合同")
	}

	secondResponse := aggregateRealClaudeResponses(t, replayRequest, secondEvents)
	defer clear(secondResponse)
	if bytes.Contains(secondResponse, []byte(`"encrypted_content"`)) {
		t.Fatal("未声明 include 的非流式 Responses 响应泄漏 encrypted_content")
	}
	t.Logf(
		"real_claude_reasoning_continuity endpoint=%s model=%s first_http_status=%d first_stream=true first_reasoning_deltas=%s first_usage=%s first_output_match=%t replay_http_status=%d replay_stream=false replay_reasoning_deltas=%s replay_usage=%s replay_output_match=%t replay_encrypted_content_omitted=true",
		firstTransport.endpoint,
		selection.model,
		firstTransport.statusCode,
		reasoningDeltaKinds(firstEvents),
		usageEventShape(firstEvents),
		firstOutputMatch,
		secondTransport.statusCode,
		reasoningDeltaKinds(secondEvents),
		usageEventShape(secondEvents),
		secondOutputMatch,
	)
}

// TestLiveClaudeToolUseSmoke 使用显式账号要求模型只返回一次工具调用，
// 验证真实 tool_use SSE 能无损进入 Canonical 事件，而不执行任何本地工具。
func TestLiveClaudeToolUseSmoke(t *testing.T) {
	if os.Getenv(realClaudeToolSmokeEnv) != "1" {
		t.Skip("设置 AIH_REAL_CLAUDE_TOOL_SMOKE=1 后才允许真实工具请求")
	}

	selection := loadRealClaudeCanonicalSelection(t, realClaudeReasoningModel)
	tool, err := inference.NewToolDefinition(
		"aih_probe",
		"Return the requested fixed probe value",
		[]byte(`{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false}`),
	)
	if err != nil {
		t.Fatalf("创建真实工具定义失败: %v", err)
	}
	toolChoice, err := inference.NewNamedToolChoice("aih_probe")
	if err != nil {
		t.Fatalf("创建真实工具选择失败: %v", err)
	}
	request := newRealClaudeToolRequest(t, selection.model, tool, toolChoice)

	events, recorder, transport, executeErr := executeRealClaudeRequest(
		t,
		selection.credential,
		selection.model,
		request,
	)
	fingerprint := strings.Join(transport.fingerprint(), "|")
	toolCompleted := false
	argumentsMatch := false
	stopReason := inference.StopReason("")
	for _, event := range events {
		switch typed := event.(type) {
		case inference.ToolCallCompletedEvent:
			var arguments struct {
				Value string `json:"value"`
			}
			argumentsErr := json.Unmarshal(typed.Arguments(), &arguments)
			toolCompleted = typed.Name() == "aih_probe"
			argumentsMatch = argumentsErr == nil &&
				arguments.Value == "AIH_TOOL_ARGUMENT_OK"
		case inference.ResponseCompletedEvent:
			stopReason = typed.StopReason()
		}
	}
	t.Logf(
		"real_claude_tool_use method=%s endpoint=%s model=%s max_tokens=%d stream=true http_status=%d media_type=%s successes=%d failures=%d events=%s fingerprint=%s tool_completed=%t arguments_match=%t stop_reason=%s",
		transport.method,
		transport.endpoint,
		selection.model,
		request.MaxOutputTokens(),
		transport.statusCode,
		transport.mediaType,
		recorder.successes,
		len(recorder.failures),
		eventKinds(events),
		fingerprint,
		toolCompleted,
		argumentsMatch,
		stopReason,
	)
	if executeErr != nil {
		t.Fatalf("真实 Claude tool_use 请求失败: %v", executeErr)
	}
	if recorder.successes != 1 ||
		len(recorder.failures) != 0 ||
		!toolCompleted ||
		!argumentsMatch ||
		stopReason != inference.StopReasonToolUse {
		t.Fatal("真实 Claude tool_use 未满足成功合同")
	}
}

// TestLiveClaudeRedactedThinkingSmoke 使用可直连凭据观察两轮
// omitted thinking 请求：请求形状必须满足 Claude Code 合同；只有上游实际
// 下发 redacted_thinking 时才执行原样回放断言。上游可能因账号、模型或实验
// 开关返回普通 signed thinking，此时记录观测结果，不把服务端能力误报为适配器失败。
func TestLiveClaudeRedactedThinkingSmoke(t *testing.T) {
	if os.Getenv(realClaudeRedactedThinkingSmokeEnv) != "1" {
		t.Skip("设置 AIH_REAL_CLAUDE_REDACTED_THINKING_SMOKE=1 后才允许真实请求")
	}

	selection := loadRealClaudeCanonicalSelection(t, realClaudeSmokeModel)
	request := newRealClaudeRedactedThinkingRequest(t, selection.model)

	events, recorder, transport, executeErr := executeRealClaudeRequest(
		t,
		selection.credential,
		selection.model,
		request,
	)
	firstFingerprint := strings.Join(transport.fingerprint(), "|")
	requestFingerprint := transport.requestFingerprint()
	outputMatch := strings.Contains(
		completedClaudeText(events),
		realClaudeReasoningExpected,
	)
	redacted := hasCompletedRedactedThinking(events)
	visibleThinking := hasCompletedThinking(events)
	if executeErr != nil {
		t.Fatalf("真实 Claude redacted thinking 请求失败: %v", executeErr)
	}
	if recorder.successes != 1 ||
		len(recorder.failures) != 0 ||
		transport.statusCode != http.StatusOK ||
		!outputMatch {
		t.Logf(
			"real_claude_redacted_first method=%s endpoint=%s model=%s max_tokens=%d stream=true http_status=%d media_type=%s successes=%d failures=%d redacted_completed=%t visible_thinking=%t events=%s request=%s fingerprint=%s output_match=%t",
			transport.method,
			transport.endpoint,
			selection.model,
			request.MaxOutputTokens(),
			transport.statusCode,
			transport.mediaType,
			recorder.successes,
			len(recorder.failures),
			redacted,
			visibleThinking,
			eventKinds(events),
			requestFingerprint,
			firstFingerprint,
			outputMatch,
		)
		t.Fatal("真实 Claude omitted thinking 请求未满足成功合同")
	}
	// 请求 beta、thinking 形状和 effort 是适配器必须负责的部分；服务端是否
	// 选择 redacted_thinking 不由客户端声明单独决定，因此不能省略这组断言。
	// display=none 表示没有向上游添加未经官方确认的私有 display 字段。
	if !strings.Contains(requestFingerprint, "redact_beta=true") ||
		!strings.Contains(requestFingerprint, "interleaved_beta=true") ||
		!strings.Contains(requestFingerprint, "thinking_type=adaptive") ||
		!strings.Contains(requestFingerprint, "thinking_display=none") ||
		!strings.Contains(requestFingerprint, "effort=low") {
		t.Fatalf("真实 Claude omitted thinking 请求形状错误: %s", requestFingerprint)
	}
	if !redacted {
		if !visibleThinking {
			t.Fatalf("真实 Claude 未返回 redacted_thinking，也未返回 signed thinking: events=%s", eventKinds(events))
		}
		t.Logf(
			"real_claude_redacted_observed endpoint=%s model=%s http_status=%d request=%s response=%s redacted_available=false visible_signed_thinking=true output_match=%t; upstream did not enable redacted_thinking",
			transport.endpoint,
			selection.model,
			transport.statusCode,
			requestFingerprint,
			firstFingerprint,
			outputMatch,
		)
		return
	}

	firstResponse := aggregateRealClaudeAnthropicMessage(t, request, events)
	defer clear(firstResponse)
	replayRequest := decodeRealClaudeAnthropicReplayRequest(
		t,
		firstResponse,
		selection.model,
	)
	replayEvents, replayRecorder, replayTransport, replayErr := executeRealClaudeRequest(
		t,
		selection.credential,
		selection.model,
		replayRequest,
	)
	replayFingerprint := strings.Join(replayTransport.fingerprint(), "|")
	replayOutputMatch := strings.TrimSpace(completedClaudeText(replayEvents)) ==
		realClaudeReplayExpected
	if replayErr != nil ||
		replayRecorder.successes != 1 ||
		len(replayRecorder.failures) != 0 ||
		!replayOutputMatch {
		t.Logf(
			"real_claude_redacted_replay method=%s endpoint=%s model=%s max_tokens=%d stream=false http_status=%d media_type=%s successes=%d failures=%d events=%s fingerprint=%s output_match=%t",
			replayTransport.method,
			replayTransport.endpoint,
			selection.model,
			replayRequest.MaxOutputTokens(),
			replayTransport.statusCode,
			replayTransport.mediaType,
			replayRecorder.successes,
			len(replayRecorder.failures),
			eventKinds(replayEvents),
			replayFingerprint,
			replayOutputMatch,
		)
		if replayErr != nil {
			t.Fatalf("真实 Claude redacted thinking 回放失败: %v", replayErr)
		}
		t.Fatal("真实 Claude redacted thinking 回放未满足成功合同")
	}
	t.Logf(
		"real_claude_redacted_continuity endpoint=%s model=%s first_http_status=%d first_stream=true redacted_completed=true first_usage=%s first_output_match=%t replay_http_status=%d replay_stream=false replay_usage=%s replay_output_match=%t",
		transport.endpoint,
		selection.model,
		transport.statusCode,
		usageEventShape(events),
		outputMatch,
		replayTransport.statusCode,
		usageEventShape(replayEvents),
		replayOutputMatch,
	)
}

// TestLiveClaudeAuthPreflight 只验证显式账号、凭据和物化模型，不访问网络。
func TestLiveClaudeAuthPreflight(t *testing.T) {
	if !hasRealClaudeAccountSelection() {
		t.Skip("显式选择 Claude AIH_HOME 和账号 ID 后才检查真实账号")
	}

	selection := loadRealClaudeAccountSelection(t, realClaudeSmokeModel)
	claudeCredential, ok := selection.credential.(claudeauth.Auth)
	if !ok {
		t.Fatalf("真实 Claude 测试账号凭据类型无效: %T", selection.credential)
	}
	oauth, isOAuth := selection.credential.(*claudeauth.OAuthAuth)
	expiresAt := "not_applicable"
	refreshDue := false
	if isOAuth {
		expiresAt = time.UnixMilli(oauth.ExpiresAtMS()).UTC().Format(time.RFC3339)
		refreshDue = time.Until(time.UnixMilli(oauth.ExpiresAtMS())) <= 5*time.Minute
	}
	t.Logf(
		"real_claude_auth_preflight auth=%s model=%s upstream_available=true effective=true expires_at=%s refresh_due=%t",
		claudeCredential.Kind().String(),
		selection.model,
		expiresAt,
		refreshDue,
	)
}

// TestSelectRealClaudeAccountModelUsesMaterializedAvailability 验证真实验收
// 只能选择该账号上游已发现且最终有效的模型。
func TestSelectRealClaudeAccountModelUsesMaterializedAvailability(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	models := []accountapp.AccountModel{
		newRealClaudeAccountModel(
			t,
			accountRef,
			"claude-opus-5",
			true,
			accountapp.ModelPolicyInherit,
		),
		newRealClaudeAccountModel(
			t,
			accountRef,
			"claude-sonnet-5",
			false,
			accountapp.ModelPolicyForceEnable,
		),
		newRealClaudeAccountModel(
			t,
			accountRef,
			"claude-disabled-5",
			true,
			accountapp.ModelPolicyForceDisable,
		),
	}

	selected, err := selectRealClaudeAccountModel(
		models,
		"claude-opus-5",
		"claude-sonnet-5",
	)
	if err != nil || selected != "claude-opus-5" {
		t.Fatalf("selectRealClaudeAccountModel() = (%q, %v)", selected, err)
	}
	preferred, err := selectRealClaudeAccountModel(
		models,
		"",
		"claude-opus-5",
	)
	if err != nil || preferred != "claude-opus-5" {
		t.Fatalf(
			"selectRealClaudeAccountModel(preferred) = (%q, %v)",
			preferred,
			err,
		)
	}
	for _, rejected := range []string{
		"claude-sonnet-5",
		"claude-disabled-5",
		"claude-not-in-catalog",
	} {
		if _, selectErr := selectRealClaudeAccountModel(
			models,
			rejected,
			"claude-opus-5",
		); selectErr == nil ||
			!strings.Contains(selectErr.Error(), "claude-opus-5") {
			t.Fatalf("模型 %q 未被目录合同拒绝: %v", rejected, selectErr)
		}
	}
}

// TestRealClaudeLiveRequestsEncodeCurrentModelMaxTokens 验证全部真实请求构造器
// 使用所选模型的 Claude Code 当前默认值，不用测试专属魔法数。
func TestRealClaudeLiveRequestsEncodeCurrentModelMaxTokens(t *testing.T) {
	t.Parallel()

	tool, err := inference.NewToolDefinition(
		"aih_probe",
		"Return the requested fixed probe value",
		[]byte(`{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false}`),
	)
	if err != nil {
		t.Fatalf("NewToolDefinition() error = %v", err)
	}
	toolChoice, err := inference.NewNamedToolChoice("aih_probe")
	if err != nil {
		t.Fatalf("NewNamedToolChoice() error = %v", err)
	}
	model := realClaudeSmokeModel
	expectedMaxTokens := claudeCodeDefaultMaxOutputTokens(model)
	requests := map[string]inference.Request{
		"text":              newRealClaudeRequest(t, model),
		"reasoning":         newRealClaudeReasoningRequest(t, model),
		"redacted_thinking": newRealClaudeRedactedThinkingRequest(t, model),
		"tool": newRealClaudeToolRequest(
			t,
			model,
			tool,
			toolChoice,
		),
		"replay": decodeRealClaudeReplayRequest(
			t,
			[]byte(`{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first"}]}]}`),
			model,
		),
	}
	for name, request := range requests {
		encoded, encodeErr := encodeRequest(request, model, false)
		if encodeErr != nil {
			t.Fatalf("%s encodeRequest() error = %v", name, encodeErr)
		}
		var payload struct {
			MaxTokens uint64 `json:"max_tokens"`
		}
		if jsonErr := json.Unmarshal(encoded.payload, &payload); jsonErr != nil {
			t.Fatalf("%s json.Unmarshal() error = %v", name, jsonErr)
		}
		if request.MaxOutputTokens() != expectedMaxTokens ||
			payload.MaxTokens != expectedMaxTokens {
			t.Fatalf(
				"%s max tokens: canonical=%d wire=%d want=%d",
				name,
				request.MaxOutputTokens(),
				payload.MaxTokens,
				expectedMaxTokens,
			)
		}
	}
}

// newRealClaudeAccountModel 创建模型选择单元测试使用的完整关系。
func newRealClaudeAccountModel(
	t *testing.T,
	accountRef accountcore.AccountRef,
	modelID string,
	upstreamAvailable bool,
	manualPolicy accountapp.ModelManualPolicy,
) accountapp.AccountModel {
	t.Helper()

	model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accountRef,
		ModelID:           modelID,
		UpstreamAvailable: upstreamAvailable,
		ManualPolicy:      manualPolicy,
		UpdatedAt:         time.UnixMilli(1_700_000_000_000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccountModel() error = %v", err)
	}
	return model
}

// realClaudeAccountSelection 把真实测试绑定到一个账号凭据及其已物化模型。
type realClaudeAccountSelection struct {
	credential accountapp.Credential
	model      string
}

// loadRealClaudeAccountSelection 通过正式 SQLite Store 读取显式账号，
// 并且只接受最近上游目录已发现且最终有效的模型。
func loadRealClaudeAccountSelection(
	t *testing.T,
	preferredModel string,
) realClaudeAccountSelection {
	t.Helper()

	aiHomeDir := strings.TrimSpace(os.Getenv(realClaudeAccountHomeEnv))
	rawAccountID := os.Getenv(realClaudeAccountIDEnv)
	if aiHomeDir == "" || rawAccountID == "" {
		t.Fatalf(
			"%s 和 %s 必须同时指定",
			realClaudeAccountHomeEnv,
			realClaudeAccountIDEnv,
		)
	}
	accountID, err := strconv.ParseInt(rawAccountID, 10, 64)
	if err != nil || accountID <= 0 {
		t.Fatalf("%s 必须是正整数", realClaudeAccountIDEnv)
	}
	alias, err := accountcore.NewCLIAccountID(accountID)
	if err != nil {
		t.Fatalf("创建真实测试账号 ID 失败: %v", err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("创建真实测试 Provider Catalog 失败: %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("打开真实测试账号数据库失败: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	account, err := store.GetByCLIAccountID(
		context.Background(),
		"claude",
		alias,
	)
	if err != nil {
		t.Fatalf("读取真实 Claude 测试账号失败: %v", err)
	}
	if !account.Enabled() {
		t.Fatal("真实 Claude 测试账号已停用")
	}
	credential, err := store.GetCredential(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("读取真实 Claude 测试凭据失败: %v", err)
	}
	models, err := store.ListAccountModels(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("读取真实 Claude 账号模型目录失败: %v", err)
	}
	model, err := selectRealClaudeAccountModel(
		models,
		os.Getenv(realClaudeModelEnv),
		preferredModel,
	)
	if err != nil {
		t.Fatal(err)
	}
	return realClaudeAccountSelection{
		credential: credential,
		model:      model,
	}
}

// loadRealClaudeOAuthSelection 校验真实账号必须使用未过期 OAuth 凭据。
func loadRealClaudeOAuthSelection(
	t *testing.T,
	preferredModel string,
) realClaudeAccountSelection {
	t.Helper()

	selection := loadRealClaudeAccountSelection(t, preferredModel)
	oauth, ok := selection.credential.(*claudeauth.OAuthAuth)
	if !ok {
		t.Fatalf("真实 Claude 测试账号不是 OAuth: %T", selection.credential)
	}
	requireUnexpiredClaudeOAuth(t, oauth)
	return selection
}

// requireUnexpiredClaudeOAuth 在发出任何真实请求前排除过期 Access Token。
func requireUnexpiredClaudeOAuth(t *testing.T, oauth *claudeauth.OAuthAuth) {
	t.Helper()

	expiresAt := time.UnixMilli(oauth.ExpiresAtMS())
	if !expiresAt.After(time.Now().Add(time.Minute)) {
		t.Fatalf(
			"Claude OAuth 凭据已过期或即将过期: expires_at=%s",
			expiresAt.UTC().Format(time.RFC3339),
		)
	}
}

// loadRealClaudeCanonicalSelection 只允许 Canonical Adapter 能够精确承载的
// 凭据；订阅 OAuth 额外要求 Access Token 仍在有效期内，避免把过期当成协议缺陷。
func loadRealClaudeCanonicalSelection(
	t *testing.T,
	preferredModel string,
) realClaudeAccountSelection {
	t.Helper()

	selection := loadRealClaudeAccountSelection(t, preferredModel)
	if oauth, ok := selection.credential.(*claudeauth.OAuthAuth); ok {
		requireUnexpiredClaudeOAuth(t, oauth)
		return selection
	}
	client := &claudeRecordingHTTPClient{}
	adapter, err := NewAdapter(client, time.Now)
	if err != nil {
		t.Fatalf("NewAdapter() error = %v", err)
	}
	if !adapter.SupportsCredential(selection.credential) {
		t.Fatalf(
			"Canonical Claude 真实验收不支持该凭据类型: %T",
			selection.credential,
		)
	}
	return selection
}

// selectRealClaudeAccountModel 从账号物化目录选择唯一明确模型。
// force_enable 但上游未发现的模型不够资格用于真实上游验收。
func selectRealClaudeAccountModel(
	models []accountapp.AccountModel,
	requestedModel string,
	preferredModel string,
) (string, error) {
	requestedModel = strings.TrimSpace(requestedModel)
	preferredModel = strings.TrimSpace(preferredModel)
	selectedModel := requestedModel
	if selectedModel == "" {
		selectedModel = preferredModel
	}
	if selectedModel == "" {
		return "", fmt.Errorf("真实 Claude 测试模型不能为空")
	}

	available := make([]string, 0, len(models))
	found := false
	for _, model := range models {
		if !model.IsValid() {
			return "", fmt.Errorf("真实 Claude 账号模型目录无效")
		}
		if !model.UpstreamAvailable() || !model.Effective() {
			continue
		}
		modelID := model.ModelID().String()
		available = append(available, modelID)
		if modelID == selectedModel {
			found = true
		}
	}
	sort.Strings(available)
	if found {
		return selectedModel, nil
	}
	return "", fmt.Errorf(
		"模型 %q 不在该账号的上游可用目录中，可用模型: %s",
		selectedModel,
		strings.Join(available, ","),
	)
}

// hasRealClaudeAccountSelection 判断调用者是否同时选择了账号库和账号 ID。
func hasRealClaudeAccountSelection() bool {
	return strings.TrimSpace(os.Getenv(realClaudeAccountHomeEnv)) != "" &&
		strings.TrimSpace(os.Getenv(realClaudeAccountIDEnv)) != ""
}

// newRealClaudeCoordinator 装配真实凭据但不持久化 Token 或响应。
func newRealClaudeCoordinator(
	t *testing.T,
	credential accountapp.Credential,
	model string,
) (
	*inferencegateway.Coordinator,
	*claudeAttemptRecorder,
	*realClaudeTransportDiagnostic,
) {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("accounts.DeriveAccountRef() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("accounts.NewCLIAccountID() error = %v", err)
	}
	account, err := accountapp.NewRoutingAccount(
		catalog,
		accountapp.RoutingAccountInput{
			Ref:          accountRef,
			ProviderID:   "claude",
			CLIAccountID: alias,
		},
	)
	if err != nil {
		t.Fatalf("accounts.NewRoutingAccount() error = %v", err)
	}
	recruiter, err := accountrouting.NewRecruiter(
		accountrouting.Dependencies{
			Candidates: claudeCandidateSource{account: account},
			Runtime:    claudeAvailableRuntime{},
			Credentials: claudeCredentialResolver{
				accountRef: accountRef,
				credential: credential,
			},
		},
	)
	if err != nil {
		t.Fatalf("accountrouting.NewRecruiter() error = %v", err)
	}
	transport := &realClaudeTransportDiagnostic{
		client: newRealClaudeHTTPClient(),
	}
	adapter, err := NewAdapter(transport, time.Now)
	if err != nil {
		t.Fatalf("messages.NewAdapter() error = %v", err)
	}
	upstreams, err := inferencegateway.NewUpstreamRegistry(adapter)
	if err != nil {
		t.Fatalf("NewUpstreamRegistry() error = %v", err)
	}
	recorder := &claudeAttemptRecorder{}
	coordinator, err := inferencegateway.NewCoordinator(
		inferencegateway.Dependencies{
			Catalog:        catalog,
			Routes:         newRealClaudeRouteCatalog(t, model),
			Recruiter:      recruiter,
			Upstreams:      upstreams,
			Attempts:       recorder,
			ModelRefreshes: claudeModelRefreshScheduler{},
			// 真实 smoke 每次只允许调用一个账号，禁止测试代码自动重试。
			UpstreamAttemptLimit: 1,
		},
	)
	if err != nil {
		t.Fatalf("NewCoordinator() error = %v", err)
	}
	return coordinator, recorder, transport
}

// newRealClaudeRouteCatalog 创建 alias 到真实 Claude 模型的唯一规则。
func newRealClaudeRouteCatalog(
	t *testing.T,
	model string,
) *inferencegateway.RouteCatalog {
	t.Helper()

	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityStreaming,
		inference.CapabilityReasoning,
		inference.CapabilityTools,
	)
	if err != nil {
		t.Fatalf("inference.NewCapabilitySet() error = %v", err)
	}
	route, err := inferencegateway.NewRoute(
		inference.ProviderClaude,
		inference.ProtocolClaudeMessages,
		model,
		capabilities,
	)
	if err != nil {
		t.Fatalf("inferencegateway.NewRoute() error = %v", err)
	}
	rule, err := inferencegateway.NewRouteRule(
		inferencegateway.RouteRuleInput{
			Pattern:  realClaudeSmokeAlias,
			Scope:    inferencegateway.RouteScopeAll,
			Route:    route,
			Priority: 0,
		},
	)
	if err != nil {
		t.Fatalf("inferencegateway.NewRouteRule() error = %v", err)
	}
	resolver, err := inferencegateway.NewRouteCatalog(rule)
	if err != nil {
		t.Fatalf("inferencegateway.NewRouteCatalog() error = %v", err)
	}
	return resolver
}

// newRealClaudeRequest 创建固定低敏文本的流式 Canonical 请求。
func newRealClaudeRequest(t *testing.T, model string) inference.Request {
	t.Helper()

	message := mustMessage(
		t,
		inference.RoleUser,
		mustText(t, realClaudeSmokePrompt),
	)
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:  inference.ClientProtocolOpenAIResponses,
		Model:           realClaudeSmokeAlias,
		Messages:        []inference.Message{message},
		Stream:          true,
		MaxOutputTokens: claudeCodeDefaultMaxOutputTokens(model),
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

// newRealClaudeReasoningRequest 创建 Claude 5 原生 adaptive/effort reasoning 请求。
func newRealClaudeReasoningRequest(t *testing.T, model string) inference.Request {
	t.Helper()

	reasoning, err := inference.NewEffortReasoning(
		inference.ReasoningEffortLow,
		inference.ReasoningSummaryAuto,
	)
	if err != nil {
		t.Fatalf("inference.NewEffortReasoning() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          realClaudeSmokeAlias,
		Messages: []inference.Message{mustMessage(
			t,
			inference.RoleUser,
			mustText(t, realClaudeReasoningPrompt),
		)},
		Reasoning:                 &reasoning,
		Stream:                    true,
		IncludeEncryptedReasoning: true,
		MaxOutputTokens:           claudeCodeDefaultMaxOutputTokens(model),
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

// newRealClaudeRedactedThinkingRequest 创建明确要求 omitted thinking 的请求。
func newRealClaudeRedactedThinkingRequest(
	t *testing.T,
	model string,
) inference.Request {
	t.Helper()

	reasoning, err := inference.NewEffortReasoning(
		inference.ReasoningEffortLow,
		inference.ReasoningSummaryNone,
	)
	if err != nil {
		t.Fatalf("inference.NewEffortReasoning() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          realClaudeSmokeAlias,
		Messages: []inference.Message{mustMessage(
			t,
			inference.RoleUser,
			mustText(t, realClaudeReasoningPrompt),
		)},
		Reasoning:       &reasoning,
		Stream:          true,
		MaxOutputTokens: claudeCodeDefaultMaxOutputTokens(model),
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

// newRealClaudeToolRequest 创建与所选模型当前 Claude Code 默认值一致的工具请求。
func newRealClaudeToolRequest(
	t *testing.T,
	model string,
	tool inference.ToolDefinition,
	toolChoice inference.ToolChoice,
) inference.Request {
	t.Helper()

	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          realClaudeSmokeAlias,
		Messages: []inference.Message{mustMessage(
			t,
			inference.RoleUser,
			mustText(t, "Call aih_probe with value AIH_TOOL_ARGUMENT_OK. Do not return text."),
		)},
		Tools:           []inference.ToolDefinition{tool},
		ToolChoice:      &toolChoice,
		Stream:          true,
		MaxOutputTokens: claudeCodeDefaultMaxOutputTokens(model),
	})
	if err != nil {
		t.Fatalf("创建真实工具请求失败: %v", err)
	}
	return request
}

// executeRealClaudeRequest 通过同一生产 Coordinator 执行一次真实请求。
func executeRealClaudeRequest(
	t *testing.T,
	credential accountapp.Credential,
	model string,
	request inference.Request,
) (
	[]inference.StreamEvent,
	*claudeAttemptRecorder,
	*realClaudeTransportDiagnostic,
	error,
) {
	t.Helper()

	coordinator, recorder, transport := newRealClaudeCoordinator(
		t,
		credential,
		model,
	)
	events := make([]inference.StreamEvent, 0, 32)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	err := coordinator.Execute(
		ctx,
		request,
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	return events, recorder, transport, err
}

// aggregateRealClaudeResponses 用生产非流式 Renderer 聚合真实事件。
func aggregateRealClaudeResponses(
	t *testing.T,
	request inference.Request,
	events []inference.StreamEvent,
) []byte {
	t.Helper()

	aggregator := openairesponses.NewResponseAggregator(request, time.Now().UTC())
	for _, event := range events {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("聚合真实 Responses 事件失败: kind=%s error=%v", event.Kind(), err)
		}
	}
	body, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("编码真实 Responses 响应失败: %v", err)
	}
	return body
}

// aggregateRealClaudeAnthropicMessage 用生产非流式 Renderer 聚合原生 Message。
func aggregateRealClaudeAnthropicMessage(
	t *testing.T,
	request inference.Request,
	events []inference.StreamEvent,
) []byte {
	t.Helper()

	aggregator := clientanthropic.NewResponseAggregator(request)
	for _, event := range events {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("聚合真实 Anthropic 事件失败: kind=%s error=%v", event.Kind(), err)
		}
	}
	body, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("编码真实 Anthropic 响应失败: %v", err)
	}
	return body
}

// decodeRealClaudeAnthropicReplayRequest 把原生 Message 内容原样放回 assistant
// 历史，并追加固定用户标记；redacted data 只在内存中流转且从不写日志。
func decodeRealClaudeAnthropicReplayRequest(
	t *testing.T,
	firstResponse []byte,
	model string,
) inference.Request {
	t.Helper()

	var response struct {
		Content []json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(firstResponse, &response); err != nil ||
		len(response.Content) == 0 {
		t.Fatal("真实 Anthropic 响应无法形成回放历史")
	}
	body, err := json.Marshal(struct {
		Model        string `json:"model"`
		MaxTokens    uint64 `json:"max_tokens"`
		Messages     []any  `json:"messages"`
		Thinking     any    `json:"thinking"`
		OutputConfig any    `json:"output_config"`
		Stream       bool   `json:"stream"`
	}{
		Model:     realClaudeSmokeAlias,
		MaxTokens: claudeCodeDefaultMaxOutputTokens(model),
		Messages: []any{
			map[string]any{
				"role":    "assistant",
				"content": response.Content,
			},
			map[string]any{
				"role":    "user",
				"content": realClaudeReplayPrompt,
			},
		},
		Thinking: map[string]string{
			"type":    "adaptive",
			"display": "omitted",
		},
		OutputConfig: map[string]string{
			"effort": string(inference.ReasoningEffortLow),
		},
		Stream: false,
	})
	if err != nil {
		t.Fatalf("编码真实 Anthropic 回放请求失败: %v", err)
	}
	defer clear(body)
	request, err := clientanthropic.NewAdapter().Decode(body)
	if err != nil {
		t.Fatalf("解码真实 Anthropic 回放请求失败: %v", err)
	}
	return request
}

// decodeRealClaudeReplayRequest 把真实 Responses 输出作为下一轮历史重新解码。
func decodeRealClaudeReplayRequest(
	t *testing.T,
	firstResponse []byte,
	model string,
) inference.Request {
	t.Helper()

	var response struct {
		Output []json.RawMessage `json:"output"`
	}
	if err := json.Unmarshal(firstResponse, &response); err != nil ||
		len(response.Output) == 0 {
		t.Fatal("真实 Responses 输出无法形成回放历史")
	}
	user, err := json.Marshal(map[string]any{
		"type": "message",
		"role": "user",
		"content": []map[string]string{{
			"type": "input_text",
			"text": realClaudeReplayPrompt,
		}},
	})
	if err != nil {
		t.Fatalf("编码真实回放用户消息失败: %v", err)
	}
	defer clear(user)
	input := append([]json.RawMessage(nil), response.Output...)
	input = append(input, json.RawMessage(user))
	body, err := json.Marshal(struct {
		Model           string            `json:"model"`
		Input           []json.RawMessage `json:"input"`
		Reasoning       map[string]string `json:"reasoning"`
		Stream          bool              `json:"stream"`
		MaxOutputTokens uint64            `json:"max_output_tokens"`
	}{
		Model: realClaudeSmokeAlias,
		Input: input,
		Reasoning: map[string]string{
			"effort":  string(inference.ReasoningEffortLow),
			"summary": string(inference.ReasoningSummaryAuto),
		},
		Stream:          false,
		MaxOutputTokens: claudeCodeDefaultMaxOutputTokens(model),
	})
	if err != nil {
		t.Fatalf("编码真实 Responses 回放请求失败: %v", err)
	}
	defer clear(body)
	adapter, err := openairesponses.NewAdapter(time.Now)
	if err != nil {
		t.Fatalf("openairesponses.NewAdapter() error = %v", err)
	}
	request, err := adapter.Decode(body)
	if err != nil {
		t.Fatalf("解码真实 Responses 回放请求失败: %v", err)
	}
	return request
}

// hasReasoningDelta 判断事件流是否包含指定 reasoning 增量类别。
func hasReasoningDelta(
	events []inference.StreamEvent,
	kind inference.ReasoningDeltaKind,
) bool {
	for _, event := range events {
		if delta, ok := event.(inference.ReasoningDeltaEvent); ok &&
			delta.DeltaKind() == kind {
			return true
		}
	}
	return false
}

// hasCompletedThinking 验证事件流保留完整的 Claude thinking 和 signature。
// Claude 允许可见 thinking 为空，因此连续性只强制要求原生签名存在。
func hasCompletedThinking(events []inference.StreamEvent) bool {
	for _, event := range events {
		completed, ok := event.(inference.ReasoningCompletedEvent)
		if !ok {
			continue
		}
		content := completed.Content()
		if content.ReasoningKind() == inference.ReasoningThinking &&
			content.Signature() != "" {
			return true
		}
	}
	return false
}

// hasCompletedRedactedThinking 验证事件流保留非空 Claude redacted 数据。
func hasCompletedRedactedThinking(events []inference.StreamEvent) bool {
	for _, event := range events {
		completed, ok := event.(inference.ReasoningCompletedEvent)
		if !ok {
			continue
		}
		content := completed.Content()
		if content.ReasoningKind() == inference.ReasoningRedacted &&
			content.RedactedData() != "" {
			return true
		}
	}
	return false
}

// reasoningDeltaKinds 只输出 reasoning 增量种类，不输出正文。
func reasoningDeltaKinds(events []inference.StreamEvent) string {
	kinds := make([]string, 0, 2)
	seen := make(map[inference.ReasoningDeltaKind]struct{}, 2)
	for _, event := range events {
		delta, ok := event.(inference.ReasoningDeltaEvent)
		if !ok {
			continue
		}
		kind := delta.DeltaKind()
		if _, exists := seen[kind]; exists {
			continue
		}
		seen[kind] = struct{}{}
		kinds = append(kinds, string(kind))
	}
	if len(kinds) == 0 {
		return "none"
	}
	return strings.Join(kinds, "+")
}

// usageEventShape 只报告 usage 事件是否存在，不报告账号额度或 token 数值。
func usageEventShape(events []inference.StreamEvent) string {
	updated := false
	completed := false
	for _, event := range events {
		switch event.(type) {
		case inference.UsageUpdatedEvent:
			updated = true
		case inference.ResponseCompletedEvent:
			completed = true
		}
	}
	return "updated=" + strconv.FormatBool(updated) +
		",completed=" + strconv.FormatBool(completed)
}

// newRealClaudeHTTPClient 禁止重定向并限制真实请求总时长。
func newRealClaudeHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 60 * time.Second,
		CheckRedirect: func(
			_ *http.Request,
			_ []*http.Request,
		) error {
			return http.ErrUseLastResponse
		},
	}
}
