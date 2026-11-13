package environment

import "context"

// LifecycleView 是工具三个生命周期动作的可用性。
type LifecycleView struct {
	Install   bool `json:"install"`
	Update    bool `json:"update"`
	Uninstall bool `json:"uninstall"`
}

// ResourceView 是 Node resources[] 的等价投影（字段名与前端一致）。
type ResourceView struct {
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Runtime         string        `json:"runtime"`
	Category        string        `json:"category"`
	Description     string        `json:"description"`
	Platform        string        `json:"platform"`
	Installed       bool          `json:"installed"`
	Version         string        `json:"version"`
	ExecutablePath  string        `json:"executablePath"`
	ManagedVersions []string      `json:"managedVersions"`
	CanInstall      bool          `json:"canInstall"`
	CanUpdate       bool          `json:"canUpdate"`
	CanUninstall    bool          `json:"canUninstall"`
	Lifecycle       LifecycleView `json:"lifecycle"`
}

// RuntimePluginView 是运行时插件标识（界面图标用）。
type RuntimePluginView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Icon string `json:"icon"`
}

// Summary 是 GET /environments 的响应主体。
type Summary struct {
	OK             bool                      `json:"ok"`
	Platform       string                    `json:"platform"`
	RuntimePlugins []RuntimePluginView       `json:"runtimePlugins"`
	Runtimes       map[string]RuntimeView    `json:"runtimes"`
	Resources      []ResourceView            `json:"resources"`
	InstalledCount int                       `json:"installedCount"`
	Total          int                       `json:"total"`
	Environments   map[string]map[string]any `json:"environments"`
}

// runtimePlugins 与 Node ENVIRONMENT_RUNTIME_PLUGINS 的顺序一致。
var runtimePlugins = []RuntimePluginView{
	{ID: "node", Name: "Node.js", Icon: "node"},
	{ID: "python", Name: "Python", Icon: "python"},
	{ID: "rust", Name: "Rust", Icon: "rust"},
	{ID: "go", Name: "Go", Icon: "go"},
	{ID: "git", Name: "Git", Icon: "git"},
}

// LifecycleAvailability 返回三个动作是否可生成计划。
func LifecycleAvailability(spec ToolSpec, options BuildOptions) LifecycleView {
	return LifecycleView{
		Install:   ResolveToolPlans(spec.ID, "install", options).OK,
		Update:    ResolveToolPlans(spec.ID, "update", options).OK,
		Uninstall: ResolveToolPlans(spec.ID, "uninstall", options).OK,
	}
}

// BuildResource 探测一个工具并计算生命周期可用性。
func BuildResource(ctx context.Context, spec ToolSpec, host Host, options BuildOptions) ResourceView {
	observed := Probe(ctx, spec, host)
	availability := LifecycleAvailability(spec, options)
	managed := observed.ManagedVersions
	if managed == nil {
		managed = []string{}
	}
	return ResourceView{
		ID:              spec.ID,
		Name:            spec.Name,
		Runtime:         spec.Runtime,
		Category:        spec.Category,
		Description:     spec.Description,
		Platform:        options.Platform,
		Installed:       observed.Installed,
		Version:         observed.Version,
		ExecutablePath:  observed.ExecutablePath,
		ManagedVersions: managed,
		CanInstall:      !observed.Installed && availability.Install,
		CanUpdate:       observed.Installed && availability.Update,
		CanUninstall:    observed.Installed && availability.Uninstall,
		Lifecycle:       availability,
	}
}

// BuildSummary 复刻 Node buildEnvironmentsSummaryAsync：并发探测所有工具与运行时。
//
// 本函数是同步接口：调用方（HTTP handler）负责把它放进请求 goroutine。工具级并发
// 在内部完成，总耗时接近最慢的一条探测。
func BuildSummary(ctx context.Context, host Host, options BuildOptions) Summary {
	platform := normalizePlatform(options.Platform)
	options.Platform = platform
	specs := ToolsForPlatform(platform)
	resources := make([]ResourceView, len(specs))
	type resourceResult struct {
		index    int
		resource ResourceView
	}
	results := make(chan resourceResult, len(specs))
	for index, spec := range specs {
		go func(index int, spec ToolSpec) {
			results <- resourceResult{index: index, resource: BuildResource(ctx, spec, host, options)}
		}(index, spec)
	}
	for range specs {
		result := <-results
		resources[result.index] = result.resource
	}
	runtimes := DetectRuntimes(ctx, host)
	installed := 0
	for _, resource := range resources {
		if resource.Installed {
			installed++
		}
	}
	summary := Summary{
		OK:             true,
		Platform:       platform,
		RuntimePlugins: append([]RuntimePluginView{}, runtimePlugins...),
		Runtimes:       runtimes,
		Resources:      resources,
		InstalledCount: installed,
		Total:          len(resources),
		Environments:   map[string]map[string]any{},
	}
	node, hasNode := runtimes["node"]
	python, hasPython := runtimes["python"]
	if hasNode && hasPython {
		summary.Environments["node"] = legacyNodeShape(node, resources)
		summary.Environments["python"] = legacyPythonShape(python, resources)
	}
	return summary
}

func resourcesByID(resources []ResourceView) map[string]ResourceView {
	result := make(map[string]ResourceView, len(resources))
	for _, resource := range resources {
		result[resource.ID] = resource
	}
	return result
}

// legacyNodeShape 复刻 Node legacyEnvironmentShape('node', ...)。
func legacyNodeShape(summary RuntimeView, resources []ResourceView) map[string]any {
	byID := resourcesByID(resources)
	packageManagers := map[string]any{
		"npm":  nullableString(summary.PackageManagerVersion),
		"pnpm": resourceVersion(byID, "pnpm"),
		"yarn": resourceVersion(byID, "yarn"),
		"bun":  resourceVersion(byID, "bun"),
	}
	versionManagers := []map[string]any{}
	for _, id := range []string{"nvm", "fnm", "volta"} {
		resource, ok := byID[id]
		if !ok || !resource.Installed {
			continue
		}
		versionManagers = append(versionManagers, map[string]any{
			"name":        resource.ID,
			"displayName": resource.Name,
			"installed":   true,
			"version":     resource.Version,
			"path":        resource.ExecutablePath,
			"versions":    nonNil(resource.ManagedVersions),
		})
	}
	installedVersions := []string{}
	if nvm, ok := byID["nvm"]; ok && len(nvm.ManagedVersions) > 0 {
		installedVersions = nonNil(nvm.ManagedVersions)
	} else if summary.CurrentVersion != "" {
		installedVersions = []string{summary.CurrentVersion}
	}
	return map[string]any{
		"name":              summary.Name,
		"scope":             summary.Scope,
		"source":            summary.Source,
		"probeStatus":       summary.ProbeStatus,
		"currentVersion":    summary.CurrentVersion,
		"activePath":        summary.ActivePath,
		"packageManagers":   packageManagers,
		"versionManagers":   versionManagers,
		"installedVersions": installedVersions,
	}
}

// legacyPythonShape 复刻 Node legacyEnvironmentShape('python', ...)。
func legacyPythonShape(summary RuntimeView, resources []ResourceView) map[string]any {
	byID := resourcesByID(resources)
	versionManagers := []map[string]any{}
	for _, id := range []string{"pyenv", "conda"} {
		resource, ok := byID[id]
		if !ok || !resource.Installed {
			continue
		}
		versionManagers = append(versionManagers, map[string]any{
			"name":        resource.ID,
			"displayName": resource.Name,
			"installed":   true,
			"version":     resource.Version,
			"path":        resource.ExecutablePath,
			"versions":    nonNil(resource.ManagedVersions),
		})
	}
	installedVersions := []string{}
	if pyenv, ok := byID["pyenv"]; ok && len(pyenv.ManagedVersions) > 0 {
		installedVersions = nonNil(pyenv.ManagedVersions)
	} else if summary.CurrentVersion != "" {
		installedVersions = []string{summary.CurrentVersion}
	}
	return map[string]any{
		"name":           summary.Name,
		"scope":          summary.Scope,
		"source":         summary.Source,
		"probeStatus":    summary.ProbeStatus,
		"currentVersion": summary.CurrentVersion,
		"activePath":     summary.ActivePath,
		"pip":            nullableString(summary.PackageManagerVersion),
		"tools": map[string]any{
			"uv":     resourceVersion(byID, "uv"),
			"poetry": resourceVersion(byID, "poetry"),
		},
		"versionManagers":   versionManagers,
		"installedVersions": installedVersions,
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func resourceVersion(byID map[string]ResourceView, id string) any {
	resource, ok := byID[id]
	if !ok || resource.Version == "" {
		return nil
	}
	return resource.Version
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
