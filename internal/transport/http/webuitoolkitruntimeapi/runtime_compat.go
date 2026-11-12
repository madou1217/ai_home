package webuitoolkitruntimeapi

import (
	"context"
	"regexp"
	"sort"
	"strings"
)

type RuntimePluginView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Icon string `json:"icon"`
}

type RuntimeView struct {
	ID                    string         `json:"id"`
	Name                  string         `json:"name"`
	Installed             bool           `json:"installed"`
	CurrentVersion        string         `json:"currentVersion"`
	ActivePath            string         `json:"activePath"`
	PackageManagerVersion string         `json:"packageManagerVersion"`
	PackageManagers       map[string]any `json:"packageManagers,omitempty"`
	Scope                 string         `json:"scope"`
	Source                string         `json:"source"`
	ProbeStatus           string         `json:"probeStatus"`
}

type VersionManagerView struct {
	Name        string   `json:"name"`
	DisplayName string   `json:"displayName"`
	Installed   bool     `json:"installed"`
	Version     string   `json:"version"`
	Path        string   `json:"path"`
	Versions    []string `json:"versions"`
}

type EnvironmentView struct {
	Name              string               `json:"name"`
	Scope             string               `json:"scope"`
	Source            string               `json:"source"`
	ProbeStatus       string               `json:"probeStatus"`
	CurrentVersion    string               `json:"currentVersion"`
	ActivePath        string               `json:"activePath"`
	PackageManagers   map[string]any       `json:"packageManagers,omitempty"`
	Pip               string               `json:"pip,omitempty"`
	Tools             map[string]any       `json:"tools,omitempty"`
	VersionManagers   []VersionManagerView `json:"versionManagers"`
	InstalledVersions []string             `json:"installedVersions"`
}

var (
	nodeVersionPattern   = regexp.MustCompile(`v?\d+\.\d+\.\d+`)
	simpleVersionPattern = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`)
)

func (handler *Handler) buildRuntimeCompatibility(ctx context.Context, tools []ToolView, platform string) ([]RuntimePluginView, map[string]RuntimeView, map[string]EnvironmentView) {
	resources := make(map[string]ToolView, len(tools))
	for _, tool := range tools {
		resources[tool.ID] = tool
	}
	plugins := []RuntimePluginView{
		{ID: "node", Name: "Node.js", Icon: "node"},
		{ID: "python", Name: "Python", Icon: "python"},
		{ID: "rust", Name: "Rust", Icon: "rust"},
		{ID: "go", Name: "Go", Icon: "go"},
		{ID: "git", Name: "Git", Icon: "git"},
	}
	runtimes := map[string]RuntimeView{
		"node":   handler.probeRuntime(ctx, "node", "Node.js", "node", []string{"--version"}, nodeVersionPattern),
		"python": handler.probeRuntime(ctx, "python", "Python", "python3", []string{"--version"}, nil),
		"rust":   handler.probeRuntime(ctx, "rust", "Rust", "rustc", []string{"--version"}, simpleVersionPattern),
		"go":     runtimeFromResource("go", "Go", resources["go"]),
		"git":    runtimeFromResource("git", "Git", resources["git"]),
	}
	node := runtimes["node"]
	node.PackageManagers = map[string]any{"npm": nil}
	if npm, path := handler.probeVersion(ctx, "npm", []string{"--version"}, simpleVersionPattern); npm != "" {
		node.PackageManagers["npm"] = npm
		node.PackageManagerVersion = npm
		node.ActivePath = firstNonEmpty(node.ActivePath, path)
	}
	runtimes["node"] = node
	python := runtimes["python"]
	if pip, _ := handler.probeVersion(ctx, "pip3", []string{"--version"}, simpleVersionPattern); pip != "" {
		python.PackageManagerVersion = pip
	}
	runtimes["python"] = python
	rust := runtimes["rust"]
	if cargo, _ := handler.probeVersion(ctx, "cargo", []string{"--version"}, simpleVersionPattern); cargo != "" {
		rust.PackageManagerVersion = cargo
	}
	runtimes["rust"] = rust

	environments := map[string]EnvironmentView{}
	if node.Installed {
		managers := []VersionManagerView{}
		for _, id := range []string{"nvm", "fnm", "volta"} {
			if item, ok := resources[id]; ok && item.Available {
				managers = append(managers, VersionManagerView{
					Name: id, DisplayName: item.Name, Installed: true, Version: item.Version,
					Path: item.Path, Versions: sortedVersions(item.ManagedVersions),
				})
			}
		}
		installed := sortedVersions(resources["nvm"].ManagedVersions)
		if len(installed) == 0 {
			installed = []string{node.CurrentVersion}
		}
		environments["node"] = EnvironmentView{
			Name: "Node.js", Scope: node.Scope, Source: node.Source, ProbeStatus: node.ProbeStatus,
			CurrentVersion: node.CurrentVersion, ActivePath: node.ActivePath,
			PackageManagers: map[string]any{
				"npm":  node.PackageManagerVersion,
				"pnpm": packageManagerVersion(ctx, handler, resources, "pnpm"),
				"yarn": packageManagerVersion(ctx, handler, resources, "yarn"),
				"bun":  packageManagerVersion(ctx, handler, resources, "bun"),
			},
			VersionManagers: managers, InstalledVersions: installed,
		}
	}
	if python.Installed {
		managers := []VersionManagerView{}
		for _, id := range []string{"pyenv", "conda"} {
			if item, ok := resources[id]; ok && item.Available {
				managers = append(managers, VersionManagerView{
					Name: id, DisplayName: item.Name, Installed: true, Version: item.Version,
					Path: item.Path, Versions: sortedVersions(item.ManagedVersions),
				})
			}
		}
		installed := nonNilStrings(resources["pyenv"].ManagedVersions)
		if len(installed) == 0 {
			installed = []string{python.CurrentVersion}
		}
		environments["python"] = EnvironmentView{
			Name: "Python", Scope: python.Scope, Source: python.Source, ProbeStatus: python.ProbeStatus,
			CurrentVersion: python.CurrentVersion, ActivePath: python.ActivePath, Pip: python.PackageManagerVersion,
			Tools:           map[string]any{"uv": valueOrNil(resources["uv"]), "poetry": valueOrNil(resources["poetry"])},
			VersionManagers: managers, InstalledVersions: installed,
		}
	}
	return plugins, runtimes, environments
}

func (handler *Handler) probeRuntime(ctx context.Context, id, name, command string, args []string, pattern *regexp.Regexp) RuntimeView {
	path := handler.which(command)
	view := RuntimeView{ID: id, Name: name, ActivePath: path, Scope: "aih-server-process-path", Source: "command-probe", ProbeStatus: "missing"}
	if path == "" {
		return view
	}
	view.Installed = true
	view.ProbeStatus = "available"
	if output, status := handler.versionOutput(ctx, path, args); status == versionStatusOK {
		if pattern == nil {
			view.CurrentVersion = strings.TrimSpace(output)
		} else {
			view.CurrentVersion = firstMatch(pattern, output)
		}
	}
	return view
}

func (handler *Handler) probeVersion(ctx context.Context, command string, args []string, pattern *regexp.Regexp) (string, string) {
	path := handler.which(command)
	if path == "" {
		return "", ""
	}
	output, status := handler.versionOutput(ctx, path, args)
	if status != versionStatusOK {
		return "", path
	}
	return firstMatch(pattern, output), path
}

func runtimeFromResource(id, name string, tool ToolView) RuntimeView {
	return RuntimeView{
		ID: id, Name: name, Installed: tool.Available, CurrentVersion: tool.Version,
		ActivePath: tool.Path, Scope: "aih-server-process-path", Source: "command-probe",
		ProbeStatus: map[bool]string{true: "available", false: "missing"}[tool.Available],
	}
}

func firstMatch(pattern *regexp.Regexp, value string) string {
	if match := pattern.FindString(value); match != "" {
		return match
	}
	return strings.TrimSpace(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func valueOrNil(tool ToolView) any {
	if !tool.Available || tool.Version == "" {
		return nil
	}
	return tool.Version
}

func sortedVersions(values []string) []string {
	result := append([]string{}, values...)
	sort.Slice(result, func(left, right int) bool { return result[left] > result[right] })
	return result
}

func packageManagerVersion(ctx context.Context, handler *Handler, resources map[string]ToolView, id string) any {
	if tool, ok := resources[id]; ok && tool.Available && tool.Version != "" {
		return tool.Version
	}
	if version, _ := handler.probeVersion(ctx, id, []string{"--version"}, simpleVersionPattern); version != "" {
		return version
	}
	return nil
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
