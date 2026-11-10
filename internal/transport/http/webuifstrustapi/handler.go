// Package webuifstrustapi 是 WebUI 文件预览授权的管理 HTTP 边界。
//
// 对应 Node 的 POST /v0/webui/fs/trust（lib/server/webui-file-routes.js 的
// handleTrustFilePathRequest）：文件目标解析、凭证拒绝与候选范围派生全部复用
// internal/webuifile，本包只负责鉴权、请求体、错误形状与 app-state 落盘。
//
// 契约（与 Node 逐字段一致）：
//
//	POST /v1/management/webui/fs/trust
//	body: { path, source?, scope }，上限 64KB
//	200:  { ok: true, trustedRoot, filePath }
//	400:  { ok: false, error: "unsafe_trust_scope", message }
//
// 授权范围只接受服务端派生的 file_directory / parent_directory，客户端不能
// 直接提交目录路径。
package webuifstrustapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/webuifile"
)

const (
	// TrustPath 是可信目录写入的管理契约。
	TrustPath = "/v1/management/webui/fs/trust"
	// maxBodyBytes 与 Node handleTrustFilePathRequest 的 64KB 上限一致。
	maxBodyBytes = 64 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权或存储端口。
var ErrInvalidDependencies = errors.New("文件信任接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 读写 app-state.db 的 webui-file-trusted-roots。
type Store interface {
	ReadTrustedRoots(ctx context.Context) ([]webuifile.TrustedRoot, error)
	WriteTrustedRoots(ctx context.Context, roots []webuifile.TrustedRoot) error
}

// Dependencies 汇总可信目录写入依赖。
//
// FS 与 CanonicalizeProviderPath 可留空：默认本地文件系统、不做 provider 投影
// 改写，便于测试注入符号链接与投影拒绝场景。
type Dependencies struct {
	Authorizer               Authorizer
	Store                    Store
	AIHomeDir                string
	HostHomeDir              string
	FS                       webuifile.FS
	CanonicalizeProviderPath func(rawPath string) webuifile.ProviderPath
	Now                      func() time.Time
}

// Handler 处理可信目录写入。
type Handler struct {
	authorizer Authorizer
	store      Store
	fs         webuifile.FS
	env        webuifile.Env
	now        func() time.Time
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	fileSystem := dependencies.FS
	if fileSystem == nil {
		fileSystem = webuifile.OSFS{}
	}
	clock := dependencies.Now
	if clock == nil {
		clock = time.Now
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		store:      dependencies.Store,
		fs:         fileSystem,
		env: webuifile.Env{
			AIHomeDir:                dependencies.AIHomeDir,
			HostHomeDir:              dependencies.HostHomeDir,
			CanonicalizeProviderPath: dependencies.CanonicalizeProviderPath,
		},
		now: clock,
	}, nil
}

// payload 是 POST body；字段名与 Node 读取的 payload 一致。
type payload struct {
	Path   string
	Source string
	Scope  string
}

type trustResponse struct {
	OK          bool   `json:"ok"`
	TrustedRoot string `json:"trustedRoot"`
	FilePath    string `json:"filePath"`
}

type errorView struct {
	OK            bool               `json:"ok"`
	Error         string             `json:"error"`
	Message       string             `json:"message"`
	Authorization *authorizationView `json:"authorization,omitempty"`
}

type authorizationView struct {
	Required   bool                 `json:"required"`
	FilePath   string               `json:"filePath"`
	Candidates []trustCandidateView `json:"candidates"`
}

type trustCandidateView struct {
	Scope       string `json:"scope"`
	Path        string `json:"path"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// ServeHTTP 只接受带管理密钥的 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil || handler.fs == nil {
		writeError(response, http.StatusServiceUnavailable, "file_trust_unavailable", "文件信任服务不可用")
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

	body, bodyErr := decodePayload(response, request)
	switch {
	case errors.Is(bodyErr, errBodyTooLarge):
		// Node 的 readRequestBody 抛普通 Error，路由 catch 后统一成 500。
		writeError(response, http.StatusInternalServerError, "trust_file_path_failed", "request_body_too_large")
		return
	case bodyErr != nil:
		writeError(response, http.StatusBadRequest, "invalid_json", "请求内容不是有效 JSON")
		return
	}

	target, failure := webuifile.ResolveTarget(handler.fs, handler.env, body.Path, body.Source)
	if failure != nil {
		writeFileError(response, failure)
		return
	}

	scope := strings.TrimSpace(body.Scope)
	var candidate *webuifile.TrustCandidate
	for _, item := range webuifile.TrustCandidates(target.ReadPath, target.TrustBoundary) {
		if item.Scope == scope {
			matched := item
			candidate = &matched
			break
		}
	}
	if candidate == nil {
		writeError(response, http.StatusBadRequest, "unsafe_trust_scope", "所选文件夹范围不可授权")
		return
	}

	current, err := handler.store.ReadTrustedRoots(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "trust_file_path_failed", err.Error())
		return
	}
	next, trustedRoot, err := webuifile.AddTrustedRoot(current, candidate.Path, handler.now().UnixMilli())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "trust_file_path_failed", err.Error())
		return
	}
	// 已有覆盖项时 Node 直接复用，不重写 app-state。
	if rootsChanged(current, next) {
		if err := handler.store.WriteTrustedRoots(request.Context(), next); err != nil {
			writeError(response, http.StatusInternalServerError, "trust_file_path_failed", err.Error())
			return
		}
	}

	writeJSON(response, http.StatusOK, trustResponse{
		OK:          true,
		TrustedRoot: trustedRoot,
		FilePath:    target.ReadPath,
	})
}

var (
	errBodyTooLarge = errors.New("请求体过大")
	errInvalidJSON  = errors.New("请求体不是有效 JSON")
)

// decodePayload 读取上限 64KB 的 body。Node 用 JSON.parse，不校验 Content-Type，
// 因此这里也只做语法校验；空 body 与非法 JSON 同样落到 invalid_json。
func decodePayload(response http.ResponseWriter, request *http.Request) (payload, error) {
	var decoded payload
	if request.Body == nil {
		return decoded, errInvalidJSON
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBodyBytes)
	document, err := io.ReadAll(request.Body)
	if err != nil {
		var limitError *http.MaxBytesError
		if errors.As(err, &limitError) {
			return decoded, errBodyTooLarge
		}
		return decoded, errInvalidJSON
	}
	document = bytes.TrimSpace(document)
	if len(document) == 0 {
		return decoded, errInvalidJSON
	}
	var value any
	if err := json.Unmarshal(document, &value); err != nil {
		return decoded, errInvalidJSON
	}
	object, ok := value.(map[string]any)
	if !ok {
		// Node 对非对象 JSON 也继续走字段读取，等价于所有字段为空。
		return decoded, nil
	}
	decoded.Path = stringField(object, "path")
	decoded.Source = stringField(object, "source")
	decoded.Scope = stringField(object, "scope")
	return decoded, nil
}

func stringField(object map[string]any, key string) string {
	value, ok := object[key]
	if !ok {
		return ""
	}
	text, _ := value.(string)
	return text
}

// rootsChanged 用归一化后的当前列表与 AddTrustedRoot 的结果比较；命中覆盖项时
// 两者逐项相同，不需要写库。
func rootsChanged(current, next []webuifile.TrustedRoot) bool {
	normalized := webuifile.NormalizeTrustedRoots(current)
	if len(normalized) != len(next) {
		return true
	}
	for index := range normalized {
		if normalized[index] != next[index] {
			return true
		}
	}
	return false
}

// writeFileError 复刻 Node sendFileRequestError 的形状；500 级失败在 Node 里
// 是被路由 catch 的统一错误，因此改写成 trust_file_path_failed。
func writeFileError(response http.ResponseWriter, failure *webuifile.FileError) {
	if failure == nil {
		writeError(response, http.StatusInternalServerError, "trust_file_path_failed", "保存文件信任失败")
		return
	}
	if failure.Status >= http.StatusInternalServerError {
		writeError(response, failure.Status, "trust_file_path_failed", failure.Message)
		return
	}
	view := errorView{OK: false, Error: failure.Code, Message: failure.Message}
	if failure.Authorization != nil {
		candidates := make([]trustCandidateView, 0, len(failure.Authorization.Candidates))
		for _, item := range failure.Authorization.Candidates {
			candidates = append(candidates, trustCandidateView{
				Scope:       item.Scope,
				Path:        item.Path,
				Label:       item.Label,
				Description: item.Description,
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

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
