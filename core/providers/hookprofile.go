package providers

import (
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// HookAdapterID 是 Hook 写入格式适配器的标识。
//
// 取值与 Node 描述符（lib/providers/contract.js HOOK_ADAPTER_IDS）逐字一致：
// 适配器只决定「怎么把事件写成目标文件的形状」，格式实现不在合同里。
type HookAdapterID string

const (
	// HookAdapterJSONHooks 是「事件 → [{hooks:[…]}]」的 JSON 结构（codex / claude / gemini / grok）。
	HookAdapterJSONHooks HookAdapterID = "json_hooks"
	// HookAdapterAgyNamedHooks 是顶层具名 hook 定义，事件值形状不同（agy）。
	HookAdapterAgyNamedHooks HookAdapterID = "agy_named_hooks"
	// HookAdapterOpenCodePlugin 是插件桥，不是 JSON 事件清单（opencode）。
	HookAdapterOpenCodePlugin HookAdapterID = "opencode_plugin"
)

// HookTimeoutUnit 是 Hook 配置里 timeout 字段的计量单位。
//
// 同一个数值在不同原生客户端里含义不同（gemini 用毫秒，其余用秒），
// 所以单位必须显式声明；空值表示**未声明**，不是「默认秒」。
type HookTimeoutUnit string

const (
	// HookTimeoutSeconds 表示 timeout 以秒计。
	HookTimeoutSeconds HookTimeoutUnit = "seconds"
	// HookTimeoutMilliseconds 表示 timeout 以毫秒计。
	HookTimeoutMilliseconds HookTimeoutUnit = "ms"
)

// HookFormat 是 SessionSync 中「怎么写」的合同数据：目标路径段、超时单位、
// 事件 matcher 与目标文件旁的特性开关。它是 HookProfile 的唯一数据源：
// DeriveHookProfile 只做复制，不为零值补默认值。
//
// 零值 / nil 表示**合同没有声明**这项事实，不是「默认秒 / 不需要 matcher /
// 不需要开关」。内置合同里的数据逐字转录自 Node 描述符（lib/providers/defs）
// 与其合同默认值：gemini 显式 ms，其余 provider 显式声明「秒」；codex 显式给
// SessionStart matcher 与特性开关，其余 provider 显式声明不需要开关。
type HookFormat struct {
	// Target 是相对宿主 home 的路径段（例：[".codex", "hooks.json"]）。
	Target []string `json:"target,omitempty"`
	// TimeoutUnit 是 timeout 的计量单位；空表示合同未声明。
	TimeoutUnit HookTimeoutUnit `json:"timeoutUnit,omitempty"`
	// EventMatchers 是「事件名 → matcher 正则」；空表示合同未声明。
	EventMatchers map[string]string `json:"eventMatchers,omitempty"`
	// FeatureFlag 表示目标文件旁还有一份特性开关需要一起打开。
	// nil 表示合同未声明——不能当成 false。
	FeatureFlag *bool `json:"featureFlag,omitempty"`
}

// HookProfile 是 Hook 档案的声明式数据：目标路径段、超时单位、事件 matcher、
// 目标文件旁的特性开关，以及「有没有 Hook」的回答。
//
// 设计约束（与 Node 描述符 hooks 能力对齐）：
//   - 一个 Provider 要么 supported=true 并给出 adapter，要么 supported=false 并写明 Reason；
//     沉默缺席会让调用方只能靠猜，这正是本能力位要消灭的形态。
//   - Target 是**相对宿主 home 的路径段**，不是整条路径：段里出现分隔符说明写错了形状。
//   - TimeoutUnit / EventMatchers / FeatureFlag 的零值表示**合同没有声明**，
//     不是「默认值」。给零值编一个默认值等于伪造上游事实（codex 之外的 provider
//     确实没有 matcher，而 gemini 的单位是毫秒），所以宁可留空。
//
// 字段来源：全部来自 SessionSync（Go 合同是真值源）。HookFormat 声明的字段
// 原样复制，未声明的字段保持零值——缺数据就留空并如实报告，不从 Node 描述符
// 反抄一遍变成第二份需要同步的名单。
type HookProfile struct {
	// Supported 表示该 Provider 是否声明了 Hook 档案。
	Supported bool `json:"supported"`
	// Reason 在 Supported=false 时必填：为什么没有 Hook。
	Reason string `json:"reason,omitempty"`
	// Adapter 是写入格式适配器，Supported=true 时必填。
	Adapter HookAdapterID `json:"adapter,omitempty"`
	// Target 是相对原生根的路径段（例：[".codex", "hooks.json"]）。
	Target []string `json:"target,omitempty"`
	// TimeoutUnit 是 timeout 的计量单位；空表示合同未声明。
	TimeoutUnit HookTimeoutUnit `json:"timeoutUnit,omitempty"`
	// EventMatchers 是「事件名 → matcher 正则」；空表示不需要 matcher。
	EventMatchers map[string]string `json:"eventMatchers,omitempty"`
	// FeatureFlag 表示目标文件旁还有一份特性开关需要一起打开（codex 的 config.toml）。
	// nil 表示合同未声明——不能当成 false，否则「没数据」会被读成「确定不需要」。
	FeatureFlag *bool `json:"featureFlag,omitempty"`
}

// DeriveHookProfile 从 Provider 合同里**能查到的**事实推导 Hook 档案。
//
// Supported 由 SessionSync.Mode 决定，adapter 来自 SessionSync.Adapter，
// 格式字段从 SessionSync.Hook 原样复制。不做跨字段拼接、不补默认值：
// 合同没声明的字段保持零值，调用方必须读成「未声明」。
func DeriveHookProfile(definition Definition) HookProfile {
	if definition.SessionSync.Mode != SessionSyncHook {
		return HookProfile{
			Supported: false,
			Reason:    hookUnsupportedReason(definition.SessionSync.Mode),
		}
	}
	profile := HookProfile{
		Supported: true,
		Adapter:   HookAdapterID(strings.TrimSpace(definition.SessionSync.Adapter)),
	}
	format := definition.SessionSync.Hook
	if format == nil {
		return profile
	}
	profile.Target = append([]string(nil), format.Target...)
	profile.TimeoutUnit = format.TimeoutUnit
	if len(format.EventMatchers) > 0 {
		profile.EventMatchers = make(map[string]string, len(format.EventMatchers))
		for event, matcher := range format.EventMatchers {
			profile.EventMatchers[event] = matcher
		}
	}
	if format.FeatureFlag != nil {
		flag := *format.FeatureFlag
		profile.FeatureFlag = &flag
	}
	return profile
}

// hookUnsupportedReason 给出「为什么没有 Hook」的事实性回答。
//
// 只复述合同自己的取值（polling / unavailable），不编造上游原因：
// 「这个 Provider 靠轮询」是合同已经写死的事实，而「上游不提供 Hook」不是。
func hookUnsupportedReason(mode SessionSyncMode) string {
	switch mode {
	case SessionSyncPolling:
		return "sessionSync.mode=polling：会话变化靠轮询原生存储，未声明 hook"
	case SessionSyncUnavailable:
		return "sessionSync.mode=unavailable：未实现会话同步，未声明 hook"
	default:
		return fmt.Sprintf("sessionSync.mode=%s：不是 hook 同步，未声明 hook", mode)
	}
}

// ValidateHookProfile 校验一个候选档案与 Provider 合同是否自洽。
//
// 不变量：
//   - Supported 必须与 SessionSync.Mode 一致：合同说 hook、档案说没有，或反过来，
//     都会让调用方拿到自相矛盾的两个答案；
//   - Supported=false 必须写 Reason，且**不得**携带 adapter/target/单位/matcher/开关
//     ——「不支持」却带着写文件参数，只会让人以为配置生效了；
//   - Supported=true 必须有合法 adapter；合同与档案都声明 target 时必须逐段一致；
//   - Target 的每一段都必须是一个正常路径段（非空、非 . / ..、不含分隔符、非绝对路径），
//     否则适配器拼接出的路径会落到预期之外的位置；
//   - TimeoutUnit 非空时必须已在单位表登记：拼错会让超时被当成另一种量级；
//   - EventMatchers 的事件名必须是合同 Events 里真正会发出的事件，matcher 不能为空；
//     给一个永不发出的挂 matcher 等于静默死配置；
//   - 合同与档案都声明 timeoutUnit / eventMatchers / featureFlag 时必须逐字一致，
//     否则调用方会拿到两个互相矛盾的答案（与 target 的规则相同）。
func ValidateHookProfile(definition Definition, profile HookProfile) error {
	id := strings.TrimSpace(definition.ID)
	if id == "" {
		return errors.New("provider id 不能为空")
	}
	wantsHook := definition.SessionSync.Mode == SessionSyncHook
	if profile.Supported != wantsHook {
		return fmt.Errorf("provider %s: hooks.supported=%t 与 sessionSync.mode=%s 矛盾",
			id, profile.Supported, definition.SessionSync.Mode)
	}
	if !profile.Supported {
		return validateUnsupportedHookProfile(id, profile)
	}
	adapter := HookAdapterID(strings.TrimSpace(string(profile.Adapter)))
	if adapter == "" {
		return fmt.Errorf("provider %s: hooks.adapter 不能为空", id)
	}
	if !adapter.IsValid() {
		return fmt.Errorf("provider %s: 未知 hooks.adapter %q", id, adapter)
	}
	contractAdapter := HookAdapterID(strings.TrimSpace(definition.SessionSync.Adapter))
	if contractAdapter != "" && contractAdapter != adapter {
		return fmt.Errorf("provider %s: hooks.adapter=%q 与 sessionSync.adapter=%q 不一致",
			id, adapter, contractAdapter)
	}
	if err := validateHookTarget(id, profile.Target); err != nil {
		return err
	}
	if contract := definition.SessionSync.Hook; contract != nil && len(contract.Target) > 0 && len(profile.Target) > 0 {
		if !slices.Equal(contract.Target, profile.Target) {
			return fmt.Errorf("provider %s: hooks.target=%v 与 sessionSync.hook.target=%v 不一致",
				id, profile.Target, contract.Target)
		}
	}
	if profile.TimeoutUnit != "" && !profile.TimeoutUnit.IsValid() {
		return fmt.Errorf("provider %s: 未知 hooks.timeoutUnit %q", id, profile.TimeoutUnit)
	}
	if err := validateHookMatchers(id, definition, profile.EventMatchers); err != nil {
		return err
	}
	return validateHookFormatConsistency(id, definition.SessionSync.Hook, profile)
}

// validateHookFormatConsistency 保证档案与合同声明的格式字段逐字一致。
//
// 规则与 target 相同：只有双方都声明时才比较；任一方留空表示「无此项事实」，
// 不追究。出现两个不同答案则必须失败，否则写文件的人不知道该信哪个。
func validateHookFormatConsistency(id string, contract *HookFormat, profile HookProfile) error {
	if contract == nil {
		return nil
	}
	if contract.TimeoutUnit != "" && profile.TimeoutUnit != "" && contract.TimeoutUnit != profile.TimeoutUnit {
		return fmt.Errorf("provider %s: hooks.timeoutUnit=%q 与 sessionSync.hook.timeoutUnit=%q 不一致",
			id, profile.TimeoutUnit, contract.TimeoutUnit)
	}
	if len(contract.EventMatchers) > 0 && len(profile.EventMatchers) > 0 && !maps.Equal(contract.EventMatchers, profile.EventMatchers) {
		return fmt.Errorf("provider %s: hooks.eventMatchers=%v 与 sessionSync.hook.eventMatchers=%v 不一致",
			id, profile.EventMatchers, contract.EventMatchers)
	}
	if contract.FeatureFlag != nil && profile.FeatureFlag != nil && *contract.FeatureFlag != *profile.FeatureFlag {
		return fmt.Errorf("provider %s: hooks.featureFlag=%t 与 sessionSync.hook.featureFlag=%t 不一致",
			id, *profile.FeatureFlag, *contract.FeatureFlag)
	}
	return nil
}

// validateUnsupportedHookProfile 保证「不支持」是一个干净的回答。
func validateUnsupportedHookProfile(id string, profile HookProfile) error {
	if strings.TrimSpace(profile.Reason) == "" {
		return fmt.Errorf("provider %s: hooks.supported=false 时必须写明 reason", id)
	}
	if strings.TrimSpace(string(profile.Adapter)) != "" {
		return fmt.Errorf("provider %s: hooks.supported=false 时不能声明 adapter", id)
	}
	if len(profile.Target) > 0 {
		return fmt.Errorf("provider %s: hooks.supported=false 时不能声明 target", id)
	}
	if profile.TimeoutUnit != "" {
		return fmt.Errorf("provider %s: hooks.supported=false 时不能声明 timeoutUnit", id)
	}
	if len(profile.EventMatchers) > 0 {
		return fmt.Errorf("provider %s: hooks.supported=false 时不能声明 eventMatchers", id)
	}
	if profile.FeatureFlag != nil {
		return fmt.Errorf("provider %s: hooks.supported=false 时不能声明 featureFlag", id)
	}
	return nil
}

// validateHookTarget 校验路径段列表的形状。
func validateHookTarget(id string, target []string) error {
	if err := validateHookTargetSegments(target); err != nil {
		return fmt.Errorf("provider %s: %w", id, err)
	}
	return nil
}

// validateHookTargetSegments 是 provider 无关的路径段形状校验。
func validateHookTargetSegments(target []string) error {
	for index, segment := range target {
		trimmed := strings.TrimSpace(segment)
		if trimmed == "" {
			return fmt.Errorf("hooks.target[%d] 为空路径段", index)
		}
		if trimmed != segment {
			return fmt.Errorf("hooks.target[%d] 含首尾空白: %q", index, segment)
		}
		if trimmed == "." || trimmed == ".." {
			return fmt.Errorf("hooks.target[%d] 不能是 %q", index, trimmed)
		}
		if strings.ContainsAny(trimmed, "/\\") {
			return fmt.Errorf("hooks.target[%d]=%q 必须是单个路径段，不能含分隔符", index, trimmed)
		}
	}
	return nil
}

// validateHookMatchers 校验 matcher 只挂在合同真正会发出的事件上。
func validateHookMatchers(id string, definition Definition, matchers map[string]string) error {
	if err := validateHookMatcherEntries(definition.SessionSync.Events, matchers); err != nil {
		return fmt.Errorf("provider %s: %w", id, err)
	}
	return nil
}

// validateHookMatcherEntries 是 provider 无关的 matcher 校验。
func validateHookMatcherEntries(events []string, matchers map[string]string) error {
	for event, matcher := range matchers {
		event = strings.TrimSpace(event)
		if event == "" {
			return fmt.Errorf("hooks.eventMatchers 含空事件名")
		}
		if strings.TrimSpace(matcher) == "" {
			return fmt.Errorf("hooks.eventMatchers[%s] 的 matcher 为空", event)
		}
		if !containsString(events, event) {
			return fmt.Errorf("hooks.eventMatchers[%s] 对应的事件不在 sessionSync.events 里（永不触发）", event)
		}
	}
	return nil
}

// validateHookFormat 校验 SessionSync.Hook 自身的字段形状。
//
// 与 ValidateHookProfile 的分工：这里校验「合同里声明的数据」，所以不要求
// 字段齐全（缺数据是允许的），只拒绝写错的形状。
func validateHookFormat(format HookFormat, events []string) error {
	if err := validateHookTargetSegments(format.Target); err != nil {
		return err
	}
	if format.TimeoutUnit != "" && !format.TimeoutUnit.IsValid() {
		return fmt.Errorf("未知 hook.timeoutUnit %q", format.TimeoutUnit)
	}
	return validateHookMatcherEntries(events, format.EventMatchers)
}

// ValidateHookProfiles 校验整份合同推导出的 Hook 档案是否全部自洽。
//
// 供生成器与测试做整体守卫：任何一个 Provider 的档案与合同矛盾都要在构建期失败，
// 而不是等运行时写坏一个原生配置文件。
func ValidateHookProfiles(manifest Manifest) error {
	for index, definition := range manifest.Providers {
		if err := ValidateHookProfile(definition, DeriveHookProfile(definition)); err != nil {
			return fmt.Errorf("provider[%d]: %w", index, err)
		}
	}
	return nil
}

// IsValid 报告适配器是否已登记。
func (adapter HookAdapterID) IsValid() bool {
	switch adapter {
	case HookAdapterJSONHooks, HookAdapterAgyNamedHooks, HookAdapterOpenCodePlugin:
		return true
	default:
		return false
	}
}

// IsValid 报告超时单位是否已登记。
func (unit HookTimeoutUnit) IsValid() bool {
	switch unit {
	case HookTimeoutSeconds, HookTimeoutMilliseconds:
		return true
	default:
		return false
	}
}

// containsString 判断列表里是否有完全相等的取值。
func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
