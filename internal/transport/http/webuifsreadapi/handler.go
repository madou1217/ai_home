// Package webuifsreadapi 是 WebUI 文本文件读取的 HTTP 边界。
//
//	GET /v1/management/webui/fs/read?path=...&projectPath=...&source=...
//
// 对应 Node lib/server/webui-file-routes.js 的 handleReadFileRequest：
// 按文本上限（5MB）授权后返回 {ok,path,content,size,mtime}，并固定关闭缓存。
// 授权、项目登记、信任目录与错误形状全部委托 internal/webuifile；本包只负责
// 查询参数、读取动作与响应编码。
package webuifsreadapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"

	"github.com/madou1217/ai_home/internal/webuifile"
)

// Path 是 WebUI 文本文件读取的路由契约。
const Path = "/v1/management/webui/fs/read"

// ErrInvalidDependencies 表示 Handler 缺少鉴权依赖。
var ErrInvalidDependencies = errors.New("WebUI 文件读取接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总读取依赖。
type Dependencies struct {
	Authorizer Authorizer
	// Env 是访问策略的宿主环境：AIH 数据目录、宿主 HOME、图片临时目录，
	// 以及 provider 凭证投影路径改写。
	Env webuifile.Env
	// FS 为 nil 时使用本地文件系统；注入点用于确定性测试符号链接与凭证拒绝。
	FS webuifile.FS
	// ReadFile 为 nil 时使用 os.ReadFile；注入失败用于测试 500 形状。
	ReadFile func(name string) ([]byte, error)
	// ProjectPaths 返回服务端当前已登记项目的绝对路径（项目快照）。
	ProjectPaths func() []string
	// TrustedRoots 返回 app-state 中已信任的目录。为 nil 时视为没有信任项。
	TrustedRoots func() []webuifile.TrustedRoot
}

// Handler 处理文本文件读取。
type Handler struct {
	authorizer   Authorizer
	env          webuifile.Env
	fs           webuifile.FS
	readFile     func(name string) ([]byte, error)
	projectPaths func() []string
	trustedRoots func() []webuifile.TrustedRoot
}

// NewHandler 创建读取 Handler；缺少鉴权时拒绝装配。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	fs := dependencies.FS
	if fs == nil {
		fs = webuifile.OSFS{}
	}
	readFile := dependencies.ReadFile
	if readFile == nil {
		readFile = os.ReadFile
	}
	return &Handler{
		authorizer:   dependencies.Authorizer,
		env:          dependencies.Env,
		fs:           fs,
		readFile:     readFile,
		projectPaths: dependencies.ProjectPaths,
		trustedRoots: dependencies.TrustedRoots,
	}, nil
}

type readView struct {
	OK      bool   `json:"ok"`
	Path    string `json:"path"`
	Content string `json:"content"`
	Size    int64  `json:"size"`
	Mtime   int64  `json:"mtime"`
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

// ServeHTTP 只接受 GET，并按 Node 的 handleReadFileRequest 输出
// {ok,path,content,size,mtime} 或 {ok:false,error,message,authorization?}。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	// 与 Node disableFilePreviewCaching 一致：内容不允许被缓存，
	// 否则授权或文件变化后前端仍会拿到旧内容。
	response.Header().Set("Cache-Control", webuifile.CacheControlNoStore)
	response.Header().Set("Pragma", webuifile.PragmaNoCache)

	if handler == nil || handler.authorizer == nil || handler.fs == nil || handler.readFile == nil {
		writeError(response, http.StatusServiceUnavailable, "fs_read_unavailable", "文件读取服务不可用")
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
		// read 路由是文本读取，所以按文本上限而不是媒体上限判定。
		SizeLimit: webuifile.TextFileSizeLimit,
	}, trusted)
	if failure != nil {
		writeFileError(response, failure)
		return
	}

	payload, err := handler.readFile(target.ReadPath)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "read_file_failed", err.Error())
		return
	}

	writeJSON(response, http.StatusOK, readView{
		OK:      true,
		Path:    target.TargetPath,
		Content: string(payload),
		Size:    target.Stat.Size(),
		Mtime:   target.Stat.ModTime().UnixMilli(),
	})
}

// writeFileError 把策略错误映射成 Node sendFileRequestError 的形状。
func writeFileError(response http.ResponseWriter, failure *webuifile.FileError) {
	view := errorView{OK: false, Error: failure.Code, Message: failure.Message}
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
	writeJSON(response, failure.Status, view)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
