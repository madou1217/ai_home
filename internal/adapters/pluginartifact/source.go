package pluginartifact

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

// legacyManifestProtocolVersion 是制品清单的协议版本常量（与 manifest.schema.json 一致）。
// 注意它不同于 RPC 线的 plugincontract.ProtocolVersion。
const legacyManifestProtocolVersion = 1

var portableCapabilities = map[string]bool{
	"lifecycle":     true,
	"tool.register": true,
}

// SourceManifest 是从插件源目录读出的清单及其来源形态。
type SourceManifest struct {
	// Manifest 是待校验的清单对象（legacy plugin.json 或 canonical 投影）。
	Manifest map[string]any
	// Generated 表示清单由 package.json 的 agentPlugin 投影生成，打包时需写入 plugin.json。
	Generated bool
}

// ReadSourceManifest 读取 legacy plugin.json 或 canonical package.json 的 agentPlugin 投影。
//
// canonical 包不允许同时维护 plugin.json；投影规则与 Node source-manifest.js 同构，
// 保证 Go CLI 打出的包与 Node CLI 的包可以被同一套宿主接受。
func ReadSourceManifest(dir string) (SourceManifest, error) {
	root := strings.TrimSpace(dir)
	if root == "" {
		return SourceManifest{}, pluginerr.New("plugin_manifest_missing", "插件目录不能为空")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return SourceManifest{}, pluginerr.New("plugin_manifest_missing", "插件目录不可用")
	}
	legacyPath := filepath.Join(absolute, "plugin.json")
	packagePath := filepath.Join(absolute, "package.json")
	packageJSON, packageFound, err := readJSONObjectFile(packagePath)
	if err != nil {
		return SourceManifest{}, pluginerr.New("plugin_manifest_invalid", "插件清单不是合法 JSON")
	}
	if packageFound && packageJSON["agentPlugin"] != nil {
		if _, legacyFound, _ := readJSONObjectFile(legacyPath); legacyFound {
			return SourceManifest{}, pluginerr.New("plugin_manifest_source_conflict", "canonical 包不能同时维护 plugin.json")
		}
		manifest, projectErr := projectCanonicalManifest(packageJSON)
		if projectErr != nil {
			return SourceManifest{}, projectErr
		}
		entry, _ := manifest["entry"].(string)
		info, statErr := os.Lstat(filepath.Join(absolute, filepath.FromSlash(entry)))
		if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return SourceManifest{}, pluginerr.New("plugin_entry_missing", "包内没有入口 "+entry)
		}
		return SourceManifest{Manifest: manifest, Generated: true}, nil
	}
	legacy, legacyFound, err := readJSONObjectFile(legacyPath)
	if err != nil {
		return SourceManifest{}, pluginerr.New("plugin_manifest_invalid", "插件清单不是合法 JSON")
	}
	if !legacyFound {
		return SourceManifest{}, pluginerr.New("plugin_manifest_missing", root+" 下没有 plugin.json 或 canonical package.json")
	}
	return SourceManifest{Manifest: legacy, Generated: false}, nil
}

func readJSONObjectFile(file string) (map[string]any, bool, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil || value == nil {
		return nil, true, fmt.Errorf("invalid json")
	}
	return value, true, nil
}

func projectCanonicalManifest(pkg map[string]any) (map[string]any, error) {
	portable, _ := pkg["agentPlugin"].(map[string]any)
	if portable == nil {
		return nil, pluginerr.New("plugin_portable_api_incompatible", "package.json 缺少 agentPlugin")
	}
	if !integerEquals(portable["manifestVersion"], 1) || !integerEquals(portable["portableApiVersion"], 1) {
		return nil, pluginerr.New("plugin_portable_api_incompatible", "portable 清单版本不受支持")
	}
	hosts, _ := portable["hosts"].(map[string]any)
	host, _ := hosts["aih"].(map[string]any)
	if host == nil ||
		!integerEquals(host["hostAdapterApiVersion"], 1) ||
		!integerEquals(host["transportProtocolVersion"], int(plugincontract.ProtocolVersion)) {
		return nil, pluginerr.New("plugin_adapter_incompatible", "宿主适配器版本不受支持")
	}
	for key := range host {
		if key != "hostAdapterApiVersion" && key != "transportProtocolVersion" && key != "contributes" {
			return nil, pluginerr.New("plugin_adapter_projection_unsupported", "宿主适配器包含无法投影的字段")
		}
	}
	capabilities, ok := portable["capabilities"].([]any)
	if !ok {
		return nil, pluginerr.New("plugin_portable_capabilities_invalid", "portable capabilities 不是数组")
	}
	declared := map[string]bool{}
	for _, item := range capabilities {
		capability, _ := item.(map[string]any)
		id, _ := capability["id"].(string)
		version, hasVersion := integerValue(capability["version"])
		required, hasRequired := capability["required"].(bool)
		if capability == nil || strings.TrimSpace(id) == "" || !hasVersion || !hasRequired {
			return nil, pluginerr.New("plugin_portable_capabilities_invalid", "portable capability 结构不合法")
		}
		if required && (!portableCapabilities[id] || version != 1) {
			return nil, pluginerr.New("plugin_capability_incompatible", "必需能力不受支持："+id)
		}
		if declared[id] {
			return nil, pluginerr.New("plugin_capability_duplicate", "portable capability 重复："+id)
		}
		declared[id] = true
	}
	for id := range portableCapabilities {
		if !declared[id] {
			return nil, pluginerr.New("plugin_capability_missing", "缺少必需能力："+id)
		}
	}
	entry := ""
	if exports, ok := pkg["exports"].(map[string]any); ok {
		if exported, ok := exports["./aih"].(string); ok && strings.HasPrefix(exported, "./") {
			entry = strings.TrimPrefix(exported, "./")
		}
	}
	if !safeRelativePath(entry) {
		return nil, pluginerr.New("plugin_entry_missing", "package.json exports[\"./aih\"] 不是合法入口")
	}
	contributes, ok := host["contributes"].([]any)
	if !ok || len(contributes) == 0 {
		return nil, pluginerr.New("plugin_adapter_projection_unsupported", "host.contributes 必须是非空数组")
	}
	for _, item := range contributes {
		contribution, _ := item.(map[string]any)
		if contribution == nil ||
			contribution["capability"] != "command" ||
			!integerEquals(contribution["version"], 1) {
			return nil, pluginerr.New("plugin_adapter_projection_unsupported", "host.contributes 只支持 command@1")
		}
	}
	permissions, ok := portable["permissions"].(map[string]any)
	if !ok || len(permissions) != 3 {
		return nil, pluginerr.New("plugin_permissions_invalid", "portable permissions 结构不合法")
	}
	network, networkOK := permissions["network"].([]any)
	filesystem, filesystemOK := permissions["filesystem"].([]any)
	secrets, secretsOK := permissions["secrets"].([]any)
	if !networkOK || !filesystemOK || !secretsOK {
		return nil, pluginerr.New("plugin_permissions_invalid", "portable permissions 结构不合法")
	}
	for _, scope := range filesystem {
		if scope != "private-state" {
			return nil, pluginerr.New("plugin_permission_filesystem_invalid", "portable 文件权限只支持 private-state")
		}
	}
	stateScopes := []any{}
	if len(filesystem) > 0 {
		stateScopes = []any{"state"}
	}
	engines, _ := portable["engines"].(map[string]any)
	aihEngine, _ := engines["aih"].(string)
	packageEngines, _ := pkg["engines"].(map[string]any)
	nodeEngine, _ := packageEngines["node"].(string)
	if strings.TrimSpace(nodeEngine) == "" {
		nodeEngine = ">=22"
	}
	version, _ := pkg["version"].(string)
	pluginID, _ := portable["pluginId"].(string)
	return map[string]any{
		"manifestVersion": 1,
		"protocolVersion": legacyManifestProtocolVersion,
		"pluginId":        pluginID,
		"version":         version,
		"engines": map[string]any{
			"aih":  aihEngine,
			"node": nodeEngine,
		},
		"runtime":     "node",
		"entry":       entry,
		"targets":     []any{"any"},
		"contributes": contributes,
		"permissions": map[string]any{
			"network":    network,
			"filesystem": map[string]any{"read": stateScopes, "write": stateScopes},
			"secrets":    secrets,
		},
	}, nil
}

func integerEquals(value any, target int) bool {
	parsed, ok := integerValue(value)
	return ok && parsed == target
}
