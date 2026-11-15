package webuichatapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// GatewayChatTurnStreamer uses the complete gateway, including canonical
// providers, aliases, account routing and its single usage recorder.
type GatewayChatTurnStreamer struct {
	Client    HTTPClient
	ClientKey func() string
	BaseURL   string
}

func (s *GatewayChatTurnStreamer) StreamTurn(ctx context.Context, input chatruntime.ChatTurnStreamRequest, emit func(chatruntime.ChatTurnStreamEvent) error) error {
	if s.Client == nil || s.ClientKey == nil {
		return chatruntime.NewError("chat_gateway_unavailable", http.StatusServiceUnavailable, nil)
	}
	payload := map[string]any{
		"model": input.Model, "messages": input.Messages, "stream": true,
		"stream_options": map[string]any{"include_usage": true},
	}
	if input.ReasoningEffort != "" {
		payload["reasoning_effort"] = input.ReasoningEffort
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(s.BaseURL, "/")+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Authorization", "Bearer "+s.ClientKey())
	request.Header.Set("X-Session-Id", input.SessionID)
	if input.AccountRef != "" {
		request.Header.Set(inferenceapi.AccountRefHeader, input.AccountRef)
	}
	response, err := s.Client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
		var doc map[string]any
		_ = json.Unmarshal(raw, &doc)
		message := strings.TrimSpace(string(raw))
		if detail, ok := doc["error"].(map[string]any); ok {
			message = objectMessage(detail)
		}
		if message == "" {
			message = http.StatusText(response.StatusCode)
		}
		return chatruntime.NewErrorWithMessage("chat_gateway_request_failed", response.StatusCode,
			fmt.Sprintf("AIH 网关请求失败（%d）：%s", response.StatusCode, message), nil)
	}
	started := time.Now()
	var firstToken time.Time
	items := map[string]*gatewayStreamItem{}
	emitDelta := func(kind, text string) error {
		if text == "" {
			return nil
		}
		item := items[kind]
		if item == nil {
			item = &gatewayStreamItem{id: chatruntime.DefaultIDFactory("item")}
			items[kind] = item
			if firstToken.IsZero() {
				firstToken = time.Now()
			}
			if err := emit(chatruntime.ChatTurnStreamEvent{Type: eventTypeTimelineItemStarted,
				Kind: kind, ItemID: item.id, Role: "assistant", CreatedAt: started.UnixMilli()}); err != nil {
				return err
			}
		}
		item.content.WriteString(text)
		return emit(chatruntime.ChatTurnStreamEvent{Type: eventTypeTimelineItemDelta, Kind: kind, ItemID: item.id, Chunk: text})
	}
	reader := newChatStreamReader(response.Body)
	for {
		next, ok, err := reader.Next()
		if err != nil {
			return err
		}
		if !ok {
			break
		}
		if err := emitDelta("reasoning", next.Reasoning); err != nil {
			return err
		}
		if err := emitDelta("message", next.Content); err != nil {
			return err
		}
	}
	if !reader.terminalSeen {
		return chatruntime.NewErrorWithMessage("chat_upstream_stream_incomplete", 502, "上游连接在回复完成前断开，请重试", nil)
	}
	// Drain through handler completion before closing its context: gateway
	// accounting may run after writing the final SSE frame.
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		return err
	}
	if items["message"] == nil {
		return chatruntime.NewErrorWithMessage("chat_upstream_empty_response", 502, "上游未返回回复内容", nil)
	}
	usage, hasUsage := reader.Result()
	completed := time.Now()
	for _, kind := range []string{"reasoning", "message"} {
		item := items[kind]
		if item == nil {
			continue
		}
		var metrics map[string]any
		if kind == "message" {
			metrics = map[string]any{"durationMs": completed.Sub(started).Milliseconds(), "ttftMs": firstToken.Sub(started).Milliseconds()}
			if hasUsage {
				metrics["inputTokens"], metrics["outputTokens"] = int64(usage.InputTokens()), int64(usage.OutputTokens())
			}
		}
		if err := emit(chatruntime.ChatTurnStreamEvent{Type: eventTypeTimelineItemCompleted,
			Kind: kind, ItemID: item.id, Role: "assistant", Content: item.content.String(),
			Metrics: metrics, CreatedAt: started.UnixMilli(), UpdatedAt: completed.UnixMilli()}); err != nil {
			return err
		}
	}
	return emit(chatruntime.ChatTurnStreamEvent{Type: eventTypeTurnCompleted})
}

type gatewayStreamItem struct {
	id      string
	content strings.Builder
}
