package codeassist

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/madou1217/ai_home/core/inference"
)

const skipThoughtSignature = "skip_thought_signature_validator"

var ErrUnsupportedRequest = errors.New("AGY Code Assist 请求语义不受支持")

type generateEnvelope struct {
	Project            string               `json:"project"`
	RequestID          string               `json:"requestId"`
	Request            generateInnerRequest `json:"request"`
	Model              string               `json:"model"`
	UserAgent          string               `json:"userAgent"`
	RequestType        string               `json:"requestType"`
	EnabledCreditTypes []string             `json:"enabledCreditTypes,omitempty"`
}

type generateInnerRequest struct {
	Contents          []wireContent        `json:"contents"`
	SystemInstruction *wireContent         `json:"systemInstruction,omitempty"`
	GenerationConfig  wireGenerationConfig `json:"generationConfig"`
	Tools             []wireToolGroup      `json:"tools,omitempty"`
	ToolConfig        *wireToolConfig      `json:"toolConfig,omitempty"`
	SessionID         string               `json:"sessionId"`
}

type wireContent struct {
	Role  string     `json:"role,omitempty"`
	Parts []wirePart `json:"parts"`
}

type wirePart struct {
	Text             string                `json:"text,omitempty"`
	FunctionCall     *wireFunctionCall     `json:"functionCall,omitempty"`
	FunctionResponse *wireFunctionResponse `json:"functionResponse,omitempty"`
	ThoughtSignature string                `json:"thoughtSignature,omitempty"`
}

type wireFunctionCall struct {
	ID   string         `json:"id"`
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

type wireFunctionResponse struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Response map[string]any `json:"response"`
}

type wireGenerationConfig struct {
	MaxOutputTokens uint64              `json:"maxOutputTokens,omitempty"`
	Temperature     *float64            `json:"temperature,omitempty"`
	TopP            *float64            `json:"topP,omitempty"`
	TopK            *uint64             `json:"topK,omitempty"`
	StopSequences   []string            `json:"stopSequences,omitempty"`
	ThinkingConfig  *wireThinkingConfig `json:"thinkingConfig,omitempty"`
}

type wireThinkingConfig struct {
	IncludeThoughts bool  `json:"includeThoughts"`
	ThinkingBudget  int64 `json:"thinkingBudget"`
}

type wireToolGroup struct {
	FunctionDeclarations []wireFunctionDeclaration `json:"functionDeclarations"`
}

type wireFunctionDeclaration struct {
	Name                 string         `json:"name"`
	Description          string         `json:"description,omitempty"`
	ParametersJSONSchema map[string]any `json:"parametersJsonSchema"`
}

type wireToolConfig struct {
	FunctionCallingConfig wireFunctionCallingConfig `json:"functionCallingConfig"`
}

type wireFunctionCallingConfig struct {
	Mode                 string   `json:"mode"`
	AllowedFunctionNames []string `json:"allowedFunctionNames,omitempty"`
}

func encodeRequest(
	request inference.Request,
	model string,
	project string,
	sessionID string,
	requestID string,
) ([]byte, error) {
	if model == "" || project == "" || sessionID == "" || requestID == "" {
		return nil, ErrUnsupportedRequest
	}
	contents, system, toolNames, err := encodeMessages(request.Messages())
	if err != nil {
		return nil, err
	}
	tools, err := encodeTools(request.Tools())
	if err != nil {
		return nil, err
	}
	config := wireGenerationConfig{
		MaxOutputTokens: request.MaxOutputTokens(),
		StopSequences:   request.StopSequences(),
	}
	if value, found := request.Temperature(); found {
		config.Temperature = &value
	}
	if value, found := request.TopP(); found {
		config.TopP = &value
	}
	if value, found := request.TopK(); found {
		config.TopK = &value
	}
	inner := generateInnerRequest{
		Contents:          contents,
		SystemInstruction: system,
		GenerationConfig:  config,
		SessionID:         sessionID,
	}
	if len(tools) > 0 {
		inner.Tools = []wireToolGroup{{FunctionDeclarations: tools}}
		inner.ToolConfig = encodeToolChoice(request, toolNames)
	}
	envelope := generateEnvelope{
		Project:            project,
		RequestID:          requestID,
		Request:            inner,
		Model:              model,
		UserAgent:          "antigravity",
		RequestType:        "agent",
		EnabledCreditTypes: []string{"GOOGLE_ONE_AI"},
	}
	return json.Marshal(envelope)
}

func encodeMessages(
	messages []inference.Message,
) ([]wireContent, *wireContent, map[string]string, error) {
	contents := make([]wireContent, 0, len(messages))
	systemParts := make([]wirePart, 0)
	toolNames := make(map[string]string)
	for _, message := range messages {
		parts := make([]wirePart, 0, len(message.Contents()))
		for _, content := range message.Contents() {
			switch typed := content.(type) {
			case inference.TextContent:
				part := wirePart{Text: typed.Text()}
				if message.Role() == inference.RoleSystem ||
					message.Role() == inference.RoleDeveloper {
					systemParts = append(systemParts, part)
					continue
				}
				parts = append(parts, part)
			case inference.ToolCallContent:
				var args map[string]any
				if err := json.Unmarshal(typed.Arguments(), &args); err != nil {
					return nil, nil, nil, ErrUnsupportedRequest
				}
				toolNames[typed.CallID()] = typed.Name()
				parts = append(parts, wirePart{
					FunctionCall: &wireFunctionCall{
						ID: typed.CallID(), Name: typed.Name(), Args: args,
					},
					ThoughtSignature: skipThoughtSignature,
				})
			case inference.ToolResultContent:
				name := toolNames[typed.CallID()]
				if name == "" {
					return nil, nil, nil, ErrUnsupportedRequest
				}
				result, err := encodeToolResult(typed)
				if err != nil {
					return nil, nil, nil, err
				}
				parts = append(parts, wirePart{FunctionResponse: &wireFunctionResponse{
					ID: typed.CallID(), Name: name, Response: result,
				}})
			default:
				return nil, nil, nil, fmt.Errorf("%w: %s", ErrUnsupportedRequest, content.Kind())
			}
		}
		if len(parts) == 0 {
			continue
		}
		role := "user"
		if message.Role() == inference.RoleAssistant {
			role = "model"
		}
		contents = append(contents, wireContent{Role: role, Parts: parts})
	}
	if len(contents) == 0 {
		return nil, nil, nil, ErrUnsupportedRequest
	}
	var system *wireContent
	if len(systemParts) > 0 {
		system = &wireContent{Parts: systemParts}
	}
	return contents, system, toolNames, nil
}

func encodeToolResult(content inference.ToolResultContent) (map[string]any, error) {
	result := make([]any, 0, len(content.Contents()))
	for _, item := range content.Contents() {
		text, valid := item.(inference.TextContent)
		if !valid {
			return nil, ErrUnsupportedRequest
		}
		var value any = text.Text()
		var decoded any
		if json.Unmarshal([]byte(text.Text()), &decoded) == nil {
			value = decoded
		}
		result = append(result, value)
	}
	var value any = result
	if len(result) == 1 {
		value = result[0]
	}
	return map[string]any{
		"result":  value,
		"isError": content.IsError(),
	}, nil
}

func encodeTools(tools []inference.ToolDefinition) ([]wireFunctionDeclaration, error) {
	declarations := make([]wireFunctionDeclaration, 0, len(tools))
	for _, tool := range tools {
		var schema map[string]any
		if err := json.Unmarshal(tool.InputSchema(), &schema); err != nil {
			return nil, ErrUnsupportedRequest
		}
		declarations = append(declarations, wireFunctionDeclaration{
			Name: tool.Name(), Description: tool.Description(), ParametersJSONSchema: schema,
		})
	}
	return declarations, nil
}

func encodeToolChoice(request inference.Request, toolNames map[string]string) *wireToolConfig {
	config := wireFunctionCallingConfig{Mode: "AUTO"}
	if choice, found := request.ToolChoice(); found {
		switch choice.Mode() {
		case inference.ToolChoiceNone:
			config.Mode = "NONE"
		case inference.ToolChoiceRequired:
			config.Mode = "ANY"
		case inference.ToolChoiceNamed:
			config.Mode = "ANY"
			config.AllowedFunctionNames = []string{choice.Name()}
		}
	}
	_ = toolNames
	return &wireToolConfig{FunctionCallingConfig: config}
}
