package kirorelay

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// defaultContinuePrompt 用于补齐「必须以 user 轮结尾」的会话形状（与 Node 同值）。
const defaultContinuePrompt = "Continue."

// remoteImagePlaceholder 是远程图片 URL 无法经 kiro 通道发送时的显式占位。
// 不静默丢内容：客户端与模型都能看到这张图没有被送达。
const remoteImagePlaceholder = "[远程图片 URL 无法经 kiro 通道发送，请改为内联 base64 图片]"

// missingToolResultText 是缺失工具结果的显式占位（规则 4 要求一一对应）。
const missingToolResultText = "Tool result unavailable: the client did not return a result for this tool call."

// kiroImageFormats 是 CodeWhisperer 接受的图片格式（与 Node 同表）。
var kiroImageFormats = map[string]string{
	"png":  "png",
	"jpeg": "jpeg",
	"jpg":  "jpeg",
	"gif":  "gif",
	"webp": "webp",
}

// emptyToolSchema 是工具缺省参数模型（description 不能为空，schema 也必须存在）。
var emptyToolSchema = json.RawMessage(`{"type":"object","properties":{}}`)

// Image 是 CodeWhisperer userInputMessage.images 的元素。
type Image struct {
	Format string      `json:"format"`
	Source ImageSource `json:"source"`
}

// ImageSource 携带 base64 字节（远程 URL 不可送）。
type ImageSource struct {
	Bytes string `json:"bytes"`
}

// ToolUse 是 assistant 轮发起的工具调用。
type ToolUse struct {
	ToolUseID string         `json:"toolUseId"`
	Name      string         `json:"name"`
	Input     map[string]any `json:"input"`
}

// ToolResult 是紧随其后的 user 轮返回的工具结果。
type ToolResult struct {
	ToolUseID string              `json:"toolUseId"`
	Status    string              `json:"status"`
	Content   []ToolResultContent `json:"content"`
}

// ToolResultContent 是工具结果文本块。
type ToolResultContent struct {
	Text string `json:"text"`
}

// ToolSpec 是客户端声明的工具（OpenAI Chat 语义）。
type ToolSpec struct {
	Name        string
	Description string
	Schema      json.RawMessage
}

// Message 是编码所需的最小 Chat 消息投影。
type Message struct {
	Role    string
	Content string
	// HasImages 是旧调用方的「内容里含图片」标记；真实图片数据走 Images。
	// 只有标记而没有数据时按 images_unsupported 降级（兼容旧行为）。
	HasImages bool
	// Images 是可直接发送的 base64 图片。
	Images []Image
	// ToolUses 是 assistant 轮的工具调用。
	ToolUses []ToolUse
	// ToolResults 是 user/tool 轮返回的工具结果。
	ToolResults []ToolResult
}

// EncodeOptions 是会话编码的外部事实。
type EncodeOptions struct {
	// ConversationID 为空时随机生成；调用方通常传会话键派生值。
	ConversationID string
	// ModelID 是上游 modelId（默认取请求的 model）。
	ModelID string
	// ToolCount 是旧调用方的工具数量标记；Tools 为空时据此报 tools_unsupported。
	ToolCount int
	// Tools 是客户端声明的工具；非空时编码进 conversationState。
	Tools []ToolSpec
	// UnsupportedParams 是客户端要求但 conversationState 表达不了的参数名。
	// 每个名字会以 "<param>_unsupported" 记入 Degradations，避免静默丢语义。
	UnsupportedParams []string
}

// EncodedConversation 是编码结果。
type EncodedConversation struct {
	// Body 是上游 conversationState 所在的对象（JSON 可序列化）。
	Body map[string]any
	// Degradations 是本端丢掉的语义（relaycore 会如实回给客户端）。
	Degradations []string
	// PromptText 是给 usage 估算用的纯文本（上游没有 token 数）。
	PromptText string
}

// conversationTurn 是编码期间的交替 user/assistant 轮。
type conversationTurn struct {
	role        string
	text        string
	images      []Image
	toolUses    []ToolUse
	toolResults []ToolResult
}

// EncodeConversation 把 Chat 语义消息编码成 CodeWhisperer 的 conversationState。
//
// 规则来自 2026-10-19 真机取证（与已删除的 Node kiro-dialect 同语义）：
//  1. 工具定义放在 currentMessage.userInputMessageContext.tools；
//  2. toolSpecification.description 不能为空；
//  3. history 出现 toolUses/toolResults 时 currentMessage 必须带 tools；
//  4. toolResults 必须与紧邻上一个 assistant 轮的 toolUses 一一对应；
//  5. 工具结果可只有 toolResults、content 为空；assistant 轮可只有 toolUses；
//  6. 图片走 userInputMessage.images（仅 base64 data URL）；
//  7. tool_choice 无对应字段（等价 auto），按降级上报。
func EncodeConversation(messages []Message, options EncodeOptions) EncodedConversation {
	system, turns := collectTurns(messages)
	if system != "" {
		folded := false
		for index := range turns {
			if turns[index].role != "user" {
				continue
			}
			if turns[index].text != "" {
				turns[index].text = system + "\n\n" + turns[index].text
			} else {
				turns[index].text = system
			}
			folded = true
			break
		}
		if !folded {
			turns = append([]conversationTurn{{role: "user", text: system}}, turns...)
		}
	}
	// history 必须从 user 轮开始。
	if len(turns) > 0 && turns[0].role != "user" {
		turns = append([]conversationTurn{{role: "user", text: defaultContinuePrompt}}, turns...)
	}
	var orphaned, synthesized bool
	turns, orphaned, synthesized = pairToolResults(turns)
	// currentMessage 必须是 userInputMessage：末轮是 assistant 时补续写指令。
	if len(turns) == 0 || turns[len(turns)-1].role != "user" {
		turns = append(turns, conversationTurn{role: "user", text: defaultContinuePrompt})
	}

	modelID := strings.TrimSpace(options.ModelID)
	conversationID := strings.TrimSpace(options.ConversationID)
	if conversationID == "" {
		conversationID = newUUID()
	}

	toolSpecs := buildToolSpecifications(options.Tools, turns)
	degradations := make([]string, 0, 8)
	for _, message := range messages {
		if message.HasImages && len(message.Images) == 0 {
			degradations = append(degradations, "images_unsupported")
			break
		}
	}
	if options.ToolCount > 0 && len(options.Tools) == 0 {
		degradations = append(degradations, "tools_unsupported")
	}
	for _, param := range options.UnsupportedParams {
		param = strings.TrimSpace(param)
		if param != "" {
			degradations = append(degradations, param+"_unsupported")
		}
	}
	if orphaned {
		degradations = append(degradations, "tool_result_orphaned")
	}
	if synthesized {
		degradations = append(degradations, "tool_result_synthesized")
	}
	degradations = uniqueStrings(degradations)

	promptParts := make([]string, 0, len(turns)+1)
	history := make([]any, 0, len(turns)-1)
	for _, turn := range turns[:len(turns)-1] {
		if turn.role == "assistant" {
			history = append(history, encodeAssistantTurn(turn))
		} else {
			history = append(history, encodeUserTurn(turn, false, modelID, nil))
		}
		promptParts = append(promptParts, turnPromptText(turn))
	}
	last := turns[len(turns)-1]
	promptParts = append(promptParts, turnPromptText(last))
	conversationState := map[string]any{
		"chatTriggerType": "MANUAL",
		"conversationId":  conversationID,
		"currentMessage":  encodeUserTurn(last, true, modelID, toolSpecs),
	}
	if len(history) > 0 {
		conversationState["history"] = history
	}
	if len(toolSpecs) > 0 {
		promptParts = append(promptParts, mustJSON(toolSpecs))
	}
	body := map[string]any{"conversationState": conversationState}
	return EncodedConversation{
		Body:         body,
		Degradations: degradations,
		PromptText:   strings.Join(promptParts, "\n"),
	}
}

// collectTurns 把 Chat 消息压成交替的 user/assistant 轮（system 单独返回）。
func collectTurns(messages []Message) (string, []conversationTurn) {
	var systemParts []string
	turns := make([]conversationTurn, 0, len(messages))
	turnFor := func(role string) *conversationTurn {
		if len(turns) > 0 && turns[len(turns)-1].role == role {
			return &turns[len(turns)-1]
		}
		turns = append(turns, conversationTurn{role: role})
		return &turns[len(turns)-1]
	}
	for _, message := range messages {
		role := strings.ToLower(strings.TrimSpace(message.Role))
		switch role {
		case "system", "developer":
			if message.Content != "" {
				systemParts = append(systemParts, message.Content)
			}
		case "tool", "function":
			turn := turnFor("user")
			if len(message.ToolResults) == 0 {
				appendTurnText(turn, message.Content)
				continue
			}
			turn.toolResults = append(turn.toolResults, message.ToolResults...)
			appendTurnText(turn, message.Content)
		case "assistant":
			if message.Content == "" && len(message.ToolUses) == 0 {
				continue
			}
			turn := turnFor("assistant")
			appendTurnText(turn, message.Content)
			turn.toolUses = append(turn.toolUses, message.ToolUses...)
		default:
			turn := turnFor("user")
			appendTurnText(turn, message.Content)
			turn.images = append(turn.images, message.Images...)
		}
	}
	return strings.Join(systemParts, "\n\n"), turns
}

// appendTurnText 在同一轮内用空行拼接多段文本（与 Node appendText 同语义）。
func appendTurnText(turn *conversationTurn, text string) {
	if text == "" {
		return
	}
	if turn.text == "" {
		turn.text = text
		return
	}
	turn.text += "\n\n" + text
}

// pairToolResults 实现规则 4：多余结果降级为文本，缺失结果补 error 结果。
func pairToolResults(turns []conversationTurn) ([]conversationTurn, bool, bool) {
	orphaned := false
	synthesized := false
	for index := range turns {
		turn := &turns[index]
		if turn.role != "user" {
			continue
		}
		var expected []string
		if index > 0 && turns[index-1].role == "assistant" {
			for _, use := range turns[index-1].toolUses {
				expected = append(expected, use.ToolUseID)
			}
		}
		byID := make(map[string]ToolResult, len(turn.toolResults))
		var orphans []ToolResult
		for _, result := range turn.toolResults {
			if containsString(expected, result.ToolUseID) {
				if _, exists := byID[result.ToolUseID]; !exists {
					byID[result.ToolUseID] = result
					continue
				}
			}
			orphans = append(orphans, result)
		}
		paired := make([]ToolResult, 0, len(expected))
		for _, id := range expected {
			if result, found := byID[id]; found {
				paired = append(paired, result)
				continue
			}
			synthesized = true
			paired = append(paired, ToolResult{
				ToolUseID: id,
				Status:    "error",
				Content:   []ToolResultContent{{Text: missingToolResultText}},
			})
		}
		turn.toolResults = paired
		if len(orphans) > 0 {
			orphaned = true
			var described []string
			for _, orphan := range orphans {
				described = append(described, describeOrphanResult(orphan))
			}
			if turn.text != "" {
				turn.text = strings.Join(described, "\n\n") + "\n\n" + turn.text
			} else {
				turn.text = strings.Join(described, "\n\n")
			}
		}
	}
	// 末轮 assistant 的 toolUses 没有后继 user 轮：补一个只带 error 结果的 user 轮。
	last := len(turns) - 1
	if last >= 0 && turns[last].role == "assistant" && len(turns[last].toolUses) > 0 {
		turns = append(turns, conversationTurn{role: "user"})
		turn := &turns[len(turns)-1]
		for _, use := range turns[len(turns)-2].toolUses {
			synthesized = true
			turn.toolResults = append(turn.toolResults, ToolResult{
				ToolUseID: use.ToolUseID,
				Status:    "error",
				Content:   []ToolResultContent{{Text: missingToolResultText}},
			})
		}
	}
	return turns, orphaned, synthesized
}

func describeOrphanResult(result ToolResult) string {
	var body []string
	for _, item := range result.Content {
		if item.Text != "" {
			body = append(body, item.Text)
		}
	}
	suffix := ""
	if result.Status == "error" {
		suffix = " (error)"
	}
	return fmt.Sprintf("[tool result %s%s]\n%s", result.ToolUseID, suffix, strings.Join(body, "\n"))
}

// buildToolSpecifications 生成 toolSpecification；历史里用过但未声明的工具补最小定义。
func buildToolSpecifications(tools []ToolSpec, turns []conversationTurn) []map[string]any {
	specs := make([]map[string]any, 0, len(tools))
	seen := make(map[string]struct{}, len(tools))
	for _, tool := range tools {
		name := strings.TrimSpace(tool.Name)
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		description := strings.TrimSpace(tool.Description)
		if description == "" {
			// 规则 2：description 为空会被上游 400 拒绝。
			description = name
		}
		schema := tool.Schema
		if !isJSONObjectSchema(schema) {
			schema = emptyToolSchema
		}
		specs = append(specs, map[string]any{
			"toolSpecification": map[string]any{
				"name":        name,
				"description": description,
				"inputSchema": map[string]any{"json": schema},
			},
		})
	}
	for _, turn := range turns {
		for _, use := range turn.toolUses {
			name := strings.TrimSpace(use.Name)
			if name == "" {
				continue
			}
			if _, exists := seen[name]; exists {
				continue
			}
			seen[name] = struct{}{}
			// 规则 3：history 用过但请求没声明的工具必须补最小定义。
			specs = append(specs, map[string]any{
				"toolSpecification": map[string]any{
					"name":        name,
					"description": name,
					"inputSchema": map[string]any{"json": emptyToolSchema},
				},
			})
		}
	}
	return specs
}

func isJSONObjectSchema(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(trimmed, "{") {
		return false
	}
	var object map[string]any
	return json.Unmarshal([]byte(trimmed), &object) == nil
}

// encodeUserTurn 生成 userInputMessage。
func encodeUserTurn(turn conversationTurn, current bool, modelID string, toolSpecs []map[string]any) map[string]any {
	context := map[string]any{}
	if len(turn.toolResults) > 0 {
		context["toolResults"] = turn.toolResults
	}
	if current && len(toolSpecs) > 0 {
		context["tools"] = toolSpecs
	}
	content := turn.text
	if content == "" && len(turn.toolResults) == 0 && len(turn.images) == 0 && !current {
		content = defaultContinuePrompt
	}
	message := map[string]any{
		"content":                 content,
		"userInputMessageContext": context,
		"origin":                  "AI_EDITOR",
	}
	if len(turn.images) > 0 {
		message["images"] = turn.images
	}
	if modelID != "" {
		message["modelId"] = modelID
	}
	return map[string]any{"userInputMessage": message}
}

// encodeAssistantTurn 生成 assistantResponseMessage。
func encodeAssistantTurn(turn conversationTurn) map[string]any {
	message := map[string]any{"content": turn.text}
	if len(turn.toolUses) > 0 {
		message["toolUses"] = turn.toolUses
	}
	return map[string]any{"assistantResponseMessage": message}
}

// turnPromptText 汇总一轮文本、工具输入与工具结果，供 usage 估算。
func turnPromptText(turn conversationTurn) string {
	parts := make([]string, 0, 1+len(turn.toolUses)+len(turn.toolResults))
	parts = append(parts, turn.text)
	for _, use := range turn.toolUses {
		parts = append(parts, mustJSON(use.Input))
	}
	for _, result := range turn.toolResults {
		var texts []string
		for _, item := range result.Content {
			texts = append(texts, item.Text)
		}
		parts = append(parts, strings.Join(texts, "\n"))
	}
	return strings.Join(parts, "\n")
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// Base64Image 把 data:image/<fmt>;base64,<bytes> 解析成 kiro 图片块。
// 返回 ok=false 表示远程 URL 或未知格式，调用方应显式占位。
func Base64Image(url string) (Image, bool) {
	trimmed := strings.TrimSpace(url)
	const prefix = "data:image/"
	if !strings.HasPrefix(trimmed, prefix) {
		return Image{}, false
	}
	rest := trimmed[len(prefix):]
	separator := strings.Index(rest, ";base64,")
	if separator <= 0 {
		return Image{}, false
	}
	format := strings.ToLower(strings.TrimSpace(rest[:separator]))
	mapped, known := kiroImageFormats[format]
	if !known {
		return Image{}, false
	}
	bytes := strings.TrimSpace(rest[separator+len(";base64,"):])
	if bytes == "" {
		return Image{}, false
	}
	bytes = strings.Join(strings.Fields(bytes), "")
	return Image{Format: mapped, Source: ImageSource{Bytes: bytes}}, true
}

func newUUID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return ""
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(bytes[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexed[0:8], hexed[8:12], hexed[12:16], hexed[16:20], hexed[20:32])
}
