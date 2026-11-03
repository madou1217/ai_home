package imagegeneration

import (
	"encoding/json"
	"errors"
	"strings"
)

// PassthroughMaxImageBytes 是透传口径的单张图片上限。
//
// 与入口请求体上限一致，不再套公开入口给原生策略定的 4 MiB：上游（OpenAI 兼容端点或另一台
// AIH）自己的上限才是权威，网关这一跳不该先拒（与 Node 的 PASSTHROUGH_MAX_IMAGE_BYTES 一致）。
const PassthroughMaxImageBytes = 16 * 1024 * 1024

// ParsePassthrough 是透传口径的宽松解析，只给 passthrough 策略用。
//
// 参数合法性的权威是上游（dall-e-3 的 quality=hd、style、user、seed、http 图片引用、file_id、
// 更大的输入图……），网关只取路由必需的字段，其余原样转发。调用方保证：没有任何透传账号可用时，
// 抛回严格解析的原始错误，原生策略永远拿不到宽松请求。
func ParsePassthrough(body []byte, pathname string, options Options) (Request, error) {
	mode := ModeGeneration
	if pathname == PathEdits {
		mode = ModeEdit
	}
	var document map[string]json.RawMessage
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := json.Unmarshal(body, &document); err != nil {
			return Request{}, requestError("invalid_request_body", "request body must be a JSON object")
		}
	}
	if document == nil {
		document = map[string]json.RawMessage{}
	}
	model := trimmedString(document["model"])
	if model == "" {
		return Request{}, requestError("model_required", "model is required")
	}
	provider := strings.ToLower(trimmedString(document["provider"]))
	prompt := ""
	if raw, found := document["prompt"]; found {
		var value string
		if err := json.Unmarshal(raw, &value); err == nil {
			prompt = value
		}
	}
	n := 1
	if raw, found := document["n"]; found && !isJSONNull(raw) {
		if value, ok := jsNumber(raw); ok && isJSInteger(value) && value >= 1 && value <= MaxOutputCount {
			n = int(value)
		}
	}
	stream := jsBoolean(document["stream"])
	responseFormat := ResponseFormatB64JSON
	if strings.EqualFold(trimmedString(document["response_format"]), "url") {
		responseFormat = ResponseFormatURL
	}
	if stream && responseFormat == ResponseFormatURL {
		return Request{}, requestError(
			"stream_requires_b64_json",
			"streaming image responses require response_format=b64_json",
		)
	}

	// 图片与蒙版只在能解出字节时才内联；http 链接、file_id 这类引用解不出字节，整体改用 JSON 转发。
	var images []Image
	jsonOnly := false
	if mode == ModeEdit {
		source := document["images"]
		if _, found := document["image"]; found {
			source = document["image"]
		}
		references, refErr := imageReferences(source)
		if refErr != nil {
			jsonOnly = true
		}
		for _, reference := range references {
			parsed, parseErr := parseDataURL(reference, PassthroughMaxImageBytes, options)
			if parseErr != nil {
				jsonOnly = true
				continue
			}
			images = append(images, parsed)
		}
	}
	var mask *Image
	if raw, found := document["mask"]; found && !isJSONNull(raw) {
		reference, refErr := imageReference(raw)
		if refErr != nil {
			jsonOnly = true
		} else if parsed, parseErr := parseDataURL(reference, PassthroughMaxImageBytes, options); parseErr != nil {
			jsonOnly = true
		} else {
			mask = &parsed
		}
	}

	return Request{
		Mode:            mode,
		Provider:        provider,
		Model:           model,
		Prompt:          prompt,
		N:               n,
		ResponseFormat:  responseFormat,
		Images:          images,
		Mask:            mask,
		Stream:          stream,
		Raw:             append(json.RawMessage(nil), body...),
		PassthroughOnly: true,
		JSONOnly:        jsonOnly,
	}, nil
}

// IsPassthroughCandidateError 判断严格解析的失败是否允许回落到透传口径。
//
// 只有「参数值不在网关白名单」这一类 400 可以回落：缺 model / prompt 任何上游都会拒绝，
// 回落只会把明确的错误变成一次无效的上游调用。
func IsPassthroughCandidateError(err error) bool {
	var requestErr *Error
	if !errors.As(err, &requestErr) {
		return false
	}
	if requestErr.StatusCode != 400 {
		return false
	}
	switch requestErr.Code {
	case "model_required", "prompt_required":
		return false
	}
	return true
}
