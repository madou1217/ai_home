// Package webuiproviderauthsourcesapi 提供「这台机器上每个认证方式能用哪些登录来源」只读契约。
//
// 契约来源：Node 的 GET /v0/webui/accounts/provider-auth-sources
// （lib/server/webui-account-routes.js → lib/account/auth-sources.js 的
// describeAuthMethodsWithSources）。响应键名、类型与缺省值与该端点逐字一致，
// 界面据此渲染「从本机导入」与安装提示，不自己判断环境。
//
// 数据边界：
//   - 来源清单是**声明**，不是探测结果：内置来源来自 Go 的 Provider 合同
//     （storagepolicy 的 authArtifacts + authOptions），与 Node 描述符逐条对齐的特殊来源
//     （kiro / cline / CodeBuddy 家族）声明在本包的 sources.go。
//   - 可用性只做**存在性判断**：宿主凭据产物 stat、CLI 走 LookPath + 安装落点 stat、
//     Kiro IDE 登录态 stat。不读凭据内容、不启动进程、不打开 App。
//   - 没有声明来源的 Provider 返回 supported=false 与空 methods（与 Node 一致），
//     绝不凭空造一个来源出来。
//
// 三块 Node 事实 Go 侧没有可信来源，整块留空并列入 unfilledFields：
//   - sources[].installable / methods[].installableSourceId：Node 问安装器注册表
//     （lib/server/app-installers）「这个平台有没有安装方案」，Go 没有等价声明，
//     一律 false——宁可少提示「装了就能导入」，也不猜一个装不上的方案。
//   - sources[].alreadyImported：去重指纹要读宿主凭据内容再算 identitySeed，
//     超出本包的探测边界（只判存在性），因此恒为 false。
//   - pluginSources：外部账号插件提供的登录来源只存在于 Node 的插件运行时，
//     Go 读不到；受此影响，只靠插件提供来源的 Provider 会返回 supported=false。
package webuiproviderauthsourcesapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// Path 是认证来源链只读契约的管理面路径。
//
//	GET /v1/management/webui/accounts/provider-auth-sources?provider=<id>
const Path = "/v1/management/webui/accounts/provider-auth-sources"

// derivedByGoPartial 标注响应只包含 Go 能证明的来源与可用性。
const derivedByGoPartial = "go_partial"

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或 Provider 合同。
var ErrInvalidDependencies = errors.New("认证来源接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总认证来源解析的依赖。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是宿主 HOME：宿主凭据产物与 Kiro IDE 登录态都相对它定位。
	// 空值表示不参与探测——此时本机来源一律不可用（绝不假设家目录存在）。
	HostHomeDir string
	// AIHomeDir 是 AI Home 数据根。Node 用它收集账号池里已入库的凭据指纹做去重；
	// 该判断需要读凭据内容，本包按「只判存在性」的边界不做，因此它当前不参与探测，
	// 保留字段只为与其它 WebUI 契约的接线形状一致。
	AIHomeDir string
	// LookPath 解析 PATH 上的可执行文件；为 nil 时使用 exec.LookPath。
	// 注入以便测试，无需依赖真实宿主安装。
	LookPath func(string) (string, error)
}

// Handler 是认证来源链的 HTTP 入站适配器。
type Handler struct {
	authorizer  Authorizer
	hostHomeDir string
	lookPath    func(string) (string, error)
	catalog     *providers.Catalog
	// searchDirs 是 LookPath 之外的固定安装落点候选目录。
	searchDirs []string
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, errors.Join(ErrInvalidDependencies, err)
	}
	lookPath := dependencies.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)
	return &Handler{
		authorizer:  dependencies.Authorizer,
		hostHomeDir: hostHomeDir,
		lookPath:    lookPath,
		catalog:     catalog,
		searchDirs:  defaultSearchDirs(hostHomeDir),
	}, nil
}

// methodView 是一个认证方式下的来源集合，字段名与 Node 一致。
type methodView struct {
	AuthMode             string       `json:"authMode"`
	Sources              []sourceView `json:"sources"`
	PreferredSourceID    string       `json:"preferredSourceId"`
	InstallableSourceID  string       `json:"installableSourceId"`
	LocalSourceAvailable bool         `json:"localSourceAvailable"`
}

// sourceView 是单个登录来源。
//
// implementation 在 Node 里是函数句柄（JSON.stringify 时要么被丢弃、要么是 null），
// 本身不可跨进程传递，Go 恒输出 null，保持键存在而类型不变。
type sourceView struct {
	ID              string `json:"id"`
	Kind            string `json:"kind"`
	ClientDependent bool   `json:"clientDependent"`
	RequiresApp     string `json:"requiresApp"`
	AuthMode        string `json:"authMode"`
	Handler         string `json:"handler"`
	PluginLogin     bool   `json:"pluginLogin"`
	DirectImport    bool   `json:"directImport"`
	Description     string `json:"description"`
	Available       bool   `json:"available"`
	Installable     bool   `json:"installable"`
	AlreadyImported bool   `json:"alreadyImported"`
	Reason          string `json:"reason"`
	Implementation  any    `json:"implementation"`
}

// responseView 是成功响应（含「该 Provider 没有来源声明」这一正常结果）。
type responseView struct {
	OK             bool         `json:"ok"`
	Supported      bool         `json:"supported"`
	Provider       string       `json:"provider"`
	Methods        []methodView `json:"methods"`
	DerivedBy      string       `json:"derivedBy"`
	UnfilledFields []string     `json:"unfilledFields"`
}

// errorView 是失败响应。
//
// error 是字符串而不是 {code,message}：Node 这个端点就返回 {ok:false,error:'missing_provider'}，
// web/src/services/api.ts 的 ProviderAuthSourcesResponse 也把 error 声明为 string。
type errorView struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.catalog == nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "provider_auth_sources_unavailable")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized")
		return
	}
	if request.Method != http.MethodGet {
		responseWriter.Header().Set("Allow", http.MethodGet)
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("provider")))
	if provider == "" {
		writeError(responseWriter, http.StatusBadRequest, "missing_provider")
		return
	}
	definition, known := handler.catalog.Get(provider)
	descriptors := []sourceDescriptor(nil)
	if known {
		descriptors = descriptorsFor(provider, definition)
	}
	writeJSON(responseWriter, http.StatusOK, responseView{
		OK:             true,
		Supported:      len(descriptors) > 0,
		Provider:       provider,
		Methods:        handler.describeMethods(provider, definition, descriptors),
		DerivedBy:      derivedByGoPartial,
		UnfilledFields: unfilledFields(),
	})
}

// unfilledFields 列出 Node 响应有、而本契约没有可信来源的键。
// 每次返回新切片，避免调用方改写共享状态。
func unfilledFields() []string {
	return []string{
		"sources[].installable",
		"methods[].installableSourceId",
		"sources[].alreadyImported",
		"pluginSources",
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string) {
	writeJSON(response, status, errorView{OK: false, Error: code})
}
