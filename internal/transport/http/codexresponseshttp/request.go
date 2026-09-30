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
)

const MaxRequestBytes int64 = 16 * 1024 * 1024

var errInvalidRequest = errors.New("invalid native Responses request")

type nativeRequest struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
}

func readRequest(request *http.Request) ([]byte, nativeRequest, error) {
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
	if err != nil || json.Unmarshal(body, &metadata) != nil || metadata.Model == "" {
		return payload, metadata, errInvalidRequest
	}
	return payload, metadata, nil
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	if reader == nil {
		return nil, errInvalidRequest
	}
	payload, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil || int64(len(payload)) > limit {
		return nil, errInvalidRequest
	}
	return payload, nil
}
