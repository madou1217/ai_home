package inference

// ContextEditKind 是跨协议上下文管理编辑的稳定语义。
type ContextEditKind string

const (
	// ContextEditClearThinking 表示清理较旧的 reasoning/thinking 历史。
	ContextEditClearThinking ContextEditKind = "clear_thinking"
	// ContextEditClearToolUses 表示按阈值清理较旧的工具调用历史。
	ContextEditClearToolUses ContextEditKind = "clear_tool_uses"
)

// IsValid 判断上下文编辑类型是否已经建立 Canonical 语义。
func (kind ContextEditKind) IsValid() bool {
	return kind == ContextEditClearThinking || kind == ContextEditClearToolUses
}

// ContextMetricKind 是上下文阈值和保留数量的计量单位。
type ContextMetricKind string

const (
	// ContextMetricInputTokens 表示输入 token 数量。
	ContextMetricInputTokens ContextMetricKind = "input_tokens"
	// ContextMetricToolUses 表示工具调用数量。
	ContextMetricToolUses ContextMetricKind = "tool_uses"
	// ContextMetricThinkingTurns 表示包含 thinking 的 assistant 轮次数量。
	ContextMetricThinkingTurns ContextMetricKind = "thinking_turns"
)

// IsValid 判断上下文计量单位是否已经注册。
func (kind ContextMetricKind) IsValid() bool {
	return kind == ContextMetricInputTokens ||
		kind == ContextMetricToolUses ||
		kind == ContextMetricThinkingTurns
}

// ContextMetric 是带明确单位的正整数上下文数量。
type ContextMetric struct {
	kind  ContextMetricKind
	value uint64
}

// NewContextMetric 创建不能混淆 token、工具调用和 thinking 轮次的数量值。
func NewContextMetric(kind ContextMetricKind, value uint64) (ContextMetric, error) {
	if !kind.IsValid() || value == 0 {
		return ContextMetric{}, ErrInvalidRequest
	}
	return ContextMetric{kind: kind, value: value}, nil
}

// Kind 返回数量单位。
func (metric ContextMetric) Kind() ContextMetricKind {
	return metric.kind
}

// Value 返回正整数数量。
func (metric ContextMetric) Value() uint64 {
	return metric.value
}

// IsValid 判断数量仍满足构造不变量。
func (metric ContextMetric) IsValid() bool {
	_, err := NewContextMetric(metric.kind, metric.value)
	return err == nil
}

// ThinkingRetentionMode 是 thinking 历史的保留方式。
type ThinkingRetentionMode string

const (
	// ThinkingRetentionAll 表示保留全部 thinking 轮次。
	ThinkingRetentionAll ThinkingRetentionMode = "all"
	// ThinkingRetentionRecent 表示只保留最近指定数量的 thinking 轮次。
	ThinkingRetentionRecent ThinkingRetentionMode = "recent"
)

// ThinkingRetention 是 clear-thinking 编辑的可选保留策略。
type ThinkingRetention struct {
	mode  ThinkingRetentionMode
	turns uint64
}

// NewAllThinkingRetention 创建保留全部 thinking 的策略。
func NewAllThinkingRetention() ThinkingRetention {
	return ThinkingRetention{mode: ThinkingRetentionAll}
}

// NewRecentThinkingRetention 创建只保留最近 thinking 轮次的策略。
func NewRecentThinkingRetention(turns uint64) (ThinkingRetention, error) {
	if turns == 0 {
		return ThinkingRetention{}, ErrInvalidRequest
	}
	return ThinkingRetention{mode: ThinkingRetentionRecent, turns: turns}, nil
}

// Mode 返回保留方式。
func (retention ThinkingRetention) Mode() ThinkingRetentionMode {
	return retention.mode
}

// Turns 返回 recent 模式的 thinking 轮次数量。
func (retention ThinkingRetention) Turns() uint64 {
	return retention.turns
}

// IsValid 判断保留策略仍满足构造不变量。
func (retention ThinkingRetention) IsValid() bool {
	switch retention.mode {
	case ThinkingRetentionAll:
		return retention.turns == 0
	case ThinkingRetentionRecent:
		return retention.turns > 0
	default:
		return false
	}
}

// ToolInputClearMode 是工具输入清理策略的联合类型。
type ToolInputClearMode string

const (
	// ToolInputClearBoolean 表示用布尔值启用或禁用全部工具输入清理。
	ToolInputClearBoolean ToolInputClearMode = "boolean"
	// ToolInputClearNamed 表示只清理指定工具的输入。
	ToolInputClearNamed ToolInputClearMode = "named"
)

// ToolInputClearPolicy 保留 bool 或工具名列表两种互斥表达。
type ToolInputClearPolicy struct {
	mode    ToolInputClearMode
	enabled bool
	tools   []string
}

// NewBooleanToolInputClear 创建全部工具输入的布尔清理策略。
func NewBooleanToolInputClear(enabled bool) ToolInputClearPolicy {
	return ToolInputClearPolicy{
		mode:    ToolInputClearBoolean,
		enabled: enabled,
	}
}

// NewNamedToolInputClear 创建指定工具输入的清理策略。
func NewNamedToolInputClear(tools []string) (ToolInputClearPolicy, error) {
	if !areValidContextToolNames(tools, true) {
		return ToolInputClearPolicy{}, ErrInvalidRequest
	}
	return ToolInputClearPolicy{
		mode:  ToolInputClearNamed,
		tools: append([]string(nil), tools...),
	}, nil
}

// Mode 返回工具输入清理表达类型。
func (policy ToolInputClearPolicy) Mode() ToolInputClearMode {
	return policy.mode
}

// Enabled 返回 boolean 模式的开关值。
func (policy ToolInputClearPolicy) Enabled() bool {
	return policy.enabled
}

// Tools 返回 named 模式的独立工具名切片。
func (policy ToolInputClearPolicy) Tools() []string {
	return append([]string(nil), policy.tools...)
}

// IsValid 判断联合值只有当前模式允许的字段。
func (policy ToolInputClearPolicy) IsValid() bool {
	switch policy.mode {
	case ToolInputClearBoolean:
		return len(policy.tools) == 0
	case ToolInputClearNamed:
		return !policy.enabled && areValidContextToolNames(policy.tools, true)
	default:
		return false
	}
}

// ClearToolUsesInput 是 clear-tool-uses 编辑的显式构造输入。
type ClearToolUsesInput struct {
	Trigger         *ContextMetric
	Keep            *ContextMetric
	ClearAtLeast    *ContextMetric
	ClearToolInputs *ToolInputClearPolicy
	ExcludeTools    []string
}

// ContextEdit 是 clear-thinking 与 clear-tool-uses 的不可变联合值。
type ContextEdit struct {
	kind            ContextEditKind
	thinking        *ThinkingRetention
	trigger         *ContextMetric
	keep            *ContextMetric
	clearAtLeast    *ContextMetric
	clearToolInputs *ToolInputClearPolicy
	excludeTools    []string
}

// NewClearThinkingEdit 创建 Claude 当前 clear-thinking 的 Canonical 语义。
// retention 为 nil 时保留上游默认策略。
func NewClearThinkingEdit(retention *ThinkingRetention) (ContextEdit, error) {
	if retention != nil && !retention.IsValid() {
		return ContextEdit{}, ErrInvalidRequest
	}
	return ContextEdit{
		kind:     ContextEditClearThinking,
		thinking: cloneThinkingRetention(retention),
	}, nil
}

// NewClearToolUsesEdit 创建带单位校验的工具历史清理语义。
func NewClearToolUsesEdit(input ClearToolUsesInput) (ContextEdit, error) {
	if !validOptionalContextMetric(
		input.Trigger,
		ContextMetricInputTokens,
		ContextMetricToolUses,
	) ||
		!validOptionalContextMetric(input.Keep, ContextMetricToolUses) ||
		!validOptionalContextMetric(input.ClearAtLeast, ContextMetricInputTokens) ||
		input.ClearToolInputs != nil && !input.ClearToolInputs.IsValid() ||
		!areValidContextToolNames(input.ExcludeTools, false) {
		return ContextEdit{}, ErrInvalidRequest
	}
	return ContextEdit{
		kind:            ContextEditClearToolUses,
		trigger:         cloneContextMetric(input.Trigger),
		keep:            cloneContextMetric(input.Keep),
		clearAtLeast:    cloneContextMetric(input.ClearAtLeast),
		clearToolInputs: cloneToolInputClearPolicy(input.ClearToolInputs),
		excludeTools:    append([]string(nil), input.ExcludeTools...),
	}, nil
}

// Kind 返回编辑类型。
func (edit ContextEdit) Kind() ContextEditKind {
	return edit.kind
}

// ThinkingRetention 返回 clear-thinking 的可选保留策略。
func (edit ContextEdit) ThinkingRetention() (ThinkingRetention, bool) {
	if edit.thinking == nil {
		return ThinkingRetention{}, false
	}
	return *edit.thinking, true
}

// Trigger 返回 clear-tool-uses 的可选触发阈值。
func (edit ContextEdit) Trigger() (ContextMetric, bool) {
	if edit.trigger == nil {
		return ContextMetric{}, false
	}
	return *edit.trigger, true
}

// Keep 返回 clear-tool-uses 的可选保留数量。
func (edit ContextEdit) Keep() (ContextMetric, bool) {
	if edit.keep == nil {
		return ContextMetric{}, false
	}
	return *edit.keep, true
}

// ClearAtLeast 返回 clear-tool-uses 的最小清理 token 数。
func (edit ContextEdit) ClearAtLeast() (ContextMetric, bool) {
	if edit.clearAtLeast == nil {
		return ContextMetric{}, false
	}
	return *edit.clearAtLeast, true
}

// ClearToolInputs 返回可选工具输入清理策略的独立副本。
func (edit ContextEdit) ClearToolInputs() (ToolInputClearPolicy, bool) {
	if edit.clearToolInputs == nil {
		return ToolInputClearPolicy{}, false
	}
	return edit.clearToolInputs.clone(), true
}

// ExcludeTools 返回不能被 clear-tool-uses 清理的工具名。
func (edit ContextEdit) ExcludeTools() []string {
	return append([]string(nil), edit.excludeTools...)
}

// IsValid 判断联合值只携带当前编辑类型允许的字段。
func (edit ContextEdit) IsValid() bool {
	switch edit.kind {
	case ContextEditClearThinking:
		_, err := NewClearThinkingEdit(edit.thinking)
		return err == nil && edit.trigger == nil && edit.keep == nil &&
			edit.clearAtLeast == nil && edit.clearToolInputs == nil &&
			len(edit.excludeTools) == 0
	case ContextEditClearToolUses:
		_, err := NewClearToolUsesEdit(ClearToolUsesInput{
			Trigger:         edit.trigger,
			Keep:            edit.keep,
			ClearAtLeast:    edit.clearAtLeast,
			ClearToolInputs: edit.clearToolInputs,
			ExcludeTools:    edit.excludeTools,
		})
		return err == nil && edit.thinking == nil
	default:
		return false
	}
}

// clone 返回不能修改原值切片的编辑副本。
func (edit ContextEdit) clone() ContextEdit {
	return ContextEdit{
		kind:            edit.kind,
		thinking:        cloneThinkingRetention(edit.thinking),
		trigger:         cloneContextMetric(edit.trigger),
		keep:            cloneContextMetric(edit.keep),
		clearAtLeast:    cloneContextMetric(edit.clearAtLeast),
		clearToolInputs: cloneToolInputClearPolicy(edit.clearToolInputs),
		excludeTools:    append([]string(nil), edit.excludeTools...),
	}
}

// ContextManagement 是请求级上下文编辑的不可变有序集合。
type ContextManagement struct {
	edits []ContextEdit
}

// NewContextManagement 创建至少包含一个合法编辑的上下文管理策略。
func NewContextManagement(edits ...ContextEdit) (ContextManagement, error) {
	if len(edits) == 0 {
		return ContextManagement{}, ErrInvalidRequest
	}
	cloned := make([]ContextEdit, len(edits))
	for index, edit := range edits {
		if !edit.IsValid() {
			return ContextManagement{}, ErrInvalidRequest
		}
		cloned[index] = edit.clone()
	}
	return ContextManagement{edits: cloned}, nil
}

// Edits 返回保持声明顺序的独立编辑切片。
func (management ContextManagement) Edits() []ContextEdit {
	edits := make([]ContextEdit, len(management.edits))
	for index, edit := range management.edits {
		edits[index] = edit.clone()
	}
	return edits
}

// IsValid 判断集合非空且每个编辑都满足自身不变量。
func (management ContextManagement) IsValid() bool {
	_, err := NewContextManagement(management.edits...)
	return err == nil
}

// clone 返回上下文管理值的深拷贝。
func (management ContextManagement) clone() ContextManagement {
	cloned, _ := NewContextManagement(management.edits...)
	return cloned
}

// validOptionalContextMetric 校验可选数量及其允许的单位集合。
func validOptionalContextMetric(
	metric *ContextMetric,
	allowed ...ContextMetricKind,
) bool {
	if metric == nil {
		return true
	}
	if !metric.IsValid() {
		return false
	}
	for _, kind := range allowed {
		if metric.kind == kind {
			return true
		}
	}
	return false
}

// areValidContextToolNames 校验工具名非空、规范且不重复。
func areValidContextToolNames(values []string, requireNonEmpty bool) bool {
	if requireNonEmpty && len(values) == 0 {
		return false
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !isCanonicalOpaqueID(value) {
			return false
		}
		if _, found := seen[value]; found {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

// cloneContextMetric 复制可选不可变数量值。
func cloneContextMetric(value *ContextMetric) *ContextMetric {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

// cloneThinkingRetention 复制可选 thinking 保留策略。
func cloneThinkingRetention(value *ThinkingRetention) *ThinkingRetention {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

// cloneToolInputClearPolicy 深拷贝可选工具输入清理策略。
func cloneToolInputClearPolicy(value *ToolInputClearPolicy) *ToolInputClearPolicy {
	if value == nil {
		return nil
	}
	cloned := value.clone()
	return &cloned
}

// clone 返回工具输入清理策略及其工具名切片的独立副本。
func (policy ToolInputClearPolicy) clone() ToolInputClearPolicy {
	return ToolInputClearPolicy{
		mode:    policy.mode,
		enabled: policy.enabled,
		tools:   append([]string(nil), policy.tools...),
	}
}
