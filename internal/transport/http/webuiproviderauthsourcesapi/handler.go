// Package webuiproviderauthsourcesapi 提供「这台机器上每个认证方式能用哪些登录来源」只读契约。
//
// 契约来源：Node 的 GET /v0/webui/accounts/provider-auth-sources
// （lib/server/webui-account-routes.js → lib/account/auth-sources.js 的
// describeAuthMethodsWithSources）。响应键名、类型与缺省值与该端点逐字一致，
// 界面据此渲染「从本机导入」「装上客户端就能导入」「已入库」三种状态，
// 不自己判断环境。
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
// 四块「Node 有、Go 不能自己算」的事实通过可选端口注入，注入即由 Go 投影，
// 未注入则显式列入 unfilledFields（绝不假装算过）：
//   - installable / installableSourceId：Node 问安装器注册表（lib/server/app-installers）
//     「这个平台有没有安装方案」。Go 没有注册表，默认按 Provider 合同的安装声明判定
//     （见 canInstall：CLI 要有可分发包，桌面端要有该平台的安装落点），宿主也可以注入
//     CanInstall 换成更权威的答案。
//   - alreadyImported：去重要读宿主凭据内容并派生身份种子，超出本包「只判存在性」的边界。
//     两个端口一起注入才生效：ExistingIdentities 给账号池里该 Provider 已入库账号的种子，
//     LocalSourceIdentity 给某个本机来源当前登录态的种子（都由宿主用官方 artifact 解码器派生）。
//   - pluginSources：外部账号插件提供的登录来源只存在于 Node 的插件运行时。注入 PluginSources
//     后这些来源与内置来源同形进入 methods（按同一排序与分组规则），否则只靠插件提供来源的
//     Provider 会返回 supported=false，调用方据此回落到 Node 实现。
package webuiproviderauthsourcesapi

import (
	"context"
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

const (
	// derivedByGo 标注响应全部字段都由 Go 自己证明（端口齐全）。
	derivedByGo = "go"
	// derivedByGoPartial 标注响应里仍有 Node 才能证明的键（见 unfilledFields）。
	derivedByGoPartial = "go_partial"
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或 Provider 合同。
var ErrInvalidDependencies = errors.New("认证来源接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// PluginSource 是外部账号插件声明的登录来源。
//
// 字段与 Node 的插件来源（lib/plugins/account/auth-sources.js 的 toAuthSourceDescriptor）
// 一一对应：插件只传 JSON，宿主把它转成这个值交给 Go，Go 与内置来源按同一规则排序分组。
// Identity 是插件自报的账号指纹；空串表示该来源不参与「已入库」去重。
type PluginSource struct {
	ID              string
	Kind            string
	ClientDependent bool
	RequiresApp     string
	AuthMode        string
	DirectImport    bool
	// PluginLogin 表示这个来源的登录任务走插件的 /plugin-login，而不是内置 auth job。
	PluginLogin bool
	Description string
	// Available 是插件自报的可用性（插件才知道宿主登录态/设备环境）。
	//
	// nil 表示插件没有声明可用性——按 Node 的 source.available !== false，这种情况视为可用；
	// 用指针而不是布尔，就是为了让「没声明」与「声明不可用」不会被压成同一个 false。
	Available *bool
	Identity  string
}

// Dependencies 汇总认证来源解析的依赖。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是宿主 HOME：宿主凭据产物与 Kiro IDE 登录态都相对它定位。
	// 空值表示不参与探测——此时本机来源一律不可用（绝不假设家目录存在）。
	HostHomeDir string
	// AIHomeDir 是 AI Home 数据根。只有注入 ExistingIdentities 时才会被宿主用来读账号池；
	// 本包自己不开数据库连接。
	AIHomeDir string
	// LookPath 解析 PATH 上的可执行文件；为 nil 时使用 exec.LookPath。
	// 注入以便测试，无需依赖真实宿主安装。
	LookPath func(string) (string, error)
	// CanInstall 判定「这个平台有没有该 Provider 这一类客户端的安装方案」。
	// app 取 cli / desktop；为 nil 时按 Provider 合同的安装声明判定（见 canInstall）。
	CanInstall func(provider, app string) bool
	// ExistingIdentities 返回账号池里该 Provider 已入库账号的身份种子集合。
	// 为空 Map 表示该 Provider 还没有账号；返回错误时本包按「没有账号」处理（fail-open：
	// 宁可多显示一个导入入口，也不把可用来源误标成已入库）。
	ExistingIdentities func(ctx context.Context, provider string) (map[string]struct{}, error)
	// LocalSourceIdentity 返回某个本机来源当前登录态的身份种子。
	// 第二个返回值 false 表示读不出来（凭据缺失/格式不受支持），此时不做去重判断。
	LocalSourceIdentity func(ctx context.Context, provider, sourceID string) (string, bool)
	// PluginSources 返回外部账号插件为该 Provider 声明的登录来源。
	PluginSources func(ctx context.Context, provider string) ([]PluginSource, error)
}

// Handler 是认证来源链的 HTTP 入站适配器。
type Handler struct {
	authorizer         Authorizer
	hostHomeDir        string
	lookPath           func(string) (string, error)
	catalog            *providers.Catalog
	canInstallOverride func(provider, app string) bool
	identities         func(ctx context.Context, provider string) (map[string]struct{}, error)
	sourceIdentity     func(ctx context.Context, provider, sourceID string) (string, bool)
	pluginSources      func(ctx context.Context, provider string) ([]PluginSource, error)
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
		authorizer:         dependencies.Authorizer,
		hostHomeDir:        hostHomeDir,
		lookPath:           lookPath,
		catalog:            catalog,
		canInstallOverride: dependencies.CanInstall,
		identities:         dependencies.ExistingIdentities,
		sourceIdentity:     dependencies.LocalSourceIdentity,
		pluginSources:      dependencies.PluginSources,
		searchDirs:         defaultSearchDirs(hostHomeDir),
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
	descriptors = append(descriptors, handler.pluginDescriptors(request.Context(), provider)...)
	writeJSON(responseWriter, http.StatusOK, responseView{
		OK:             true,
		Supported:      len(descriptors) > 0,
		Provider:       provider,
		Methods:        handler.describeMethods(request.Context(), provider, definition, descriptors),
		DerivedBy:      handler.derivedBy(),
		UnfilledFields: handler.unfilledFields(),
	})
}

// derivedBy 标注这次响应是否仍然依赖 Node 才能补全的键。
func (handler *Handler) derivedBy() string {
	if len(handler.unfilledFields()) > 0 {
		return derivedByGoPartial
	}
	return derivedByGo
}

// unfilledFields 列出 Node 响应有、而这次响应没有可信来源的键。
//
// 端口注入后对应的键就不再是缺口——名单由注入状态派生，而不是写死一份「永远缺」的清单，
// 否则补齐了也还在对外宣称缺失。每次返回新切片，避免调用方改写共享状态。
func (handler *Handler) unfilledFields() []string {
	fields := make([]string, 0, 2)
	if handler.sourceIdentity == nil || handler.identities == nil {
		fields = append(fields, "sources[].alreadyImported")
	}
	if handler.pluginSources == nil {
		fields = append(fields, "pluginSources")
	}
	return fields
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
