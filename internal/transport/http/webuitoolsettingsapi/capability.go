package webuitoolsettingsapi

import (
	"errors"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// capabilityView 是 /settings 的 capability 字段（camelCase，与 Node 响应逐字段一致）。
type capabilityView struct {
	MaxSupported          bool              `json:"maxSupported"`
	MaxArgs               []string          `json:"maxArgs"`
	MaxReason             string            `json:"maxReason"`
	PermissionCatalog     permissionCatalog `json:"permissionCatalog"`
	HostSupported         bool              `json:"hostSupported"`
	HostFileID            string            `json:"hostFileId"`
	HostDisplayPath       string            `json:"hostDisplayPath"`
	HostExists            bool              `json:"hostExists"`
	HostWritable          bool              `json:"hostWritable"`
	HostRequiresElevation bool              `json:"hostRequiresElevation"`
	HostReason            string            `json:"hostReason"`
}

// providerMenuLabel 与 Node getProviderMenuLabel 同义：多站点产品带站点，
// 单站产品直接用族名，避免出现「Codex · 国际站」这种零信息量后缀。
func providerMenuLabel(catalog ProviderCatalog, providerID string) string {
	definition, ok := catalog.Get(providerID)
	if !ok {
		return ""
	}
	members := familyMembers(catalog, definition)
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
	siteLabel := ""
	switch definition.Site {
	case providers.SiteGlobal:
		siteLabel = "国际站"
	case providers.SiteCN:
		siteLabel = "国内站"
	}
	if siteLabel == "" {
		return named.Presentation.Label
	}
	return named.Presentation.Label + " · " + siteLabel
}

func familyMembers(catalog ProviderCatalog, definition providers.Definition) []providers.Definition {
	lister, ok := catalog.(interface {
		List() []providers.Definition
	})
	if !ok {
		return []providers.Definition{definition}
	}
	members := make([]providers.Definition, 0, 2)
	for _, member := range lister.List() {
		if member.Family == definition.Family {
			members = append(members, member)
		}
	}
	if len(members) == 0 {
		return []providers.Definition{definition}
	}
	return members
}

// describeCapability 组装启动能力与宿主配置探测结果。
func describeCapability(
	definition providers.Definition,
	catalog ProviderCatalog,
	home string,
	lookupEnv func(string) string,
) capabilityView {
	maxArgs := providers.MaxPermissionArgs(definition)
	label := providerMenuLabel(catalog, definition.ID)
	view := capabilityView{
		MaxSupported:      len(maxArgs) > 0,
		MaxArgs:           maxArgs,
		PermissionCatalog: describePermissionCatalog(definition.ID),
	}
	if !view.MaxSupported {
		view.MaxReason = label + " 尚未声明免确认参数，启动时保持原生确认"
	}
	profile, hostKnown := hostPermissionProfiles[definition.ID]
	if !hostKnown {
		view.HostReason = "host_profile_unsupported"
		return view
	}
	target, err := describeHostTarget(definition, profile, home, lookupEnv)
	if err != nil {
		// 与 Node describeCapability 的 catch 分支同义：错误码能取到就用它，取不到
		// 统一 host_config_unavailable，界面据此显示「不可写」而不是猜一个路径。
		view.HostReason = "host_config_unavailable"
		var coded hostTargetError
		if errors.As(err, &coded) {
			view.HostReason = coded.code
		}
		return view
	}
	view.HostSupported = true
	view.HostFileID = target.FileID
	view.HostDisplayPath = target.DisplayPath
	view.HostExists = target.Exists
	view.HostWritable = target.Writable
	view.HostRequiresElevation = target.RequiresElevation
	return view
}

func normalizeProviderID(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// CapabilityViewFor 返回 /settings 的 capability 模型（写路径组装响应时复用同一份事实）。
func CapabilityViewFor(
	definition providers.Definition,
	catalog ProviderCatalog,
	home string,
	lookupEnv func(string) string,
) any {
	return describeCapability(definition, catalog, home, lookupEnv)
}

// ProviderLabel 返回与 Node getProviderMenuLabel 同义的应用名。
func ProviderLabel(catalog ProviderCatalog, providerID string) string {
	return providerMenuLabel(catalog, providerID)
}
