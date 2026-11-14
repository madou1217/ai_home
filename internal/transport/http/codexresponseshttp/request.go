package codexresponseshttp

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
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

func readRequest(request *http.Request) ([]byte, nativeRequest, error) {
	if request.ContentLength > MaxRequestBytes {
		return nil, nativeRequest{}, inferenceapi.ErrRequestTooLarge
	}
	payload, err := readBounded(request.Body, MaxRequestBytes)
	if err != nil {
		return nil, nativeRequest{}, err
	}
	var decoded io.Reader = bytes.NewReader(payload)
	switch strings.ToLower(strings.TrimSpace(request.Header.Get("Content-Encoding"))) {
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
	if json.Unmarshal(body, &metadata) != nil || metadata.Model == "" {
		return payload, metadata, errInvalidRequest
	}
	return payload, metadata, nil
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
		return nil, errInvalidRequest
	}
	return payload, nil
}
