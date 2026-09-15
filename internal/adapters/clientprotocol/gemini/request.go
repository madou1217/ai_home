package gemini

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// generateContentRequest 是 generateContent 请求的根 DTO。
//
// 未知字段被忽略而不是拒绝：Gemini 的 schema 很大且仍在演进，用
// DisallowUnknownFields 会让新增的官方字段直接变成 400。
type generateContentRequest struct {
	Contents          []contentDTO         `json:"contents"`
	SystemInstruction *contentDTO          `json:"systemInstruction"`
	GenerationConfig  *generationConfigDTO `json:"generationConfig"`
	Tools             []toolGroupDTO       `json:"tools"`
	ToolConfig        *toolConfigDTO       `json:"toolConfig"`
}

// contentDTO 是 contents 与 systemInstruction 共用的内容结构。
type contentDTO struct {
	Role  string    `json:"role"`
	Parts []partDTO `json:"parts"`
}

// partDTO 是内容块联合类型的宽松解码目标。
type partDTO struct {
	Text             *string              `json:"text"`
	Thought          bool                 `json:"thought"`
	InlineData       *inlineDataDTO       `json:"inlineData"`
	FunctionCall     *functionCallDTO     `json:"functionCall"`
	FunctionResponse *functionResponseDTO `json:"functionResponse"`
}

// inlineDataDTO 是内联二进制载荷。
type inlineDataDTO struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

// functionCallDTO 是模型发起的工具调用。
type functionCallDTO struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

// functionResponseDTO 是工具结果。
type functionResponseDTO struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Response json.RawMessage `json:"response"`
}

// generationConfigDTO 是采样与长度控制。
type generationConfigDTO struct {
	Temperature     *float64 `json:"temperature"`
	TopP            *float64 `json:"topP"`
	TopK            *uint64  `json:"topK"`
	MaxOutputTokens *uint64  `json:"maxOutputTokens"`
	StopSequences   []string `json:"stopSequences"`
	CandidateCount  *uint64  `json:"candidateCount"`
}

// toolGroupDTO 是一组函数声明。
type toolGroupDTO struct {
	FunctionDeclarations []functionDeclarationDTO `json:"functionDeclarations"`
}

// functionDeclarationDTO 是单个函数声明。
type functionDeclarationDTO struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// toolConfigDTO 是工具调用配置。
type toolConfigDTO struct {
	FunctionCallingConfig *functionCallingConfigDTO `json:"functionCallingConfig"`
}

// functionCallingConfigDTO 是工具选择模式。
type functionCallingConfigDTO struct {
	Mode                 string   `json:"mode"`
	AllowedFunctionNames []string `json:"allowedFunctionNames"`
}

// RequestDecoder 把 Gemini generateContent 请求转换为 Canonical Request。
type RequestDecoder struct{}

// NewRequestDecoder 创建无状态、可并发复用的 Gemini Request Decoder。
func NewRequestDecoder() RequestDecoder {
	return RequestDecoder{}
}

// DecodeWithModel 严格解析一个完整 generateContent 请求。
//
// stream 由传输层按路径决定（:streamGenerateContent 为真）：Gemini 的流式语义在路径上，
// 请求体里没有对应字段，因此不能从正文推断。
func (RequestDecoder) DecodeWithModel(
	model string,
	body []byte,
	stream bool,
) (inference.Request, error) {
	trimmedModel := strings.TrimSpace(model)
	if trimmedModel == "" {
		return inference.Request{}, ErrModelRequired
	}
	var wire generateContentRequest
	if err := json.Unmarshal(body, &wire); err != nil {
		return inference.Request{}, invalidField("$")
	}

	messages, err := decodeMessages(wire.SystemInstruction, wire.Contents)
	if err != nil {
		return inference.Request{}, err
	}
	tools, err := decodeTools(wire.Tools)
	if err != nil {
		return inference.Request{}, err
	}
	toolChoice, err := decodeToolChoice(wire.ToolConfig)
	if err != nil {
		return inference.Request{}, err
	}
	config, err := decodeGenerationConfig(wire.GenerationConfig)
	if err != nil {
		return inference.Request{}, err
	}

	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:  inference.ClientProtocolGeminiGenerateContent,
		Model:           trimmedModel,
		Messages:        messages,
		Tools:           tools,
		ToolChoice:      toolChoice,
		Stream:          stream,
		MaxOutputTokens: config.maxOutputTokens,
		Temperature:     config.temperature,
		TopP:            config.topP,
		TopK:            config.topK,
		StopSequences:   config.stopSequences,
	})
	if err != nil {
		return inference.Request{}, invalidField("$")
	}
	return request, nil
}

// generationConfig 是解码后的采样与长度控制。
type generationConfig struct {
	temperature     *float64
	topP            *float64
	topK            *uint64
	maxOutputTokens uint64
	stopSequences   []string
}

// decodeGenerationConfig 校验并归一化 generationConfig。
func decodeGenerationConfig(
	wire *generationConfigDTO,
) (generationConfig, error) {
	if wire == nil {
		return generationConfig{}, nil
	}
	if wire.CandidateCount != nil && *wire.CandidateCount > 1 {
		// Canonical 目前只承载单个候选；静默丢弃会让客户端以为拿到了多个结果。
		return generationConfig{}, unsupportedField("generationConfig.candidateCount")
	}
	config := generationConfig{
		temperature: wire.Temperature,
		topP:        wire.TopP,
		topK:        wire.TopK,
	}
	if wire.MaxOutputTokens != nil {
		config.maxOutputTokens = *wire.MaxOutputTokens
	}
	for _, sequence := range wire.StopSequences {
		if strings.TrimSpace(sequence) == "" {
			return generationConfig{}, invalidField("generationConfig.stopSequences")
		}
		config.stopSequences = append(config.stopSequences, sequence)
	}
	return config, nil
}

// decodeMessages 把 systemInstruction 与 contents 转成 Canonical 消息序列。
func decodeMessages(
	system *contentDTO,
	contents []contentDTO,
) ([]inference.Message, error) {
	messages := make([]inference.Message, 0, len(contents)+1)
	if system != nil {
		contentsOfSystem, err := decodeParts(system.Parts, 0)
		if err != nil {
			return nil, err
		}
		if len(contentsOfSystem) > 0 {
			message, err := inference.NewMessage(inference.RoleSystem, contentsOfSystem...)
			if err != nil {
				return nil, invalidField("systemInstruction")
			}
			messages = append(messages, message)
		}
	}
	for index, content := range contents {
		role, err := decodeRole(content.Role, index)
		if err != nil {
			return nil, err
		}
		decoded, err := decodeParts(content.Parts, index)
		if err != nil {
			return nil, err
		}
		if len(decoded) == 0 {
			return nil, invalidField(messageField(index) + ".parts")
		}
		message, err := inference.NewMessage(role, decoded...)
		if err != nil {
			return nil, invalidField(messageField(index))
		}
		messages = append(messages, message)
	}
	if len(messages) == 0 {
		return nil, invalidField("contents")
	}
	return messages, nil
}

// decodeRole 映射 Gemini 的参与方名称。
//
// Gemini 用 user / model；历史协议里还出现过 function。缺省按 user 处理，
// 与官方「省略 role 等价于 user」的行为一致。
func decodeRole(value string, index int) (inference.Role, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "user", "function":
		return inference.RoleUser, nil
	case "model":
		return inference.RoleAssistant, nil
	case "system":
		return inference.RoleSystem, nil
	default:
		return "", invalidField(messageField(index) + ".role")
	}
}

// decodeParts 把内容块数组转成 Canonical 内容。
func decodeParts(parts []partDTO, contentIndex int) ([]inference.Content, error) {
	decoded := make([]inference.Content, 0, len(parts))
	for partIndex, part := range parts {
		field := partField(contentIndex, partIndex)
		switch {
		case part.Text != nil:
			if part.Thought {
				content, err := inference.NewReasoningSummaryContent(*part.Text)
				if err != nil {
					return nil, invalidField(field + ".text")
				}
				decoded = append(decoded, content)
				continue
			}
			if strings.TrimSpace(*part.Text) == "" {
				// 空文本块没有语义，跳过而不是拒绝：官方客户端会发出占位空块。
				continue
			}
			content, err := inference.NewTextContent(*part.Text)
			if err != nil {
				return nil, invalidField(field + ".text")
			}
			decoded = append(decoded, content)
		case part.InlineData != nil:
			content, err := decodeInlineData(part.InlineData, field)
			if err != nil {
				return nil, err
			}
			decoded = append(decoded, content)
		case part.FunctionCall != nil:
			content, err := decodeFunctionCall(part.FunctionCall, field)
			if err != nil {
				return nil, err
			}
			decoded = append(decoded, content)
		case part.FunctionResponse != nil:
			content, err := decodeFunctionResponse(part.FunctionResponse, field)
			if err != nil {
				return nil, err
			}
			decoded = append(decoded, content)
		default:
			return nil, unsupportedField(field)
		}
	}
	return decoded, nil
}

// decodeInlineData 把内联二进制转成图片内容。
func decodeInlineData(
	wire *inlineDataDTO,
	field string,
) (inference.Content, error) {
	source, err := inference.NewBase64MediaSource(
		strings.TrimSpace(wire.MimeType),
		strings.TrimSpace(wire.Data),
	)
	if err != nil {
		return nil, invalidField(field + ".inlineData")
	}
	content, err := inference.NewImageContent(source, inference.ImageDetailAuto)
	if err != nil {
		return nil, invalidField(field + ".inlineData")
	}
	return content, nil
}

// decodeFunctionCall 把模型发起的工具调用转成 Canonical 内容。
//
// Gemini 的 functionCall 没有必填调用 ID：只有较新的协议版本才带 `id`。缺失时用函数名
// 兜底，因为 functionResponse 也是按 name 引用同一个调用——这样同一轮内的调用与结果
// 仍能配对。代价是同一轮里对同一函数的两次并行调用会共用 ID，这是 Gemini 线协议本身
// 的信息缺失，不是本地可以补出来的。
func decodeFunctionCall(
	wire *functionCallDTO,
	field string,
) (inference.Content, error) {
	name := strings.TrimSpace(wire.Name)
	if name == "" {
		return nil, invalidField(field + ".functionCall.name")
	}
	arguments := wire.Args
	if len(arguments) == 0 || strings.TrimSpace(string(arguments)) == "null" {
		arguments = []byte("{}")
	}
	content, err := inference.NewToolCallContent(
		callID(wire.ID, name),
		name,
		arguments,
	)
	if err != nil {
		return nil, invalidField(field + ".functionCall")
	}
	return content, nil
}

// decodeFunctionResponse 把工具结果转成 Canonical 内容。
func decodeFunctionResponse(
	wire *functionResponseDTO,
	field string,
) (inference.Content, error) {
	name := strings.TrimSpace(wire.Name)
	if name == "" {
		return nil, invalidField(field + ".functionResponse.name")
	}
	output := wire.Response
	if len(output) == 0 || strings.TrimSpace(string(output)) == "null" {
		output = []byte("{}")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, output); err != nil {
		return nil, invalidField(field + ".functionResponse.response")
	}
	text, err := inference.NewTextContent(compact.String())
	if err != nil {
		return nil, invalidField(field + ".functionResponse.response")
	}
	content, err := inference.NewToolResultContent(
		callID(wire.ID, name),
		false,
		text,
	)
	if err != nil {
		return nil, invalidField(field + ".functionResponse")
	}
	return content, nil
}

// callID 选择工具调用的稳定 ID：优先协议提供的 id，缺失时回退到函数名。
func callID(provided string, name string) string {
	if trimmed := strings.TrimSpace(provided); trimmed != "" {
		return trimmed
	}
	return name
}

// decodeTools 把 functionDeclarations 转成 Canonical 工具定义。
func decodeTools(groups []toolGroupDTO) ([]inference.ToolDefinition, error) {
	tools := make([]inference.ToolDefinition, 0, len(groups))
	for groupIndex, group := range groups {
		for declarationIndex, declaration := range group.FunctionDeclarations {
			field := toolField(groupIndex, declarationIndex)
			name := strings.TrimSpace(declaration.Name)
			if name == "" {
				return nil, invalidField(field + ".name")
			}
			schema := declaration.Parameters
			if len(schema) == 0 || strings.TrimSpace(string(schema)) == "null" {
				schema = []byte(`{"type":"object"}`)
			}
			definition, err := inference.NewToolDefinition(
				name,
				strings.TrimSpace(declaration.Description),
				schema,
			)
			if err != nil {
				return nil, invalidField(field)
			}
			tools = append(tools, definition)
		}
	}
	return tools, nil
}

// decodeToolChoice 把 functionCallingConfig 转成 Canonical 工具选择意图。
func decodeToolChoice(wire *toolConfigDTO) (*inference.ToolChoice, error) {
	if wire == nil || wire.FunctionCallingConfig == nil {
		return nil, nil
	}
	config := wire.FunctionCallingConfig
	switch strings.ToUpper(strings.TrimSpace(config.Mode)) {
	case "", "AUTO":
		// AUTO 是默认值，不构成显式意图。
		return nil, nil
	case "NONE":
		choice, err := inference.NewToolChoice(inference.ToolChoiceNone)
		if err != nil {
			return nil, invalidField("toolConfig.functionCallingConfig.mode")
		}
		return &choice, nil
	case "ANY":
		if len(config.AllowedFunctionNames) == 1 {
			choice, err := inference.NewNamedToolChoice(
				strings.TrimSpace(config.AllowedFunctionNames[0]),
			)
			if err != nil {
				return nil, invalidField("toolConfig.functionCallingConfig.allowedFunctionNames")
			}
			return &choice, nil
		}
		if len(config.AllowedFunctionNames) > 1 {
			return nil, unsupportedField(
				"toolConfig.functionCallingConfig.allowedFunctionNames",
			)
		}
		choice, err := inference.NewToolChoice(inference.ToolChoiceRequired)
		if err != nil {
			return nil, invalidField("toolConfig.functionCallingConfig.mode")
		}
		return &choice, nil
	default:
		return nil, unsupportedField("toolConfig.functionCallingConfig.mode")
	}
}

// messageField 返回 contents 下某条消息的字段路径。
func messageField(index int) string {
	return "contents[" + itoa(index) + "]"
}

// partField 返回 contents 下某个内容块的字段路径。
func partField(contentIndex int, partIndex int) string {
	return messageField(contentIndex) + ".parts[" + itoa(partIndex) + "]"
}

// toolField 返回 tools 下某个函数声明的字段路径。
func toolField(groupIndex int, declarationIndex int) string {
	return "tools[" + itoa(groupIndex) + "].functionDeclarations[" +
		itoa(declarationIndex) + "]"
}

// itoa 是局部小整数格式化，避免为字段路径引入额外依赖。
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		index--
		digits[index] = '-'
	}
	return string(digits[index:])
}
