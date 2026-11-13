package nativeresources

import (
	"fmt"
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
	Evidence  string `json:"evidence"`
}

var importedHosts = []HostDescriptor{
	{Host: "deepseek", State: "projection-only", Harness: "dsh", Entry: "lib/bin.js", CLIExport: "runCli", Reason: "native_owned_patch_boot_tool_cleanup_and_headless_loop_verified; Web/TUI entrypoints remain separate", Evidence: "scripts/deepseek-plugin-managed-demo.mjs"},
	{Host: "opencode", State: "supported", Reason: "server_plugin_native_tool_loop_verified; TUI/RPC entrypoints remain separate", Evidence: "scripts/opencode-plugin-native-demo.js"},
	{Host: "pi", State: "runtime-unavailable", Harness: "pi", Entry: "dist/bundle/cli.js", Reason: "native_directory_tool_command_cleanup_and_cli_tool_loop_verified; TUI/RPC entrypoints remain separate", Evidence: "scripts/pi-plugin-native-demo.js --managed"},
	{Host: "aih", State: "supported", Reason: "canonical_signed_artifact_and_shared_core_supervised_host_verified", Evidence: "scripts/aih-portable-plugin-demo.js"},
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

// DemoSpec 描述单类资源与 Provider 对应的实测闭环 Demo 脚本命令。
type DemoSpec struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Source  string   `json:"source,omitempty"`
}

var demoRelativeSources = map[string]string{
	"plugin": "examples/native-plugins/aih-demo",
	"skill":  "assets/provider-skills/aih-demo",
	"mcp":    "examples/mcp/aih-demo-server.js",
}

var demoSpecs = map[string]DemoSpec{
	"plugin:deepseek":    {Command: "node scripts/deepseek-plugin-managed-demo.mjs", Args: []string{"scripts/deepseek-plugin-managed-demo.mjs"}},
	"plugin:pi":          {Command: "node scripts/pi-plugin-native-demo.js --managed", Args: []string{"scripts/pi-plugin-native-demo.js", "--managed"}},
	"plugin:aih":         {Command: "node scripts/aih-portable-plugin-demo.js", Args: []string{"scripts/aih-portable-plugin-demo.js"}},
	"plugin:codex":       {Command: "node scripts/native-plugin-use-demo.js codex", Args: []string{"scripts/native-plugin-use-demo.js", "codex"}},
	"plugin:claude":      {Command: "node scripts/native-plugin-use-demo.js claude", Args: []string{"scripts/native-plugin-use-demo.js", "claude"}},
	"plugin:opencode":    {Command: "node scripts/opencode-plugin-native-demo.js", Args: []string{"scripts/opencode-plugin-native-demo.js"}},
	"plugin:codebuddy":   {Command: "node scripts/workbuddy-resource-native-demo.js --provider codebuddy", Args: []string{"scripts/workbuddy-resource-native-demo.js", "--provider", "codebuddy"}},
	"plugin:codebuddycn": {Command: "node scripts/workbuddy-resource-native-demo.js --provider codebuddycn", Args: []string{"scripts/workbuddy-resource-native-demo.js", "--provider", "codebuddycn"}},
	"plugin:workbuddy":   {Command: "node scripts/workbuddy-resource-native-demo.js", Args: []string{"scripts/workbuddy-resource-native-demo.js"}},
	"skill:codex":        {Command: "node scripts/skill-native-demo.js --provider codex", Args: []string{"scripts/skill-native-demo.js", "--provider", "codex"}},
	"skill:claude":       {Command: "node scripts/skill-native-demo.js --provider claude", Args: []string{"scripts/skill-native-demo.js", "--provider", "claude"}},
	"skill:opencode":     {Command: "node scripts/skill-native-demo.js --provider opencode", Args: []string{"scripts/skill-native-demo.js", "--provider", "opencode"}},
	"skill:workbuddy":    {Command: "node scripts/workbuddy-resource-native-demo.js", Args: []string{"scripts/workbuddy-resource-native-demo.js"}},
	"skill:codebuddy":    {Command: "node scripts/workbuddy-resource-native-demo.js --provider codebuddy", Args: []string{"scripts/workbuddy-resource-native-demo.js", "--provider", "codebuddy"}},
	"skill:codebuddycn":  {Command: "node scripts/workbuddy-resource-native-demo.js --provider codebuddycn", Args: []string{"scripts/workbuddy-resource-native-demo.js", "--provider", "codebuddycn"}},
	"mcp:codex":          {Command: "node scripts/codex-mcp-tool-loop-demo.js", Args: []string{"scripts/codex-mcp-tool-loop-demo.js"}},
	"mcp:claude":         {Command: "node scripts/claude-mcp-tool-loop-demo.js", Args: []string{"scripts/claude-mcp-tool-loop-demo.js"}},
	"mcp:opencode":       {Command: "node scripts/opencode-mcp-tool-loop-demo.js", Args: []string{"scripts/opencode-mcp-tool-loop-demo.js"}},
	"mcp:cline":          {Command: "node scripts/cline-mcp-tool-loop-demo.js", Args: []string{"scripts/cline-mcp-tool-loop-demo.js"}},
	"mcp:workbuddy":      {Command: "node scripts/workbuddy-mcp-tool-loop-demo.js", Args: []string{"scripts/workbuddy-mcp-tool-loop-demo.js"}},
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

func demoForKind(kind string) DemoSpec {
	src := demoRelativeSources[kind]
	cmd := "node scripts/mcp-native-demo.js"
	if kind == "plugin" {
		cmd = "node scripts/resource-closure-demo.js --skip-skill --skip-mcp"
	} else if kind == "skill" {
		cmd = "node scripts/skill-native-demo.js --provider <provider>"
	}
	return DemoSpec{Source: src, Command: cmd}
}

func lookupDemoSpec(provider, host, kind string) (DemoSpec, bool) {
	id := provider
	if host != "" {
		id = host
	}
	key := fmt.Sprintf("%s:%s", kind, id)
	spec, ok := demoSpecs[key]
	return spec, ok
}
