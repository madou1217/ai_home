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

// deriveMaxPermissionArgs 从合同 nativeBoundary.permissions 推导默认最大权限参数。
//
// 顺序即优先级，与 Node deriveMaxPermissionArgs 完全一致：
// claude 同时声明 --permission-mode 与 --dangerously-skip-permissions，必须优先返回
// 模式（更窄且可被上游识别）；kimi 的 --auto 才是不再询问，--yolo 仍会询问高风险操作。
func deriveMaxPermissionArgs(definition providers.Definition) []string {
	flags := []string{}
	modes := []string{}
	if definition.NativeBoundary != nil {
		flags = definition.NativeBoundary.Permissions.Flags
		modes = definition.NativeBoundary.Permissions.Modes
	}
	has := func(list []string, value string) bool {
		for _, item := range list {
			if item == value {
				return true
			}
		}
		return false
	}
	if has(modes, "danger-full-access") && has(flags, "--sandbox") {
		args := []string{"--sandbox", "danger-full-access"}
		if has(flags, "--ask-for-approval") {
			args = append(args, "--ask-for-approval", "never")
		}
		return args
	}
	if has(modes, "bypassPermissions") && has(flags, "--permission-mode") {
		return []string{"--permission-mode", "bypassPermissions"}
	}
	if has(modes, "bypass_permissions") && has(flags, "--permission-mode") {
		return []string{"--permission-mode", "bypass_permissions"}
	}
	if has(modes, "auto") && has(flags, "--auto") {
		return []string{"--auto"}
	}
	if has(modes, "yolo") && has(flags, "--yolo") {
		return []string{"--yolo"}
	}
	if has(modes, "yolo") && has(flags, "--approval-mode") {
		return []string{"--approval-mode", "yolo"}
	}
	if has(flags, "--dangerously-skip-permissions") {
		return []string{"--dangerously-skip-permissions"}
	}
	if has(flags, "--trust-all-tools") {
		return []string{"--trust-all-tools"}
	}
	return []string{}
}

// providerMenuLabel 与 Node getProviderMenuLabel 同义：多站点产品带站点，
// 单站产品直接用族名，避免出现「Codex · 国际站」这种零信息量后缀。
func providerMenuLabel(catalog ProviderCatalog, providerID string) string {
	definition, ok := catalog.Get(providerID)
	if !ok {
		return ""
	}
	members := familyMembers(catalog, definition.Family)
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

func familyMembers(catalog ProviderCatalog, family string) []providers.Definition {
	members := make([]providers.Definition, 0, 2)
	for _, definition := range catalog.List() {
		if definition.Family == family {
			members = append(members, definition)
		}
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
	maxArgs := deriveMaxPermissionArgs(definition)
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
