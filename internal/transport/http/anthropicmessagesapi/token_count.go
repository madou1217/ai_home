package anthropicmessagesapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
)

// CountTokensPath 是 Anthropic count_tokens 的规范 HTTP 路径。
const CountTokensPath = "/v1/messages/count_tokens"

// ErrInvalidTokenCountDependencies 表示本地计数 Handler 缺少鉴权策略。
var ErrInvalidTokenCountDependencies = errors.New("Anthropic count_tokens Handler 依赖无效")

// TokenCountDependencies 声明本地计数所需的窄依赖。
//
// 这里刻意不要 Executor：count_tokens 是纯本地估算，不选账号、不发上游请求，
// 与 Node 的 v1-router 一致（命中该协议后直接写本地响应并返回）。
type TokenCountDependencies struct {
	Authorizer   Authorizer
	MaxBodyBytes int64
}

// TokenCountHandler 提供 POST /v1/messages/count_tokens。
type TokenCountHandler struct {
	authorizer   Authorizer
	maxBodyBytes int64
}

// writeNodeTokenCountError preserves the legacy Node v1-router error envelope
// for this local endpoint. It intentionally does not use the Anthropic
// Messages envelope because count_tokens is handled before protocol routing
// in Node and therefore returns {ok:false,error:...}.
func writeNodeTokenCountError(response http.ResponseWriter, status int, code string, allowed []string) {
	payload := struct {
		OK      bool     `json:"ok"`
		Error   string   `json:"error"`
		Allowed []string `json:"allowed,omitempty"`
	}{OK: false, Error: code, Allowed: allowed}
	data, err := json.Marshal(payload)
	if err != nil {
		http.Error(response, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(response, status, data)
}

// NewTokenCountHandler 创建默认失败关闭的本地计数 Handler。
func NewTokenCountHandler(
	dependencies TokenCountDependencies,
) (*TokenCountHandler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidTokenCountDependencies
	}
	maxBodyBytes := dependencies.MaxBodyBytes
	if maxBodyBytes == 0 {
		maxBodyBytes = DefaultMaxBodyBytes
	}
	if maxBodyBytes < 1 || maxBodyBytes > MaxBodyBytesLimit {
		return nil, ErrInvalidTokenCountDependencies
	}
	return &TokenCountHandler{
		authorizer:   dependencies.Authorizer,
		maxBodyBytes: maxBodyBytes,
	}, nil
}

// ServeHTTP 完成鉴权后返回本地估算的 input_tokens。
func (handler *TokenCountHandler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		!handler.authorizer.Authorized(request) {
		writeNodeTokenCountError(response, http.StatusUnauthorized, "unauthorized_client", nil)
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeNodeTokenCountError(response, http.StatusMethodNotAllowed, "method_not_allowed", []string{"POST"})
		return
	}
	body, err := readTokenCountBody(response, request, handler.maxBodyBytes)
	if err != nil {
		if errors.Is(err, errTokenCountBodyTooLarge) {
			writeNodeTokenCountError(response, http.StatusRequestEntityTooLarge, "request_body_too_large", nil)
			return
		}
		writeNodeTokenCountError(response, http.StatusBadRequest, "invalid_request_body", nil)
		return
	}
	result := anthropicmessages.EstimateInputTokens(body)
	data, err := json.Marshal(result)
	if err != nil {
		http.Error(response, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(response, http.StatusOK, data)
}

// errTokenCountBodyTooLarge 表示请求体超过配置上限。
var errTokenCountBodyTooLarge = errors.New("token count body too large")

// readTokenCountBody 在明确上限内读取请求体。
//
// 上限必须显式设置：count_tokens 走的是同一客户端密钥闸门，不能因为它是本地估算
// 就允许无界读取。
func readTokenCountBody(
	response http.ResponseWriter,
	request *http.Request,
	maxBodyBytes int64,
) ([]byte, error) {
	if request.Body == nil {
		return nil, nil
	}
	limited := http.MaxBytesReader(response, request.Body, maxBodyBytes)
	defer func() { _ = limited.Close() }()
	body, err := io.ReadAll(limited)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return nil, errTokenCountBodyTooLarge
		}
		return nil, err
	}
	return bytes.TrimSpace(body), nil
}
