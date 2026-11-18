package nativeresources

import (
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

var resourceTypes = []string{"plugin", "skill", "mcp"}

// ResourceCapability 描述某个 Provider/Host 对单类原生资源（plugin / skill / mcp）的支持边界。
type ResourceCapability struct {
	State         string                         `json:"state"`
	Reason        string                         `json:"reason,omitempty"`
	Mode          string                         `json:"mode,omitempty"`
	Adapter       string                         `json:"adapter,omitempty"`
	PathBase      string                         `json:"pathBase,omitempty"`
	Commands      []string                       `json:"commands,omitempty"`
	Paths         []string                       `json:"paths,omitempty"`
	ConfigFiles   []string                       `json:"configFiles,omitempty"`
	Projection    *providers.NativeMCPProjection `json:"projection,omitempty"`
	EntryExport   string                         `json:"entryExport,omitempty"`
	LaunchArg     string                         `json:"launchArgument,omitempty"`
	LaunchInstall bool                           `json:"launchFromInstall,omitempty"`
}

// HostDescriptor 描述外部宿主（deepseek / opencode / pi / aih）的插件承载能力。
type HostDescriptor struct {
	Host      string `json:"host"`
	State     string `json:"state"`
	Harness   string `json:"harness,omitempty"`
	Entry     string `json:"entry,omitempty"`
	CLIExport string `json:"cliExport,omitempty"`
	Reason    string `json:"reason"`
	Evidence  string `json:"evidence,omitempty"`
}

var importedHosts = []HostDescriptor{
	{Host: "deepseek", State: "projection-only", Harness: "dsh", Entry: "lib/bin.js", CLIExport: "runCli", Reason: "host_adapter_declared; installed plugin execution is not verified"},
	{Host: "opencode", State: "projection-only", Reason: "host_adapter_declared; installed plugin execution is not verified"},
	{Host: "pi", State: "runtime-unavailable", Harness: "pi", Entry: "dist/bundle/cli.js", Reason: "host_adapter_declared; runtime must be detected"},
	{Host: "aih", State: "supported", Reason: "signed_artifact_host_available; no plugin is bundled"},
}

var hostResourceCapabilities = map[string]map[string]ResourceCapability{
	"pi": {
		"plugin": {
			State:     "supported",
			Mode:      "native",
			Adapter:   "native-directory",
			PathBase:  "host-home",
			Paths:     []string{".pi/agent/extensions"},
			LaunchArg: "--extension",
		},
	},
	"deepseek": {
		"plugin": {
			State:         "supported",
			Mode:          "native",
			Adapter:       "cordis-patch",
			PathBase:      "host-home",
			Paths:         []string{".dsh/plugins"},
			EntryExport:   "./deepseek",
			LaunchArg:     "--patch",
			LaunchInstall: true,
		},
	},
}

var harnessPackageNames = map[string]string{
	"pi":      "@earendil-works/pi-coding-agent",
	"dsh":     "@deepseek-ai/dsh",
	"dsh-tui": "@deepseek-harness-tui/dsh-tui",
}

func nativeResourceStatus(def providers.Definition, resource string) ResourceCapability {
	b := def.NativeBoundary
	if b == nil {
		return ResourceCapability{State: "unsupported", Reason: "native_boundary_missing"}
	}
	switch resource {
	case "mcp":
		commands := nonNilStrings(b.MCP.Commands)
		configFiles := nonNilStrings(b.MCP.ConfigFiles)
		if len(commands) == 0 && len(configFiles) == 0 {
			return ResourceCapability{State: "unsupported", Reason: "mcp_not_declared"}
		}
		reason := "mcp_projection_not_declared"
		if b.MCP.Projection != nil {
			reason = "mcp_native_execution_unverified"
		}
		return ResourceCapability{
			State:       "projection-only",
			Reason:      reason,
			Commands:    commands,
			ConfigFiles: configFiles,
			Projection:  b.MCP.Projection,
		}
	case "plugin":
		commands := nonNilStrings(b.Plugins.Commands)
		paths := nonNilStrings(b.Plugins.Paths)
		mode := strings.TrimSpace(b.Plugins.Mode)
		if len(commands) == 0 && len(paths) == 0 {
			return ResourceCapability{State: "unsupported", Reason: "plugin_boundary_not_declared"}
		}
		st := "projection-only"
		reason := "plugin_projection_only"
		if mode == "native" {
			st = "supported"
			reason = ""
		}
		return ResourceCapability{
			State:    st,
			Reason:   reason,
			Commands: commands,
			Paths:    paths,
			Mode:     mode,
			Adapter:  b.Plugins.Adapter,
			PathBase: b.Plugins.PathBase,
		}
	case "skill":
		commands := nonNilStrings(b.Skills.Commands)
		paths := nonNilStrings(b.Skills.Paths)
		mode := strings.TrimSpace(b.Skills.Mode)
		if len(commands) == 0 && len(paths) == 0 {
			return ResourceCapability{State: "unsupported", Reason: "skill_boundary_not_declared"}
		}
		st := "projection-only"
		reason := "skill_projection_only"
		if mode == "native" {
			st = "supported"
			reason = ""
		}
		return ResourceCapability{
			State:    st,
			Reason:   reason,
			Commands: commands,
			Paths:    paths,
			Mode:     mode,
			PathBase: b.Skills.PathBase,
		}
	default:
		return ResourceCapability{State: "unsupported", Reason: "resource_type_unknown"}
	}
}

func getHostResourceCapability(host, resource string) ResourceCapability {
	if byRes, ok := hostResourceCapabilities[strings.ToLower(strings.TrimSpace(host))]; ok {
		if capVal, found := byRes[strings.ToLower(strings.TrimSpace(resource))]; found {
			return capVal
		}
	}
	return ResourceCapability{State: "unsupported", Reason: "host_resource_adapter_not_registered"}
}

func resolveProviderNativeRoot(hostHome, provider string) string {
	root := storagepolicy.ResolveNativeRoot(hostHome, provider)
	if root != "" {
		return root
	}
	if strings.TrimSpace(hostHome) == "" || strings.TrimSpace(provider) == "" {
		return ""
	}
	return filepath.Join(hostHome, "."+strings.ToLower(strings.TrimSpace(provider)))
}

func resolveProjectionRoot(hostHome, provider, pathBase string) string {
	if pathBase == "host-home" {
		return hostHome
	}
	return resolveProviderNativeRoot(hostHome, provider)
}

func nonNilStrings(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}
