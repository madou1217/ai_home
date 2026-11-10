package webuiarchivedsessionsapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

const (
	// Path 是已归档会话只读视图的管理契约。
	//
	//	GET /v1/management/webui/sessions/archived
	Path = "/v1/management/webui/sessions/archived"

	// ScopeLegacy 表示响应只包含历史归档（Claude / Gemini 文件）；
	// Codex 原生归档读取失败时保持该值，并在 errors 里声明失败。
	ScopeLegacy = "legacy"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("归档会话接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是宿主 HOME，历史归档位于其 .claude/.gemini 下。
	HostHomeDir string
	// CodexCommand 解析 Codex app-server 启动方式；为 nil 时
	// 响应会在 errors 里报 codex_command_unavailable。
	CodexCommand CodexCommandResolver
}

// Handler 处理已归档会话读取。
type Handler struct {
	authorizer   Authorizer
	hostHomeDir  string
	codexCommand CodexCommandResolver
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)
	if dependencies.Authorizer == nil || hostHomeDir == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:   dependencies.Authorizer,
		hostHomeDir:  hostHomeDir,
		codexCommand: dependencies.CodexCommand,
	}, nil
}

type responseView struct {
	OK       bool            `json:"ok"`
	Scope    string          `json:"scope"`
	Archived []Entry         `json:"archived"`
	Errors   []archivedError `json:"errors"`
}

type archivedError struct {
	Provider string `json:"provider"`
	Error    string `json:"error"`
	Message  string `json:"message,omitempty"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "archived_sessions_unavailable", "归档会话服务不可用")
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
	archived := scanLegacyArchives(handler.hostHomeDir)
	failures := make([]archivedError, 0, 1)
	scope := ScopeLegacy
	codexEntries, codexErr := handler.listCodexArchived(request.Context())
	if codexErr != nil {
		failures = append(failures, providerError(providerCodex, codexErr))
	} else {
		archived = append(archived, codexEntries...)
		scope = ScopeAll
	}
	sortEntries(archived)

	writeJSON(response, http.StatusOK, responseView{
		OK:       true,
		Scope:    scope,
		Archived: archived,
		Errors:   failures,
	})
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
