package providers

import "testing"

func TestBuiltinManifestIsValid(t *testing.T) {
	// 内置合同必须在生成任何跨语言文件前通过完整校验。
	manifest := BuiltinManifest()
	if err := ValidateManifest(manifest); err != nil {
		t.Fatalf("内置 Provider 合同无效: %v", err)
	}
	if got, want := len(manifest.Providers), 15; got != want {
		t.Fatalf("Provider 数量错误: got=%d want=%d", got, want)
	}
}

func TestBuiltinManifestDeclaresSitesAndFamilies(t *testing.T) {
	// 单站 Provider 由 withDefaultSite 补齐 (Family=ID, Site=global)；
	// 双站点产品线的两个 Provider 必须共享同一个 family、站点不同。
	manifest := BuiltinManifest()
	byID := make(map[string]Definition, len(manifest.Providers))
	for _, definition := range manifest.Providers {
		byID[definition.ID] = definition
	}

	for _, id := range []string{"codex", "gemini", "claude", "agy", "opencode", "grok", "kimi", "kiro", "zcode"} {
		definition, ok := byID[id]
		if !ok {
			t.Fatalf("缺少 Provider %s", id)
		}
		if definition.Family != id || definition.Site != SiteGlobal {
			t.Fatalf("单站 Provider %s 应默认 (family=%s, site=global)，实际 (%s, %s)",
				id, id, definition.Family, definition.Site)
		}
	}

	for family, members := range map[string][2]string{
		"qoder":     {"qoder", "qodercn"},
		"codebuddy": {"codebuddy", "codebuddycn"},
		"workbuddy": {"workbuddy", "workbuddycn"},
	} {
		global, cn := byID[members[0]], byID[members[1]]
		if global.Family != family || cn.Family != family {
			t.Fatalf("产品族 %s 的两个 Provider 必须共享 family，实际 (%s, %s)",
				family, global.Family, cn.Family)
		}
		if global.Site != SiteGlobal || cn.Site != SiteCN {
			t.Fatalf("产品族 %s 必须无后缀=国际站、cn 后缀=国内站，实际 (%s, %s)",
				family, global.Site, cn.Site)
		}
	}
}

func TestValidateManifestRejectsDuplicateFamilySite(t *testing.T) {
	// 同一产品在同一站点只能有一个 Provider，否则 Client 按族聚合会出现重复入口。
	manifest := BuiltinManifest()
	duplicate := manifest.Providers[0]
	duplicate.ID = "codex-copy"
	duplicate.Presentation.ID = "codex-copy"
	manifest.Providers = append(manifest.Providers, duplicate)
	if err := ValidateManifest(manifest); err == nil {
		t.Fatal("重复的 family+site 组合应被拒绝")
	}
}

func TestCatalogQueriesCapabilitiesAndLifecycle(t *testing.T) {
	// 注册表只回答身份和能力，不执行任何 Provider 特有行为。
	catalog, err := NewCatalog(BuiltinManifest())
	if err != nil {
		t.Fatalf("构建 Provider 注册表失败: %v", err)
	}
	if !catalog.Supports(" CODEX ", CapabilityQuotaUsage) {
		t.Fatal("Codex 应声明统一额度能力")
	}
	if !catalog.Supports("kimi", CapabilityModelCatalog) {
		t.Fatal("Kimi 应声明统一模型目录能力")
	}
	gemini, ok := catalog.Get("gemini")
	if !ok || gemini.Gateway != GatewayDeprecated {
		t.Fatal("Gemini 必须保留显式使用但退出自动网关")
	}
}

func TestCatalogContainsChecksIdentityWithoutReturningDefinition(t *testing.T) {
	// 只验证身份时不能复制完整 Provider 定义，账号批量注册依赖该轻量查询。
	catalog, err := NewCatalog(BuiltinManifest())
	if err != nil {
		t.Fatalf("构建 Provider 注册表失败: %v", err)
	}
	if !catalog.Contains(" CODEX ") {
		t.Fatal("Contains() 应按规范化 Provider ID 查询")
	}
	canonicalID, found := catalog.CanonicalID(" CODEX ")
	if !found || canonicalID != "codex" {
		t.Fatalf("CanonicalID() = (%q, %t), want (codex, true)", canonicalID, found)
	}
	if catalog.Contains("future") {
		t.Fatal("Contains() 不应接受未注册 Provider")
	}
	var nilCatalog *Catalog
	if nilCatalog.Contains("codex") {
		t.Fatal("nil Catalog 不应包含任何 Provider")
	}
	if canonicalID, found := nilCatalog.CanonicalID("codex"); found || canonicalID != "" {
		t.Fatalf("nil CanonicalID() = (%q, %t), want empty/false", canonicalID, found)
	}
}

func TestCatalogReturnsDefensiveCopies(t *testing.T) {
	// 调用方修改返回值不能污染注册表中的定义。
	catalog, err := NewCatalog(BuiltinManifest())
	if err != nil {
		t.Fatalf("构建 Provider 注册表失败: %v", err)
	}
	first, ok := catalog.Get("codex")
	if !ok {
		t.Fatal("缺少 Codex Provider")
	}
	first.CLI.EnvKeys[0] = "MUTATED"
	first.AuthOptions[0].Label = "MUTATED"

	second, ok := catalog.Get("codex")
	if !ok {
		t.Fatal("缺少 Codex Provider")
	}
	if second.CLI.EnvKeys[0] == "MUTATED" || second.AuthOptions[0].Label == "MUTATED" {
		t.Fatal("Provider 注册表泄漏了可变内部状态")
	}
}

func TestValidateManifestRejectsDuplicateProvider(t *testing.T) {
	// 重复 ID 必须在生成期失败，不能由后加载项静默覆盖前一项。
	manifest := BuiltinManifest()
	manifest.Providers = append(manifest.Providers, manifest.Providers[0])
	if err := ValidateManifest(manifest); err == nil {
		t.Fatal("重复 Provider ID 应被拒绝")
	}
}

func TestValidateManifestRejectsInvalidSessionSync(t *testing.T) {
	// polling Provider 不能误带 Hook 事件，否则 Client 会展示不存在的实时能力。
	manifest := BuiltinManifest()
	manifest.Providers[6].SessionSync.Events = []string{"Stop"}
	if err := ValidateManifest(manifest); err == nil {
		t.Fatal("矛盾的会话同步声明应被拒绝")
	}
}
