// Package codebuddyfamilyrelay 实现 CodeBuddy / WorkBuddy 家族的 OpenAI Chat Completions
// 原生透传通道。
//
// 为什么是**透传**而不是 Canonical 上游适配器：家族上游线协议就是标准 OpenAI
// `chat.completion(.chunk)`，客户端入口也是 chat completions——同协议下逐字节转发能保住
// 上游的富字段（`reasoning_content` / `function_call` / `refusal` / `extra_fields` 等），
// 与 Node 侧家族链路的做法一致（Node 也是改写请求体后直通，不做协议翻译）。
//
// 上游四条硬约束（错一条就是 400/404，且报错文案不会告诉你是哪一条；见 Node 侧
// lib/account/codebuddy-family-inference.js 的模块说明与 2026-10-14 实测）：
//  1. 路径只有 `/v2/chat/completions`（`/v1/chat/completions` 实测 404 Route Not Found）；
//  2. `stream` 必须为 true（非流式实测 400 Non-stream chat request is currently not supported），
//     因此客户端要非流式时，本端必须自己向上游要流、再聚合成单个响应；
//  3. `messages[0].role` 必须是 `system`（否则 400 first message is not system prompt）；
//  4. 必须带真实客户端 User-Agent（脚本 UA 被网关 403 code 10085）。
//
// **当前进度（2026-10-15）**：已完成并通过测试的是两件不依赖其它模块的事——
//   - `request_rewrite.go`：四条硬约束改写 + tool_choice 翻译（与 Node 侧
//     lib/account/codebuddy-family-inference.js 同语义，结论字段一一对应）；
//   - `aggregate.go`：客户端要非流式时的 SSE 聚合（上游只给流，约束 2）。
//
// **尚未接线**（本包目前没有调用方，路由仍由 Node 承载）：HTTP Handler（账号选择、
// 凭据取 token、上游请求、重试、响应回写、尝试记账、用量观察）、composition/router
// 注册，以及 Node 侧 `GO_INFERENCE_PROVIDERS` 与守卫测试的同步。在接线完成之前，
// `go-core-route-deferral` 会把家族请求继续交还 Node（见 lib/server/go-core-servable-providers.js）。
package codebuddyfamilyrelay

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// ErrInvalidRequestBody 表示请求体不是合法 JSON 对象。
//
// 调用方应据此交回 Canonical 入口：那边会按客户端协议给出规范的 400，而不是由透传通道
// 拼一个自造错误——透传只承诺处理它真正理解的请求。
var ErrInvalidRequestBody = errors.New("家族透传请求体无效")

// DefaultSystemPrompt 是客户端没给 system 首条时补的**中性**占位。
//
// 刻意不把第一条 user 改写成 system：那会改变模型对角色边界的理解，属于静默语义篡改。
const DefaultSystemPrompt = "You are a helpful assistant."

// tool_choice 的稳定取值（上游把它声明成 Go string，object 直接被 400 拒）。
var supportedToolChoiceStrings = map[string]bool{
	"auto":     true,
	"required": true,
	"none":     true,
}

// toolChoiceAliases 是等价别名：语义与目标串相同，不算降级。
var toolChoiceAliases = map[string]string{
	"any": "required",
}

// 丢信息的改写码。只列**真的丢信息**的改写：等价改写（any→required）与纯增补
// （补 system 占位）都不算有损，因此不进这个列表。客户端据此知道「它要求的语义没有被
// 完整执行」——日志里能查到不等于客户端知道。
const (
	// DegradationPinMissing 表示客户端钉住的工具没保住。
	DegradationPinMissing = "tool_choice_pin_missing"
	// DegradationUnsupportedForm 表示 tool_choice 形态认不出，只能放宽。
	DegradationUnsupportedForm = "tool_choice_unsupported_form"
)

// RewriteOptions 是改写需要的可注入项。
type RewriteOptions struct {
	// DefaultSystemPrompt 覆盖补位文案；为空时用 DefaultSystemPrompt。
	DefaultSystemPrompt string
}

// RewriteResult 是改写结论：既给出新请求体，也给出「本次改写丢掉了什么」。
//
// 结论字段与 Node 侧 adaptCodebuddyFamilyChatRequest 一一对应，便于两侧对照排查。
type RewriteResult struct {
	// Body 是交给上游的请求体（未触碰的字段逐字节保留）。
	Body []byte
	// InjectedSystemPrompt 表示补了一条 system 占位。
	InjectedSystemPrompt bool
	// ToolChoice 是落到 body 的 tool_choice 原样字节；nil 表示该字段应缺席。
	ToolChoice json.RawMessage
	// ToolChoiceChanged 表示 tool_choice 被改写（含大小写归一）。
	ToolChoiceChanged bool
	// ToolChoiceDowngraded 表示其中发生了语义降级（钉选没能保住）。
	ToolChoiceDowngraded bool
	// ToolChoicePin 是客户端想钉住的函数名（没钉则为空）。
	ToolChoicePin string
	// ToolChoicePinPreserved 表示钉选被严格保住（收窄 tools + required）。
	ToolChoicePinPreserved bool
	// ToolChoicePinMissing 表示客户端钉了一个不在 tools 里的函数。
	ToolChoicePinMissing bool
	// ToolChoiceUnsupportedForm 记录认不出的形态（原样透传会被上游 400）。
	ToolChoiceUnsupportedForm string
	// NarrowedToolCount 是收窄后保留的工具数（仅在保住钉选时非零）。
	NarrowedToolCount int
	// Degradations 是丢信息的改写码列表（见 Degradation* 常量）。
	Degradations []string
}

// toolChoiceDecision 是 tool_choice 翻译的中间结论。
type toolChoiceDecision struct {
	toolChoice    json.RawMessage
	changed       bool
	downgraded    bool
	pin           string
	pinPreserved  bool
	pinMissing    bool
	unsupported   string
	narrowedTools []json.RawMessage
}

// RewriteRequestBody 按上游硬约束改写家族请求体。
//
// 返回**新**字节切片，不改动入参：调用方可能还要拿原始体做日志或重试。
func RewriteRequestBody(body []byte, options RewriteOptions) (RewriteResult, error) {
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(body, &fields); err != nil {
		return RewriteResult{}, fmt.Errorf("%w: %v", ErrInvalidRequestBody, err)
	}
	result := RewriteResult{}

	// 约束 3：首条必须是 system。
	messages, err := decodeRawArray(fields["messages"])
	if err != nil {
		return RewriteResult{}, fmt.Errorf("%w: messages %v", ErrInvalidRequestBody, err)
	}
	if !firstMessageIsSystem(messages) {
		prompt := strings.TrimSpace(options.DefaultSystemPrompt)
		if prompt == "" {
			prompt = DefaultSystemPrompt
		}
		placeholder, marshalErr := json.Marshal(map[string]string{"role": "system", "content": prompt})
		if marshalErr != nil {
			return RewriteResult{}, fmt.Errorf("%w: %v", ErrInvalidRequestBody, marshalErr)
		}
		messages = append([]json.RawMessage{placeholder}, messages...)
		result.InjectedSystemPrompt = true
	}
	if len(messages) > 0 {
		encoded, marshalErr := json.Marshal(messages)
		if marshalErr != nil {
			return RewriteResult{}, fmt.Errorf("%w: %v", ErrInvalidRequestBody, marshalErr)
		}
		fields["messages"] = encoded
	}

	tools, err := decodeRawArray(fields["tools"])
	if err != nil {
		return RewriteResult{}, fmt.Errorf("%w: tools %v", ErrInvalidRequestBody, err)
	}
	decision, err := normalizeToolChoice(fields["tool_choice"], tools)
	if err != nil {
		return RewriteResult{}, err
	}
	applyToolChoice(fields, decision, &result)

	// 约束 2：stream 恒为 true（客户端要非流式时由聚合器还原）。
	fields["stream"] = json.RawMessage("true")

	rewritten, err := json.Marshal(fields)
	if err != nil {
		return RewriteResult{}, fmt.Errorf("%w: %v", ErrInvalidRequestBody, err)
	}
	result.Body = rewritten
	return result, nil
}

// applyToolChoice 把翻译结论写回请求体并填充结论字段。
func applyToolChoice(
	fields map[string]json.RawMessage,
	decision toolChoiceDecision,
	result *RewriteResult,
) {
	if decision.changed {
		if decision.toolChoice == nil {
			delete(fields, "tool_choice")
		} else {
			fields["tool_choice"] = decision.toolChoice
		}
	}
	// 钉选靠「收窄 tools」保住语义：只有真的收窄了才改写工具集，其余情况原样保留。
	if decision.pinPreserved && decision.narrowedTools != nil {
		if encoded, err := json.Marshal(decision.narrowedTools); err == nil {
			fields["tools"] = encoded
			result.NarrowedToolCount = len(decision.narrowedTools)
		}
	}
	result.ToolChoice = decision.toolChoice
	result.ToolChoiceChanged = decision.changed
	result.ToolChoiceDowngraded = decision.downgraded
	result.ToolChoicePin = decision.pin
	result.ToolChoicePinPreserved = decision.pinPreserved
	result.ToolChoicePinMissing = decision.pinMissing
	result.ToolChoiceUnsupportedForm = decision.unsupported
	if decision.pinMissing {
		result.Degradations = append(result.Degradations, DegradationPinMissing)
	}
	if decision.unsupported != "" {
		result.Degradations = append(result.Degradations, DegradationUnsupportedForm)
	}
}

// normalizeToolChoice 把客户端形态翻译成上游认的字符串形态。
//
// 形态表（与 Node 侧逐条对齐）：
//   - 缺席 / null            → 不动（不得凭空造出一个约束）；
//   - auto|required|none     → 原样（仅大小写/空白归一）；
//   - any                    → required（等价别名，不算降级）；
//   - {type:function, function:{name}}（Responses 扁平形态 {type:function,name} 同）
//     → 收窄 tools 到该函数 + required（语义等价）；该函数不在 tools 里时只能退化成裸
//     required，客户端压根没带 tools 时直接去掉该字段。去掉是**刻意选择**而不是上游逼的：
//     2026-10-14 探针实测 required + 空工具集上游照常 200（回散文），但空工具集下这个约束
//     本就不可满足，透传只是留个空壳；去掉字段 + 记 pinMissing 才能让「客户端钉了一个不在
//     列表里的工具」可排查；
//   - {type:function} 没有名字 → 裸 required，记 unsupportedForm；
//   - {type:auto|none|required} → 同名字符串；
//   - 其余形态（未知字符串/未知对象/数组/数字）→ auto（有 tools 时）或去掉字段（无 tools 时），
//     并把原始形态记进 unsupportedForm。
func normalizeToolChoice(raw json.RawMessage, tools []json.RawMessage) (toolChoiceDecision, error) {
	decision := toolChoiceDecision{}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return decision, nil
	}
	hasTools := len(tools) > 0
	relax := func(form string) toolChoiceDecision {
		decision.changed = true
		decision.downgraded = true
		decision.unsupported = form
		if hasTools {
			decision.toolChoice = json.RawMessage(`"auto"`)
		}
		return decision
	}

	if trimmed[0] == '"' {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return toolChoiceDecision{}, fmt.Errorf("%w: tool_choice %v", ErrInvalidRequestBody, err)
		}
		normalized := strings.ToLower(strings.TrimSpace(value))
		if supportedToolChoiceStrings[normalized] {
			decision.changed = normalized != value
			encoded, _ := json.Marshal(normalized)
			decision.toolChoice = encoded
			return decision, nil
		}
		if alias, ok := toolChoiceAliases[normalized]; ok {
			decision.changed = true
			encoded, _ := json.Marshal(alias)
			decision.toolChoice = encoded
			return decision, nil
		}
		return relax(value), nil
	}

	if trimmed[0] != '{' {
		return relax(describeJSONForm(trimmed)), nil
	}
	var object struct {
		Type     string `json:"type"`
		Name     string `json:"name"`
		Function *struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if err := json.Unmarshal(raw, &object); err != nil {
		return toolChoiceDecision{}, fmt.Errorf("%w: tool_choice %v", ErrInvalidRequestBody, err)
	}
	form := strings.ToLower(strings.TrimSpace(object.Type))
	if supportedToolChoiceStrings[form] {
		decision.changed = true
		encoded, _ := json.Marshal(form)
		decision.toolChoice = encoded
		return decision, nil
	}
	if form != "function" {
		return relax(object.Type), nil
	}
	name := strings.TrimSpace(object.Name)
	if object.Function != nil && strings.TrimSpace(object.Function.Name) != "" {
		name = strings.TrimSpace(object.Function.Name)
	}
	if name == "" {
		decision.changed = true
		decision.downgraded = true
		decision.unsupported = "function_without_name"
		if hasTools {
			decision.toolChoice = json.RawMessage(`"required"`)
		}
		return decision, nil
	}
	narrowed := narrowTools(tools, name)
	if len(narrowed) > 0 {
		decision.changed = true
		decision.pin = name
		decision.pinPreserved = true
		decision.narrowedTools = narrowed
		decision.toolChoice = json.RawMessage(`"required"`)
		return decision, nil
	}
	decision.changed = true
	decision.downgraded = true
	decision.pin = name
	decision.pinMissing = true
	if hasTools {
		decision.toolChoice = json.RawMessage(`"required"`)
	}
	return decision, nil
}

// narrowTools 按函数名过滤工具集，保持原顺序与原始字节。
func narrowTools(tools []json.RawMessage, name string) []json.RawMessage {
	narrowed := make([]json.RawMessage, 0, 1)
	for _, tool := range tools {
		if toolFunctionName(tool) == name {
			narrowed = append(narrowed, tool)
		}
	}
	return narrowed
}

// toolFunctionName 读取工具定义的函数名（嵌套 OpenAI 形态与 Responses 扁平形态）。
func toolFunctionName(tool json.RawMessage) string {
	var parsed struct {
		Name     string `json:"name"`
		Function *struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if err := json.Unmarshal(tool, &parsed); err != nil {
		return ""
	}
	if parsed.Function != nil && strings.TrimSpace(parsed.Function.Name) != "" {
		return strings.TrimSpace(parsed.Function.Name)
	}
	return strings.TrimSpace(parsed.Name)
}

// firstMessageIsSystem 判断首条消息的 role 是否为 system。
func firstMessageIsSystem(messages []json.RawMessage) bool {
	if len(messages) == 0 {
		return false
	}
	var parsed struct {
		Role string `json:"role"`
	}
	if err := json.Unmarshal(messages[0], &parsed); err != nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(parsed.Role), "system")
}

// decodeRawArray 解析 JSON 数组；字段缺席返回空数组，类型不符返回错误。
//
// 实现复用 relaycore（协议形状的 JSON 解析与 Provider 无关，只有一份）。
func decodeRawArray(raw json.RawMessage) ([]json.RawMessage, error) {
	return relaycore.DecodeRawArray(raw)
}

// describeJSONForm 给认不出的形态一个人可读的名字（进 unsupportedForm 与日志）。
func describeJSONForm(trimmed string) string {
	return relaycore.DescribeJSONForm(trimmed)
}

// 包内小写别名：家族自己的解析逻辑与测试沿用这些短名，实现统一指向 relaycore。
func decodeRawObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	return relaycore.DecodeRawObject(raw)
}

func rawString(raw json.RawMessage) (string, bool) { return relaycore.RawString(raw) }

func rawArray(raw json.RawMessage) []json.RawMessage { return relaycore.RawArray(raw) }

func rawInt64(raw json.RawMessage) (int64, bool) { return relaycore.RawInt64(raw) }
