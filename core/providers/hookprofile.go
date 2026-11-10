package providers

import (
	"errors"
	"fmt"
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

// HookProfile 是 Hook 档案的声明式数据：目标路径段、超时单位、事件 matcher、
// 目标文件旁的特性开关，以及「有没有 Hook」的回答。
//
// 设计约束（与 Node 描述符 hooks 能力对齐）：
//   - 一个 Provider 要么 supported=true 并给出 adapter，要么 supported=false 并写明 Reason；
//     沉默缺席会让调用方只能靠猜，这正是本能力位要消灭的形态。
//   - Target 是**相对原生根的路径段**，不是整条路径：段里出现分隔符说明写错了形状。
//   - TimeoutUnit / EventMatchers / FeatureFlag 的零值表示**合同没有声明**，
//     不是「默认值」。给零值编一个默认值等于伪造上游事实（codex 之外的 provider
//     确实没有 matcher，而 gemini 的单位是毫秒），所以宁可留空。
//
// 字段来源：adapter 来自 SessionSync（Go 合同是真值源）；其余档案字段目前
// Go 内置数据里没有，DeriveHookProfile 不会填它们——缺数据就留空并如实报告，
// 不从 Node 描述符反抄一遍变成第二份需要同步的名单。
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
// 只填两个字段：Supported（SessionSync.Mode 是否为 hook）与 Adapter（合同声明）。
// Target / TimeoutUnit / EventMatchers / FeatureFlag 在内置数据里没有真值源：
// CLI.GlobalDir 与 NativeHooks.Files 的基准不同（claude 的 "settings.json" 相对配置根，
// antigravity 的 ".gemini/config/hooks.json" 相对宿主 home），按它们拼 target 会得出
// 错误路径；因此这里留空，调用方必须把空值读成「未声明」而不是默认值。
func DeriveHookProfile(definition Definition) HookProfile {
	if definition.SessionSync.Mode != SessionSyncHook {
		return HookProfile{
			Supported: false,
			Reason:    hookUnsupportedReason(definition.SessionSync.Mode),
		}
	}
	return HookProfile{
		Supported: true,
		Adapter:   HookAdapterID(strings.TrimSpace(definition.SessionSync.Adapter)),
	}
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
//   - Supported=true 必须有合法 adapter；
//   - Target 的每一段都必须是一个正常路径段（非空、非 . / ..、不含分隔符、非绝对路径），
//     否则适配器拼接出的路径会落到预期之外的位置；
//   - TimeoutUnit 非空时必须已在单位表登记：拼错会让超时被当成另一种量级；
//   - EventMatchers 的事件名必须是合同 Events 里真正会发出的事件，matcher 不能为空；
//     给一个永不发出的挂 matcher 等于静默死配置。
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
	if profile.TimeoutUnit != "" && !profile.TimeoutUnit.IsValid() {
		return fmt.Errorf("provider %s: 未知 hooks.timeoutUnit %q", id, profile.TimeoutUnit)
	}
	return validateHookMatchers(id, definition, profile.EventMatchers)
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
	for index, segment := range target {
		trimmed := strings.TrimSpace(segment)
		if trimmed == "" {
			return fmt.Errorf("provider %s: hooks.target[%d] 为空路径段", id, index)
		}
		if trimmed != segment {
			return fmt.Errorf("provider %s: hooks.target[%d] 含首尾空白: %q", id, index, segment)
		}
		if trimmed == "." || trimmed == ".." {
			return fmt.Errorf("provider %s: hooks.target[%d] 不能是 %q", id, index, trimmed)
		}
		if strings.ContainsAny(trimmed, "/\\") {
			return fmt.Errorf("provider %s: hooks.target[%d]=%q 必须是单个路径段，不能含分隔符",
				id, index, trimmed)
		}
	}
	return nil
}

// validateHookMatchers 校验 matcher 只挂在合同真正会发出的事件上。
func validateHookMatchers(id string, definition Definition, matchers map[string]string) error {
	for event, matcher := range matchers {
		event = strings.TrimSpace(event)
		if event == "" {
			return fmt.Errorf("provider %s: hooks.eventMatchers 含空事件名", id)
		}
		if strings.TrimSpace(matcher) == "" {
			return fmt.Errorf("provider %s: hooks.eventMatchers[%s] 的 matcher 为空", id, event)
		}
		if !containsString(definition.SessionSync.Events, event) {
			return fmt.Errorf("provider %s: hooks.eventMatchers[%s] 对应的事件不在 sessionSync.events 里（永不触发）",
				id, event)
		}
	}
	return nil
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
