package translation

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultFirstByteTimeout 是本机网关请求等待响应头的首字节预算（120s）。
	DefaultFirstByteTimeout = 120 * time.Second
	// DefaultIdleTimeout 是流式响应开始后两次有效数据块之间的最大静默时间（90s）。
	DefaultIdleTimeout = 90 * time.Second
	// MaxGatewayErrorBytes 限制读取网关错误响应体的上限，防止大文档占满内存。
	MaxGatewayErrorBytes = 256 * 1024
)

// GatewayConfig 描述调用本机 AIH 推理网关（/v1/chat/completions）的配置。
type GatewayConfig struct {
	BaseURL          func() string
	ClientKey        func() string
	HTTPClient       AdapterClient
	FirstByteTimeout time.Duration
	IdleTimeout      time.Duration
}

// GatewayStreamInput 描述单次发往 AIH 网关的请求载荷。
type GatewayStreamInput struct {
	Model      string
	Provider   string
	SessionKey string
	MaxTokens  int
	Messages   []ChatMessage
}

// ResolveGatewayCompletionsURL 计算本机网关 `/v1/chat/completions` 地址。
func ResolveGatewayCompletionsURL(baseURL string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		if envBase := strings.TrimRight(strings.TrimSpace(os.Getenv("AIH_GATEWAY_BASE_URL")), "/"); envBase != "" {
			base = envBase
		} else {
			port := strings.TrimSpace(os.Getenv("AIH_SERVER_PORT"))
			if port == "" {
				port = "8080"
			}
			base = "http://127.0.0.1:" + port
		}
	}
	if strings.HasSuffix(base, "/v1/chat/completions") {
		return base
	}
	if strings.HasSuffix(base, "/v1") {
		return base + "/chat/completions"
	}
	return base + "/v1/chat/completions"
}

// ExecuteGatewayStream 向本机 AIH 网关发起流式翻译请求并产出 delta 事件。
func ExecuteGatewayStream(
	ctx context.Context,
	cfg GatewayConfig,
	input GatewayStreamInput,
	emit func(StreamEvent),
) RunResult {
	model := strings.TrimSpace(input.Model)
	if model == "" {
		return adapterFailure("translation_model_required", "未选择翻译模型", 0, true)
	}
	if ctx.Err() != nil {
		return adapterFailure("translation_aborted", "翻译已取消", 0, false)
	}

	firstByteTimeout := cfg.FirstByteTimeout
	if firstByteTimeout <= 0 {
		firstByteTimeout = DefaultFirstByteTimeout
	}
	idleTimeout := cfg.IdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = DefaultIdleTimeout
	}

	payloadMap := map[string]any{
		"model":            model,
		"messages":         input.Messages,
		"stream":           true,
		"temperature":      0,
		"reasoning_effort": "none",
	}
	if input.MaxTokens > 0 {
		payloadMap["max_tokens"] = input.MaxTokens
	}
	bodyBytes, err := json.Marshal(payloadMap)
	if err != nil {
		return adapterFailure("translation_upstream_unreachable", "本机网关请求失败", 0, true)
	}

	var base string
	if cfg.BaseURL != nil {
		base = cfg.BaseURL()
	}
	targetURL := ResolveGatewayCompletionsURL(base)

	var clientKey string
	if cfg.ClientKey != nil {
		clientKey = strings.TrimSpace(cfg.ClientKey())
	}
	if clientKey == "" {
		clientKey = strings.TrimSpace(os.Getenv("AIH_SERVER_API_KEY"))
	}
	if clientKey == "" {
		clientKey = "dummy"
	}

	reqCtx, cancelReq := context.WithCancel(ctx)
	defer cancelReq()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, targetURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return adapterFailure("translation_upstream_unreachable", "本机网关请求失败", 0, true)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+clientKey)
	if provider := NormalizeProviderID(input.Provider); provider != "" {
		req.Header.Set("X-Provider", provider)
	}
	if sessionKey := strings.TrimSpace(input.SessionKey); sessionKey != "" {
		req.Header.Set("X-Session-Id", sessionKey)
	}

	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{}
	}

	firstByteTimer := time.AfterFunc(firstByteTimeout, cancelReq)
	resp, err := client.Do(req)
	firstByteTimedOut := !firstByteTimer.Stop()
	if err != nil {
		if ctx.Err() != nil {
			return adapterFailure("translation_aborted", "翻译已取消", 0, false)
		}
		if firstByteTimedOut {
			return adapterFailure("translation_upstream_timeout", "翻译上游响应超时", 0, true)
		}
		return adapterFailure("translation_upstream_unreachable", "本机网关请求失败", 0, true)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		rawErr, _ := io.ReadAll(io.LimitReader(resp.Body, MaxGatewayErrorBytes))
		msg := HumanizeUpstreamError(string(rawErr), resp.StatusCode, model, input.Provider)
		return adapterFailure("translation_upstream_error", msg, resp.StatusCode, isRetryableHTTPStatus(resp.StatusCode))
	}

	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if !strings.Contains(contentType, "text/event-stream") {
		rawJSON, err := io.ReadAll(io.LimitReader(resp.Body, MaxAdapterResponseBytes+1))
		if err != nil || len(rawJSON) > MaxAdapterResponseBytes {
			return adapterFailure("translation_empty_output", "上游没有返回译文", 0, true)
		}
		var doc struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
			Usage *UsageSummary `json:"usage"`
		}
		_ = json.Unmarshal(rawJSON, &doc)
		text := ""
		if len(doc.Choices) > 0 {
			text = doc.Choices[0].Message.Content
		}
		if text == "" {
			return adapterFailure("translation_empty_output", "上游没有返回译文", 0, true)
		}
		if emit != nil {
			emit(StreamEvent{Type: "delta", Content: text})
		}
		return RunResult{OK: true, Text: text, Usage: doc.Usage}
	}

	text, usage, streamErr := pumpGatewaySSE(ctx, cancelReq, resp.Body, idleTimeout, emit)
	if streamErr != nil {
		if ctx.Err() != nil {
			return RunResult{
				OK:    false,
				Text:  text,
				Error: &ExecutionError{Code: "translation_aborted", Message: "翻译已取消", Retryable: false},
			}
		}
		if errors.Is(streamErr, errStreamIdleTimeout) {
			return RunResult{
				OK:   false,
				Text: text,
				Error: &ExecutionError{
					Code:      "translation_stream_idle_timeout",
					Message:   "翻译上游长时间没有新内容，已中断",
					Retryable: text == "",
				},
			}
		}
		return RunResult{
			OK:   false,
			Text: text,
			Error: &ExecutionError{
				Code:      "translation_stream_failed",
				Message:   streamErr.Error(),
				Retryable: text == "",
			},
		}
	}
	return RunResult{
		OK:    true,
		Text:  text,
		Usage: usage,
	}
}

var errStreamIdleTimeout = errors.New("translation_stream_idle_timeout")

func pumpGatewaySSE(
	ctx context.Context,
	cancelReq func(),
	body io.Reader,
	idleTimeout time.Duration,
	emit func(StreamEvent),
) (string, *UsageSummary, error) {
	reader := bufio.NewReaderSize(body, 16*1024)
	var blockBuf strings.Builder
	var fullText strings.Builder
	var usage *UsageSummary
	var idleTimedOut bool

	var idleTimer *time.Timer
	if idleTimeout > 0 {
		idleTimer = time.AfterFunc(idleTimeout, func() {
			idleTimedOut = true
			cancelReq()
		})
		defer idleTimer.Stop()
	}

	handleBlock := func(rawBlock string) error {
		trimmed := strings.TrimSpace(rawBlock)
		if trimmed == "" {
			return nil
		}
		lines := strings.Split(trimmed, "\n")
		dataParts := make([]string, 0, len(lines))
		for _, line := range lines {
			if strings.HasPrefix(line, "data:") {
				dataParts = append(dataParts, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		payloadText := strings.Join(dataParts, "\n")
		if payloadText == "" || payloadText == "[DONE]" {
			return nil
		}
		var parsed struct {
			Error   json.RawMessage `json:"error"`
			Usage   *UsageSummary   `json:"usage"`
			Choices []struct {
				Delta *struct {
					Content string `json:"content"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(payloadText), &parsed); err != nil {
			return nil
		}
		if len(parsed.Error) > 0 && string(parsed.Error) != "null" {
			return errors.New(HumanizeUpstreamError(payloadText, 0, "", ""))
		}
		if parsed.Usage != nil {
			usage = parsed.Usage
		}
		if len(parsed.Choices) > 0 && parsed.Choices[0].Delta != nil && parsed.Choices[0].Delta.Content != "" {
			piece := parsed.Choices[0].Delta.Content
			fullText.WriteString(piece)
			if emit != nil {
				emit(StreamEvent{Type: "delta", Content: piece})
			}
		}
		return nil
	}

	for {
		line, err := reader.ReadString('\n')
		if idleTimer != nil && line != "" {
			idleTimer.Reset(idleTimeout)
		}
		if line != "" {
			normalized := strings.ReplaceAll(line, "\r\n", "\n")
			if normalized == "\n" {
				if blockErr := handleBlock(blockBuf.String()); blockErr != nil {
					return fullText.String(), usage, blockErr
				}
				blockBuf.Reset()
			} else {
				blockBuf.WriteString(normalized)
			}
		}
		if err != nil {
			if idleTimedOut && ctx.Err() == nil {
				return fullText.String(), usage, errStreamIdleTimeout
			}
			if errors.Is(err, io.EOF) {
				if blockErr := handleBlock(blockBuf.String()); blockErr != nil {
					return fullText.String(), usage, blockErr
				}
				return fullText.String(), usage, nil
			}
			if ctx.Err() != nil {
				return fullText.String(), usage, ctx.Err()
			}
			return fullText.String(), usage, err
		}
	}
}

func isRetryableHTTPStatus(status int) bool {
	return status == 408 || status == 409 || status == 425 || status == 429 || status >= 500
}

var (
	reSchedulableReason = regexp.MustCompile(`(?i)no schedulable [a-z0-9_-]+ account:\s*([^"}\]]+?)(?:["}\]]|\.\s*Retry|$)`)
	reNestedDetail      = regexp.MustCompile(`"detail"\s*:\s*"([^"]+)"`)
	reNoAvailableDetail = regexp.MustCompile(`(?i)^No available \w+ account$`)
	reRelayedNoAccount  = regexp.MustCompile(`(?i)no available ([a-z0-9_-]+) account can serve model ([^"\\\s}]+)`)
	reHasSchedulable    = regexp.MustCompile(`(?i)no schedulable [a-z0-9_-]+ account`)
	reJSONObject        = regexp.MustCompile(`\{[\s\S]*\}`)
	reErrorPrefix       = regexp.MustCompile(`^(?i)(?:Error:\s*)+`)
	reUpstreamStatus    = regexp.MustCompile(`(?i)^upstream_\d+\s*:`)
)

func formatRetryAfterCN(seconds float64) string {
	v := math.Max(1, math.Ceil(seconds))
	if v >= 3600 {
		return fmt.Sprintf("%g 小时", math.Round(v/360)/10)
	}
	if v >= 60 {
		return fmt.Sprintf("%d 分钟", int(math.Round(v/60)))
	}
	return fmt.Sprintf("%d 秒", int(v))
}

func extractRemotePoolReason(detail string) string {
	text := strings.TrimSpace(detail)
	if text == "" {
		return ""
	}
	if m := reSchedulableReason.FindStringSubmatch(text); len(m) > 1 {
		return strings.TrimSpace(m[1])
	}
	if m := reNestedDetail.FindStringSubmatch(text); len(m) > 1 && !reNoAvailableDetail.MatchString(m[1]) {
		return strings.TrimSpace(m[1])
	}
	return ""
}

func decodeLooseJSONObject(raw string) map[string]any {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err == nil && parsed != nil {
		return parsed
	}
	if match := reJSONObject.FindString(raw); match != "" {
		if err := json.Unmarshal([]byte(match), &parsed); err == nil && parsed != nil {
			return parsed
		}
	}
	return nil
}

// HumanizeUpstreamError 把本机或远端网关返回的多层 JSON 错误体翻译成可读中文提示。
func HumanizeUpstreamError(rawText string, status int, model string, provider string) string {
	raw := strings.TrimSpace(rawText)
	var payload map[string]any
	if raw != "" {
		payload = decodeLooseJSONObject(raw)
	}

	if payload != nil && asString(payload["error"]) == "no_available_account" {
		parts := []string{strings.TrimSpace(asString(payload["detail"]))}
		if avail, ok := payload["availability"].(map[string]any); ok {
			if reasons, ok := avail["reasons"].([]any); ok {
				for _, item := range reasons {
					if m, ok := item.(map[string]any); ok {
						parts = append(parts, strings.TrimSpace(asString(m["reason"])))
					}
				}
			}
		}
		joined := strings.Join(parts, " ")
		if m := reRelayedNoAccount.FindStringSubmatch(joined); len(m) > 2 && reHasSchedulable.MatchString(joined) {
			suffix := ""
			if retrySec := asFloat(payload["retryAfterSeconds"]); retrySec > 0 {
				suffix = "；该中转账号对这个模型冷却约 " + formatRetryAfterCN(retrySec)
			}
			return fmt.Sprintf(
				"模型「%s」走的是中转账号：远端 server 的 %s 账号池里没有能提供这个模型的账号（不是本机账号缺失，也不是网络问题）。请改用远端账号目录里有的模型%s。",
				m[2], m[1], suffix,
			)
		}
	}

	outerRelayCode := payload != nil && asString(payload["error"]) == "remote_pool_unavailable"
	if payload != nil && !outerRelayCode {
		if nestedText := strings.TrimSpace(asString(payload["detail"])); nestedText != "" {
			if nested := decodeLooseJSONObject(nestedText); nested != nil {
				merged := make(map[string]any, len(nested)+len(payload))
				for k, v := range nested {
					merged[k] = v
				}
				for k, v := range payload {
					merged[k] = v
				}
				if nested["error"] != nil {
					merged["error"] = nested["error"]
				}
				payload = merged
			}
		}
	}

	var code string
	var innerError map[string]any
	if payload != nil {
		if strErr, ok := payload["error"].(string); ok {
			code = strErr
		} else if objErr, ok := payload["error"].(map[string]any); ok {
			innerError = objErr
			code = asString(objErr["code"])
			if code == "" {
				code = asString(objErr["type"])
			}
		}
	}
	detail := ""
	if payload != nil {
		for _, candidate := range []string{asString(payload["detail"]), asString(payload["message"]), asString(payload["reason"])} {
			if strings.TrimSpace(candidate) != "" {
				detail = strings.TrimSpace(candidate)
				break
			}
		}
		if detail == "" && innerError != nil {
			detail = strings.TrimSpace(asString(innerError["message"]))
			if detail == "" {
				detail = strings.TrimSpace(asString(innerError["detail"]))
			}
		}
	}

	modelLabel := strings.TrimSpace(model)
	providerLabel := strings.TrimSpace(provider)
	modelText := ""
	if modelLabel != "" {
		modelText = "「" + modelLabel + "」"
	}
	providerText := ""
	if providerLabel != "" {
		providerText = providerLabel + " "
	}

	switch code {
	case "no_available_account":
		lowerModel := strings.ToLower(modelLabel)
		familyProvider := strings.ToLower(providerLabel)
		if strings.HasPrefix(lowerModel, "gemini") || strings.HasPrefix(lowerModel, "agy") {
			familyProvider = "agy"
		}
		var avail map[string]any
		var hasAvail bool
		var totalNum float64
		var hasTotal bool
		if payload != nil {
			if a, ok := payload["availability"].(map[string]any); ok && a != nil {
				avail = a
				hasAvail = true
				totalNum, hasTotal = asFiniteFloat(a["total"])
			}
		}
		if familyProvider == "agy" && !(hasAvail && hasTotal && totalNum > 0) {
			return fmt.Sprintf("模型%s暂时不可用。请刷新模型目录或同步 AWS Server 的 AGY 账号；这不是 Codex 账号缺失。", modelText)
		}
		if strings.EqualFold(providerLabel, "zcode") {
			return "当前 AIH 没有可用于该模型的 ZCode 推理账号。ZCode OAuth 账号在 AIH 中用于账号管理、桌面启动和用量查询；网关推理请使用已配置且可用的 Coding Plan API Key 账号，或切换其他账号/模型。"
		}
		if hasAvail && hasTotal {
			poolProvider := strings.TrimSpace(asString(avail["provider"]))
			if poolProvider == "" {
				poolProvider = providerLabel
			}
			poolText := ""
			if poolProvider != "" {
				poolText = poolProvider + " "
			}
			reason := strings.TrimSpace(asString(avail["reason"]))
			if totalNum > 0 {
				var why string
				if reason == "no_eligible_account" {
					why = fmt.Sprintf("这 %g 个账号都不提供该模型，或正在冷却 / 已停用", totalNum)
				} else {
					suffix := ""
					if reason != "" {
						suffix = "（" + reason + "）"
					}
					why = fmt.Sprintf("这 %g 个账号当前都不可用%s", totalNum, suffix)
				}
				return fmt.Sprintf("模型%s被路由到 %s账号池，但%s。请改用账号目录里有的模型，或在「账号」页确认该模型对应的账号可用。", modelText, poolText, why)
			}
			if totalNum == 0 {
				return fmt.Sprintf("模型%s被路由到 %s账号池，但当前 server 上没有任何 %s账号。请先在「账号」页添加，或改用其他模型。", modelText, poolText, poolText)
			}
		}
		return fmt.Sprintf("当前 server 上没有可用于模型%s的%s账号。可能原因：该账号未在此 server 完成登录/凭据配置，或该模型未在账号的可用清单里。请在「账号」页补全该 server 上的账号凭据，或改用其他账号/模型后重试。", modelText, providerText)
	case "remote_pool_unavailable":
		remoteReason := extractRemotePoolReason(detail)
		reasonPart := ""
		if remoteReason != "" {
			reasonPart = "（" + remoteReason + "）"
		}
		retryPart := ""
		if payload != nil {
			if sec := asFloat(payload["retryAfterSeconds"]); sec > 0 {
				retryPart = fmt.Sprintf("约 %s后可重试，", formatRetryAfterCN(sec))
			}
		}
		return fmt.Sprintf("模型%s走的是中转账号，远端 server 的%s账号池暂时没有可用账号%s。%s或改用本机其他账号/模型。", modelText, providerText, reasonPart, retryPart)
	case "account_not_configured":
		return fmt.Sprintf("所选%s账号在当前 server 上尚未完成配置(缺少登录凭据)。请先在「账号」页为该 server 补全登录后再发送。", providerText)
	case "missing_model", "model_required":
		return "请先选择一个模型再发送。"
	case "model_not_found":
		return fmt.Sprintf("模型%s在当前 server 上不可用，请改用其他模型。", modelText)
	case "rate_limited", "cooldown":
		suffix := ""
		if detail != "" {
			suffix = "（" + detail + "）"
		}
		return fmt.Sprintf("该%s账号当前被上游限流/熔断%s。请稍后重试，或改用其他账号。", providerText, suffix)
	}

	if detail != "" {
		cleanDetail := reErrorPrefix.ReplaceAllString(detail, "")
		if strings.EqualFold(cleanDetail, "Internal server error") {
			return "上游服务暂时发生内部错误（Internal server error），请稍后重试或切换其他模型。"
		}
		if reUpstreamStatus.MatchString(cleanDetail) {
			if status >= 500 {
				return "翻译上游暂时不可用，请在高级设置中刷新模型目录或切换模型。"
			}
			return "翻译请求未被上游接受，请在高级设置中检查模型和路由。"
		}
		return cleanDetail
	}

	if raw != "" && payload == nil {
		return raw
	}
	if status == 500 {
		return "上游模型服务发生 500 内部错误，请稍后重试或切换模型。"
	}
	if status > 0 {
		return "请求失败（HTTP " + strconv.Itoa(status) + "）"
	}
	return "请求失败"
}

func asFloat(v any) float64 {
	n, _ := asFiniteFloat(v)
	return n
}

func asFiniteFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, !math.IsNaN(x) && !math.IsInf(x, 0)
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	default:
		return 0, false
	}
}
