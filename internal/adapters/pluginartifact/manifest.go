package pluginartifact

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"runtime"
	"strings"
	"sync"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

// ManifestOptions 是清单校验依赖的宿主事实。
//
// HostVersion / NodeVersion 由 Node 管理面在代理 install 时随请求给出：插件最终
// 跑在 Node 宿主进程里，engines 必须按真正的宿主版本判断，不能由 Go 猜一个。
type ManifestOptions struct {
	HostVersion string
	NodeVersion string
	// Target 是 platform-arch，缺省按 Go 运行平台映射成 Node 的命名。
	Target string
}

// 错误码与 Node plugin sdk 的 PluginError.code 逐字一致。
const (
	codeManifestInvalid             = "plugin_manifest_invalid"
	codeEntryInvalid                = "plugin_entry_invalid"
	codeVersionInvalid              = "plugin_version_invalid"
	codeHostIncompatible            = "plugin_host_incompatible"
	codeNodeIncompatible            = "plugin_node_incompatible"
	codePlatformIncompatible        = "plugin_platform_incompatible"
	codeCapabilityIncompatible      = "plugin_capability_incompatible"
	codeContributionDuplicate       = "plugin_contribution_duplicate"
	codeServiceDuplicate            = "plugin_service_duplicate"
	codeServiceVersionInvalid       = "plugin_service_version_invalid"
	codeRequirementDuplicate        = "plugin_requirement_duplicate"
	codeConfigSchemaInvalid         = "plugin_config_schema_invalid"
	codePermissionsRequired         = "plugin_permissions_required"
	codePermissionNetworkInvalid    = "plugin_permission_network_invalid"
	codePermissionFilesystemInvalid = "plugin_permission_filesystem_invalid"
)

var (
	manifestSchemaOnce  sync.Once
	manifestSchemaValue *Schema
	manifestSchemaErr   error
	capabilityVersions  = buildCapabilityVersions()
)

func buildCapabilityVersions() map[string]int {
	versions := make(map[string]int, len(plugincontract.Capabilities))
	for _, capability := range plugincontract.Capabilities {
		versions[capability.ID] = capability.Version
	}
	return versions
}

var accountCapabilities = map[string]bool{
	"account.source":      true,
	"account.login":       true,
	"account.refresh":     true,
	"account.materialize": true,
}

func compiledManifestSchema() (*Schema, error) {
	manifestSchemaOnce.Do(func() {
		manifestSchemaValue, manifestSchemaErr = CompileSchema([]byte(plugincontract.ManifestSchemaJSON))
	})
	return manifestSchemaValue, manifestSchemaErr
}

// ValidateManifest 与 Node lib/plugins/sdk/manifest.js 的 validateManifest 逐项对齐，
// 返回写入控制状态的规范化清单（permissions 补齐 environment、固定字段形状）。
func ValidateManifest(input any, options ManifestOptions) (map[string]any, error) {
	schema, err := compiledManifestSchema()
	if err != nil {
		// 合同 schema 自身编译失败是不可恢复的装配问题；安装必须 fail closed。
		return nil, pluginerr.New(codeManifestInvalid, "插件清单不符合公开合同")
	}
	if err := schema.Validate(input); err != nil {
		return nil, pluginerr.New(codeManifestInvalid, "插件清单不符合公开合同")
	}
	manifest, ok := input.(map[string]any)
	if !ok {
		return nil, pluginerr.New(codeManifestInvalid, "插件清单不符合公开合同")
	}
	entry, _ := manifest["entry"].(string)
	if !safeRelativePath(entry) {
		return nil, pluginerr.New(codeEntryInvalid, "插件入口必须为包内相对路径")
	}
	version, _ := manifest["version"].(string)
	if !validSemver(version) {
		return nil, pluginerr.New(codeVersionInvalid, "")
	}
	hostVersion := strings.TrimSpace(options.HostVersion)
	if hostVersion == "" {
		hostVersion = "1.0.0"
	}
	engines, _ := manifest["engines"].(map[string]any)
	aihRange, _ := engines["aih"].(string)
	if !validSemverRange(aihRange) || !satisfiesSemverRange(hostVersion, aihRange) {
		return nil, pluginerr.New(codeHostIncompatible, "")
	}
	if nodeRangeValue, present := engines["node"]; present {
		nodeRange, _ := nodeRangeValue.(string)
		if !validSemverRange(nodeRange) {
			return nil, pluginerr.New(codeNodeIncompatible, "")
		}
		nodeVersion := strings.TrimSpace(options.NodeVersion)
		if nodeVersion == "" || !satisfiesSemverRange(nodeVersion, nodeRange) {
			// 没有宿主 Node 版本时 fail closed：插件最终在 Node 里执行，
			// 不能在不知道宿主版本的情况下放行 engines.node 约束。
			return nil, pluginerr.New(codeNodeIncompatible, "")
		}
	}
	target := strings.TrimSpace(options.Target)
	if target == "" {
		target = nodePlatformTarget()
	}
	if targets, ok := manifest["targets"].([]any); ok && len(targets) > 0 {
		matched := false
		for _, item := range targets {
			value, _ := item.(string)
			if value == "any" || value == target {
				matched = true
				break
			}
		}
		if !matched {
			return nil, pluginerr.New(codePlatformIncompatible, "")
		}
	}
	contributionIDs := map[string]bool{}
	contributes, _ := manifest["contributes"].([]any)
	for _, item := range contributes {
		contribution, _ := item.(map[string]any)
		capability, _ := contribution["capability"].(string)
		requiredVersion, hasVersion := integerValue(contribution["version"])
		actualVersion, known := capabilityVersions[capability]
		if !known || !hasVersion || actualVersion != requiredVersion {
			return nil, pluginerr.New(codeCapabilityIncompatible, "")
		}
		id, _ := contribution["id"].(string)
		if contributionIDs[id] {
			return nil, pluginerr.New(codeContributionDuplicate, "")
		}
		contributionIDs[id] = true
	}
	serviceNames := map[string]bool{}
	if provides, ok := manifest["provides"].([]any); ok {
		for _, item := range provides {
			service, _ := item.(map[string]any)
			name, _ := service["name"].(string)
			if name == "aih" || serviceNames[name] {
				return nil, pluginerr.New(codeServiceDuplicate, "")
			}
			serviceVersion, _ := service["version"].(string)
			if !validSemver(serviceVersion) {
				return nil, pluginerr.New(codeServiceVersionInvalid, "")
			}
			serviceNames[name] = true
		}
	}
	requirementNames := map[string]bool{}
	if requires, ok := manifest["requires"].([]any); ok {
		for _, item := range requires {
			requirement, _ := item.(map[string]any)
			name, _ := requirement["name"].(string)
			if requirementNames[name] {
				return nil, pluginerr.New(codeRequirementDuplicate, "")
			}
			versionRange, _ := requirement["versionRange"].(string)
			if !validSemverRange(versionRange) {
				return nil, pluginerr.New(codeServiceVersionInvalid, "")
			}
			requirementNames[name] = true
		}
	}
	for _, name := range []string{"configSchema", "secretsSchema"} {
		value, present := manifest[name]
		if !present {
			continue
		}
		encoded, err := encodeJSONNoEscape(value)
		if err != nil {
			return nil, pluginerr.New(codeConfigSchemaInvalid, "")
		}
		if _, err := CompileSchema(encoded); err != nil {
			return nil, pluginerr.New(codeConfigSchemaInvalid, "")
		}
	}
	if err := validatePermissions(manifest); err != nil {
		return nil, err
	}
	return normalizeManifest(manifest), nil
}

func validatePermissions(manifest map[string]any) error {
	contributes, _ := manifest["contributes"].([]any)
	contributesAccount := false
	for _, item := range contributes {
		contribution, _ := item.(map[string]any)
		capability, _ := contribution["capability"].(string)
		if accountCapabilities[capability] {
			contributesAccount = true
			break
		}
	}
	permissions, present := manifest["permissions"]
	if !present || permissions == nil {
		if contributesAccount {
			return pluginerr.New(codePermissionsRequired, "账号插件必须显式声明 permissions（network / filesystem / secrets）")
		}
		return nil
	}
	object, ok := permissions.(map[string]any)
	if !ok {
		return pluginerr.New(codePermissionsRequired, "")
	}
	if network, ok := object["network"].([]any); ok {
		for _, item := range network {
			value, _ := item.(string)
			if !validNetworkPermission(value) {
				return pluginerr.New(codePermissionNetworkInvalid, "网络权限必须是 https 源："+value)
			}
		}
	}
	if filesystem, ok := object["filesystem"].(map[string]any); ok {
		for _, direction := range []string{"read", "write"} {
			scopes, _ := filesystem[direction].([]any)
			for _, item := range scopes {
				scope, _ := item.(string)
				if scope != "state" {
					return pluginerr.New(codePermissionFilesystemInvalid,
						fmt.Sprintf("文件系统权限只允许 state（插件私有状态），不允许 %s", scope))
				}
			}
		}
	}
	return nil
}

func validNetworkPermission(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return false
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	return parsed.Path == "" || parsed.Path == "/"
}

// filesystemPermissions / normalizedPermissions 的字段声明顺序就是 Node
// normalizePermissions 的 JSON.stringify 属性序：network、filesystem{read,write}、
// secrets、environment。permissionsFingerprint 是对这段 JSON 取 sha256，
// 用 map 序列化会按字典序排列，指纹就会与 Node 分叉。
type filesystemPermissions struct {
	Read  []string `json:"read"`
	Write []string `json:"write"`
}

type normalizedPermissions struct {
	Network     []string              `json:"network"`
	Filesystem  filesystemPermissions `json:"filesystem"`
	Secrets     []string              `json:"secrets"`
	Environment []string              `json:"environment"`
}

func normalizeManifest(input map[string]any) map[string]any {
	normalized := make(map[string]any, len(input))
	for key, value := range input {
		normalized[key] = value
	}
	permissions, ok := input["permissions"].(map[string]any)
	if !ok {
		return normalized
	}
	document, ok := permissionDocument(permissions)
	if !ok {
		return normalized
	}
	normalized["permissions"] = document
	return normalized
}

func permissionDocument(value any) (normalizedPermissions, bool) {
	switch typed := value.(type) {
	case normalizedPermissions:
		return typed, true
	case map[string]any:
		filesystem, _ := typed["filesystem"].(map[string]any)
		return normalizedPermissions{
			Network: stringValues(typed["network"]),
			Filesystem: filesystemPermissions{
				Read:  stringValues(filesystem["read"]),
				Write: stringValues(filesystem["write"]),
			},
			Secrets:     stringValues(typed["secrets"]),
			Environment: stringValues(typed["environment"]),
		}, true
	}
	return normalizedPermissions{}, false
}

func stringValues(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func integerValue(value any) (int, bool) {
	number, ok := numberValue(value)
	if !ok || number < 0 || math.Trunc(number) != number || number > math.MaxInt32 {
		return 0, false
	}
	return int(number), true
}

func nodePlatformTarget() string {
	return nodePlatformName(runtime.GOOS) + "-" + nodeArchName(runtime.GOARCH)
}

func nodePlatformName(goos string) string {
	switch goos {
	case "windows":
		return "win32"
	default:
		return goos
	}
}

func nodeArchName(goarch string) string {
	switch goarch {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	default:
		return goarch
	}
}

// PermissionFingerprint 与 Node permissionFingerprint 逐字节一致：
// sha256(JSON.stringify(normalizePermissions(input))).slice(0, 16)。
//
// 两个约束缺一不可：
//   - 字段顺序必须是 network、filesystem{read,write}、secrets、environment；
//   - 必须不转义 HTML（Node 的 JSON.stringify 不会把 < > & 写成 \u003c）。
//
// 任何一条不满足，enable 时会把已确认的权限判成未确认。
func PermissionFingerprint(manifest map[string]any) string {
	permissions, present := manifest["permissions"]
	if !present || permissions == nil {
		return ""
	}
	document, ok := permissionDocument(permissions)
	if !ok {
		return ""
	}
	encoded, err := encodeJSONNoEscape(document)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])[:16]
}

func encodeJSONNoEscape(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}
