// Package webuifsaccessapi 是 WebUI 文件预览前的访问预检 HTTP 边界。
//
//	GET /v1/management/webui/fs/access?path=...&projectPath=...&source=...
//
// 对应 Node lib/server/webui-file-routes.js 的 handleCheckFileAccessRequest：
// 不读取文件内容，只回答「这个路径能否预览」。前端在把路径交给 <img>/<video>
// 直接加载之前先打这条路由，才能拿到结构化的 403 授权载荷，而不是浏览器里
// 一个无法解析的失败响应。
//
// 判定全部委托 internal/webuifile；本包只负责查询参数、媒体大小上限（15MB）、
// 响应形状与缓存头。项目快照与 app-state 里的已信任目录属于宿主存储职责，
// 通过 Dependencies 注入，避免在本包复制第二份存储语义。
package webuifsaccessapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/internal/webuifile"
)

// Path 是 WebUI 媒体预览的访问预检契约。
const Path = "/v1/management/webui/fs/access"

// ErrInvalidDependencies 表示 Handler 缺少鉴权依赖。
var ErrInvalidDependencies = errors.New("WebUI 文件访问检查接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总访问预检依赖。
type Dependencies struct {
	Authorizer Authorizer
	// Env 是访问策略的宿主环境：AIH 数据目录、宿主 HOME、图片临时目录，
	// 以及 provider 凭证投影路径改写。
	Env webuifile.Env
	// FS 为 nil 时使用本地文件系统；注入点用于确定性测试符号链接与凭证拒绝。
	FS webuifile.FS
	// ProjectPaths 返回服务端当前已登记项目的绝对路径（项目快照）。
	// 对应 Node 的 getCompleteProjectSnapshot；为 nil 时任何带 projectPath
	// 的请求都按未登记处理。
	ProjectPaths func() []string
	// TrustedRoots 返回 app-state 中已信任的目录。为 nil 时视为没有信任项。
	TrustedRoots func() []webuifile.TrustedRoot
}

// Handler 处理媒体文件的访问预检。
type Handler struct {
	authorizer   Authorizer
	env          webuifile.Env
	fs           webuifile.FS
	projectPaths func() []string
	trustedRoots func() []webuifile.TrustedRoot
}

// NewHandler 创建访问预检 Handler；缺少鉴权时拒绝装配。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	fs := dependencies.FS
	if fs == nil {
		fs = webuifile.OSFS{}
	}
	return &Handler{
		authorizer:   dependencies.Authorizer,
		env:          dependencies.Env,
		fs:           fs,
		projectPaths: dependencies.ProjectPaths,
		trustedRoots: dependencies.TrustedRoots,
	}, nil
}

type accessView struct {
	OK    bool   `json:"ok"`
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

type errorView struct {
	OK            bool               `json:"ok"`
	Error         string             `json:"error"`
	Message       string             `json:"message"`
	Authorization *authorizationView `json:"authorization,omitempty"`
}

type authorizationView struct {
	Required   bool            `json:"required"`
	FilePath   string          `json:"filePath"`
	Candidates []candidateView `json:"candidates"`
}

type candidateView struct {
	Scope       string `json:"scope"`
	Path        string `json:"path"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// ServeHTTP 只接受 GET，并按 Node 的 handleCheckFileAccessRequest 输出
// {ok,path,size,mtime} 或 {ok:false,error,message,authorization?}。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	// 与 Node disableFilePreviewCaching 一致：预检结果不允许被缓存，
	// 否则授权或文件变化后前端仍会拿到旧的 403/200。
	response.Header().Set("Cache-Control", webuifile.CacheControlNoStore)
	response.Header().Set("Pragma", webuifile.PragmaNoCache)

	if handler == nil || handler.authorizer == nil || handler.fs == nil {
		writeError(response, http.StatusServiceUnavailable, "fs_access_unavailable", "文件访问检查服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}

	registry := webuifile.NewProjectRoots(nil)
	if handler.projectPaths != nil {
		registry = webuifile.NewProjectRoots(handler.projectPaths())
	}
	var trusted []webuifile.TrustedRoot
	if handler.trustedRoots != nil {
		trusted = webuifile.NormalizeTrustedRoots(handler.trustedRoots())
	}

	query := request.URL.Query()
	target, failure := webuifile.ResolveAuthorized(handler.fs, handler.env, registry, webuifile.Request{
		RawPath:     query.Get("path"),
		ProjectPath: query.Get("projectPath"),
		Source:      query.Get("source"),
		// access 路由是媒体预览的预检，所以按媒体上限而不是文本上限判定。
		SizeLimit: webuifile.MediaFileSizeLimit,
	}, trusted)
	if failure != nil {
		writeFileError(response, failure)
		return
	}

	writeJSON(response, http.StatusOK, accessView{
		OK:    true,
		Path:  target.TargetPath,
		Size:  target.Stat.Size(),
		Mtime: target.Stat.ModTime().UnixMilli(),
	})
}

// writeFileError 把策略错误映射成 Node sendFileRequestError 的形状。
// Node 在该路由的 catch 里统一写 check_file_access_failed，因此 5xx 不透传 io_error。
func writeFileError(response http.ResponseWriter, failure *webuifile.FileError) {
	status := failure.Status
	code := failure.Code
	if status >= http.StatusInternalServerError {
		status = http.StatusInternalServerError
		code = "check_file_access_failed"
	}
	view := errorView{OK: false, Error: code, Message: failure.Message}
	if failure.Authorization != nil {
		candidates := make([]candidateView, 0, len(failure.Authorization.Candidates))
		for _, candidate := range failure.Authorization.Candidates {
			candidates = append(candidates, candidateView{
				Scope:       candidate.Scope,
				Path:        candidate.Path,
				Label:       candidate.Label,
				Description: candidate.Description,
			})
		}
		view.Authorization = &authorizationView{
			Required:   failure.Authorization.Required,
			FilePath:   failure.Authorization.FilePath,
			Candidates: candidates,
		}
	}
	writeJSON(response, status, view)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
