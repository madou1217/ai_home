package providers

import (
	"maps"
	"slices"
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
// 它用于证明校验器能接受齐全数据；四项都与内置合同逐字一致。
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

// hookTargetSource 从内置合同的既有事实重建预期 target：
// cli.globalDir（宿主 home 相对）加 nativeBoundary.hooks.files 的第一个文件；
// 文件本身已带 globalDir 前缀时（grok / agy）只保留一次。
func hookTargetSource(t *testing.T, definition Definition) []string {
	t.Helper()
	if definition.CLI == nil {
		t.Fatalf("%s: 缺少 cli 配置，无法定位 hook 路径", definition.ID)
	}
	globalDir := strings.Trim(strings.TrimSpace(definition.CLI.GlobalDir), "/")
	if globalDir == "" {
		t.Fatalf("%s: cli.globalDir 为空，无法定位 hook 路径", definition.ID)
	}
	base := strings.Split(globalDir, "/")
	if definition.NativeBoundary == nil || len(definition.NativeBoundary.Hooks.Files) == 0 {
		t.Fatalf("%s: 缺少 nativeBoundary.hooks.files，无法定位 hook 文件", definition.ID)
	}
	file := strings.Trim(strings.TrimSpace(definition.NativeBoundary.Hooks.Files[0]), "/")
	parts := strings.Split(file, "/")
	if len(parts) >= len(base) && slices.Equal(parts[:len(base)], base) {
		parts = parts[len(base):]
	}
	return append(append([]string{}, base...), parts...)
}

// TestDeriveHookProfilePopulatesTargets 锁定 target 的出处：
// 只允许由 cli.globalDir + nativeBoundary.hooks.files 组合而成，
// 且必须真的落到合同声明的某个 hook 文件上。
func TestDeriveHookProfilePopulatesTargets(t *testing.T) {
	for _, id := range hookProviderIDs(t) {
		definition := builtinDefinition(t, id)
		profile := DeriveHookProfile(definition)
		if definition.SessionSync.Hook == nil {
			t.Fatalf("%s: 缺少 sessionSync.hook 声明", id)
		}
		if len(profile.Target) == 0 {
			t.Fatalf("%s: 已有 hook 文件事实，target 不能为空", id)
		}
		if !slices.Equal(profile.Target, definition.SessionSync.Hook.Target) {
			t.Fatalf("%s: profile.target=%v 应逐字复制 sessionSync.hook.target=%v",
				id, profile.Target, definition.SessionSync.Hook.Target)
		}
		want := hookTargetSource(t, definition)
		if !slices.Equal(profile.Target, want) {
			t.Fatalf("%s: target=%v 与既有事实组合结果 %v 不一致", id, profile.Target, want)
		}
		joined := strings.Join(profile.Target, "/")
		matched := false
		for _, file := range definition.NativeBoundary.Hooks.Files {
			if strings.HasSuffix(joined, strings.Trim(strings.TrimSpace(file), "/")) {
				matched = true
				break
			}
		}
		if !matched {
			t.Fatalf("%s: target=%v 没有落到 nativeBoundary.hooks.files=%v 上",
				id, profile.Target, definition.NativeBoundary.Hooks.Files)
		}
	}
}

// hookFormatFacts 是 Node 描述符（lib/providers/defs + contract.js 归一规则）
// 转录来的黄金样本：
//   - gemini 显式 timeoutUnit='ms'，其余 provider 按合同默认值为 'seconds'；
//   - 只有 codex 声明 SessionStart matcher 与 featureFlag=true；
//   - 其余 provider 的 featureFlag 归一为 false（Node 注释：只有 codex 要在
//     config.toml 打开开关），false 是声明值，不是「未声明」。
var hookFormatFacts = map[string]struct {
	timeoutUnit HookTimeoutUnit
	matchers    map[string]string
	featureFlag bool
}{
	"codex":    {HookTimeoutSeconds, map[string]string{"SessionStart": "startup|resume|clear|compact"}, true},
	"gemini":   {HookTimeoutMilliseconds, nil, false},
	"claude":   {HookTimeoutSeconds, nil, false},
	"agy":      {HookTimeoutSeconds, nil, false},
	"opencode": {HookTimeoutSeconds, nil, false},
	"grok":     {HookTimeoutSeconds, nil, false},
}

// TestDeriveHookProfileTranscribesFormatFacts 锁定转录值：推导只能原样复制合同，
// 任何一项漂移都必须在构建期暴露。
func TestDeriveHookProfileTranscribesFormatFacts(t *testing.T) {
	ids := hookProviderIDs(t)
	for _, id := range ids {
		want, exists := hookFormatFacts[id]
		if !exists {
			t.Fatalf("%s: 缺少 Node 描述符事实样本", id)
		}
		profile := DeriveHookProfile(builtinDefinition(t, id))
		if profile.TimeoutUnit != want.timeoutUnit {
			t.Fatalf("%s: timeoutUnit=%q, want %q", id, profile.TimeoutUnit, want.timeoutUnit)
		}
		if len(profile.EventMatchers) != len(want.matchers) || !maps.Equal(profile.EventMatchers, want.matchers) {
			t.Fatalf("%s: eventMatchers=%v, want %v", id, profile.EventMatchers, want.matchers)
		}
		if profile.FeatureFlag == nil {
			t.Fatalf("%s: featureFlag 必须是声明值（false 也是事实），实际 nil", id)
		}
		if *profile.FeatureFlag != want.featureFlag {
			t.Fatalf("%s: featureFlag=%t, want %t", id, *profile.FeatureFlag, want.featureFlag)
		}
	}
	for id := range hookFormatFacts {
		if !slices.Contains(ids, id) {
			t.Fatalf("%s: 样本表含非 hook provider", id)
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
			name:     "timeoutUnit 与合同不一致",
			provider: codex,
			profile:  HookProfile{Supported: true, Adapter: HookAdapterJSONHooks, TimeoutUnit: HookTimeoutMilliseconds},
			want:     "不一致",
		},
		{
			name:     "matcher 与合同不一致",
			provider: codex,
			profile: HookProfile{
				Supported:     true,
				Adapter:       HookAdapterJSONHooks,
				EventMatchers: map[string]string{"SessionStart": "startup"},
			},
			want: "不一致",
		},
		{
			name:     "featureFlag 与合同不一致",
			provider: codex,
			profile:  HookProfile{Supported: true, Adapter: HookAdapterJSONHooks, FeatureFlag: boolPointer(false)},
			want:     "不一致",
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

// mutateBuiltinProvider 在 manifest 副本上修改指定 Provider，避免测试间共享状态。
func mutateBuiltinProvider(t *testing.T, manifest *Manifest, id string, mutate func(*Definition)) {
	t.Helper()
	for index := range manifest.Providers {
		if manifest.Providers[index].ID == id {
			mutate(&manifest.Providers[index])
			return
		}
	}
	t.Fatalf("内置合同缺少 provider: %s", id)
}

// TestValidateManifestRejectsInvalidHookFormat 覆盖 SessionSync.Hook 的每一类拒绝理由。
func TestValidateManifestRejectsInvalidHookFormat(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		mutate   func(*Definition)
		want     string
	}{
		{
			name:     "非 hook Provider 声明 hook 格式",
			provider: "kimi",
			mutate: func(definition *Definition) {
				definition.SessionSync.Hook = &HookFormat{Target: []string{".kimi", "hooks.json"}}
			},
			want: "非 hook 同步不能声明 hook 格式",
		},
		{
			name:     "target 段含分隔符",
			provider: "codex",
			mutate: func(definition *Definition) {
				definition.SessionSync.Hook = &HookFormat{Target: []string{".codex/hooks.json"}}
			},
			want: "单个路径段",
		},
		{
			name:     "target 含上跳段",
			provider: "codex",
			mutate: func(definition *Definition) {
				definition.SessionSync.Hook = &HookFormat{Target: []string{"..", "hooks.json"}}
			},
			want: "不能是",
		},
		{
			name:     "target 含空段",
			provider: "codex",
			mutate: func(definition *Definition) {
				definition.SessionSync.Hook = &HookFormat{Target: []string{".codex", " "}}
			},
			want: "为空路径段",
		},
		{
			name:     "未登记的 timeoutUnit",
			provider: "codex",
			mutate: func(definition *Definition) {
				definition.SessionSync.Hook.TimeoutUnit = "nanoseconds"
			},
			want: "未知 hook.timeoutUnit",
		},
		{
			name:     "matcher 挂在不存在的事件上",
			provider: "codex",
			mutate: func(definition *Definition) {
				definition.SessionSync.Hook.EventMatchers = map[string]string{"PreInvocation": "always"}
			},
			want: "不在 sessionSync.events",
		},
		{
			name:     "matcher 为空",
			provider: "codex",
			mutate: func(definition *Definition) {
				definition.SessionSync.Hook.EventMatchers = map[string]string{"SessionStart": "  "}
			},
			want: "matcher 为空",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			manifest := BuiltinManifest()
			mutateBuiltinProvider(t, &manifest, testCase.provider, testCase.mutate)
			err := ValidateManifest(manifest)
			if err == nil {
				t.Fatal("应拒绝但通过了")
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("错误信息应包含 %q，实际: %v", testCase.want, err)
			}
		})
	}
}

// TestValidateManifestAcceptsDeclaredHookFormatFields 证明合同一旦有真值，
// timeoutUnit / eventMatchers / featureFlag 会被校验并通过推导原样进入档案。
func TestValidateManifestAcceptsDeclaredHookFormatFields(t *testing.T) {
	manifest := BuiltinManifest()
	mutateBuiltinProvider(t, &manifest, "codex", func(definition *Definition) {
		definition.SessionSync.Hook.TimeoutUnit = HookTimeoutSeconds
		definition.SessionSync.Hook.EventMatchers = map[string]string{
			"SessionStart": "startup|resume|clear|compact",
		}
		definition.SessionSync.Hook.FeatureFlag = boolPointer(true)
	})
	if err := ValidateManifest(manifest); err != nil {
		t.Fatalf("声明齐全的 hook 格式应通过校验: %v", err)
	}
	var codex Definition
	for _, definition := range manifest.Providers {
		if definition.ID == "codex" {
			codex = definition
			break
		}
	}
	profile := DeriveHookProfile(codex)
	if profile.TimeoutUnit != HookTimeoutSeconds {
		t.Fatalf("timeoutUnit = %q, want %q", profile.TimeoutUnit, HookTimeoutSeconds)
	}
	if profile.EventMatchers["SessionStart"] != "startup|resume|clear|compact" {
		t.Fatalf("eventMatchers = %v", profile.EventMatchers)
	}
	if profile.FeatureFlag == nil || !*profile.FeatureFlag {
		t.Fatalf("featureFlag = %v, want true", profile.FeatureFlag)
	}
}

// TestCatalogClonesHookFormat 保证 Get 返回的 HookFormat 是深复制：
// 调用方改 target / matcher / featureFlag 不能污染合同缓存。
func TestCatalogClonesHookFormat(t *testing.T) {
	manifest := BuiltinManifest()
	mutateBuiltinProvider(t, &manifest, "codex", func(definition *Definition) {
		definition.SessionSync.Hook.TimeoutUnit = HookTimeoutSeconds
		definition.SessionSync.Hook.EventMatchers = map[string]string{"SessionStart": "startup"}
		definition.SessionSync.Hook.FeatureFlag = boolPointer(true)
	})
	catalog, err := NewCatalog(manifest)
	if err != nil {
		t.Fatalf("构建 Catalog 失败: %v", err)
	}
	first, ok := catalog.Get("codex")
	if !ok || first.SessionSync.Hook == nil {
		t.Fatal("缺少 codex hook 格式")
	}
	first.SessionSync.Hook.Target[0] = "mutated"
	first.SessionSync.Hook.EventMatchers["SessionStart"] = "mutated"
	*first.SessionSync.Hook.FeatureFlag = false

	second, ok := catalog.Get("codex")
	if !ok || second.SessionSync.Hook == nil {
		t.Fatal("缺少 codex hook 格式")
	}
	if second.SessionSync.Hook.Target[0] != ".codex" {
		t.Fatalf("target 被调用方污染: %v", second.SessionSync.Hook.Target)
	}
	if second.SessionSync.Hook.EventMatchers["SessionStart"] != "startup" {
		t.Fatalf("eventMatchers 被调用方污染: %v", second.SessionSync.Hook.EventMatchers)
	}
	if second.SessionSync.Hook.FeatureFlag == nil || !*second.SessionSync.Hook.FeatureFlag {
		t.Fatalf("featureFlag 被调用方污染: %v", second.SessionSync.Hook.FeatureFlag)
	}
}
