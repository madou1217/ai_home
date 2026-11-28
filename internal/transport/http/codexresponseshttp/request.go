package codexresponseshttp

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/klauspost/compress/zstd"
	"github.com/madou1217/ai_home/internal/transport/http/codexwire"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

const MaxRequestBytes int64 = codexwire.MaxRequestBytes

var errInvalidRequest = errors.New("invalid native Responses request")

type nativeRequest struct {
	Model              string          `json:"model"`
	Stream             bool            `json:"stream"`
	Store              *bool           `json:"store"`
	Input              json.RawMessage `json:"input"`
	PreviousResponseID string          `json:"previous_response_id"`
}

// passthroughSafe 报告请求能否原样转发给 Codex 上游。原样转发只适用于 codex CLI 形状的请求：
// ChatGPT 登录账号的上游要求 stream=true、显式 store=false、input 为列表，且不存储 response
// （previous_response_id 无从解析）。其他形状（OpenAI SDK 的同步请求、store 默认 true、
// store=null、字符串 input、链式续接）原样发出只会得到 400，交给 Node 按上游能力归一化或明确拒绝。
func (request nativeRequest) passthroughSafe() bool {
	if !request.Stream || request.PreviousResponseID != "" {
		return false
	}
	if request.Store == nil || *request.Store {
		return false
	}
	input := bytes.TrimSpace(request.Input)
	return len(input) > 0 && input[0] == '['
}

// readRequest 返回解压后的请求体。
//
// 之前返回原始（可能压缩的）请求体：压缩请求因此绕过 RequiresCanonicalProjection
// 与 SanitizeRequestPayload，交回 Canonical 时还会被当成不支持的 body 形状（415）。
// 长会话恰好都会压缩。现在统一解码一次，原生转发与下游交还都使用 JSON 明文，
// 上游不再携带客户端的 Content-Encoding（见 handler）。
func readRequest(response http.ResponseWriter, request *http.Request) ([]byte, nativeRequest, error) {
	if request.ContentLength > MaxRequestBytes {
		return nil, nativeRequest{}, inferenceapi.ErrRequestTooLarge
	}
	payload, err := inferenceapi.ReadRequestBody(response, request.Body, MaxRequestBytes)
	if err != nil {
		return nil, nativeRequest{}, err
	}
	encoding := strings.ToLower(strings.TrimSpace(request.Header.Get("Content-Encoding")))
	// 传输层（扩展/代理）可能吞掉 Content-Encoding，却把压缩字节留给服务端。
	// 明文 JSON 不可能以 zstd/gzip 魔数开头，按魔数识别并解码，避免把可读请求
	// 误判成 invalid_request_body。
	sniffed := ""
	if encoding == "" || encoding == "identity" {
		switch {
		case len(payload) >= 4 && payload[0] == 0x28 && payload[1] == 0xb5 && payload[2] == 0x2f && payload[3] == 0xfd:
			encoding, sniffed = "zstd", "zstd"
		case len(payload) >= 2 && payload[0] == 0x1f && payload[1] == 0x8b:
			encoding, sniffed = "gzip", "gzip"
		}
	}
	var decoded io.Reader = bytes.NewReader(payload)
	switch encoding {
	case "", "identity":
	case "gzip":
		reader, err := gzip.NewReader(decoded)
		if err != nil {
			return nil, nativeRequest{}, errInvalidRequest
		}
		defer reader.Close()
		decoded = reader
	case "zstd":
		reader, err := zstd.NewReader(decoded, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(uint64(MaxRequestBytes)))
		if err != nil {
			return nil, nativeRequest{}, errInvalidRequest
		}
		defer reader.Close()
		decoded = reader
	default:
		return nil, nativeRequest{}, errInvalidRequest
	}
	body, err := readBounded(decoded, MaxRequestBytes)
	var metadata nativeRequest
	if err != nil {
		return nil, metadata, err
	}
	if jsonErr := json.Unmarshal(body, &metadata); jsonErr != nil {
		// 保留可诊断细节：长度、编码来源与前缀魔数足以区分截断/压缩/形状错误，
		// 不落正文。
		return nil, metadata, fmt.Errorf("%w: json=%v len=%d encoding=%q sniffed=%q prefix=%x",
			errInvalidRequest, jsonErr, len(body), encoding, sniffed, bodyPrefix(body, 16))
	}
	// model 允许为空：Codex 从 WS 掉到 HTTPS 时，续接帧常常省略 model，
	// 交由 resolveContinuation 用持久化的响应上下文补回；无上下文时再拒绝。
	return body, metadata, nil
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	if reader == nil {
		return nil, errInvalidRequest
	}
	payload, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if int64(len(payload)) > limit || errors.Is(err, zstd.ErrDecoderSizeExceeded) || errors.Is(err, zstd.ErrWindowSizeExceeded) {
		return nil, inferenceapi.ErrRequestTooLarge
	}
	if err != nil {
		return nil, err
	}
	return payload, nil
}

// bodyPrefix 返回最多 n 字节前缀，用于日志识别压缩魔数。
func bodyPrefix(body []byte, n int) []byte {
	if len(body) < n {
		return body
	}
	return body[:n]
}
