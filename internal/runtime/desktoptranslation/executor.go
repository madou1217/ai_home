package desktoptranslation

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/translation"
)

type TranslationRequest struct {
	Text, Source, Target, Policy, Model, Provider string
	Routes                                        []translation.Route
	ExecutionTarget                               string
	ServerTarget                                  translation.SystemServerTarget
}
type Executor struct {
	DatabasePath  string
	Gateway       translation.GatewayConfig
	HTTPClient    translation.AdapterClient
	ResolveTarget TargetResolver
}

func failed(code, message string, retry bool) translation.RunResult {
	return translation.RunResult{Error: &translation.ExecutionError{Code: code, Message: message, Retryable: retry}}
}
func (e *Executor) Execute(ctx context.Context, request TranslationRequest, emit func(translation.StreamEvent)) translation.RunResult {
	if request.ExecutionTarget == "direct-provider" {
		prompt := translation.BuildTranslationMessages(translation.TranslationMessagesInput{Text: request.Text, Source: request.Source, Target: request.Target})
		return translation.RunRoutes(ctx, translation.ExecuteRouteInput{Text: request.Text, Source: request.Source, Target: request.Target, Operation: "selection", Messages: prompt.Messages}, translation.RunOptions{Routes: request.Routes, Operation: "selection", DatabasePath: e.DatabasePath, Gateway: e.Gateway, HTTPClient: e.HTTPClient}, emit)
	}
	if e.ResolveTarget == nil {
		return failed("translation_server_target_invalid", "翻译服务目标不可用", false)
	}
	target, err := e.ResolveTarget(ctx, request.ServerTarget)
	if err != nil {
		return failed("translation_server_target_invalid", "翻译服务目标未授权或配置无效", false)
	}
	body := map[string]any{"text": request.Text, "source": request.Source, "target": request.Target, "targetPolicy": request.Policy, "operation": "selection"}
	if request.Model != "" {
		body["model"] = request.Model
	}
	if request.Provider != "" {
		body["provider"] = request.Provider
	}
	if request.Routes != nil {
		body["routes"] = request.Routes
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return failed("translation_input_invalid", "翻译内容无效", false)
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.Origin+"/v0/webui/translation/stream", bytes.NewReader(raw))
	if err != nil {
		return failed("translation_server_target_invalid", "翻译服务目标不可用", false)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if target.ManagementKey != "" {
		req.Header.Set("Authorization", "Bearer "+target.ManagementKey)
	}
	client := e.HTTPClient
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(req)
	if err != nil {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		if ctx.Err() != nil {
			return failed("translation_aborted", "翻译已取消", false)
		}
		return failed("translation_network_error", "无法连接翻译服务", true)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return translation.RunResult{Error: &translation.ExecutionError{Code: "translation_server_http_error", Message: "翻译请求失败", Status: response.StatusCode, Retryable: response.StatusCode == 429 || response.StatusCode >= 500}}
	}
	if !strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		return failed("translation_stream_invalid", "翻译响应格式无效", false)
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	var block strings.Builder
	result := translation.RunResult{}
	var text strings.Builder
	terminal := false
	consume := func() {
		if block.Len() == 0 {
			return
		}
		data := block.String()
		block.Reset()
		if data == "[DONE]" {
			return
		}
		var event translation.StreamEvent
		if json.Unmarshal([]byte(data), &event) != nil {
			return
		}
		switch event.Type {
		case "delta":
			if result.Error != nil || terminal {
				return
			}
			if text.Len()+len(event.Content) > 1<<20 {
				result = failed("translation_output_too_large", "翻译结果超出限制", false)
				terminal = true
				return
			}
			text.WriteString(event.Content)
		case "error":
			if result.Error != nil || terminal {
				return
			}
			result.OK = false
			result.Error = &translation.ExecutionError{Code: event.Code, Message: event.Message, Retryable: false}
			terminal = true
		case "done":
			if result.Error != nil || terminal {
				return
			}
			terminal = true
			result.OK = true
			result.Usage = event.Usage
			if text.Len() == 0 {
				if len(event.Text) > 1<<20 {
					result = failed("translation_output_too_large", "翻译结果超出限制", false)
					return
				}
				text.WriteString(event.Text)
			}
		}
		if emit != nil {
			emit(event)
		}
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			consume()
			if terminal {
				break
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			value := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if block.Len()+len(value) > 1<<20 {
				return failed("translation_frame_too_large", "翻译数据超出限制", false)
			}
			if block.Len() > 0 {
				block.WriteByte('\n')
			}
			block.WriteString(value)
		}
	}
	consume()
	result.Text = text.String()
	if ctx.Err() != nil {
		return failed("translation_aborted", "翻译已取消", false)
	}
	if scanner.Err() != nil && result.Error == nil {
		result = failed("translation_stream_error", "翻译连接中断", text.Len() == 0)
		result.Text = text.String()
		return result
	}
	if !terminal {
		result = failed("translation_stream_incomplete", "翻译连接未返回完整结果", text.Len() == 0)
		result.Text = text.String()
		return result
	}
	return result
}
