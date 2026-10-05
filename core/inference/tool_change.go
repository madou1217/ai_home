package inference

// 对话中途的工具增删（Anthropic beta mid-conversation-tool-changes）：Claude Code 在对话中途的
// system 消息里放 tool_addition（携带工具定义）与 tool_removal（按名移除）。它们只能出现在
// system 消息里，表示「从这里起」可用工具的变化。
//
// Claude 编码器把它们原样写回；不认识这一概念的 Provider（Codex、Code Assist）先调用
// FoldToolChanges：新增的工具并入请求级工具列表、移除忽略、这些内容块从消息里去掉——
// 模型照样能调用新增工具，只是失去「从这里起」的位置语义。

// ContentToolChange 是对话中途工具增删的内容类别。
const ContentToolChange ContentKind = "tool_change"

// ToolChangeKind 区分新增与移除。
type ToolChangeKind string

const (
	// ToolChangeAddition 表示从这里起新增一个工具。
	ToolChangeAddition ToolChangeKind = "addition"
	// ToolChangeRemoval 表示从这里起移除一个工具。
	ToolChangeRemoval ToolChangeKind = "removal"
)

// ToolChangeContent 是一次对话中途的工具增删。
type ToolChangeContent struct {
	change     ToolChangeKind
	definition ToolDefinition
	name       string
}

// NewToolAddition 创建新增工具的内容块。
func NewToolAddition(definition ToolDefinition) (ToolChangeContent, error) {
	if !definition.IsValid() {
		return ToolChangeContent{}, ErrInvalidMessage
	}
	return ToolChangeContent{change: ToolChangeAddition, definition: definition.clone()}, nil
}

// NewToolRemoval 创建按名移除工具的内容块。
func NewToolRemoval(name string) (ToolChangeContent, error) {
	if !isNonBlankText(name) {
		return ToolChangeContent{}, ErrInvalidMessage
	}
	return ToolChangeContent{change: ToolChangeRemoval, name: name}, nil
}

// Kind 返回内容类别。
func (content ToolChangeContent) Kind() ContentKind { return ContentToolChange }

// Change 返回新增或移除。
func (content ToolChangeContent) Change() ToolChangeKind { return content.change }

// Definition 返回新增的工具定义；移除时第二个返回值为 false。
func (content ToolChangeContent) Definition() (ToolDefinition, bool) {
	if content.change != ToolChangeAddition {
		return ToolDefinition{}, false
	}
	return content.definition.clone(), true
}

// RemovedName 返回被移除工具的名字；新增时为空。
func (content ToolChangeContent) RemovedName() string { return content.name }

// IsValid 判断内容满足构造不变量。
func (content ToolChangeContent) IsValid() bool {
	switch content.change {
	case ToolChangeAddition:
		return content.definition.IsValid()
	case ToolChangeRemoval:
		return isNonBlankText(content.name)
	default:
		return false
	}
}

func (content ToolChangeContent) cloneContent() Content {
	return ToolChangeContent{change: content.change, definition: content.definition.clone(), name: content.name}
}

func (ToolChangeContent) isContent() {}

// HasToolChanges 报告请求是否含对话中途的工具增删。
func (request Request) HasToolChanges() bool {
	for _, message := range request.messages {
		for _, content := range message.contents {
			if _, ok := content.(ToolChangeContent); ok {
				return true
			}
		}
	}
	return false
}

// FoldToolChanges 为不认识对话中途工具增删的 Provider 投影请求：新增的工具并入请求级工具
// （同身份已存在时不重复）、移除忽略、这些内容块从消息里去掉（只剩它们的消息整条去掉）。
// 提示缓存断点按位置记录，内容移动后不再成立，一并清空（这些 Provider 不使用 Anthropic 缓存断点）。
func (request Request) FoldToolChanges() Request {
	if !request.HasToolChanges() {
		return request
	}
	folded := request
	folded.tools = make([]ToolDefinition, 0, len(request.tools))
	for _, tool := range request.tools {
		folded.tools = append(folded.tools, tool.clone())
	}
	folded.messages = make([]Message, 0, len(request.messages))
	for _, message := range request.messages {
		kept := make([]Content, 0, len(message.contents))
		for _, content := range message.contents {
			change, ok := content.(ToolChangeContent)
			if !ok {
				kept = append(kept, content.cloneContent())
				continue
			}
			if definition, added := change.Definition(); added && !hasToolIdentity(folded.tools, definition.identity) {
				folded.tools = append(folded.tools, definition)
			}
		}
		if len(kept) == 0 {
			continue
		}
		folded.messages = append(folded.messages, Message{role: message.role, phase: message.phase, contents: kept, turnEffort: message.turnEffort})
	}
	folded.cacheBreakpoints = nil
	folded.capabilities = deriveRequiredCapabilities(folded)
	return folded
}
