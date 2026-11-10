package providers

import (
	"strings"
	"testing"
)

// builtinDefinition 按 ID 取出内置 Provider 定义，取不到直接失败。
func builtinDefinition(t *testing.T, id string) Definition {
	t.Helper()
	for _, definition := range BuiltinManifest().Providers {
		if definition.ID == id {
			return definition
		}
	}
	t.Fatalf("内置合同缺少 provider: %s", id)
	return Definition{}
}

// hookProviderIDs 是合同里声明 sessionSync.mode=hook 的 Provider。
//
// 名单从合同自身派生（不写死），新增 hook Provider 时这组守卫自动覆盖。
func hookProviderIDs(t *testing.T) []string {
	t.Helper()
	ids := []string{}
	for _, definition := range BuiltinManifest().Providers {
		if definition.SessionSync.Mode == SessionSyncHook {
			ids = append(ids, definition.ID)
		}
	}
	if len(ids) == 0 {
		t.Fatal("内置合同里没有任何 hook provider")
	}
	return ids
}

// boolPointer 返回 bool 的地址，用于 FeatureFlag 的三态（nil = 未声明）。
func boolPointer(value bool) *bool {
	return &value
}

// validCodexHookProfile 是一份**完整**的 codex 档案。
//
// 它现在只用于证明校验器能接受齐全数据：内置合同里这些字段没有真值源，
// 所以 DeriveHookProfile 不会产出它们（见下一个测试）。
func validCodexHookProfile() HookProfile {
	return HookProfile{
		Supported:     true,
		Adapter:       HookAdapterJSONHooks,
		Target:        []string{".codex", "hooks.json"},
		TimeoutUnit:   HookTimeoutSeconds,
		EventMatchers: map[string]string{"SessionStart": "startup|resume|clear|compact"},
		FeatureFlag:   boolPointer(true),
	}
}

// TestDeriveHookProfileMatchesSessionSync 锁住「档案只复述合同」这条不变量：
// supported 由 mode 决定，adapter 逐字来自合同，方向相反的两个答案不允许并存。
func TestDeriveHookProfileMatchesSessionSync(t *testing.T) {
	for _, definition := range BuiltinManifest().Providers {
		profile := DeriveHookProfile(definition)
		if definition.SessionSync.Mode == SessionSyncHook {
			if !profile.Supported {
				t.Fatalf("%s: mode=hook 时档案必须 supported", definition.ID)
			}
			if string(profile.Adapter) != definition.SessionSync.Adapter {
				t.Fatalf("%s: adapter=%q 应等于 sessionSync.adapter=%q",
					definition.ID, profile.Adapter, definition.SessionSync.Adapter)
			}
			if profile.Reason != "" {
				t.Fatalf("%s: supported 时不应带 reason: %q", definition.ID, profile.Reason)
			}
			continue
		}
		if profile.Supported {
			t.Fatalf("%s: mode=%s 时档案不能 supported", definition.ID, definition.SessionSync.Mode)
		}
		if strings.TrimSpace(profile.Reason) == "" {
			t.Fatalf("%s: 不支持时必须给出 reason", definition.ID)
		}
		if profile.Adapter != "" {
			t.Fatalf("%s: 不支持时不能带 adapter: %q", definition.ID, profile.Adapter)
		}
	}
}

// TestDeriveHookProfileLeavesUndeclaredDataEmpty 记录「数据缺失」这一事实。
//
// target / timeoutUnit / eventMatchers / featureFlag 在 Go 内置数据里没有真值源，
// 推导必须留空。用 CLI.GlobalDir + TargetKind 硬拼 target 只在 codex/gemini/claude
// 上凑巧成立（agy 少一层 config/、grok 是 hooks/aih-session-sync.json、opencode 为空），
// 那属于猜测而不是读取，因此这里把「留空」变成守卫：谁开始猜，这个测试就红。
func TestDeriveHookProfileLeavesUndeclaredDataEmpty(t *testing.T) {
	for _, id := range hookProviderIDs(t) {
		profile := DeriveHookProfile(builtinDefinition(t, id))
		if len(profile.Target) != 0 {
			t.Fatalf("%s: target 无真值源，必须留空，实际 %v", id, profile.Target)
		}
		if profile.TimeoutUnit != "" {
			t.Fatalf("%s: timeoutUnit 无真值源，必须留空，实际 %q", id, profile.TimeoutUnit)
		}
		if len(profile.EventMatchers) != 0 {
			t.Fatalf("%s: eventMatchers 无真值源，必须留空，实际 %v", id, profile.EventMatchers)
		}
		if profile.FeatureFlag != nil {
			t.Fatalf("%s: featureFlag 无真值源，必须留 nil（未声明），实际 %t", id, *profile.FeatureFlag)
		}
	}
}

// TestValidateHookProfilesBuiltinManifest 保证整份内置合同推导出的档案全部自洽。
func TestValidateHookProfilesBuiltinManifest(t *testing.T) {
	if err := ValidateHookProfiles(BuiltinManifest()); err != nil {
		t.Fatalf("内置合同的 hook 档案不自洽: %v", err)
	}
}

// TestValidateHookProfileAcceptsCompleteProfile 证明校验器已经能承接齐全的档案数据。
func TestValidateHookProfileAcceptsCompleteProfile(t *testing.T) {
	definition := builtinDefinition(t, "codex")
	if err := ValidateHookProfile(definition, validCodexHookProfile()); err != nil {
		t.Fatalf("完整 codex 档案应通过校验: %v", err)
	}
}

// TestValidateHookProfileRejects 覆盖每一类拒绝理由。
func TestValidateHookProfileRejects(t *testing.T) {
	codex := builtinDefinition(t, "codex")
	kimi := builtinDefinition(t, "kimi")

	cases := []struct {
		name     string
		provider Definition
		profile  HookProfile
		want     string
	}{
		{
			name:     "合同是 hook 但档案说没有",
			provider: codex,
			profile:  HookProfile{Supported: false, Reason: "没有 hook"},
			want:     "矛盾",
		},
		{
			name:     "合同不是 hook 但档案说有",
			provider: kimi,
			profile:  HookProfile{Supported: true, Adapter: HookAdapterJSONHooks},
			want:     "矛盾",
		},
		{
			name:     "不支持却缺 reason",
			provider: kimi,
			profile:  HookProfile{Supported: false},
			want:     "必须写明 reason",
		},
		{
			name:     "不支持却声明 adapter",
			provider: kimi,
			profile:  HookProfile{Supported: false, Reason: "未接入", Adapter: HookAdapterJSONHooks},
			want:     "不能声明 adapter",
		},
		{
			name:     "不支持却声明 target",
			provider: kimi,
			profile:  HookProfile{Supported: false, Reason: "未接入", Target: []string{".kimi-code"}},
			want:     "不能声明 target",
		},
		{
			name:     "不支持却声明 timeoutUnit",
			provider: kimi,
			profile:  HookProfile{Supported: false, Reason: "未接入", TimeoutUnit: HookTimeoutSeconds},
			want:     "不能声明 timeoutUnit",
		},
		{
			name:     "不支持却声明 eventMatchers",
			provider: kimi,
			profile:  HookProfile{Supported: false, Reason: "未接入", EventMatchers: map[string]string{"Stop": ".*"}},
			want:     "不能声明 eventMatchers",
		},
		{
			name:     "不支持却声明 featureFlag",
			provider: kimi,
			profile:  HookProfile{Supported: false, Reason: "未接入", FeatureFlag: boolPointer(false)},
			want:     "不能声明 featureFlag",
		},
		{
			name:     "缺 adapter",
			provider: codex,
			profile:  HookProfile{Supported: true},
			want:     "adapter 不能为空",
		},
		{
			name:     "未登记的 adapter",
			provider: codex,
			profile:  HookProfile{Supported: true, Adapter: "shell_hooks"},
			want:     "未知 hooks.adapter",
		},
		{
			name:     "adapter 与合同不一致",
			provider: codex,
			profile:  HookProfile{Supported: true, Adapter: HookAdapterOpenCodePlugin},
			want:     "不一致",
		},
		{
			name:     "target 段含分隔符",
			provider: codex,
			profile:  HookProfile{Supported: true, Adapter: HookAdapterJSONHooks, Target: []string{".codex/hooks.json"}},
			want:     "单个路径段",
		},
		{
			name:     "target 含上跳段",
			provider: codex,
			profile:  HookProfile{Supported: true, Adapter: HookAdapterJSONHooks, Target: []string{"..", "hooks.json"}},
			want:     "不能是",
		},
		{
			name:     "target 含空段",
			provider: codex,
			profile:  HookProfile{Supported: true, Adapter: HookAdapterJSONHooks, Target: []string{".codex", " "}},
			want:     "为空路径段",
		},
		{
			name:     "未登记的 timeoutUnit",
			provider: codex,
			profile:  HookProfile{Supported: true, Adapter: HookAdapterJSONHooks, TimeoutUnit: "nanoseconds"},
			want:     "未知 hooks.timeoutUnit",
		},
		{
			name:     "matcher 挂在不存在的事件上",
			provider: codex,
			profile: HookProfile{
				Supported:     true,
				Adapter:       HookAdapterJSONHooks,
				EventMatchers: map[string]string{"PreInvocation": "always"},
			},
			want: "不在 sessionSync.events",
		},
		{
			name:     "matcher 为空",
			provider: codex,
			profile: HookProfile{
				Supported:     true,
				Adapter:       HookAdapterJSONHooks,
				EventMatchers: map[string]string{"SessionStart": "  "},
			},
			want: "matcher 为空",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := ValidateHookProfile(testCase.provider, testCase.profile)
			if err == nil {
				t.Fatalf("应拒绝但通过了: %+v", testCase.profile)
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("错误信息应包含 %q，实际: %v", testCase.want, err)
			}
		})
	}
}

// TestValidateHookProfileRequiresProviderID 防止空 id 混进错误信息里无法定位。
func TestValidateHookProfileRequiresProviderID(t *testing.T) {
	if err := ValidateHookProfile(Definition{}, validCodexHookProfile()); err == nil {
		t.Fatal("缺少 provider id 时应失败")
	}
}

// TestHookAdapterAndTimeoutUnitValidation 锁住两张枚举表：拼错立即拒绝，
// 新增取值必须先登记（与 Node 描述符的白名单同一语义）。
func TestHookAdapterAndTimeoutUnitValidation(t *testing.T) {
	for _, adapter := range []HookAdapterID{HookAdapterJSONHooks, HookAdapterAgyNamedHooks, HookAdapterOpenCodePlugin} {
		if !adapter.IsValid() {
			t.Fatalf("已登记 adapter 被判非法: %s", adapter)
		}
	}
	for _, adapter := range []HookAdapterID{"", "JSON_HOOKS", "json-hooks"} {
		if adapter.IsValid() {
			t.Fatalf("未登记 adapter 被判合法: %q", adapter)
		}
	}
	for _, unit := range []HookTimeoutUnit{HookTimeoutSeconds, HookTimeoutMilliseconds} {
		if !unit.IsValid() {
			t.Fatalf("已登记 timeoutUnit 被判非法: %s", unit)
		}
	}
	for _, unit := range []HookTimeoutUnit{"", "sec", "MS"} {
		if unit.IsValid() {
			t.Fatalf("未登记 timeoutUnit 被判合法: %q", unit)
		}
	}
}
