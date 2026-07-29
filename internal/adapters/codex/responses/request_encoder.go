package responses

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
)

// encodeRequest 把 Canonical Request 无损映射为 Codex Responses JSON。
func encodeRequest(
	request inference.Request,
	effectiveModel string,
	authKind codexauth.AuthKind,
	profile requestProfile,
) ([]byte, error) {
	if err := rejectUnsupportedRequest(request, authKind); err != nil {
		return nil, err
	}
	input, err := encodeMessages(request.Messages())
	if err != nil {
		return nil, err
	}
	tools, err := encodeTools(request.Tools())
	if err != nil {
		return nil, err
	}
	toolChoice, err := encodeToolChoice(request)
	if err != nil {
		return nil, err
	}
	reasoning, err := encodeReasoning(request)
	if err != nil {
		return nil, err
	}
	text, err := encodeStructuredOutput(request)
	if err != nil {
		return nil, err
	}
	store, _ := request.Store()
	parallelToolCalls, specified := request.ParallelToolCalls()
	if !specified {
		parallelToolCalls = true
	}
	include := make([]string, 0, 1)
	if request.IncludeEncryptedReasoning() {
		include = append(include, "reasoning.encrypted_content")
	}
	input, topLevelTools, parallelToolCalls, reasoning, include :=
		profile.projectRequest(
			input,
			tools,
			parallelToolCalls,
			reasoning,
			include,
		)
	wireRequest := requestDTO{
		Model:             effectiveModel,
		Input:             input,
		Tools:             topLevelTools,
		ToolChoice:        toolChoice,
		ParallelToolCalls: parallelToolCalls,
		Reasoning:         reasoning,
		Store:             store,
		Stream:            true,
		Include:           include,
		Text:              text,
	}
	payload, err := json.Marshal(wireRequest)
	if err != nil {
		return nil, ErrUnsupportedRequest
	}
	return payload, nil
}

// rejectUnsupportedRequest 在发送网络请求前拒绝不能无损表达的 Canonical 字段。
func rejectUnsupportedRequest(
	request inference.Request,
	authKind codexauth.AuthKind,
) error {
	if request.MaxOutputTokens() != 0 {
		return unsupported("max_output_tokens")
	}
	if _, found := request.Temperature(); found {
		return unsupported("temperature")
	}
	if _, found := request.TopP(); found {
		return unsupported("top_p")
	}
	if _, found := request.TopK(); found {
		return unsupported("top_k")
	}
	if _, found := request.UserID(); found {
		return unsupported("user_id")
	}
	if len(request.StopSequences()) != 0 {
		return unsupported("stop_sequences")
	}
	if len(request.PromptCacheBreakpoints()) != 0 {
		return unsupported("prompt_cache_breakpoints")
	}
	if _, found := request.Truncation(); found {
		return unsupported("truncation")
	}
	if _, found := request.Continuation(); found {
		return unsupported("continuation")
	}
	if store, found := request.Store(); found &&
		store &&
		authKind == codexauth.AuthKindOAuth {
		return unsupported("store")
	}
	return nil
}

// encodeMessages 保持消息和内容块顺序，并在 Responses 顶层拆开工具与 reasoning 项。
func encodeMessages(messages []inference.Message) ([]inputItemDTO, error) {
	items := make([]inputItemDTO, 0, len(messages))
	for messageIndex, message := range messages {
		encoded, err := encodeMessage(message)
		if err != nil {
			return nil, fmt.Errorf(
				"%w: messages[%d]",
				err,
				messageIndex,
			)
		}
		items = append(items, encoded...)
	}
	if len(items) == 0 {
		return nil, ErrUnsupportedRequest
	}
	return items, nil
}

// encodeMessage 把一个 Canonical 消息按内容联合类型拆成一个或多个输入项。
func encodeMessage(message inference.Message) ([]inputItemDTO, error) {
	if !message.IsValid() {
		return nil, ErrUnsupportedRequest
	}
	contents := message.Contents()
	items := make([]inputItemDTO, 0, len(contents))
	buffered := make([]contentItemDTO, 0, len(contents))
	flushMessage := func() {
		if len(buffered) == 0 {
			return
		}
		items = append(items, inputItemDTO{
			Type:    "message",
			Role:    string(message.Role()),
			Content: buffered,
			Phase:   string(message.Phase()),
		})
		buffered = nil
	}
	for index := 0; index < len(contents); index++ {
		switch content := contents[index].(type) {
		case inference.TextContent:
			buffered = append(
				buffered,
				encodeTextContent(message.Role(), content),
			)
		case inference.RefusalContent:
			buffered = append(buffered, contentItemDTO{
				Type:    "refusal",
				Refusal: content.Refusal(),
			})
		case inference.ImageContent:
			wireContent, err := encodeImageContent(content)
			if err != nil {
				return nil, err
			}
			buffered = append(buffered, wireContent)
		case inference.DocumentContent:
			wireContent, err := encodeDocumentContent(content)
			if err != nil {
				return nil, err
			}
			buffered = append(buffered, wireContent)
		case inference.ToolCallContent:
			if message.Phase() != "" {
				return nil, unsupported("message.phase")
			}
			flushMessage()
			items = append(items, inputItemDTO{
				Type:      "function_call",
				Name:      content.Name(),
				Arguments: string(content.Arguments()),
				CallID:    content.CallID(),
			})
		case inference.ToolResultContent:
			flushMessage()
			output, err := encodeToolResult(content)
			if err != nil {
				return nil, err
			}
			items = append(items, inputItemDTO{
				Type:   "function_call_output",
				CallID: content.CallID(),
				Output: output,
			})
		case inference.ReasoningContent:
			if message.Phase() != "" {
				return nil, unsupported("message.phase")
			}
			flushMessage()
			reasoning, consumed, err := encodeReasoningContents(contents[index:])
			if err != nil {
				return nil, err
			}
			items = append(items, reasoning)
			index += consumed - 1
		default:
			return nil, ErrUnsupportedRequest
		}
	}
	flushMessage()
	return items, nil
}

// encodeTextContent 根据历史角色选择 input_text 或 output_text。
func encodeTextContent(
	role inference.Role,
	content inference.TextContent,
) contentItemDTO {
	contentType := "input_text"
	if role == inference.RoleAssistant {
		contentType = "output_text"
	}
	return contentItemDTO{
		Type: contentType,
		Text: content.Text(),
	}
}

// encodeReasoningContents 合并相邻摘要和加密连续性。
func encodeReasoningContents(
	contents []inference.Content,
) (inputItemDTO, int, error) {
	item := inputItemDTO{Type: "reasoning"}
	consumed := 0
	for _, candidate := range contents {
		content, ok := candidate.(inference.ReasoningContent)
		if !ok {
			break
		}
		consumed++
		switch content.ReasoningKind() {
		case inference.ReasoningSummary:
			item.Summary = append(item.Summary, reasoningSummaryDTO{
				Type: "summary_text",
				Text: content.Text(),
			})
		case inference.ReasoningEncrypted:
			if item.EncryptedContent != "" {
				return inputItemDTO{}, 0, unsupported(
					"reasoning.encrypted_content",
				)
			}
			item.EncryptedContent = content.EncryptedData()
		case inference.ReasoningThinking:
			return inputItemDTO{}, 0, unsupported("reasoning.thinking")
		default:
			return inputItemDTO{}, 0, ErrUnsupportedRequest
		}
	}
	return item, consumed, nil
}

// encodeToolResult 保留文本、图片和文档结果；错误标记没有 Codex 原生字段。
func encodeToolResult(content inference.ToolResultContent) (any, error) {
	if content.IsError() {
		return nil, unsupported("tool_result.is_error")
	}
	contents := content.Contents()
	if len(contents) == 0 {
		return "", nil
	}
	if len(contents) == 1 {
		if text, ok := contents[0].(inference.TextContent); ok {
			return text.Text(), nil
		}
	}
	encoded := make([]contentItemDTO, len(contents))
	for index, nested := range contents {
		var (
			wireContent contentItemDTO
			err         error
		)
		switch typed := nested.(type) {
		case inference.TextContent:
			wireContent = contentItemDTO{
				Type: "input_text",
				Text: typed.Text(),
			}
		case inference.ImageContent:
			wireContent, err = encodeImageContent(typed)
		case inference.DocumentContent:
			wireContent, err = encodeDocumentContent(typed)
		default:
			err = ErrUnsupportedRequest
		}
		if err != nil {
			return nil, err
		}
		encoded[index] = wireContent
	}
	return encoded, nil
}

// encodeImageContent 编码 file_id、URL 或 Base64 data URL。
func encodeImageContent(
	content inference.ImageContent,
) (contentItemDTO, error) {
	encoded := contentItemDTO{
		Type:   "input_image",
		Detail: string(content.Detail()),
	}
	source := content.Source()
	switch source.Kind() {
	case inference.MediaSourceFileID:
		encoded.FileID = source.Value()
	case inference.MediaSourceURL:
		encoded.ImageURL = source.Value()
	case inference.MediaSourceBase64:
		encoded.ImageURL = dataURL(source.MediaType(), source.Value())
	default:
		return contentItemDTO{}, unsupported("image.source")
	}
	return encoded, nil
}

// encodeDocumentContent 编码文件引用、远程 URL、Base64 或文本 data URL。
func encodeDocumentContent(
	content inference.DocumentContent,
) (contentItemDTO, error) {
	encoded := contentItemDTO{
		Type:     "input_file",
		Detail:   string(content.Detail()),
		Filename: content.Title(),
	}
	source := content.Source()
	switch source.Kind() {
	case inference.MediaSourceFileID:
		encoded.FileID = source.Value()
	case inference.MediaSourceURL:
		encoded.FileURL = source.Value()
	case inference.MediaSourceBase64:
		encoded.FileData = dataURL(source.MediaType(), source.Value())
	case inference.MediaSourceText:
		encoded.FileData = dataURL(
			source.MediaType(),
			base64.StdEncoding.EncodeToString([]byte(source.Value())),
		)
	default:
		return contentItemDTO{}, unsupported("document.source")
	}
	return encoded, nil
}

// dataURL 生成不记录原始内容的标准 Base64 data URL。
func dataURL(mediaType string, data string) string {
	return "data:" + mediaType + ";base64," + data
}

// encodeTools 编码 function 工具并拒绝 Codex 无法表达的 Claude 执行提示。
func encodeTools(
	definitions []inference.ToolDefinition,
) ([]toolDTO, error) {
	tools := make([]toolDTO, len(definitions))
	for index, definition := range definitions {
		if len(definition.AllowedCallers()) != 0 {
			return nil, unsupported("tools.allowed_callers")
		}
		if _, found := definition.EagerInputStreaming(); found {
			return nil, unsupported("tools.eager_input_streaming")
		}
		if len(definition.InputExamples()) != 0 {
			return nil, unsupported("tools.input_examples")
		}
		strict, _ := definition.Strict()
		deferLoading, deferSpecified := definition.DeferLoading()
		var deferValue *bool
		if deferSpecified {
			deferValue = &deferLoading
		}
		tools[index] = toolDTO{
			Type:         "function",
			Name:         definition.Name(),
			Description:  definition.Description(),
			Strict:       strict,
			DeferLoading: deferValue,
			Parameters:   definition.InputSchema(),
		}
	}
	return tools, nil
}

// encodeToolChoice 映射默认 auto、字符串模式或命名 function。
func encodeToolChoice(request inference.Request) (any, error) {
	choice, found := request.ToolChoice()
	if !found {
		return "auto", nil
	}
	switch choice.Mode() {
	case inference.ToolChoiceAuto,
		inference.ToolChoiceNone,
		inference.ToolChoiceRequired:
		return string(choice.Mode()), nil
	case inference.ToolChoiceNamed:
		return namedToolChoiceDTO{
			Type: "function",
			Name: choice.Name(),
		}, nil
	default:
		return nil, ErrUnsupportedRequest
	}
}

// encodeReasoning 只接受 Codex 原生 effort 模式。
func encodeReasoning(request inference.Request) (*reasoningDTO, error) {
	config, found := request.Reasoning()
	if !found {
		return nil, nil
	}
	if config.Mode() != inference.ReasoningModeEffort {
		return nil, unsupported("reasoning.mode")
	}
	return &reasoningDTO{
		Effort:  string(config.Effort()),
		Summary: string(config.Summary()),
	}, nil
}

// encodeStructuredOutput 生成 Responses json_schema 文本控制。
func encodeStructuredOutput(
	request inference.Request,
) (*textControlDTO, error) {
	output, found := request.StructuredOutput()
	if !found {
		return nil, nil
	}
	return &textControlDTO{
		Format: textFormatDTO{
			Type:        "json_schema",
			Name:        output.Name(),
			Description: output.Description(),
			Schema:      output.Schema(),
			Strict:      output.Strict(),
		},
	}, nil
}

// unsupported 返回只含稳定字段名、不含请求内容的错误。
func unsupported(field string) error {
	return fmt.Errorf("%w: %s", ErrUnsupportedRequest, field)
}
