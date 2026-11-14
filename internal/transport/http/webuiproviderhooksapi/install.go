package webuiproviderhooksapi

// POST /v1/management/webui/provider-hooks/install：显式安装 Provider 官方 Hook 配置。
//
// 与 Node 的 handleInstallProviderHooksRequest 对齐：
//   - dryRun=true 只计算补丁，不写任何文件；
//   - 非 dryRun 必须带 confirm=true（或 install-provider-session-hooks）；
//   - 一次可以安装多个 provider，逐个返回结果，任何一个失败都让整体 ok=false。
//
// 写盘细节在 hookconfig.go / opencode.go / codexfeatures.go；本文件只做鉴权、
// 请求体形状校验与结果装配。

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

const (
	// InstallPath 是显式安装 Hook 配置的管理契约路径。
	//
	//	POST /v1/management/webui/provider-hooks/install
	InstallPath = Path + "/install"

	// installConfirmToken 是非 dryRun 安装必须携带的确认值。
	installConfirmToken = "install-provider-session-hooks"

	// installBodyLimit 与 Node 的 64 KiB 上限一致。
	installBodyLimit = 64 * 1024
)

// ErrInvalidInstallDependencies 表示安装 Handler 缺少必需端口。
var ErrInvalidInstallDependencies = errors.New("Provider Hook 安装接口依赖无效")

// InstallDependencies 汇总安装所需的依赖。
type InstallDependencies struct {
	Authorizer  Authorizer
	Catalog     *providers.Catalog
	HostHomeDir string
}

// InstallHandler 是 Provider Hook 安装的 HTTP 入站适配器。
type InstallHandler struct {
	authorizer  Authorizer
	catalog     *providers.Catalog
	hostHomeDir string
}

// NewInstallHandler 校验依赖并创建 Handler；缺依赖时失败关闭。
func NewInstallHandler(dependencies InstallDependencies) (*InstallHandler, error) {
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)
	if dependencies.Authorizer == nil || dependencies.Catalog == nil || hostHomeDir == "" {
		return nil, ErrInvalidInstallDependencies
	}
	return &InstallHandler{
		authorizer:  dependencies.Authorizer,
		catalog:     dependencies.Catalog,
		hostHomeDir: hostHomeDir,
	}, nil
}

// codexFeaturesView 与 Node 安装结果的 codexFeatures 字段对齐。
type codexFeaturesView struct {
	Path           string `json:"path"`
	Changed        bool   `json:"changed"`
	FlagName       string `json:"flagName"`
	CodexVersion   string `json:"codexVersion"`
	DisabledBefore bool   `json:"disabledBefore"`
}

// installResult 是单个 Provider 的安装结果。
type installResult struct {
	OK       bool   `json:"ok"`
	Provider string `json:"provider"`
	Error    string `json:"error,omitempty"`
	Adapter  string `json:"adapter,omitempty"`
	// TargetPath / TargetKind 在成功时给出；错误结果不带。
	TargetPath    string             `json:"targetPath,omitempty"`
	TargetKind    string             `json:"targetKind,omitempty"`
	DryRun        *bool              `json:"dryRun,omitempty"`
	Changed       *bool              `json:"changed,omitempty"`
	Events        []string           `json:"events,omitempty"`
	ReceiverURL   string             `json:"receiverUrl,omitempty"`
	CodexFeatures *codexFeaturesView `json:"codexFeatures,omitempty"`
}

type installResponse struct {
	OK      bool            `json:"ok"`
	Results []installResult `json:"results"`
}

// ServeHTTP 只接受 POST。
func (handler *InstallHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.catalog == nil {
		writeError(response, http.StatusServiceUnavailable, "provider_hooks_unavailable", "Hook 安装服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}

	var payload map[string]any
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, installBodyLimit))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		writeError(response, http.StatusBadRequest, "invalid_payload", "")
		return
	}
	dryRun := payload["dryRun"] == true
	if !dryRun && !installConfirmed(payload["confirm"]) {
		writeError(response, http.StatusBadRequest, "confirm_required", "")
		return
	}
	providersToInstall := requestedProviders(payload)
	if len(providersToInstall) == 0 {
		writeError(response, http.StatusBadRequest, "provider_required", "")
		return
	}

	context := installContext{
		hostHomeDir:  handler.hostHomeDir,
		receiverURL:  textValue(payload["receiverUrl"]),
		codexVersion: textValue(payload["codexVersion"]),
	}
	results := make([]installResult, 0, len(providersToInstall))
	failed := false
	for _, provider := range providersToInstall {
		result := handler.installOne(provider, context, dryRun)
		if !result.OK {
			failed = true
		}
		results = append(results, result)
	}
	status := http.StatusOK
	if failed {
		status = http.StatusBadRequest
	}
	writeJSON(response, status, installResponse{OK: !failed, Results: results})
}

func (handler *InstallHandler) installOne(provider string, context installContext, dryRun bool) installResult {
	profile := resolveHookProfile(handler.catalog, provider)
	if !profile.supported {
		return installFailure(profile.providerID, "unsupported_provider")
	}
	switch profile.adapter {
	case providers.HookAdapterJSONHooks:
		return installJSONHookFile(profile, context, dryRun)
	case providers.HookAdapterAgyNamedHooks:
		return installAgyHookFile(profile, context, dryRun)
	case providers.HookAdapterOpenCodePlugin:
		return installOpenCodePluginHook(profile, context, dryRun)
	default:
		return installResult{
			OK:       false,
			Provider: profile.providerID,
			Error:    "unsupported_hook_adapter",
			Adapter:  string(profile.adapter),
		}
	}
}

// installConfirmed 与 Node 的确认判定一致：true 或约定字符串。
func installConfirmed(value any) bool {
	if value == true {
		return true
	}
	text, ok := value.(string)
	return ok && text == installConfirmToken
}

// requestedProviders 与 Node 的取值顺序一致：providers 数组优先，否则单个 provider。
func requestedProviders(payload map[string]any) []string {
	requested := []string{}
	if raw, isArray := payload["providers"].([]any); isArray {
		for _, item := range raw {
			if text := textValue(item); text != "" {
				requested = append(requested, text)
			}
		}
		return requested
	}
	if text := textValue(payload["provider"]); text != "" {
		requested = append(requested, text)
	}
	return requested
}

// textValue 与 Node 的 normalizeText(String(value)) 同口径：nil 为空，其它值转字符串。
func textValue(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}
