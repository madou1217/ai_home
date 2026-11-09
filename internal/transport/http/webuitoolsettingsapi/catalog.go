package webuitoolsettingsapi

import "strings"

// Node 权限目录的分组中文名（lib/providers/permission-flag-catalog.js 的 GROUPS）。
// 用结构体而不是 map：JSON 键顺序稳定，且缺组时不会悄悄少一个键。
type catalogGroups struct {
	Sandbox  string `json:"sandbox"`
	Approval string `json:"approval"`
	Bypass   string `json:"bypass"`
	Allow    string `json:"allow"`
	Deny     string `json:"deny"`
	Policy   string `json:"policy"`
}

var permissionCatalogGroups = catalogGroups{
	Sandbox:  "沙箱",
	Approval: "审批",
	Bypass:   "全放行",
	Allow:    "工具白名单",
	Deny:     "工具黑名单",
	Policy:   "策略文件",
}

// catalogFlag 是目录条目的内部形状；对外由 describePermissionCatalog 压平成 WebUI 字段。
type flagSpec struct {
	Flag             string
	Aliases          []string
	Group            string
	Value            string
	Options          []string
	Zh               string
	En               string
	Example          string
	ConfigEquivalent string
	Note             string
}

type conflictRule struct {
	A       string
	B       string
	Message string
}

type overrideRule struct {
	By      string
	Over    string
	Message string
}

type catalogSpec struct {
	VerifiedCliVersion                     string
	SubcommandsWithoutApprovalFlag         []string
	SubcommandsBlockingPermissionOverrides []string
	Flags                                  []flagSpec
	Conflicts                              []conflictRule
	Overrides                              []overrideRule
}

// permissionCatalogFlag 是 /settings 响应里的旗标条目（camelCase，与 Node 完全同名）。
type permissionCatalogFlag struct {
	Flag             string   `json:"flag"`
	Aliases          []string `json:"aliases"`
	Group            string   `json:"group"`
	GroupLabel       string   `json:"groupLabel"`
	Value            string   `json:"value"`
	Options          []string `json:"options"`
	Description      string   `json:"description"`
	DescriptionEn    string   `json:"descriptionEn"`
	Example          string   `json:"example"`
	ConfigEquivalent string   `json:"configEquivalent"`
	Note             string   `json:"note"`
}

type permissionCatalogConflict struct {
	A       string `json:"a"`
	B       string `json:"b"`
	Message string `json:"message"`
}

type permissionCatalogOverride struct {
	By      string `json:"by"`
	Over    string `json:"over"`
	Message string `json:"message"`
}

// permissionCatalog 是 WebUI 渲染权限参数的全部数据：旗标 / 取值 / 说明 / 互斥关系。
// 前端只渲染这份数据，不维护 provider 名单。
type permissionCatalog struct {
	VerifiedCliVersion                     string                      `json:"verifiedCliVersion"`
	Groups                                 catalogGroups               `json:"groups"`
	Flags                                  []permissionCatalogFlag     `json:"flags"`
	Conflicts                              []permissionCatalogConflict `json:"conflicts"`
	Overrides                              []permissionCatalogOverride `json:"overrides"`
	SubcommandsWithoutApprovalFlag         []string                    `json:"subcommandsWithoutApprovalFlag"`
	SubcommandsBlockingPermissionOverrides []string                    `json:"subcommandsBlockingPermissionOverrides"`
}

// resolveCatalogSpec 按目录别名归一后查表；未登记返回空目录（不是异常）。
func resolveCatalogSpec(provider string) catalogSpec {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	if alias, ok := permissionCatalogAliases[normalized]; ok {
		normalized = alias
	}
	spec, ok := permissionCatalogSpecs[normalized]
	if !ok {
		return catalogSpec{VerifiedCliVersion: "none"}
	}
	return spec
}

// describePermissionCatalog 输出与 Node describePermissionCatalog 逐字段一致的目录。
// 空列表统一输出 [] 而不是 null：前端直接遍历，null 会让「没有互斥项」变成渲染异常。
func describePermissionCatalog(provider string) permissionCatalog {
	spec := resolveCatalogSpec(provider)
	flags := make([]permissionCatalogFlag, 0, len(spec.Flags))
	for _, entry := range spec.Flags {
		value := entry.Value
		if value == "" {
			value = "none"
		}
		flags = append(flags, permissionCatalogFlag{
			Flag:             entry.Flag,
			Aliases:          append([]string{}, entry.Aliases...),
			Group:            entry.Group,
			GroupLabel:       catalogGroupLabel(entry.Group),
			Value:            value,
			Options:          append([]string{}, entry.Options...),
			Description:      entry.Zh,
			DescriptionEn:    entry.En,
			Example:          entry.Example,
			ConfigEquivalent: entry.ConfigEquivalent,
			Note:             entry.Note,
		})
	}
	conflicts := make([]permissionCatalogConflict, 0, len(spec.Conflicts))
	for _, rule := range spec.Conflicts {
		conflicts = append(conflicts, permissionCatalogConflict{A: rule.A, B: rule.B, Message: rule.Message})
	}
	overrides := make([]permissionCatalogOverride, 0, len(spec.Overrides))
	for _, rule := range spec.Overrides {
		overrides = append(overrides, permissionCatalogOverride{By: rule.By, Over: rule.Over, Message: rule.Message})
	}
	version := spec.VerifiedCliVersion
	if version == "" {
		version = "none"
	}
	return permissionCatalog{
		VerifiedCliVersion:                     version,
		Groups:                                 permissionCatalogGroups,
		Flags:                                  flags,
		Conflicts:                              conflicts,
		Overrides:                              overrides,
		SubcommandsWithoutApprovalFlag:         append([]string{}, spec.SubcommandsWithoutApprovalFlag...),
		SubcommandsBlockingPermissionOverrides: append([]string{}, spec.SubcommandsBlockingPermissionOverrides...),
	}
}

func catalogGroupLabel(group string) string {
	labels := map[string]string{
		"sandbox":  permissionCatalogGroups.Sandbox,
		"approval": permissionCatalogGroups.Approval,
		"bypass":   permissionCatalogGroups.Bypass,
		"allow":    permissionCatalogGroups.Allow,
		"deny":     permissionCatalogGroups.Deny,
		"policy":   permissionCatalogGroups.Policy,
	}
	if label, ok := labels[group]; ok {
		return label
	}
	return group
}
