package qoderrelay

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/qoder/modelcatalog"
)

// 本文件只复刻 Node lib/server/qoder-http-transport.js 的「请求体构造」纯函数，
// 不参与签名 / 网络 / 流解析：Body 是明文 JSON，随后交给 wasm 编码。

const (
	// 与 Node 的 DEFAULT_SYSTEM_TEXT / 目录兜底窗口 / parameters 上限同值。
	defaultSystemText     = "You are a helpful assistant."
	defaultMaxInputTokens = 200000
	maxRequestTokens      = 32000
	businessNameMaxRunes  = 200
)

// 错误值刻意沿用 Node 的 error code：调用方据此决定是否回落 CLI，而不是解析文案。
var (
	// ErrPromptRequired 表示请求里没有任何可发送的对话正文。
	ErrPromptRequired = errors.New("qoder_http_prompt_required")
	// ErrModelNotInCatalog 表示请求模型无法与传入的目录条目对应；按 Node 的
	// fail-closed 语义必须拒绝，绝不按名字猜 key 或推理能力。
	ErrModelNotInCatalog = errors.New("qoder_http_model_catalog_missing")
)

// BuildResult 是构造出的推理请求。
type BuildResult struct {
	Body        []byte // 明文 JSON（随后交给 wasm 编码）
	ModelKey    string
	DisplayName string
	ModelSource string
	IsReasoning bool
	ModelConfig map[string]any
	Transcript  string
	SystemText  string
	RequestID   string
}

// BuildBody 把客户端 OpenAI chat 请求原文转换成 Qoder 推理 body。
//
// entry 由调用方从服务端目录（catalog-v7）取；requestedModel 是客户端点名的
// 模型（为空 / auto / default / provider 名时表示 Auto）。nowMS 由调用方注入，
// 便于测试与保证同一请求内 begin_at 稳定。
func BuildBody(requestJSON []byte, entry modelcatalog.Entry, requestedModel, provider, version string, nowMS int64) (BuildResult, error) {
	request, err := decodeQoderRequest(requestJSON)
	if err != nil {
		return BuildResult{}, err
	}
	// 空 key 的条目无法参与 wasm 签名（model_config.key 会变成空串），按 fail-closed 拒绝。
	if strings.TrimSpace(entry.Key) == "" {
		return BuildResult{}, ErrModelNotInCatalog
	}
	modelSource, ok := resolveQoderRequestModel(entry, requestedModel, provider)
	if !ok {
		return BuildResult{}, ErrModelNotInCatalog
	}
	derived := deriveQoderModelRequest(entry, request)
	messages := arrayValue(request["messages"])
	systemText := collectQoderSystemText(messages)
	if systemText == "" {
		systemText = defaultSystemText
	}
	transcript := buildQoderTranscript(messages)
	if transcript == "" {
		return BuildResult{}, ErrPromptRequired
	}
	lastUserText := findQoderLastUserText(messages)
	tools := normalizeQoderTools(request["tools"])
	parameters := buildQoderParameters(request, derived)
	modelConfig := buildQoderModelConfig(entry, derived.isReasoning)

	requestID, err := newQoderRequestID()
	if err != nil {
		return BuildResult{}, err
	}
	requestSetID, err := newQoderRequestID()
	if err != nil {
		return BuildResult{}, err
	}
	sessionID, err := newQoderRequestID()
	if err != nil {
		return BuildResult{}, err
	}

	// system 在 body 里出现两次（顶层 system 与 messages[0].content），Node 同样复用
	// 同一份数组；服务端只认 messages，顶层字段是客户端历史遗留。
	systemParts := []qoderSystemPart{{Type: "text", Text: systemText}}

	body := qoderRequestBody{
		RequestID:    requestID,
		RequestSetID: requestSetID,
		ChatRecordID: requestID,
		SessionID:    sessionID,
		Stream:       true,
		ChatTask:     "FREE_INPUT",
		ChatContext: qoderChatContext{
			Text:     transcript,
			Features: []any{},
			Extra: qoderContextExtra{
				Context:         []any{},
				ModelConfig:     qoderContextModelInfo{Key: entry.Key, IsReasoning: derived.isReasoning},
				OriginalContent: transcript,
			},
			ChatPrompt: "",
			ImageURLs:  nil,
		},
		IsReply:        true,
		IsRetry:        false,
		Source:         1,
		Version:        "3",
		AgentID:        "agent_common",
		TaskID:         "common",
		SessionType:    qoderSessionType(provider),
		AliyunUserType: "",
		ModelConfig:    modelConfig,
		System:         systemParts,
		Messages: []qoderMessage{
			{Role: "system", Content: systemParts},
			{Role: "user", Content: transcript},
		},
		Tools:      tools,
		Parameters: parameters,
		Business: qoderBusiness{
			Product:  "cli",
			Version:  strings.TrimSpace(version),
			Type:     "agent",
			ID:       requestSetID,
			Name:     qoderBusinessName(lastUserText, transcript),
			BeginAt:  nowMS,
			Stage:    "start",
			ModelKey: entry.Key,
		},
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return BuildResult{}, fmt.Errorf("qoderrelay: encode body: %w", err)
	}
	return BuildResult{
		Body:        encoded,
		ModelKey:    entry.Key,
		DisplayName: entry.DisplayName,
		ModelSource: modelSource,
		IsReasoning: derived.isReasoning,
		ModelConfig: modelConfig,
		Transcript:  transcript,
		SystemText:  systemText,
		RequestID:   requestID,
	}, nil
}

// --- body 形状（字段名与 Node 逐字一致，顺序也按 Node 的插入顺序） ---

type qoderRequestBody struct {
	RequestID      string            `json:"request_id"`
	RequestSetID   string            `json:"request_set_id"`
	ChatRecordID   string            `json:"chat_record_id"`
	SessionID      string            `json:"session_id"`
	Stream         bool              `json:"stream"`
	ChatTask       string            `json:"chat_task"`
	ChatContext    qoderChatContext  `json:"chat_context"`
	IsReply        bool              `json:"is_reply"`
	IsRetry        bool              `json:"is_retry"`
	Source         int               `json:"source"`
	Version        string            `json:"version"`
	AgentID        string            `json:"agent_id"`
	TaskID         string            `json:"task_id"`
	SessionType    string            `json:"session_type"`
	AliyunUserType string            `json:"aliyun_user_type"`
	ModelConfig    map[string]any    `json:"model_config"`
	System         []qoderSystemPart `json:"system"`
	Messages       []qoderMessage    `json:"messages"`
	Tools          []qoderTool       `json:"tools"`
	Parameters     map[string]any    `json:"parameters"`
	Business       qoderBusiness     `json:"business"`
}

type qoderChatContext struct {
	Text       string            `json:"text"`
	Features   []any             `json:"features"`
	Extra      qoderContextExtra `json:"extra"`
	ChatPrompt string            `json:"chatPrompt"`
	ImageURLs  any               `json:"imageUrls"`
}

type qoderContextExtra struct {
	Context         []any                 `json:"context"`
	ModelConfig     qoderContextModelInfo `json:"modelConfig"`
	OriginalContent string                `json:"originalContent"`
}

type qoderContextModelInfo struct {
	Key         string `json:"key"`
	IsReasoning bool   `json:"is_reasoning"`
}

type qoderSystemPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type qoderMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

type qoderTool struct {
	Type     string            `json:"type"`
	Function qoderToolFunction `json:"function"`
}

type qoderToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

type qoderBusiness struct {
	Product  string `json:"product"`
	Version  string `json:"version"`
	Type     string `json:"type"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	BeginAt  int64  `json:"begin_at"`
	Stage    string `json:"stage"`
	ModelKey string `json:"model_key"`
}

// --- 请求解析 / 模型解析 ---

// decodeQoderRequest 用 UseNumber 保留数字原文：Node 侧 Number(value) 对字符串数字
// 也生效，而未知字段只留在 map 里、不参与构造。
func decodeQoderRequest(raw []byte) (map[string]any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return map[string]any{}, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var request map[string]any
	if err := decoder.Decode(&request); err != nil {
		return nil, fmt.Errorf("qoderrelay: decode request: %w", err)
	}
	if request == nil {
		request = map[string]any{}
	}
	return request, nil
}

// resolveQoderRequestModel 复刻 resolveQoderCatalogModel 的解析顺序：
// 空 / auto / default / provider 名 → Auto；其余名字必须与传入条目的 key 或
// display_name 大小写不敏感相等。返回的 source 与 Node 一致（auto / catalog）。
func resolveQoderRequestModel(entry modelcatalog.Entry, requestedModel, provider string) (string, bool) {
	key := strings.TrimSpace(requestedModel)
	if index := strings.Index(key, "/"); index >= 0 {
		key = strings.TrimSpace(key[index+1:])
	}
	lower := strings.ToLower(key)
	if key == "" || lower == "auto" || lower == "default" || lower == strings.ToLower(strings.TrimSpace(provider)) {
		if isAutoEntry(entry) {
			// 与 Node 的 AUTO_MODEL_ENTRY 对应：resolved.source = 'auto'。
			return "auto", true
		}
		// 调用方直接传入非 Auto 条目（例如账号默认模型）：没有按名字查目录，仍标记 catalog。
		return "catalog", true
	}
	if strings.EqualFold(key, entry.Key) || strings.EqualFold(key, entry.DisplayName) {
		return "catalog", true
	}
	return "", false
}

func isAutoEntry(entry modelcatalog.Entry) bool {
	return strings.EqualFold(strings.TrimSpace(entry.Key), "auto") ||
		strings.EqualFold(strings.TrimSpace(entry.DisplayName), "auto")
}

// derivedModelRequest 是 Node deriveQoderModelRequest 中被 body 用到的字段。
// 请求级只允许把 true 改 false（reasoning_effort=none / enable_thinking=false /
// thinkingBudget<=0），从不按名字反向点亮模型能力。
type derivedModelRequest struct {
	isReasoning     bool
	reasoningEffort string
	enableThinking  *bool
	disabled        bool
}

func deriveQoderModelRequest(entry modelcatalog.Entry, request map[string]any) derivedModelRequest {
	effort := readQoderExplicitEffort(request)
	thinkingFlag, hasThinkingFlag := readQoderExplicitThinkingFlag(request)
	budget, hasBudget := readQoderExplicitThinkingBudget(request)
	disabled := effort == "none" || (hasThinkingFlag && !thinkingFlag) || (hasBudget && budget <= 0)
	derived := derivedModelRequest{
		isReasoning:     entry.IsReasoning && !disabled,
		reasoningEffort: effort,
		disabled:        disabled,
	}
	if hasThinkingFlag {
		flag := thinkingFlag
		derived.enableThinking = &flag
	}
	return derived
}

func readQoderExplicitEffort(request map[string]any) string {
	value, ok := firstNonNullValue(request, "reasoning_effort")
	if !ok {
		if reasoning, isObject := objectValue(request["reasoning"]); isObject {
			value, ok = firstNonNullValue(reasoning, "effort")
		}
	}
	if !ok {
		if thinking, isObject := objectValue(request["thinking"]); isObject {
			value, ok = firstNonNullValue(thinking, "effort")
		}
	}
	if !ok {
		return ""
	}
	return strings.ToLower(normalizeQoderString(value))
}

func readQoderExplicitThinkingFlag(request map[string]any) (bool, bool) {
	if value, exists := request["enable_thinking"]; exists {
		flag, isBool := value.(bool)
		return isBool && flag, true
	}
	if value, exists := request["thinking"]; exists {
		if flag, isBool := value.(bool); isBool {
			return flag, true
		}
	}
	if thinking, isObject := objectValue(request["thinking"]); isObject {
		if value, exists := thinking["enabled"]; exists {
			flag, isBool := value.(bool)
			return isBool && flag, true
		}
	}
	if reasoning, isObject := objectValue(request["reasoning"]); isObject {
		if value, exists := reasoning["enabled"]; exists {
			flag, isBool := value.(bool)
			return isBool && flag, true
		}
	}
	return false, false
}

func readQoderExplicitThinkingBudget(request map[string]any) (float64, bool) {
	value, ok := firstNonNullValue(request, "thinking_budget", "thinkingBudget")
	if !ok {
		if thinking, isObject := objectValue(request["thinking"]); isObject {
			value, ok = firstNonNullValue(thinking, "budget_tokens")
		}
	}
	if !ok {
		return 0, false
	}
	budget, finite := jsNumber(value)
	return budget, finite
}

// firstNonNullValue 对应 JS 的 ??：键存在但值为 null 时继续往后找，0/""/false 则算命中。
func firstNonNullValue(object map[string]any, keys ...string) (any, bool) {
	for _, key := range keys {
		if value, exists := object[key]; exists && value != nil {
			return value, true
		}
	}
	return nil, false
}

// --- transcript ---

func collectQoderSystemText(messages []any) string {
	parts := make([]string, 0, len(messages))
	for _, item := range messages {
		message, ok := objectValue(item)
		if !ok {
			continue
		}
		role := qoderMessageRole(message)
		if role != "system" && role != "developer" {
			continue
		}
		if text := normalizeQoderString(extractQoderMessageText(message["content"])); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n\n")
}

func findQoderLastUserText(messages []any) string {
	for index := len(messages) - 1; index >= 0; index-- {
		message, ok := objectValue(messages[index])
		if !ok || qoderMessageRole(message) != "user" {
			continue
		}
		if text := normalizeQoderString(extractQoderMessageText(message["content"])); text != "" {
			return text
		}
	}
	return ""
}

// buildQoderTranscript 把结构化对话压成一条 user transcript：
// 单条 user 原样返回（真机抓包就是「system + 单条 user」）；多轮才加角色标签，
// 避免模型把多个 User: 块当成背景。工具调用记录进 transcript，tools 定义仍走 body.tools。
func buildQoderTranscript(messages []any) string {
	type entry struct {
		role    string
		message map[string]any
	}
	conversational := make([]entry, 0, len(messages))
	for _, item := range messages {
		message, ok := objectValue(item)
		if !ok {
			continue
		}
		role := qoderMessageRole(message)
		if role != "user" && role != "assistant" && role != "tool" {
			continue
		}
		conversational = append(conversational, entry{role: role, message: message})
	}
	if len(conversational) == 0 {
		return ""
	}
	if len(conversational) == 1 && conversational[0].role == "user" {
		return normalizeQoderString(extractQoderMessageText(conversational[0].message["content"]))
	}
	blocks := make([]string, 0, len(conversational))
	for _, item := range conversational {
		text := normalizeQoderString(extractQoderMessageText(item.message["content"]))
		label := "Tool"
		switch item.role {
		case "user":
			label = "User"
		case "assistant":
			label = "Assistant"
		}
		extra := ""
		if item.role == "assistant" {
			extra = describeQoderToolCalls(item.message["tool_calls"])
		}
		body := text
		if body == "" {
			body = extra
		} else if extra != "" {
			body = text + "\n" + extra
		}
		if body != "" {
			blocks = append(blocks, label+":\n"+body)
		}
	}
	return strings.Join(blocks, "\n\n")
}

func describeQoderToolCalls(value any) string {
	calls, ok := value.([]any)
	if !ok {
		return ""
	}
	parts := make([]string, 0, len(calls))
	for _, item := range calls {
		call, ok := objectValue(item)
		if !ok {
			continue
		}
		function, hasFunction := objectValue(call["function"])
		if !hasFunction {
			function = call
		}
		nameValue, _ := firstTruthyValue(function["name"], call["name"])
		name := normalizeQoderString(nameValue)
		if name == "" {
			continue
		}
		args := ""
		if raw, exists := function["arguments"]; exists {
			switch value := raw.(type) {
			case string:
				args = value
			case nil:
				args = "null" // JSON.stringify(null)
			default:
				args = marshalQoderValue(value)
			}
		}
		part := "[调用工具 " + name + "]"
		if args != "" {
			part += "\n" + args
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, "\n")
}

// extractQoderMessageText 与 Node extractMessageText 同口径：字符串直接用，
// 分片数组只取文本；图片显式占位，避免多模态内容静默丢失。
func extractQoderMessageText(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			part, ok := objectValue(item)
			if !ok {
				continue
			}
			text, hasText := part["text"].(string)
			switch jsString(part["type"]) {
			case "text", "input_text":
				if hasText && text != "" {
					parts = append(parts, text)
				}
			case "image_url", "input_image":
				parts = append(parts, qoderImagePlaceholder)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

const qoderImagePlaceholder = "[图片附件暂不支持经 Qoder CLI 通道发送]"

func qoderMessageRole(message map[string]any) string {
	value := message["role"]
	if !jsTruthy(value) {
		return ""
	}
	return strings.ToLower(jsString(value))
}

// --- tools / parameters ---

var qoderToolNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func normalizeQoderTools(value any) []qoderTool {
	rawTools, ok := value.([]any)
	if !ok {
		return []qoderTool{}
	}
	tools := make([]qoderTool, 0, len(rawTools))
	for _, item := range rawTools {
		tool, ok := objectValue(item)
		if !ok {
			continue
		}
		if toolType, exists := tool["type"]; exists && jsTruthy(toolType) && jsString(toolType) != "function" {
			continue
		}
		function, hasFunction := objectValue(tool["function"])
		if !hasFunction {
			function = tool
		}
		nameValue, _ := firstTruthyValue(function["name"], tool["name"])
		name := normalizeQoderString(nameValue)
		if !qoderToolNamePattern.MatchString(name) {
			continue
		}
		descriptionValue, _ := firstTruthyValue(function["description"], tool["description"])
		description := normalizeQoderString(descriptionValue)
		if description == "" {
			// 官方客户端要求 description 非空；缺省用工具名，比丢弃整个工具安全。
			description = name
		}
		rawParameters, _ := firstTruthyValue(
			function["parameters"],
			function["input_schema"],
			tool["parameters"],
			tool["input_schema"],
		)
		tools = append(tools, qoderTool{
			Type: "function",
			Function: qoderToolFunction{
				Name:        name,
				Description: description,
				Parameters:  normalizeQoderToolParameters(rawParameters),
			},
		})
	}
	return tools
}

func normalizeQoderToolParameters(value any) map[string]any {
	if object, ok := objectValue(value); ok {
		if toolType, exists := object["type"]; !exists || !jsTruthy(toolType) {
			cloned := make(map[string]any, len(object)+1)
			for key, item := range object {
				cloned[key] = item
			}
			cloned["type"] = "object"
			return cloned
		}
		return object
	}
	return map[string]any{"type": "object", "properties": map[string]any{}}
}

// buildQoderParameters 对应 buildQoderHttpParameters：max_tokens 恒定下发并收敛到
// 32000；temperature / top_p / stop 只有显式给了才写；推理参数只透传显式值。
func buildQoderParameters(request map[string]any, derived derivedModelRequest) map[string]any {
	maxTokens := readQoderInteger(request["max_tokens"], request["max_completion_tokens"], request["max_output_tokens"])
	if maxTokens <= 0 {
		maxTokens = maxRequestTokens
	}
	parameters := map[string]any{"max_tokens": maxTokens}
	if value, exists := request["temperature"]; exists {
		if temperature, finite := jsNumber(value); finite && temperature >= 0 {
			parameters["temperature"] = temperature
		}
	}
	if value, exists := request["top_p"]; exists {
		if topP, finite := jsNumber(value); finite && topP >= 0 {
			parameters["top_p"] = topP
		}
	}
	switch stop := request["stop"].(type) {
	case string:
		if stop != "" {
			parameters["stop"] = stop
		}
	case []any:
		if len(stop) > 0 {
			stops := make([]string, 0, len(stop))
			for _, item := range stop {
				if text := jsString(item); text != "" {
					stops = append(stops, text)
				}
			}
			parameters["stop"] = stops
		}
	}
	if derived.disabled {
		parameters["enable_thinking"] = false
	} else if derived.reasoningEffort != "" {
		parameters["reasoning_effort"] = derived.reasoningEffort
	}
	if derived.enableThinking != nil && *derived.enableThinking {
		if _, exists := parameters["enable_thinking"]; !exists {
			parameters["enable_thinking"] = true
		}
	}
	return parameters
}

// readQoderInteger 对应 readRequestInteger：Number 语义、有限、>0 取 floor。
// 唯一用途是 token 上限，因此超过上限的值直接收敛到 maxRequestTokens，
// 既保持 Math.min 的最终结果，也避免超大浮点转 int 溢出。
func readQoderInteger(values ...any) int {
	for _, value := range values {
		numeric, finite := jsNumber(value)
		if !finite || numeric <= 0 {
			continue
		}
		if numeric >= maxRequestTokens {
			return maxRequestTokens
		}
		return int(numeric)
	}
	return 0
}

func buildQoderModelConfig(entry modelcatalog.Entry, isReasoning bool) map[string]any {
	format := entry.Format
	if format == "" {
		format = "openai"
	}
	source := entry.Source
	if source == "" {
		source = "system"
	}
	maxInputTokens := entry.MaxInputTokens
	if maxInputTokens <= 0 {
		maxInputTokens = defaultMaxInputTokens
	}
	// api_key / url 恒为空：凭据由 wasm 签名放进 Authorization，不写进 body。
	return map[string]any{
		"key":              entry.Key,
		"display_name":     entry.DisplayName,
		"model":            "",
		"format":           format,
		"is_vl":            entry.IsVl,
		"is_reasoning":     isReasoning,
		"api_key":          "",
		"url":              "",
		"source":           source,
		"max_input_tokens": maxInputTokens,
	}
}

func qoderBusinessName(lastUserText, transcript string) string {
	if name := clipQoderRunes(normalizeQoderString(lastUserText), businessNameMaxRunes); name != "" {
		return name
	}
	return clipQoderRunes(transcript, businessNameMaxRunes)
}

// clipQoderRunes 按 rune 截断，避免中文被切成半个 UTF-8 字符。
func clipQoderRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}

func qoderSessionType(provider string) string {
	// 与 Node 布局表的 inference.sessionType 同值：两个站点各自一套客户端标识。
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "qoder":
		return "qodercli"
	case "qodercn":
		return "qoderclicn"
	}
	return ""
}

// --- 通用小工具（按 JS 语义，因为事实源是 Node 实现） ---

func objectValue(value any) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	return object, ok
}

func arrayValue(value any) []any {
	array, ok := value.([]any)
	if !ok {
		return []any{}
	}
	return array
}

func normalizeQoderString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case json.Number:
		numeric, err := typed.Float64()
		return err == nil && numeric != 0
	case float64:
		return typed != 0
	default:
		return true
	}
}

func jsString(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return ""
	}
}

// jsNumber 复刻 Number(value)：null→0、布尔→1/0、字符串按数字解析、无法解析→非有限。
func jsNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, true
	case bool:
		if typed {
			return 1, true
		}
		return 0, true
	case json.Number:
		numeric, err := typed.Float64()
		return numeric, err == nil
	case float64:
		return typed, true
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0, true
		}
		numeric, err := strconv.ParseFloat(text, 64)
		return numeric, err == nil
	}
	return 0, false
}

func firstTruthyValue(values ...any) (any, bool) {
	for _, value := range values {
		if jsTruthy(value) {
			return value, true
		}
	}
	return nil, false
}

// marshalQoderValue 关闭 HTML 转义，保持与 Node JSON.stringify 相同的参数文本。
func marshalQoderValue(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return ""
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

func newQoderRequestID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("qoderrelay: generate request id: %w", err)
	}
	// RFC 4122 version 4 / variant 10xx，与 Node crypto.randomUUID() 同形。
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(raw[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
