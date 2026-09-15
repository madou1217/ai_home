package images_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

// pngBase64 是带 PNG 魔数的最小载荷。
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAf/AAAAAElFTkSuQmCC"

// scriptedDoer 记录最后一次上游请求并返回预设响应。
type scriptedDoer struct {
	status int
	body   string
	err    error

	lastURL     string
	lastHeaders http.Header
	lastBody    []byte
}

// Do 实现 images.HTTPDoer。
func (doer *scriptedDoer) Do(request *http.Request) (*http.Response, error) {
	doer.lastURL = request.URL.String()
	doer.lastHeaders = request.Header.Clone()
	if request.Body != nil {
		payload, _ := io.ReadAll(request.Body)
		doer.lastBody = payload
	}
	if doer.err != nil {
		return nil, doer.err
	}
	status := doer.status
	if status == 0 {
		status = http.StatusOK
	}
	body := doer.body
	if body == "" {
		body = `{"data":[{"b64_json":"` + pngBase64 + `"}]}`
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{},
	}, nil
}

// editRequest 构造一次编辑请求。
func editRequest(t *testing.T) imagegeneration.Request {
	t.Helper()
	return imagegeneration.Request{
		Mode:   imagegeneration.ModeEdit,
		Model:  "gpt-image-2",
		Prompt: "make it blue",
		N:      1,
		Images: []imagegeneration.Image{
			{MIME: "image/png", Data: pngBase64},
		},
	}
}

// TestCheckCapabilitiesMatchesNodeGate 验证能力闸门逐条给出具体错误码。
func TestCheckCapabilitiesMatchesNodeGate(t *testing.T) {
	t.Parallel()

	codex := images.NewCodexStrategy("")
	tests := []struct {
		name    string
		request imagegeneration.Request
		code    string
	}{
		{
			name: "mask is not supported by codex",
			request: imagegeneration.Request{
				Mode:   imagegeneration.ModeEdit,
				Model:  "gpt-image-2",
				Prompt: "p",
				N:      1,
				Images: []imagegeneration.Image{{MIME: "image/png", Data: pngBase64}},
				Mask:   &imagegeneration.Image{MIME: "image/png", Data: pngBase64},
			},
			code: "unsupported_image_mask",
		},
		{
			name: "too many input images",
			request: imagegeneration.Request{
				Mode:   imagegeneration.ModeEdit,
				Model:  "gpt-image-2",
				Prompt: "p",
				N:      1,
				Images: make([]imagegeneration.Image, 6),
			},
			code: "unsupported_image_input_count",
		},
		{
			name: "background is supported by codex",
			request: imagegeneration.Request{
				Mode:       imagegeneration.ModeGeneration,
				Model:      "gpt-image-2",
				Prompt:     "p",
				N:          1,
				Background: "transparent",
			},
			code: "",
		},
		{
			name: "output format is not supported by codex",
			request: imagegeneration.Request{
				Mode:         imagegeneration.ModeGeneration,
				Model:        "gpt-image-2",
				Prompt:       "p",
				N:            1,
				OutputFormat: "webp",
			},
			code: "unsupported_image_output_format",
		},
		{
			name: "quality value must be declared",
			request: imagegeneration.Request{
				Mode:    imagegeneration.ModeGeneration,
				Model:   "gpt-image-2",
				Prompt:  "p",
				N:       1,
				Quality: "ultra",
			},
			code: "unsupported_image_quality_value",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			generationErr := images.CheckCapabilities(codex, "codex", test.request)
			if test.code == "" {
				if generationErr != nil {
					t.Fatalf("CheckCapabilities() = %v, want nil", generationErr)
				}
				return
			}
			if generationErr == nil || generationErr.Code != test.code {
				t.Fatalf("CheckCapabilities() = %v, want %s", generationErr, test.code)
			}
			if generationErr.StatusCode != 400 {
				t.Fatalf("status = %d, want 400", generationErr.StatusCode)
			}
		})
	}
}

// TestCodexStrategyPostsToImagesEndpoint 验证 codex 策略的地址、请求体与身份头。
func TestCodexStrategyPostsToImagesEndpoint(t *testing.T) {
	t.Parallel()

	doer := &scriptedDoer{}
	strategy := images.NewCodexStrategy("https://codex.example.test/backend-api/codex")
	result, err := strategy.Generate(context.Background(), images.Input{
		Mode:    imagegeneration.ModeGeneration,
		Model:   "gpt-image-2",
		Prompt:  "a cat",
		N:       2,
		Size:    "1024x1024",
		Quality: "high",
		Account: images.Account{
			AccessToken:       "token-1",
			AccountRef:        "acct_1",
			Email:             "a@example.test",
			UpstreamAccountID: "ws-1",
		},
		HTTP: doer,
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if doer.lastURL != "https://codex.example.test/backend-api/codex/images/generations" {
		t.Fatalf("url = %q", doer.lastURL)
	}
	if got := doer.lastHeaders.Get("Authorization"); got != "Bearer token-1" {
		t.Fatalf("authorization = %q", got)
	}
	if got := doer.lastHeaders.Get("chatgpt-account-id"); got != "ws-1" {
		t.Fatalf("chatgpt-account-id = %q", got)
	}
	var payload struct {
		Prompt     string `json:"prompt"`
		Background string `json:"background"`
		Model      string `json:"model"`
		N          int    `json:"n"`
		Quality    string `json:"quality"`
		Size       string `json:"size"`
	}
	if err := json.Unmarshal(doer.lastBody, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v body=%s", err, doer.lastBody)
	}
	if payload.Model != "gpt-image-2" ||
		payload.Prompt != "a cat" ||
		payload.N != 2 ||
		payload.Background != "auto" ||
		payload.Quality != "high" ||
		payload.Size != "1024x1024" {
		t.Fatalf("payload = %#v", payload)
	}
	if len(result.Images) != 1 || result.Images[0].MIME != "image/png" {
		t.Fatalf("images = %#v", result.Images)
	}
}

// TestCodexStrategyRejectsMissingToken 验证缺少令牌时失败关闭。
func TestCodexStrategyRejectsMissingToken(t *testing.T) {
	t.Parallel()

	strategy := images.NewCodexStrategy("https://codex.example.test")
	_, err := strategy.Generate(context.Background(), images.Input{
		Mode:   imagegeneration.ModeGeneration,
		Model:  "gpt-image-2",
		Prompt: "p",
		N:      1,
		HTTP:   &scriptedDoer{},
	})
	generationErr, ok := images.AsError(err)
	if !ok || generationErr.Code != "invalid_access_token" {
		t.Fatalf("error = %v, want invalid_access_token", err)
	}
}

// TestCodexStrategyMapsUpstreamError 验证上游错误体被透出为可读 detail。
func TestCodexStrategyMapsUpstreamError(t *testing.T) {
	t.Parallel()

	doer := &scriptedDoer{
		status: http.StatusTooManyRequests,
		body:   `{"error":{"message":"rate limited"}}`,
	}
	strategy := images.NewCodexStrategy("https://codex.example.test")
	_, err := strategy.Generate(context.Background(), images.Input{
		Mode:    imagegeneration.ModeGeneration,
		Model:   "gpt-image-2",
		Prompt:  "p",
		N:       1,
		Account: images.Account{AccessToken: "token"},
		HTTP:    doer,
	})
	generationErr, ok := images.AsError(err)
	if !ok || generationErr.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("error = %v", err)
	}
	if !strings.Contains(generationErr.Detail, "rate limited") {
		t.Fatalf("detail = %q", generationErr.Detail)
	}
}

// TestPassthroughSendsJSONForGenerationAndMultipartForEdits 验证两条上游线协议。
func TestPassthroughSendsJSONForGenerationAndMultipartForEdits(t *testing.T) {
	t.Parallel()

	strategy := images.PassthroughStrategy{}
	account := images.Account{
		APIKey:     "key-1",
		BaseURL:    "https://upstream.example.test",
		APIKeyMode: true,
	}

	generationDoer := &scriptedDoer{}
	if _, err := strategy.Generate(context.Background(), images.Input{
		Mode:    imagegeneration.ModeGeneration,
		Model:   "dall-e-3",
		Prompt:  "a cat",
		N:       1,
		Account: account,
		HTTP:    generationDoer,
	}); err != nil {
		t.Fatalf("Generate(generation) error = %v", err)
	}
	if generationDoer.lastURL != "https://upstream.example.test/v1/images/generations" {
		t.Fatalf("url = %q", generationDoer.lastURL)
	}
	if got := generationDoer.lastHeaders.Get("Content-Type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
	}
	if !strings.Contains(string(generationDoer.lastBody), `"response_format":"b64_json"`) {
		t.Fatalf("body = %s", generationDoer.lastBody)
	}

	editDoer := &scriptedDoer{}
	if _, err := strategy.Generate(context.Background(), images.Input{
		Mode:    imagegeneration.ModeEdit,
		Model:   "dall-e-3",
		Prompt:  "make it blue",
		N:       1,
		Images:  []imagegeneration.Image{{MIME: "image/png", Data: pngBase64}},
		Account: account,
		HTTP:    editDoer,
	}); err != nil {
		t.Fatalf("Generate(edit) error = %v", err)
	}
	if editDoer.lastURL != "https://upstream.example.test/v1/images/edits" {
		t.Fatalf("url = %q", editDoer.lastURL)
	}
	contentType := editDoer.lastHeaders.Get("Content-Type")
	if !strings.HasPrefix(contentType, "multipart/form-data; boundary=") {
		t.Fatalf("content-type = %q", contentType)
	}
	if !bytes.Contains(editDoer.lastBody, []byte("name=\"image\"")) {
		t.Fatalf("multipart body is missing the image part: %s", editDoer.lastBody)
	}
	if !bytes.Contains(editDoer.lastBody, []byte("make it blue")) {
		t.Fatalf("multipart body is missing the prompt field")
	}
}

// TestPassthroughRequiresBaseURL 验证缺少上游地址时失败关闭。
func TestPassthroughRequiresBaseURL(t *testing.T) {
	t.Parallel()

	_, err := images.PassthroughStrategy{}.Generate(context.Background(), images.Input{
		Mode:    imagegeneration.ModeGeneration,
		Model:   "dall-e-3",
		Prompt:  "p",
		N:       1,
		Account: images.Account{APIKey: "key", APIKeyMode: true},
		HTTP:    &scriptedDoer{},
	})
	generationErr, ok := images.AsError(err)
	if !ok || generationErr.Code != "account_base_url_missing" {
		t.Fatalf("error = %v, want account_base_url_missing", err)
	}
}

// TestNormalizeImagesRejectsInvalidOutput 验证输出归一化拒绝不可用结果。
func TestNormalizeImagesRejectsInvalidOutput(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		images   []images.GeneratedImage
		expected string
	}{
		{
			name:     "no images",
			images:   nil,
			expected: "image_output_missing",
		},
		{
			name:     "non canonical base64",
			images:   []images.GeneratedImage{{B64JSON: "not base64!!"}},
			expected: "invalid_image_output",
		},
		{
			name:     "bytes are not an image",
			images:   []images.GeneratedImage{{B64JSON: base64.StdEncoding.EncodeToString([]byte("hello"))}},
			expected: "invalid_image_output",
		},
		{
			name: "declared mime disagrees with bytes",
			images: []images.GeneratedImage{{
				B64JSON: pngBase64,
				MIME:    "image/jpeg",
			}},
			expected: "invalid_image_output",
		},
		{
			name:     "unsafe url",
			images:   []images.GeneratedImage{{URL: "file:///etc/passwd"}},
			expected: "invalid_image_output_url",
		},
		{
			name:     "url with credentials",
			images:   []images.GeneratedImage{{URL: "https://user:pass@example.test/x.png"}},
			expected: "invalid_image_output_url",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := images.NormalizeImages(test.images)
			generationErr, ok := images.AsError(err)
			if !ok || generationErr.Code != test.expected {
				t.Fatalf("error = %v, want %s", err, test.expected)
			}
		})
	}
}

// TestNormalizeImagesAcceptsSniffedBase64AndSafeURL 验证合法输出被保留。
func TestNormalizeImagesAcceptsSniffedBase64AndSafeURL(t *testing.T) {
	t.Parallel()

	normalized, err := images.NormalizeImages([]images.GeneratedImage{
		{B64JSON: pngBase64, RevisedPrompt: "revised"},
		{URL: "https://example.test/x.png"},
	})
	if err != nil {
		t.Fatalf("NormalizeImages() error = %v", err)
	}
	if len(normalized) != 2 ||
		normalized[0].MIME != "image/png" ||
		normalized[0].RevisedPrompt != "revised" ||
		normalized[1].URL != "https://example.test/x.png" {
		t.Fatalf("normalized = %#v", normalized)
	}
}

// TestExecutePrefersEligibleAccountAndRetries 验证编排只对可重试失败换号。
func TestExecutePrefersEligibleAccountAndRetries(t *testing.T) {
	t.Parallel()

	source := &scriptedSource{accounts: []images.Account{
		{Provider: "codex", AccountRef: "acct_first", AccessToken: "bad"},
		{Provider: "codex", AccountRef: "acct_second", AccessToken: "good"},
	}}
	doer := &flakyDoer{failuresBeforeSuccess: 1}
	registry := images.NewRegistry("https://codex.example.test", "")

	execution, err := images.Execute(
		context.Background(),
		registry,
		source,
		"codex",
		imagegeneration.Request{
			Mode:   imagegeneration.ModeGeneration,
			Model:  "gpt-image-2",
			Prompt: "p",
			N:      1,
		},
		images.ExecuteOptions{HTTP: doer},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if execution.Account.AccountRef != "acct_second" {
		t.Fatalf("account = %q, want acct_second", execution.Account.AccountRef)
	}
	if doer.calls != 2 {
		t.Fatalf("calls = %d, want 2", doer.calls)
	}
}

// TestExecuteReturnsCapabilityErrorWithoutRetry 验证能力类失败不换号。
func TestExecuteReturnsCapabilityErrorWithoutRetry(t *testing.T) {
	t.Parallel()

	source := &scriptedSource{accounts: []images.Account{
		{Provider: "codex", AccountRef: "acct_first", AccessToken: "good"},
	}}
	doer := &flakyDoer{}
	registry := images.NewRegistry("https://codex.example.test", "")

	_, err := images.Execute(
		context.Background(),
		registry,
		source,
		"codex",
		imagegeneration.Request{
			Mode:   imagegeneration.ModeGeneration,
			Model:  "gpt-image-2",
			Prompt: "p",
			N:      1,
			Size:   "1024x1024",
			// codex 不支持 output_format，闸门应在调用上游前拦下。
			OutputFormat: "webp",
		},
		images.ExecuteOptions{HTTP: doer},
	)
	generationErr, ok := images.AsError(err)
	if !ok || generationErr.Code != "unsupported_image_output_format" {
		t.Fatalf("error = %v, want unsupported_image_output_format", err)
	}
	if doer.calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", doer.calls)
	}
}

// TestExecuteRejectsUnsupportedProvider 验证没有图片能力的 Provider 得到明确 400。
func TestExecuteRejectsUnsupportedProvider(t *testing.T) {
	t.Parallel()

	source := &scriptedSource{accounts: []images.Account{
		{Provider: "claude", AccountRef: "acct_claude", AccessToken: "token"},
	}}
	registry := images.NewRegistry("https://codex.example.test", "")

	_, err := images.Execute(
		context.Background(),
		registry,
		source,
		"claude",
		imagegeneration.Request{
			Mode:   imagegeneration.ModeGeneration,
			Model:  "gpt-image-2",
			Prompt: "p",
			N:      1,
		},
		images.ExecuteOptions{HTTP: &scriptedDoer{}},
	)
	generationErr, ok := images.AsError(err)
	if !ok || generationErr.Code != "unsupported_image_provider" {
		t.Fatalf("error = %v, want unsupported_image_provider", err)
	}
	if generationErr.StatusCode != 400 {
		t.Fatalf("status = %d, want 400", generationErr.StatusCode)
	}
}

// scriptedSource 按 exclude 返回下一个候选账号。
type scriptedSource struct {
	accounts []images.Account
}

// Candidates 实现 images.AccountSource。
func (source *scriptedSource) Candidates(
	_ context.Context,
	_ string,
	_ string,
	exclude []string,
) ([]images.Account, error) {
	for _, account := range source.accounts {
		excluded := false
		for _, raw := range exclude {
			if raw == account.AccountRef {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}
		return []images.Account{account}, nil
	}
	return nil, nil
}

// flakyDoer 前 N 次返回 500，之后返回成功响应。
type flakyDoer struct {
	failuresBeforeSuccess int
	calls                 int
}

// Do 实现 images.HTTPDoer。
func (doer *flakyDoer) Do(*http.Request) (*http.Response, error) {
	doer.calls++
	if doer.calls <= doer.failuresBeforeSuccess {
		return &http.Response{
			StatusCode: http.StatusInternalServerError,
			Body:       io.NopCloser(strings.NewReader(`{"error":{"message":"boom"}}`)),
			Header:     http.Header{},
		}, nil
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body: io.NopCloser(strings.NewReader(
			`{"data":[{"b64_json":"` + pngBase64 + `"}]}`,
		)),
		Header: http.Header{},
	}, nil
}
