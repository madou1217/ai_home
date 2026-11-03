package inference

// PromptCacheTTL 是客户端声明的提示缓存生命周期。
type PromptCacheTTL string

const (
	// PromptCacheTTLDefault 表示使用上游协议的默认生命周期。
	PromptCacheTTLDefault PromptCacheTTL = ""
	// PromptCacheTTL5Minutes 表示缓存五分钟。
	PromptCacheTTL5Minutes PromptCacheTTL = "5m"
	// PromptCacheTTL1Hour 表示缓存一小时。
	PromptCacheTTL1Hour PromptCacheTTL = "1h"
)

// IsValid 判断缓存生命周期是否属于已知协议交集。
func (ttl PromptCacheTTL) IsValid() bool {
	return ttl == PromptCacheTTLDefault ||
		ttl == PromptCacheTTL5Minutes ||
		ttl == PromptCacheTTL1Hour
}

// PromptCacheScope 是缓存可见范围。
type PromptCacheScope string

const (
	// PromptCacheScopeDefault 表示使用上游默认缓存范围。
	PromptCacheScopeDefault PromptCacheScope = ""
	// PromptCacheScopeGlobal 表示请求全局可复用的缓存范围。
	PromptCacheScopeGlobal PromptCacheScope = "global"
	// PromptCacheScopeOrganization 表示组织内可复用的缓存范围。
	PromptCacheScopeOrganization PromptCacheScope = "org"
)

// IsValid 判断缓存范围是否属于已知协议交集。
func (scope PromptCacheScope) IsValid() bool {
	return scope == PromptCacheScopeDefault ||
		scope == PromptCacheScopeGlobal ||
		scope == PromptCacheScopeOrganization
}

// PromptCacheControl 是不依赖 Anthropic JSON 的提示缓存意图。
type PromptCacheControl struct {
	ttl   PromptCacheTTL
	scope PromptCacheScope
}

// NewPromptCacheControl 创建 ephemeral 类型的提示缓存意图。
func NewPromptCacheControl(
	ttl PromptCacheTTL,
	scope PromptCacheScope,
) (PromptCacheControl, error) {
	if !ttl.IsValid() || !scope.IsValid() {
		return PromptCacheControl{}, ErrInvalidRequest
	}
	return PromptCacheControl{ttl: ttl, scope: scope}, nil
}

// TTL 返回缓存生命周期。
func (control PromptCacheControl) TTL() PromptCacheTTL {
	return control.ttl
}

// Scope 返回缓存可见范围。
func (control PromptCacheControl) Scope() PromptCacheScope {
	return control.scope
}

// IsValid 判断缓存意图仍满足构造不变量。
func (control PromptCacheControl) IsValid() bool {
	_, err := NewPromptCacheControl(control.ttl, control.scope)
	return err == nil
}

// PromptCacheTargetKind 是缓存断点作用的位置类别。
type PromptCacheTargetKind string

const (
	// PromptCacheTargetRequest 表示由上游自动选择请求最后一个可缓存块。
	PromptCacheTargetRequest PromptCacheTargetKind = "request"
	// PromptCacheTargetMessageContent 表示精确消息内容块。
	PromptCacheTargetMessageContent PromptCacheTargetKind = "message_content"
	// PromptCacheTargetTool 表示精确工具定义。
	PromptCacheTargetTool PromptCacheTargetKind = "tool"
)

// IsValid 判断缓存断点位置类别是否已经注册。
func (kind PromptCacheTargetKind) IsValid() bool {
	return kind == PromptCacheTargetRequest ||
		kind == PromptCacheTargetMessageContent ||
		kind == PromptCacheTargetTool
}

// PromptCacheBreakpoint 保存请求中的稳定缓存位置，不持有 Provider JSON。
type PromptCacheBreakpoint struct {
	target       PromptCacheTargetKind
	messageIndex uint32
	contentIndex uint32
	toolIndex    uint32
	control      PromptCacheControl
}

// NewRequestPromptCacheBreakpoint 创建由上游定位最后可缓存块的断点。
func NewRequestPromptCacheBreakpoint(
	control PromptCacheControl,
) (PromptCacheBreakpoint, error) {
	return newPromptCacheBreakpoint(
		PromptCacheTargetRequest,
		0,
		0,
		0,
		control,
	)
}

// NewMessagePromptCacheBreakpoint 创建精确消息内容块断点。
func NewMessagePromptCacheBreakpoint(
	messageIndex uint32,
	contentIndex uint32,
	control PromptCacheControl,
) (PromptCacheBreakpoint, error) {
	return newPromptCacheBreakpoint(
		PromptCacheTargetMessageContent,
		messageIndex,
		contentIndex,
		0,
		control,
	)
}

// NewToolPromptCacheBreakpoint 创建精确工具定义断点。
func NewToolPromptCacheBreakpoint(
	toolIndex uint32,
	control PromptCacheControl,
) (PromptCacheBreakpoint, error) {
	return newPromptCacheBreakpoint(
		PromptCacheTargetTool,
		0,
		0,
		toolIndex,
		control,
	)
}

// newPromptCacheBreakpoint 统一校验断点位置和无关索引零值。
func newPromptCacheBreakpoint(
	target PromptCacheTargetKind,
	messageIndex uint32,
	contentIndex uint32,
	toolIndex uint32,
	control PromptCacheControl,
) (PromptCacheBreakpoint, error) {
	if !target.IsValid() || !control.IsValid() {
		return PromptCacheBreakpoint{}, ErrInvalidRequest
	}
	if target == PromptCacheTargetRequest &&
		(messageIndex != 0 || contentIndex != 0 || toolIndex != 0) {
		return PromptCacheBreakpoint{}, ErrInvalidRequest
	}
	if target == PromptCacheTargetMessageContent && toolIndex != 0 {
		return PromptCacheBreakpoint{}, ErrInvalidRequest
	}
	if target == PromptCacheTargetTool && (messageIndex != 0 || contentIndex != 0) {
		return PromptCacheBreakpoint{}, ErrInvalidRequest
	}
	return PromptCacheBreakpoint{
		target:       target,
		messageIndex: messageIndex,
		contentIndex: contentIndex,
		toolIndex:    toolIndex,
		control:      control,
	}, nil
}

// Target 返回缓存断点位置类别。
func (breakpoint PromptCacheBreakpoint) Target() PromptCacheTargetKind {
	return breakpoint.target
}

// MessageIndex 返回消息索引，其他位置类别返回零。
func (breakpoint PromptCacheBreakpoint) MessageIndex() uint32 {
	return breakpoint.messageIndex
}

// ContentIndex 返回消息内容索引，其他位置类别返回零。
func (breakpoint PromptCacheBreakpoint) ContentIndex() uint32 {
	return breakpoint.contentIndex
}

// ToolIndex 返回工具索引，其他位置类别返回零。
func (breakpoint PromptCacheBreakpoint) ToolIndex() uint32 {
	return breakpoint.toolIndex
}

// Control 返回缓存控制值对象。
func (breakpoint PromptCacheBreakpoint) Control() PromptCacheControl {
	return breakpoint.control
}

// IsValid 判断断点仍满足目标、索引和控制不变量。
func (breakpoint PromptCacheBreakpoint) IsValid() bool {
	_, err := newPromptCacheBreakpoint(
		breakpoint.target,
		breakpoint.messageIndex,
		breakpoint.contentIndex,
		breakpoint.toolIndex,
		breakpoint.control,
	)
	return err == nil
}

// areValidPromptCacheBreakpoints 校验断点目标存在且同一位置不重复。
func areValidPromptCacheBreakpoints(
	breakpoints []PromptCacheBreakpoint,
	messages []Message,
	tools []ToolDefinition,
) bool {
	type position struct {
		target       PromptCacheTargetKind
		messageIndex uint32
		contentIndex uint32
		toolIndex    uint32
	}
	seen := make(map[position]struct{}, len(breakpoints))
	for _, breakpoint := range breakpoints {
		if !breakpoint.IsValid() {
			return false
		}
		switch breakpoint.target {
		case PromptCacheTargetRequest:
		case PromptCacheTargetMessageContent:
			if int(breakpoint.messageIndex) >= len(messages) ||
				int(breakpoint.contentIndex) >= len(messages[breakpoint.messageIndex].contents) {
				return false
			}
		case PromptCacheTargetTool:
			if int(breakpoint.toolIndex) >= len(tools) {
				return false
			}
		default:
			return false
		}
		key := position{
			target:       breakpoint.target,
			messageIndex: breakpoint.messageIndex,
			contentIndex: breakpoint.contentIndex,
			toolIndex:    breakpoint.toolIndex,
		}
		if _, exists := seen[key]; exists {
			return false
		}
		seen[key] = struct{}{}
	}
	return true
}
