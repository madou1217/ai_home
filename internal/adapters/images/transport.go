package images

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/imagedata"
)

// 本文件承载上游传输、响应解析与输出归一化。
// 对应 Node 的 image-generation-api-transport.js、image-generation-response.js
// 与 image-generation-output.js。

// sendUpstream 发送一次有界上游请求并返回成功响应体。
//
// 失败统一映射为上游状态码 + 可读 detail：非 2xx 保留上游 error.message/detail，
// 传输错误映射为 502 upstream_failed，避免把网络异常伪装成客户端错误。
func sendUpstream(
	ctx context.Context,
	doer HTTPDoer,
	target string,
	apply func(*http.Request),
	body []byte,
) ([]byte, *Error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return nil, newError(500, "upstream_failed", "upstream request is not constructable")
	}
	if apply != nil {
		apply(request)
	}
	response, err := doer.Do(request)
	if err != nil {
		return nil, newError(502, "upstream_failed", "upstream fetch failed: "+err.Error())
	}
	defer func() { _ = response.Body.Close() }()

	limited := io.LimitReader(response.Body, maxUpstreamBodyBytes+1)
	payload, readErr := io.ReadAll(limited)
	if readErr != nil {
		return nil, newError(502, "upstream_failed", "upstream response is not readable")
	}
	if int64(len(payload)) > maxUpstreamBodyBytes {
		return nil, newError(502, "upstream_response_too_large", "upstream response exceeds the size limit")
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		generationErr := newError(
			response.StatusCode,
			"upstream_failed",
			readUpstreamErrorDetail(response.StatusCode, payload),
		)
		generationErr.UpstreamBody = truncate(payload, 500)
		generationErr.UpstreamURL = target
		return nil, generationErr
	}
	return payload, nil
}

// readUpstreamErrorDetail 从上游错误体里取可读说明。
func readUpstreamErrorDetail(status int, payload []byte) string {
	var document struct {
		Error struct {
			Message string `json:"message"`
			Detail  string `json:"detail"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &document); err == nil {
		if detail := strings.TrimSpace(document.Error.Message); detail != "" {
			return detail
		}
		if detail := strings.TrimSpace(document.Error.Detail); detail != "" {
			return detail
		}
	}
	return fmt.Sprintf("upstream returned HTTP %d", status)
}

// parseOpenAIImagesResponse 解析 OpenAI 兼容的图片响应并归一化。
func parseOpenAIImagesResponse(payload []byte) (Result, error) {
	var document struct {
		Data []struct {
			B64JSON       string `json:"b64_json"`
			URL           string `json:"url"`
			MIMEType      string `json:"mimeType"`
			RevisedPrompt string `json:"revised_prompt"`
		} `json:"data"`
		Usage json.RawMessage `json:"usage"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return Result{}, newError(502, "upstream_failed", "upstream returned invalid JSON")
	}
	candidates := make([]GeneratedImage, 0, len(document.Data))
	for _, item := range document.Data {
		candidates = append(candidates, GeneratedImage{
			B64JSON:       strings.TrimSpace(item.B64JSON),
			URL:           strings.TrimSpace(item.URL),
			MIME:          item.MIMEType,
			RevisedPrompt: item.RevisedPrompt,
		})
	}
	normalized, err := NormalizeImages(candidates)
	if err != nil {
		return Result{}, err
	}
	return Result{Images: normalized, Usage: document.Usage}, nil
}

// parseGeminiImageResponse 从 Code Assist generateContent 响应里提取内联图片。
func parseGeminiImageResponse(payload []byte) (Result, error) {
	// Code Assist 把标准 Gemini 响应包在 {"response": {...}} 里，先剥掉信封。
	var envelope struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(payload, &envelope); err == nil && len(envelope.Response) > 0 && envelope.Response[0] == '{' {
		payload = envelope.Response
	}
	var document struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					InlineData *struct {
						MIMEType string `json:"mimeType"`
						Data     string `json:"data"`
					} `json:"inlineData"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		UsageMetadata json.RawMessage `json:"usageMetadata"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return Result{}, newError(502, "upstream_failed", "upstream returned invalid JSON")
	}
	candidates := []GeneratedImage{}
	if len(document.Candidates) > 0 {
		for _, part := range document.Candidates[0].Content.Parts {
			if part.InlineData == nil {
				continue
			}
			data := strings.TrimSpace(part.InlineData.Data)
			if data == "" {
				continue
			}
			candidates = append(candidates, GeneratedImage{
				B64JSON: data,
				MIME:    part.InlineData.MIMEType,
			})
		}
	}
	normalized, err := NormalizeImages(candidates)
	if err != nil {
		return Result{}, err
	}
	return Result{Images: normalized, Usage: document.UsageMetadata}, nil
}

// NormalizeImages 校验并归一化策略产出的图片。
//
// 与 Node 的 normalizeImageGenerationImages 逐条对齐：
//   - 内联图片必须是规范 base64，且魔数嗅探出的类型与声明类型一致；
//   - URL 必须是 http/https 且不含用户信息（避免凭据泄漏到客户端）；
//   - 一项都没有时返回 502 image_output_missing，而不是回一个空 data 数组。
func NormalizeImages(candidates []GeneratedImage) ([]GeneratedImage, error) {
	normalized := make([]GeneratedImage, 0, len(candidates))
	for _, candidate := range candidates {
		if strings.TrimSpace(candidate.B64JSON) != "" {
			image, err := normalizeBase64Image(candidate)
			if err != nil {
				return nil, err
			}
			normalized = append(normalized, image)
			continue
		}
		if strings.TrimSpace(candidate.URL) != "" {
			normalizedURL := NormalizeImageOutputURL(candidate.URL)
			if normalizedURL == "" {
				return nil, newError(
					502,
					"invalid_image_output_url",
					"upstream returned an unsafe or malformed image URL",
				)
			}
			normalized = append(normalized, GeneratedImage{
				URL:           normalizedURL,
				RevisedPrompt: candidate.RevisedPrompt,
			})
		}
	}
	if len(normalized) < 1 {
		return nil, newError(502, "image_output_missing", "upstream returned no usable image data")
	}
	return normalized, nil
}

// normalizeBase64Image 校验内联图片的 base64 与媒体类型。
func normalizeBase64Image(candidate GeneratedImage) (GeneratedImage, error) {
	decoded, ok := imagedata.DecodeCanonicalBase64(candidate.B64JSON)
	if !ok {
		return GeneratedImage{}, newError(
			502,
			"invalid_image_output",
			"upstream returned invalid image base64",
		)
	}
	detected := imagedata.DetectMIME(decoded.Bytes)
	if detected == "" {
		return GeneratedImage{}, newError(
			502,
			"invalid_image_output",
			"upstream returned base64 that is not a supported image",
		)
	}
	declared := imagedata.NormalizeMIME(candidate.MIME)
	if strings.TrimSpace(candidate.MIME) != "" && (declared == "" || declared != detected) {
		return GeneratedImage{}, newError(
			502,
			"invalid_image_output",
			"upstream image mime type does not match its bytes",
		)
	}
	return GeneratedImage{
		B64JSON:       decoded.Base64,
		MIME:          string(detected),
		RevisedPrompt: candidate.RevisedPrompt,
	}, nil
}

// NormalizeImageOutputURL 只接受无凭据的 http/https 地址。
func NormalizeImageOutputURL(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	if parsed.Host == "" || parsed.User != nil {
		return ""
	}
	return parsed.String()
}

// buildUpstreamMultipart 组装编辑请求的 multipart 体。
//
// 字段名与 Node 一致：单图用 `image`，多图用 `image[]`，蒙版用 `mask`。
func buildUpstreamMultipart(
	input Input,
	fields map[string]any,
) ([]byte, string, *Error) {
	buffer := &bytes.Buffer{}
	writer := multipart.NewWriter(buffer)
	fieldName := "image"
	if len(input.Images) > 1 {
		fieldName = "image[]"
	}
	for index, image := range input.Images {
		bytes, ok := imagedata.DecodeCanonicalBase64(image.Data)
		if !ok {
			return nil, "", newError(400, "invalid_image_data_url", "image payload is not decodable")
		}
		part, err := writer.CreateFormFile(fieldName, fmt.Sprintf("image-%d", index+1))
		if err != nil {
			return nil, "", newError(500, "passthrough_transport_unavailable", "multipart part is not writable")
		}
		if _, err := part.Write(bytes.Bytes); err != nil {
			return nil, "", newError(500, "passthrough_transport_unavailable", "multipart part is not writable")
		}
	}
	if input.Mask != nil {
		bytes, ok := imagedata.DecodeCanonicalBase64(input.Mask.Data)
		if !ok {
			return nil, "", newError(400, "invalid_image_mask", "mask payload is not decodable")
		}
		part, err := writer.CreateFormFile("mask", "mask.png")
		if err != nil {
			return nil, "", newError(500, "passthrough_transport_unavailable", "multipart part is not writable")
		}
		if _, err := part.Write(bytes.Bytes); err != nil {
			return nil, "", newError(500, "passthrough_transport_unavailable", "multipart part is not writable")
		}
	}
	for _, key := range sortedKeys(fields) {
		value := fields[key]
		if value == nil {
			continue
		}
		if err := writer.WriteField(key, fmt.Sprintf("%v", value)); err != nil {
			return nil, "", newError(500, "passthrough_transport_unavailable", "multipart field is not writable")
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", newError(500, "passthrough_transport_unavailable", "multipart body is not closable")
	}
	return buffer.Bytes(), writer.Boundary(), nil
}

// sortedKeys 返回稳定顺序的字段名，保证 multipart 体可复现。
func sortedKeys(fields map[string]any) []string {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	for index := 1; index < len(keys); index++ {
		for scan := index; scan > 0 && keys[scan] < keys[scan-1]; scan-- {
			keys[scan], keys[scan-1] = keys[scan-1], keys[scan]
		}
	}
	return keys
}

// truncate 把字节切片截断为最长 limit 字节的字符串。
func truncate(payload []byte, limit int) string {
	if len(payload) <= limit {
		return string(payload)
	}
	return string(payload[:limit])
}
