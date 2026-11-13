package windowactivation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"
)

const (
	// DefaultProbeTimeout 单次探测 HTTP 请求超时上限。
	DefaultProbeTimeout = 30 * time.Second
	// DefaultMaxResponseBytes 单次探测响应体读取上限，防上游异常响应占满内存。
	DefaultMaxResponseBytes int64 = 256 * 1024
)

// ProbeInput 描述单次极小探测派发参数。
type ProbeInput struct {
	BaseURL          string
	ClientKey        string
	Spec             ProbeSpec
	Model            string
	Provider         string
	AccountRef       string
	HTTPClient       *http.Client
	LocalHandler     http.Handler
	Timeout          time.Duration
	MaxResponseBytes int64
}

// ProbeResult 描述单次极小探测响应结果。
type ProbeResult struct {
	OK               bool   `json:"ok"`
	Matched          bool   `json:"matched"`
	HTTPStatus       *int   `json:"httpStatus"`
	ServedAccountRef string `json:"servedAccountRef"`
	Model            string `json:"model"`
	Error            string `json:"error"`
}

// DispatchFunc 允许调度器在测试或内嵌场景中替换实际 HTTP 派发实现。
type DispatchFunc func(ctx context.Context, input ProbeInput) ProbeResult

// DispatchProbe 通过本机 /v1/* 数据面（优先 HTTP 回环，未配置基址且有 LocalHandler 时直调处理器）
// 发送单次最小请求并核对响应头 x-aih-server-account-ref。
func DispatchProbe(ctx context.Context, input ProbeInput) ProbeResult {
	if ctx == nil {
		ctx = context.Background()
	}
	result := ProbeResult{}
	origin := strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	accountRef := strings.TrimSpace(input.AccountRef)
	if (origin == "" && input.LocalHandler == nil) || input.Spec.Body == nil || accountRef == "" {
		result.Error = "probe_input_invalid"
		return result
	}

	model := strings.TrimSpace(input.Model)
	if model == "" {
		model = strings.TrimSpace(input.Spec.Model)
	}
	probePath := ""
	if input.Spec.Path != nil {
		probePath = strings.TrimSpace(input.Spec.Path(model))
	}
	if probePath == "" {
		result.Error = "probe_input_invalid"
		return result
	}
	if !strings.HasPrefix(probePath, "/") {
		probePath = "/" + probePath
	}
	result.Model = model

	bodyBytes, err := json.Marshal(input.Spec.Body(model))
	if err != nil {
		result.Error = "probe_marshal_failed"
		return result
	}

	timeout := input.Timeout
	if timeout <= 0 {
		timeout = DefaultProbeTimeout
	}
	maxBytes := input.MaxResponseBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxResponseBytes
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	targetURL := probePath
	if origin != "" {
		targetURL = origin + probePath
	}

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, targetURL, bytes.NewReader(bodyBytes))
	if err != nil {
		result.Error = "probe_request_invalid"
		return result
	}
	clientKey := strings.TrimSpace(input.ClientKey)
	if clientKey == "" {
		clientKey = "dummy"
	}
	provider := NormalizeProvider(input.Provider)
	if provider == "" {
		provider = NormalizeProvider(input.Spec.Provider)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+clientKey)
	req.Header.Set("X-Provider", provider)
	req.Header.Set("X-Account-Ref", accountRef)

	if origin == "" && input.LocalHandler != nil {
		recorder := httptest.NewRecorder()
		input.LocalHandler.ServeHTTP(recorder, req)
		resp := recorder.Result()
		defer func() { _ = resp.Body.Close() }()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxBytes))
		return finalizeProbeHTTPResult(result, resp.StatusCode, resp.Header, accountRef)
	}

	client := input.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			result.Error = "TimeoutError"
		} else {
			result.Error = err.Error()
		}
		if strings.TrimSpace(result.Error) == "" {
			result.Error = "probe_transport_failure"
		}
		return result
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxBytes))
	return finalizeProbeHTTPResult(result, resp.StatusCode, resp.Header, accountRef)
}

func finalizeProbeHTTPResult(result ProbeResult, statusCode int, headers http.Header, expectedAccountRef string) ProbeResult {
	status := statusCode
	result.HTTPStatus = &status
	served := strings.TrimSpace(headers.Get("x-aih-server-account-ref"))
	result.ServedAccountRef = served
	result.Matched = served == expectedAccountRef
	result.OK = statusCode >= 200 && statusCode < 300
	if !result.OK && result.Error == "" {
		if statusCode > 0 {
			result.Error = fmt.Sprintf("http_%d", statusCode)
		} else {
			result.Error = "probe_http_failure"
		}
	}
	return result
}
