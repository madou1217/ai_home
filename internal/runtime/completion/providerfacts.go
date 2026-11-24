package completion

import (
	"sort"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
)

// providerSnapshot 是 core/providers 合同的只读投影。事实只有一份：
// 候选面、拼写建议与动作过滤都从这里取，禁止再抄 Provider 名单。
type providerSnapshot struct {
	definitions   []providers.Definition
	cliProviders  []providers.Definition
	byID          map[string]providers.Definition
	families      map[string][]providers.Definition
	fallbackLabel string
}

var loadProviderSnapshot = sync.OnceValue(func() providerSnapshot {
	manifest := providers.BuiltinManifest()
	snapshot := providerSnapshot{
		byID:          make(map[string]providers.Definition, len(manifest.Providers)),
		families:      make(map[string][]providers.Definition),
		fallbackLabel: strings.TrimSpace(manifest.Fallback.Label),
	}
	if snapshot.fallbackLabel == "" {
		snapshot.fallbackLabel = "AI"
	}
	catalog, err := providers.NewCatalog(manifest)
	if err != nil || catalog == nil {
		return snapshot
	}
	snapshot.definitions = catalog.List()
	for _, definition := range snapshot.definitions {
		snapshot.byID[definition.ID] = definition
		snapshot.families[definition.Family] = append(snapshot.families[definition.Family], definition)
		if definition.CLI != nil && definition.Clients.CLI {
			snapshot.cliProviders = append(snapshot.cliProviders, definition)
		}
	}
	sort.SliceStable(snapshot.cliProviders, func(left, right int) bool {
		return snapshot.cliProviders[left].CLI.Order < snapshot.cliProviders[right].CLI.Order
	})
	return snapshot
})

func normalizeProviderID(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// providerDefinition 返回完整 Provider 定义副本。
func providerDefinition(id string) (providers.Definition, bool) {
	definition, found := loadProviderSnapshot().byID[normalizeProviderID(id)]
	return definition, found
}

// knownProvider 判断字符串是否为已注册 Provider（含没有原生 CLI 的 Provider）。
func knownProvider(id string) bool {
	_, found := providerDefinition(id)
	return found
}

// providerNames 返回面向用户的原生 CLI Provider，按合同 CLI order 排序。
func providerNames() []string {
	snapshot := loadProviderSnapshot()
	names := make([]string, 0, len(snapshot.cliProviders))
	for _, definition := range snapshot.cliProviders {
		names = append(names, definition.ID)
	}
	return names
}

func isProviderName(token string) bool {
	normalized := normalizeProviderID(token)
	if normalized == "" {
		return false
	}
	_, found := providerDefinition(normalized)
	if !found {
		return false
	}
	definition := loadProviderSnapshot().byID[normalized]
	return definition.CLI != nil && definition.Clients.CLI
}

func providerSiteLabel(site providers.Site) string {
	switch site {
	case providers.SiteGlobal:
		return "国际站"
	case providers.SiteCN:
		return "国内站"
	default:
		return ""
	}
}

// providerMenuLabel 对齐 Node provider-catalog.getProviderMenuLabel：
// 多站点产品必须带站点，单站产品直接用展示名。
func providerMenuLabel(id string) string {
	snapshot := loadProviderSnapshot()
	definition, found := snapshot.byID[normalizeProviderID(id)]
	if !found {
		return snapshot.fallbackLabel
	}
	members := snapshot.families[definition.Family]
	if len(members) <= 1 {
		return definition.Presentation.Label
	}
	named := members[0]
	for _, member := range members {
		if member.Site == providers.SiteGlobal {
			named = member
			break
		}
	}
	label := strings.TrimSpace(named.Presentation.Label)
	site := providerSiteLabel(definition.Site)
	if site == "" {
		return label
	}
	return label + " · " + site
}

// providerLabelOrID 对齐 Node candidates.providerLabel：展示名优先，未知回落 ID。
func providerLabelOrID(id string) string {
	if label := strings.TrimSpace(providerMenuLabel(id)); label != "" {
		return label
	}
	return id
}

// supportsAihServerProfile 报告 Provider 是否声明了网关档（gateway_profile）。
func supportsAihServerProfile(id string) bool {
	definition, found := providerDefinition(id)
	if !found {
		return false
	}
	for _, capability := range definition.Capabilities {
		if capability == providers.CapabilityGatewayProfile {
			return true
		}
	}
	return false
}

// providerSupportsGatewayRelay 对齐 aihcli.supportedGatewayCLIProvider：
// 只有 Codex / Claude / CodeBuddy 家族能由 Go 规划网关启动。
func providerSupportsGatewayRelay(id string) bool {
	normalized := normalizeProviderID(id)
	if normalized == "codex" || normalized == "claude" {
		return true
	}
	return providers.IsCodeBuddyFamilyProvider(normalized)
}

// providerSupportsCLILogin 判断 Provider 是否有可用的登录入口：
// 家族走 aihlogin，agy 走 clilogin；其余按合同的 loginArgs 声明。
// 空 loginArgs 不等于没有 AIH 登录（F10），不能只看这一个字段。
func providerSupportsCLILogin(id string) bool {
	normalized := normalizeProviderID(id)
	if providers.IsCodeBuddyFamilyProvider(normalized) || normalized == "agy" {
		return true
	}
	return len(providerLoginArgs(normalized)) > 0
}

func providerLoginArgs(id string) []string {
	definition, found := providerDefinition(id)
	if !found || definition.CLI == nil {
		return nil
	}
	return definition.CLI.LoginArgs
}

func providerSessionCommand(id, verb string) *providers.NativeSessionCommand {
	definition, found := providerDefinition(id)
	if !found || definition.NativeBoundary == nil {
		return nil
	}
	if verb == "fork" {
		return definition.NativeBoundary.Sessions.Fork
	}
	return definition.NativeBoundary.Sessions.Resume
}

func providerSupportsHostDefault(id string) bool {
	definition, found := providerDefinition(id)
	if !found {
		return false
	}
	if definition.CLI != nil && definition.CLI.DesktopClient != nil {
		return true
	}
	return supportsAihServerProfile(id)
}
