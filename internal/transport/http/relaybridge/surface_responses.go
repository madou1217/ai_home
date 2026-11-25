package relaybridge

import (
	"encoding/json"
	"net/http"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

// ResponsesSurface 把 OpenAI Responses 入口桥接到 Chat 透传通道。
func ResponsesSurface() Surface {
	return responsesSurface{}
}

type responsesSurface struct{}

func (responsesSurface) ID() string { return "openai_responses" }

func (responsesSurface) Path() string { return openairesponsesapi.Path }

func (responsesSurface) Decode(body []byte) (Decoded, error) {
	request, err := openairesponses.NewRequestDecoder().Decode(body)
	if err != nil {
		return Decoded{}, err
	}
	chat, err := responsesToChat(body)
	if err != nil {
		return Decoded{}, err
	}
	return Decoded{Chat: chat, Request: request, Stream: request.Stream()}, nil
}

func (responsesSurface) NewRenderer(request inference.Request) (clientprotocol.StreamRenderer, error) {
	return openairesponses.NewStreamRenderer(request, now()), nil
}

func (responsesSurface) NewAggregator(request inference.Request) clientprotocol.ResponseAggregator {
	return openairesponses.NewResponseAggregator(request, now())
}

func (responsesSurface) ErrorBody(status int, code string, message string) []byte {
	payload, _ := json.Marshal(map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    responsesErrorType(status),
			"param":   nil,
			"code":    code,
		},
	})
	return payload
}

func (responsesSurface) ErrorEvent(status int, code string, message string) (clientprotocol.RenderedEvent, bool) {
	payload, err := json.Marshal(map[string]any{
		"type":    "error",
		"code":    code,
		"message": message,
		"param":   nil,
	})
	if err != nil {
		return clientprotocol.RenderedEvent{}, false
	}
	frame, err := clientprotocol.NewRenderedEvent("error", payload)
	return frame, err == nil
}

// responsesErrorType 把 HTTP 状态映射到 OpenAI 错误类别。
func responsesErrorType(status int) string {
	switch status {
	case http.StatusBadRequest, http.StatusNotFound, http.StatusRequestEntityTooLarge:
		return "invalid_request_error"
	case http.StatusUnauthorized:
		return "authentication_error"
	case http.StatusForbidden:
		return "permission_error"
	case http.StatusTooManyRequests:
		return "rate_limit_error"
	default:
		return "server_error"
	}
}
