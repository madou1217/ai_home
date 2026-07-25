package providers

import "strings"

// Catalog 是只读 Provider 注册表，负责查询身份和声明式能力。
//
// 它不执行认证刷新、协议转换或会话读取；这些行为属于 Integration Adapter。
type Catalog struct {
	ordered []Definition
	byID    map[string]int
}

// NewCatalog 从已校验合同构建只读 Provider 注册表。
func NewCatalog(manifest Manifest) (*Catalog, error) {
	if err := ValidateManifest(manifest); err != nil {
		return nil, err
	}
	definitions := cloneDefinitions(manifest.Providers)
	byID := make(map[string]int, len(definitions))
	for index, definition := range definitions {
		byID[definition.ID] = index
	}
	return &Catalog{ordered: definitions, byID: byID}, nil
}

// List 返回按产品展示顺序排列的防御性副本。
func (catalog *Catalog) List() []Definition {
	if catalog == nil {
		return nil
	}
	return cloneDefinitions(catalog.ordered)
}

// Get 根据大小写不敏感的 Provider ID 返回防御性副本。
func (catalog *Catalog) Get(id string) (Definition, bool) {
	if catalog == nil {
		return Definition{}, false
	}
	index, ok := catalog.byID[strings.ToLower(strings.TrimSpace(id))]
	if !ok {
		return Definition{}, false
	}
	return cloneDefinition(catalog.ordered[index]), true
}

// Supports 判断 Provider 是否声明了指定能力。
func (catalog *Catalog) Supports(id string, capability Capability) bool {
	definition, ok := catalog.Get(id)
	if !ok {
		return false
	}
	for _, candidate := range definition.Capabilities {
		if candidate == capability {
			return true
		}
	}
	return false
}

// cloneDefinitions 隔离调用方对切片字段的修改。
func cloneDefinitions(definitions []Definition) []Definition {
	cloned := make([]Definition, 0, len(definitions))
	for _, definition := range definitions {
		cloned = append(cloned, cloneDefinition(definition))
	}
	return cloned
}

// cloneDefinition 深复制 Provider 定义中的所有可变切片和指针字段。
func cloneDefinition(source Definition) Definition {
	target := source
	target.Capabilities = append([]Capability(nil), source.Capabilities...)
	target.AuthOptions = append([]AuthOption(nil), source.AuthOptions...)
	target.SessionSync.Events = append([]string(nil), source.SessionSync.Events...)
	if source.CLI != nil {
		cli := *source.CLI
		cli.LoginArgs = append([]string(nil), source.CLI.LoginArgs...)
		cli.EnvKeys = append([]string(nil), source.CLI.EnvKeys...)
		cli.DesktopClient = cloneDesktopClient(source.CLI.DesktopClient)
		target.CLI = &cli
	}
	if source.NativeBoundary != nil {
		native := *source.NativeBoundary
		native.Config.EnvHomeKeys = append([]string(nil), source.NativeBoundary.Config.EnvHomeKeys...)
		native.Config.UserSettings = append([]string(nil), source.NativeBoundary.Config.UserSettings...)
		native.Config.ProjectSettings = append([]string(nil), source.NativeBoundary.Config.ProjectSettings...)
		native.Config.CLIFlags = append([]string(nil), source.NativeBoundary.Config.CLIFlags...)
		native.Sessions.Flags = append([]string(nil), source.NativeBoundary.Sessions.Flags...)
		native.MCP.Commands = append([]string(nil), source.NativeBoundary.MCP.Commands...)
		native.MCP.ConfigFiles = append([]string(nil), source.NativeBoundary.MCP.ConfigFiles...)
		native.Hooks.Files = append([]string(nil), source.NativeBoundary.Hooks.Files...)
		native.Permissions.Flags = append([]string(nil), source.NativeBoundary.Permissions.Flags...)
		native.Permissions.Modes = append([]string(nil), source.NativeBoundary.Permissions.Modes...)
		target.NativeBoundary = &native
	}
	return target
}

// cloneDesktopClient 深复制桌面客户端平台配置。
func cloneDesktopClient(source *DesktopClient) *DesktopClient {
	if source == nil {
		return nil
	}
	target := *source
	if source.ReloadsHostAuth != nil {
		value := *source.ReloadsHostAuth
		target.ReloadsHostAuth = &value
	}
	target.MacOS = cloneDesktopPlatform(source.MacOS)
	target.Windows = cloneDesktopPlatform(source.Windows)
	target.Linux = cloneDesktopPlatform(source.Linux)
	return &target
}

// cloneDesktopPlatform 深复制单个平台的路径和进程名切片。
func cloneDesktopPlatform(source *DesktopPlatform) *DesktopPlatform {
	if source == nil {
		return nil
	}
	target := *source
	target.ProcessNames = append([]string(nil), source.ProcessNames...)
	target.ExecNames = append([]string(nil), source.ExecNames...)
	target.PathIncludes = append([]string(nil), source.PathIncludes...)
	target.InstallPaths = append([]string(nil), source.InstallPaths...)
	return &target
}
