// Package webuisessionslifecycleapi 提供 WebUI 会话生命周期的管理接口。
//
// 路由（管理面）：
//
//	GET  /v1/management/webui/sessions/lifecycle-capabilities
//	POST /v1/management/webui/sessions/archive
//
// capabilities 按 Provider 声明归档工作流（archive / listArchived / unarchive）
// 的原生支持情况，事实来源分三类：
//
//	codex         app-server 逐方法探测（thread/list、thread/archive、thread/unarchive）
//	claude/gemini 本包的会话文件归档（直接写 Provider 自己的会话目录）
//	其余 Provider 没有事实源，明确标成 unsupported 并给出原因
//
// 探测不到运行时（未接线或启动失败）时不能把「不知道」写成 unsupported：
// 此时 support 仍是 native，只把 available 置 false 并带上原因，前端据此把动作
// 置灰而不是隐藏。
//
// archive 把会话写入与已归档接口同一份存储：
//
//	claude  ~/.claude/projects/<dir>/<id>.jsonl        → <dir>/.archived/<id>.jsonl
//	gemini  ~/.gemini/tmp/<dir>/chats/<file>.json      → chats/.archived/<file>.json
//	codex   通过 app-server 的 thread/archive
//
// 重复归档是幂等操作：目标文件已存在或线程已归档时同样返回 200，不制造错误，
// 也不改写已有归档的修改时间。
package webuisessionslifecycleapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/codex/appserver"
)

const (
	// Path 是 WebUI 会话生命周期契约的公共前缀。
	Path = "/v1/management/webui/sessions"
	// LifecycleCapabilitiesSuffix 是能力声明的后缀。
	LifecycleCapabilitiesSuffix = "/lifecycle-capabilities"
	// ArchiveSuffix 是归档会话的后缀。
	ArchiveSuffix = "/archive"
	// UnarchiveSuffix 是恢复归档会话的后缀。
	UnarchiveSuffix = "/unarchive"

	// LifecycleCapabilitiesPath 是完整的能力声明契约路径。
	LifecycleCapabilitiesPath = Path + LifecycleCapabilitiesSuffix
	// ArchivePath 是完整的归档契约路径。
	ArchivePath = Path + ArchiveSuffix
	// UnarchivePath 是完整的恢复归档契约路径。
	UnarchivePath = Path + UnarchiveSuffix

	// maxBodyBytes 与 Node 的 readRequestBody({maxBytes: 64 * 1024}) 对齐。
	maxBodyBytes = 64 * 1024
	// maxSessionIDBytes 限制 sessionId 长度，避免构造超长路径。
	maxSessionIDBytes = 512
	// codexTimeout 是单次 Codex 会话（探测或归档）的总预算。
	codexTimeout = 15 * time.Second
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或宿主 HOME。
var ErrInvalidDependencies = errors.New("WebUI 会话生命周期接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// CodexClient 是 Codex app-server 的生命周期端口。
//
// internal/adapters/codex/appserver.Client 直接满足该接口；这里只声明本包用到
// 的方法，测试可以注入假实现而不启动子进程。
type CodexClient interface {
	ListArchivedThreads(ctx context.Context) ([]appserver.ArchivedThread, error)
	ArchiveThread(ctx context.Context, threadID string) error
	UnarchiveThread(ctx context.Context, threadID string) error
	ProbeCapabilities(ctx context.Context) (appserver.Capabilities, error)
	Close() error
}

// CodexDialer 每次调用建立一个可用的 app-server 会话。
//
// 与归档列表接口一致：二进制发现属于运行时策略，由注入方负责，本包不猜路径。
type CodexDialer func(ctx context.Context) (CodexClient, error)

// Dependencies 汇总生命周期接口依赖。
//
// Codex 为可选端口：未接线时 codex 的能力声明为「原生支持但当前不可用」，
// 归档请求返回 503，而不是伪装成 Provider 不支持。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是宿主 HOME，Claude / Gemini 的会话目录位于其下。
	HostHomeDir string
	// AIHomeDir 是 AI Home 数据目录；本切片不读写它，保留该字段是为了让
	// 接线形状与其它 WebUI 接口一致（统一由宿主注入）。
	AIHomeDir string
	// Providers 覆盖能力声明覆盖的 Provider 列表；为空时取 Provider 目录。
	Providers []string
	// Codex 建立 app-server 会话；为 nil 时 codex 走「不可用」降级。
	Codex CodexDialer
}

// Handler 处理能力声明与归档。
type Handler struct {
	authorizer  Authorizer
	hostHomeDir string
	providerIDs []string
	codex       CodexDialer
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)
	if dependencies.Authorizer == nil || hostHomeDir == "" {
		return nil, ErrInvalidDependencies
	}
	providerIDs, err := resolveProviderIDs(dependencies.Providers)
	if err != nil {
		return nil, err
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		hostHomeDir: hostHomeDir,
		providerIDs: providerIDs,
		codex:       dependencies.Codex,
	}, nil
}

// resolveProviderIDs 归一 Provider 列表：显式列表优先，否则读 Provider 目录。
func resolveProviderIDs(configured []string) ([]string, error) {
	if len(configured) > 0 {
		ids := make([]string, 0, len(configured))
		seen := make(map[string]struct{}, len(configured))
		for _, value := range configured {
			id := normalizeProvider(value)
			if id == "" {
				continue
			}
			if _, duplicated := seen[id]; duplicated {
				continue
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
		if len(ids) == 0 {
			return nil, ErrInvalidDependencies
		}
		return ids, nil
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	definitions := catalog.List()
	ids := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		ids = append(ids, definition.ID)
	}
	if len(ids) == 0 {
		return nil, ErrInvalidDependencies
	}
	return ids, nil
}

type capabilitiesResponse struct {
	OK        bool                          `json:"ok"`
	Providers map[string]providerCapability `json:"providers"`
}

type providerCapability struct {
	Provider          string       `json:"provider"`
	WorkflowAvailable bool         `json:"workflowAvailable"`
	Operations        operationSet `json:"operations"`
	Reason            string       `json:"reason,omitempty"`
}

// operationSet 的键名与顺序与 Node 的 OPERATIONS 常量一致。
type operationSet struct {
	Archive      operationCapability `json:"archive"`
	ListArchived operationCapability `json:"listArchived"`
	Unarchive    operationCapability `json:"unarchive"`
}

type operationCapability struct {
	Support   string `json:"support"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

type archiveResponse struct {
	OK              bool   `json:"ok"`
	Provider        string `json:"provider"`
	SessionID       string `json:"sessionId"`
	NativeSessionID string `json:"nativeSessionId,omitempty"`
	Origin          string `json:"origin"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// ServeHTTP 按路径分派能力声明与归档。
//
// 鉴权在方法判定之前，与其它 WebUI 管理接口一致：未带密钥的请求不应该从
// 405 / 404 的差异里推断出路由是否存在。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "session_lifecycle_unavailable", "原生会话生命周期服务未就绪")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	switch request.URL.Path {
	case LifecycleCapabilitiesPath:
		if request.Method != http.MethodGet {
			response.Header().Set("Allow", http.MethodGet)
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
			return
		}
		handler.serveCapabilities(response, request)
	case ArchivePath:
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
			return
		}
		handler.serveArchive(response, request)
	case UnarchivePath:
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
			return
		}
		handler.serveUnarchive(response, request)
	default:
		writeError(response, http.StatusNotFound, "unknown_path", "未知的会话生命周期路径")
	}
}

// serveCapabilities 返回所有 Provider 的能力声明。
func (handler *Handler) serveCapabilities(response http.ResponseWriter, request *http.Request) {
	writeJSON(response, http.StatusOK, capabilitiesResponse{
		OK:        true,
		Providers: handler.capabilities(request.Context()),
	})
}

// serveArchive 归档一个会话。
func (handler *Handler) serveArchive(response http.ResponseWriter, request *http.Request) {
	payload, err := readArchivePayload(request)
	if err != nil {
		writeLifecycleError(response, err)
		return
	}
	result, err := handler.archive(request.Context(), payload.Provider, payload.SessionID)
	if err != nil {
		writeLifecycleError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, archiveResponse{
		OK:              true,
		Provider:        result.Provider,
		SessionID:       result.SessionID,
		NativeSessionID: result.NativeSessionID,
		Origin:          result.Origin,
	})
}

// archiveRequest 是归档请求体，字段与 Node 的 archive({provider, sessionId}) 一致。
type archiveRequest struct {
	Provider  string `json:"provider"`
	SessionID string `json:"sessionId"`
	Origin    string `json:"origin,omitempty"`
}

func readArchivePayload(request *http.Request) (archiveRequest, error) {
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil {
		return archiveRequest{}, &lifecycleError{
			status:  http.StatusBadRequest,
			code:    "invalid_json",
			message: "请求 JSON 无效",
		}
	}
	if len(body) > maxBodyBytes {
		return archiveRequest{}, &lifecycleError{
			status:  http.StatusRequestEntityTooLarge,
			code:    "payload_too_large",
			message: "请求体超过 64KB",
		}
	}
	// Node 对空请求体返回 missing_params 而不是 invalid_json：空 body 是「没带参数」，
	// 不是「JSON 写错了」。
	if len(strings.TrimSpace(string(body))) == 0 {
		return archiveRequest{}, &lifecycleError{
			status:  http.StatusBadRequest,
			code:    "missing_params",
			message: "provider 和 sessionId 必填",
		}
	}
	var payload archiveRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		return archiveRequest{}, &lifecycleError{
			status:  http.StatusBadRequest,
			code:    "invalid_json",
			message: "请求 JSON 无效",
		}
	}
	payload.Provider = normalizeProvider(payload.Provider)
	payload.SessionID = strings.TrimSpace(payload.SessionID)
	payload.Origin = strings.ToLower(strings.TrimSpace(payload.Origin))
	if payload.Provider == "" || payload.SessionID == "" {
		return archiveRequest{}, &lifecycleError{
			status:  http.StatusBadRequest,
			code:    "missing_params",
			message: "provider 和 sessionId 必填",
		}
	}
	if !validSessionID(payload.SessionID) {
		return archiveRequest{}, &lifecycleError{
			status:  http.StatusBadRequest,
			code:    "invalid_session_id",
			message: "sessionId 必须是单段路径，不能包含分隔符或指向上级目录",
		}
	}
	return payload, nil
}

// validSessionID 只接受单段路径：拒绝空串、点目录、路径分隔符与控制字符。
//
// 归档要把 sessionId 直接拼进文件路径，放行 "../x" 就等于允许写出宿主 HOME。
func validSessionID(value string) bool {
	if value == "" || value == "." || value == ".." || len(value) > maxSessionIDBytes {
		return false
	}
	if strings.ContainsAny(value, "/\\\x00") {
		return false
	}
	for _, char := range value {
		if char < 0x20 || char == 0x7f {
			return false
		}
	}
	return true
}

// lifecycleError 是带 HTTP 状态与契约错误码的失败，写响应时统一投影。
type lifecycleError struct {
	status  int
	code    string
	message string
}

func (err *lifecycleError) Error() string {
	return err.message
}

func writeLifecycleError(response http.ResponseWriter, err error) {
	var lifecycle *lifecycleError
	if !errors.As(err, &lifecycle) {
		writeError(response, http.StatusInternalServerError, "session_lifecycle_failed", "会话生命周期操作失败")
		return
	}
	writeError(response, lifecycle.status, lifecycle.code, lifecycle.message)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: code, Message: message})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}

func normalizeProvider(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
