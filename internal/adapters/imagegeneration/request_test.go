package imagegeneration_test

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
)

// 与 Node 测试矩阵同源的字节样本。
const (
	pngHex = "89504e470d0a1a0a0000000d49484452"
	gifHex = "474946383961"
	jpgHex = "ffd8ff"
)

// dataURL 由十六进制样本构造 data URL，避免把 base64 字面量抄错。
func dataURL(t *testing.T, mimeType string, fixtureHex string) string {
	t.Helper()
	bytes, err := hex.DecodeString(fixtureHex)
	if err != nil {
		t.Fatalf("hex.DecodeString(%q) error = %v", fixtureHex, err)
	}
	return fmt.Sprintf("data:%s;base64,%s", mimeType, base64.StdEncoding.EncodeToString(bytes))
}

// TestParseMatchesNodeAcceptedRequests 逐条固定 Node 接受请求后的归一化结果。
//
// 期望值由 Node 自己的实现生成：
//
//	node -e "const {parseImageGenerationRequest}=require('./lib/server/image-generation-request'); …"
func TestParseMatchesNodeAcceptedRequests(t *testing.T) {
	t.Parallel()

	pngURL := dataURL(t, "image/png", pngHex)

	tests := []struct {
		name   string
		path   string
		body   string
		verify func(t *testing.T, request imagegeneration.Request)
	}{
		{
			name: "minimal generation defaults to one image and b64_json",
			path: imagegeneration.PathGenerations,
			body: `{"model":"gpt-image-1","prompt":"a cat"}`,
			verify: func(t *testing.T, request imagegeneration.Request) {
				if request.Mode != imagegeneration.ModeGeneration ||
					request.N != 1 ||
					request.ResponseFormat != imagegeneration.ResponseFormatB64JSON ||
					len(request.Images) != 0 {
					t.Fatalf("request = %#v", request)
				}
			},
		},
		{
			// Node 用 Number(body.n)，因此数字字符串会被接受。
			name: "numeric string n is coerced",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","n":"10"}`,
			verify: func(t *testing.T, request imagegeneration.Request) {
				if request.N != 10 {
					t.Fatalf("n = %d, want 10", request.N)
				}
			},
		},
		{
			name: "boolean true n is coerced to one",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","n":true}`,
			verify: func(t *testing.T, request imagegeneration.Request) {
				if request.N != 1 {
					t.Fatalf("n = %d, want 1", request.N)
				}
			},
		},
		{
			name: "size and quality are normalized",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","size":"12345x99999","quality":"HIGH"}`,
			verify: func(t *testing.T, request imagegeneration.Request) {
				if request.Size != "12345x99999" || request.Quality != "high" {
					t.Fatalf("size=%q quality=%q", request.Size, request.Quality)
				}
			},
		},
		{
			name: "response_format url is honored",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","response_format":"url"}`,
			verify: func(t *testing.T, request imagegeneration.Request) {
				if request.ResponseFormat != imagegeneration.ResponseFormatURL {
					t.Fatalf("response_format = %q", request.ResponseFormat)
				}
			},
		},
		{
			name: "lossy output format accepts numeric string compression",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","output_format":"webp","output_compression":"50"}`,
			verify: func(t *testing.T, request imagegeneration.Request) {
				if request.OutputFormat != "webp" ||
					request.OutputCompression == nil ||
					*request.OutputCompression != 50 {
					t.Fatalf("request = %#v", request)
				}
			},
		},
		{
			name: "zero compression stays present",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","output_format":"webp","output_compression":0}`,
			verify: func(t *testing.T, request imagegeneration.Request) {
				if request.OutputCompression == nil || *request.OutputCompression != 0 {
					t.Fatalf("output_compression = %v", request.OutputCompression)
				}
			},
		},
		{
			name: "provider is lowercased",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","provider":"Codex"}`,
			verify: func(t *testing.T, request imagegeneration.Request) {
				if request.Provider != "codex" {
					t.Fatalf("provider = %q", request.Provider)
				}
			},
		},
		{
			name: "moderation is lowercased",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","moderation":"LOW"}`,
			verify: func(t *testing.T, request imagegeneration.Request) {
				if request.Moderation != "low" {
					t.Fatalf("moderation = %q", request.Moderation)
				}
			},
		},
		{
			name: "single image edit",
			path: imagegeneration.PathEdits,
			body: fmt.Sprintf(`{"model":"m","prompt":"p","image":%q}`, pngURL),
			verify: func(t *testing.T, request imagegeneration.Request) {
				if request.Mode != imagegeneration.ModeEdit ||
					len(request.Images) != 1 ||
					request.Images[0].MIME != "image/png" {
					t.Fatalf("request = %#v", request)
				}
			},
		},
		{
			name: "image_url object form is accepted",
			path: imagegeneration.PathEdits,
			body: fmt.Sprintf(`{"model":"m","prompt":"p","images":[{"image_url":%q}]}`, pngURL),
			verify: func(t *testing.T, request imagegeneration.Request) {
				if len(request.Images) != 1 || request.Images[0].MIME != "image/png" {
					t.Fatalf("images = %#v", request.Images)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request, err := imagegeneration.Parse(
				[]byte(test.body),
				test.path,
				imagegeneration.Options{},
			)
			if err != nil {
				t.Fatalf("Parse() error = %v", err)
			}
			test.verify(t, request)
		})
	}
}

// TestParseMatchesNodeRejections 逐条固定 Node 拒绝请求时的状态码与错误码。
func TestParseMatchesNodeRejections(t *testing.T) {
	t.Parallel()

	pngURL := dataURL(t, "image/png", pngHex)
	gifURL := dataURL(t, "image/gif", gifHex)
	jpgURL := dataURL(t, "image/jpeg", jpgHex)
	seventeenImages := "[" + strconv.Quote(pngURL)
	for index := 1; index < 17; index++ {
		seventeenImages += "," + strconv.Quote(pngURL)
	}
	seventeenImages += "]"

	tests := []struct {
		name string
		path string
		body string
		code string
	}{
		{
			name: "missing model",
			path: imagegeneration.PathGenerations,
			body: `{"prompt":"a cat"}`,
			code: "model_required",
		},
		{
			name: "missing prompt",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m"}`,
			code: "prompt_required",
		},
		{
			name: "n below range",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","n":0}`,
			code: "invalid_n",
		},
		{
			name: "n above range",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","n":11}`,
			code: "invalid_n",
		},
		{
			name: "n fractional",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","n":2.5}`,
			code: "invalid_n",
		},
		{
			name: "n boolean false",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","n":false}`,
			code: "invalid_n",
		},
		{
			// Number('') 是 0，因此落在范围外。
			name: "n empty string",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","n":""}`,
			code: "invalid_n",
		},
		{
			name: "size too short",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","size":"1x1"}`,
			code: "invalid_size",
		},
		{
			name: "size not a dimension pair",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","size":"huge"}`,
			code: "invalid_size",
		},
		{
			name: "unknown quality",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","quality":"ultra"}`,
			code: "invalid_quality",
		},
		{
			name: "unknown response format",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","response_format":"png"}`,
			code: "invalid_response_format",
		},
		{
			name: "transparent background with jpeg",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","background":"transparent","output_format":"jpeg"}`,
			code: "transparent_background_requires_alpha_format",
		},
		{
			name: "compression without lossy format",
			path: imagegeneration.PathGenerations,
			body: `{"model":"m","prompt":"p","output_compression":50}`,
			code: "output_compression_requires_lossy_format",
		},
		{
			name: "image input on the generation endpoint",
			path: imagegeneration.PathGenerations,
			body: fmt.Sprintf(`{"model":"m","prompt":"p","image":%q}`, pngURL),
			code: "image_requires_edit",
		},
		{
			name: "mask on the generation endpoint",
			path: imagegeneration.PathGenerations,
			body: fmt.Sprintf(`{"model":"m","prompt":"p","mask":%q}`, pngURL),
			code: "mask_requires_edit",
		},
		{
			name: "edit without any image",
			path: imagegeneration.PathEdits,
			body: `{"model":"m","prompt":"p"}`,
			code: "image_required",
		},
		{
			name: "both image and images",
			path: imagegeneration.PathEdits,
			body: fmt.Sprintf(
				`{"model":"m","prompt":"p","image":%q,"images":[%q]}`,
				pngURL,
				pngURL,
			),
			code: "ambiguous_image_input",
		},
		{
			// 请求入口的白名单只有 png/jpeg/webp，gif 被拒。
			name: "gif input is rejected by the request whitelist",
			path: imagegeneration.PathEdits,
			body: fmt.Sprintf(`{"model":"m","prompt":"p","image":%q}`, gifURL),
			code: "invalid_image_mime",
		},
		{
			name: "non png mask",
			path: imagegeneration.PathEdits,
			body: fmt.Sprintf(
				`{"model":"m","prompt":"p","image":%q,"mask":%q}`,
				pngURL,
				jpgURL,
			),
			code: "invalid_image_mask_mime",
		},
		{
			name: "non data url reference",
			path: imagegeneration.PathEdits,
			body: `{"model":"m","prompt":"p","image":"https://example.test/x.png"}`,
			code: "invalid_image_data_url",
		},
		{
			// 声明 png 但字节是 gif。
			name: "declared mime disagrees with bytes",
			path: imagegeneration.PathEdits,
			body: fmt.Sprintf(
				`{"model":"m","prompt":"p","image":"data:image/png;base64,%s"}`,
				base64.StdEncoding.EncodeToString(mustHex(t, gifHex)),
			),
			code: "invalid_image_mime",
		},
		{
			name: "too many input images",
			path: imagegeneration.PathEdits,
			body: fmt.Sprintf(
				`{"model":"m","prompt":"p","images":%s}`,
				seventeenImages,
			),
			code: "invalid_image_count",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := imagegeneration.Parse(
				[]byte(test.body),
				test.path,
				imagegeneration.Options{},
			)
			requestErr, ok := imagegeneration.AsError(err)
			if !ok {
				t.Fatalf("Parse() error = %v, want a request error", err)
			}
			if requestErr.StatusCode != 400 || requestErr.Code != test.code {
				t.Fatalf(
					"error = %d/%s, want 400/%s",
					requestErr.StatusCode,
					requestErr.Code,
					test.code,
				)
			}
		})
	}
}

// TestParseRejectsOversizedImage 验证单张图片的字节上限生效。
func TestParseRejectsOversizedImage(t *testing.T) {
	t.Parallel()

	oversized := append(mustHex(t, pngHex), make([]byte, 4096)...)
	body := fmt.Sprintf(
		`{"model":"m","prompt":"p","image":"data:image/png;base64,%s"}`,
		base64.StdEncoding.EncodeToString(oversized),
	)
	_, err := imagegeneration.Parse(
		[]byte(body),
		imagegeneration.PathEdits,
		imagegeneration.Options{MaxImageBytes: 1024},
	)
	requestErr, ok := imagegeneration.AsError(err)
	if !ok || requestErr.Code != "image_too_large" {
		t.Fatalf("error = %v, want image_too_large", err)
	}
}

// TestParseRejectsMalformedBody 验证非对象正文按请求错误处理。
func TestParseRejectsMalformedBody(t *testing.T) {
	t.Parallel()

	_, err := imagegeneration.Parse(
		[]byte(`[1,2,3]`),
		imagegeneration.PathGenerations,
		imagegeneration.Options{},
	)
	requestErr, ok := imagegeneration.AsError(err)
	if !ok || requestErr.Code != "invalid_request_body" {
		t.Fatalf("error = %v, want invalid_request_body", err)
	}
	var requestErrPointer *imagegeneration.Error
	if !errors.As(err, &requestErrPointer) {
		t.Fatal("errors.As should recover the request error")
	}
}

// mustHex 解码测试用的十六进制样本。
func mustHex(t *testing.T, value string) []byte {
	t.Helper()
	bytes, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("hex.DecodeString(%q) error = %v", value, err)
	}
	return bytes
}
