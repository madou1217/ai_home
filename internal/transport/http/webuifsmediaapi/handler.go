// Package webuifsmediaapi 是 WebUI 文件媒体预览的 HTTP 边界。
//
//	GET /v1/management/webui/fs/media?path=...&projectPath=...&source=...
//
// 对应 Node lib/server/webui-file-routes.js 的 handleReadFileMediaRequest：
// 授权判定与访问预检一致（internal/webuifile），但按媒体上限 15MB 放行，
// 并且只返回图片类型，避免这条路由变成任意二进制下载入口。
//
// 响应头、图片类型白名单与大小上限全部来自 internal/webuifile，本包只负责
// 查询参数、错误载荷与写回；项目快照与已信任目录通过 Dependencies 注入。
package webuifsmediaapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"

	"github.com/madou1217/ai_home/internal/webuifile"
)

// Path 是 WebUI 媒体文件读取的路由。
const Path = "/v1/management/webui/fs/media"

// ErrInvalidDependencies 表示 Handler 缺少鉴权依赖。
var ErrInvalidDependencies = errors.New("WebUI 媒体读取接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总媒体读取依赖。
type Dependencies struct {
	Authorizer Authorizer
	// Env 是访问策略的宿主环境：AIH 数据目录、宿主 HOME、图片临时目录，
	// 以及 provider 凭证投影路径改写。
	Env webuifile.Env
	// FS 为 nil 时使用本地文件系统；注入点用于确定性测试符号链接与凭证拒绝。
	FS webuifile.FS
	// ProjectPaths 返回服务端当前已登记项目的绝对路径（项目快照）。
	// 为 nil 时任何带 projectPath 的请求都按未登记处理。
	ProjectPaths func() []string
	// TrustedRoots 返回 app-state 中已信任的目录。为 nil 时视为没有信任项。
	TrustedRoots func() []webuifile.TrustedRoot
}

// Handler 处理媒体文件的读取。
type Handler struct {
	authorizer   Authorizer
	env          webuifile.Env
	fs           webuifile.FS
	projectPaths func() []string
	trustedRoots func() []webuifile.TrustedRoot
}

// NewHandler 创建媒体读取 Handler；缺少鉴权时拒绝装配。
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

// ServeHTTP 只接受 GET，按 handleReadFileMediaRequest 输出图片字节或 JSON 错误。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	// 与 Node disableFilePreviewCaching 一致：预览结果不允许被缓存，
	// 否则文件或授权变化后前端仍会拿到旧内容。
	response.Header().Set("Cache-Control", webuifile.CacheControlNoStore)
	response.Header().Set("Pragma", webuifile.PragmaNoCache)

	if handler == nil || handler.authorizer == nil || handler.fs == nil {
		writeError(response, http.StatusServiceUnavailable, "fs_media_unavailable", "媒体读取服务不可用")
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
		SizeLimit:   webuifile.MediaFileSizeLimit,
	}, trusted)
	if failure != nil {
		writeFileError(response, failure)
		return
	}

	headers, ok := webuifile.NewMediaHeaders(target.TargetPath, target.Stat.Size())
	if !ok {
		writeError(response, http.StatusUnsupportedMediaType, "unsupported_media_type", "当前仅支持预览图片文件")
		return
	}

	payload, err := os.ReadFile(target.ReadPath)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "read_media_failed", err.Error())
		return
	}

	response.Header().Set("Content-Type", headers.ContentType)
	response.Header().Set("Content-Length", strconv.FormatInt(headers.ContentLength, 10))
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(payload)
}

// writeFileError 把策略错误映射成 Node sendFileRequestError 的形状。
// Node 在该路由的 catch 里统一写 read_media_failed，因此 5xx 不透传 io_error。
func writeFileError(response http.ResponseWriter, failure *webuifile.FileError) {
	status := failure.Status
	code := failure.Code
	if status >= http.StatusInternalServerError {
		status = http.StatusInternalServerError
		code = "read_media_failed"
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
