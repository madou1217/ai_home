package relaybridge

import (
	"encoding/json"
	"net/http"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
	"github.com/madou1217/ai_home/internal/transport/http/anthropicmessagesapi"
)

// AnthropicSurface 把 Anthropic Messages 入口桥接到 Chat 透传通道。
func AnthropicSurface() Surface {
	return anthropicSurface{}
}

type anthropicSurface struct{}

func (anthropicSurface) ID() string { return "anthropic_messages" }

func (anthropicSurface) Path() string { return anthropicmessagesapi.Path }

func (anthropicSurface) Decode(body []byte) (Decoded, error) {
	request, err := anthropicmessages.NewAdapter().Decode(body)
	if err != nil {
		return Decoded{}, err
	}
	chat, err := anthropicToChat(body)
	if err != nil {
		return Decoded{}, err
	}
	return Decoded{Chat: chat, Request: request, Stream: request.Stream()}, nil
}

func (anthropicSurface) NewRenderer(request inference.Request) (clientprotocol.StreamRenderer, error) {
	return anthropicmessages.NewStreamRenderer(request), nil
}

func (anthropicSurface) NewAggregator(request inference.Request) clientprotocol.ResponseAggregator {
	return anthropicmessages.NewResponseAggregator(request)
}

func (anthropicSurface) ErrorBody(status int, code string, message string) []byte {
	payload, _ := json.Marshal(map[string]any{
		"type": "error",
		"error": map[string]string{
			"type":    anthropicErrorType(status),
			"message": message,
		},
	})
	return payload
}

func (anthropicSurface) ErrorEvent(status int, code string, message string) (clientprotocol.RenderedEvent, bool) {
	frame, err := clientprotocol.NewRenderedEvent(
		"error",
		anthropicSurface{}.ErrorBody(status, code, message),
	)
	return frame, err == nil
}

// anthropicErrorType 把 HTTP 状态映射到 Anthropic 公开错误类别。
func anthropicErrorType(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "invalid_request_error"
	case http.StatusUnauthorized:
		return "authentication_error"
	case http.StatusForbidden:
		return "permission_error"
	case http.StatusNotFound:
		return "not_found_error"
	case http.StatusRequestEntityTooLarge:
		return "request_too_large"
	case http.StatusTooManyRequests:
		return "rate_limit_error"
	case http.StatusServiceUnavailable, http.StatusBadGateway, 529:
		return "overloaded_error"
	default:
		return "api_error"
	}
}
