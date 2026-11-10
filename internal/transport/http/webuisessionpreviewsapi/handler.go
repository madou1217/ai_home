// Package webuisessionpreviewsapi 提供 WebUI 会话列表的「模型 + 最后消息预览」批量惰性读取。
//
// 契约来源是 Node lib/server/webui-session-routes.js 的 handleSessionPreviewsRequest
// （POST /v0/webui/sessions/previews）：
//
//	请求  { "sessions": [{ "provider", "id", "projectDirName"?, "accountRef"? }] }
//	响应  { "ok": true, "previews": [{ "provider", "id", "projectDirName"?, "accountRef"?,
//	                                  "model", "preview" }] }
//
// 该接口只服务「刚展开的分组里那几十个可见会话」，刻意不进入 projects 快照热路径：
// 调用方只送可见批次，服务端逐条惰性读取，读不出的条目留空而不是整批失败。
//
// 与 Node 的差异（有意为之，均为更严格的边界）：
//   - Node 把批次静默截到 40 条；本包超限直接 400，避免调用方以为全量返回。
//   - Node 吞掉每条读取错误只留空串；本包逐条返回 error 码，批量仍 200。
//   - Node 对非法 JSON 落到空批次；本包返回 400。
//
// 读取端口默认由 FileReader 实现（宿主 HOME 下的文本 transcript）；SQLite 承载的
// Provider 显式报 unsupported_provider，不猜格式。
package webuisessionpreviewsapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Path 是会话预览的管理契约路径。
//
//	POST /v1/management/webui/sessions/previews
const Path = "/v1/management/webui/sessions/previews"

const (
	// DefaultMaxBatch 是单次批量上限；超限返回 400。
	DefaultMaxBatch = 200
	// maxAllowedBatch 防止调用方把「上限」配成无界。
	maxAllowedBatch = 1000
	// DefaultConcurrency 是单批的并发读取数上限。
	DefaultConcurrency = 8
	// maxAllowedConcurrency 是并发上限的硬顶。
	maxAllowedConcurrency = 64
	// DefaultTimeout 是整批读取的整体超时。
	DefaultTimeout = 8 * time.Second
	// maxRequestBodyBytes 与 Node 的 readRequestBody 上限一致。
	maxRequestBodyBytes = 256 << 10
)

// 单条读取失败的错误码。它们是响应契约的一部分，不要随文案改动。
const (
	errorCodeUnsupportedProvider = "unsupported_provider"
	errorCodeSessionNotFound     = "session_not_found"
	errorCodeInvalidSessionRef   = "invalid_session_ref"
	errorCodeTimeout             = "timeout"
	errorCodeReadFailed          = "read_failed"
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权或读取端口。
var ErrInvalidDependencies = errors.New("会话预览接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总会话预览的依赖。
//
// Reader 为空时按 HostHomeDir 构造默认的 FileReader；两者都为空则构造失败。
type Dependencies struct {
	Authorizer  Authorizer
	HostHomeDir string
	Reader      Reader
	// MaxBatch 覆盖 DefaultMaxBatch（<=0 用默认值，>1000 按 1000 收）。
	MaxBatch int
	// Concurrency 覆盖 DefaultConcurrency（<=0 用默认值，>64 按 64 收）。
	Concurrency int
	// Timeout 覆盖 DefaultTimeout（<=0 用默认值）。
	Timeout time.Duration
	// MaxFileBytes 只在 Reader 为空、由本包构造 FileReader 时生效。
	MaxFileBytes int64
}

// Handler 是会话预览的 HTTP 入站适配器。
type Handler struct {
	authorizer  Authorizer
	reader      Reader
	maxBatch    int
	concurrency int
	timeout     time.Duration
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	reader := dependencies.Reader
	if reader == nil {
		home := strings.TrimSpace(dependencies.HostHomeDir)
		if home == "" {
			return nil, ErrInvalidDependencies
		}
		reader = &FileReader{HostHomeDir: home, MaxFileBytes: dependencies.MaxFileBytes}
	}
	maxBatch := dependencies.MaxBatch
	if maxBatch <= 0 {
		maxBatch = DefaultMaxBatch
	}
	if maxBatch > maxAllowedBatch {
		maxBatch = maxAllowedBatch
	}
	concurrency := dependencies.Concurrency
	if concurrency <= 0 {
		concurrency = DefaultConcurrency
	}
	if concurrency > maxAllowedConcurrency {
		concurrency = maxAllowedConcurrency
	}
	timeout := dependencies.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		reader:      reader,
		maxBatch:    maxBatch,
		concurrency: concurrency,
		timeout:     timeout,
	}, nil
}

// requestBody 是 POST 请求体；sessions 之外的键忽略。
type requestBody struct {
	Sessions []requestItem `json:"sessions"`
}

type requestItem struct {
	Provider       string `json:"provider"`
	ID             string `json:"id"`
	ProjectDirName string `json:"projectDirName"`
	AccountRef     string `json:"accountRef"`
}

// previewView 与 Node 的条目同形；error 是本包新增的逐条失败标注。
type previewView struct {
	Provider       string `json:"provider"`
	ID             string `json:"id"`
	ProjectDirName string `json:"projectDirName,omitempty"`
	AccountRef     string `json:"accountRef,omitempty"`
	Model          string `json:"model"`
	Preview        string `json:"preview"`
	Error          string `json:"error,omitempty"`
}

type responseView struct {
	OK       bool          `json:"ok"`
	Previews []previewView `json:"previews"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.reader == nil {
		writeError(response, http.StatusServiceUnavailable, "previews_unavailable", "会话预览服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST")
		return
	}

	items, ok := handler.decodeBatch(response, request)
	if !ok {
		return
	}
	writeJSON(response, http.StatusOK, responseView{
		OK:       true,
		Previews: handler.readPreviews(request.Context(), items),
	})
}

// decodeBatch 读取并校验请求体；返回 false 表示已经写过错误响应。
func (handler *Handler) decodeBatch(response http.ResponseWriter, request *http.Request) ([]requestItem, bool) {
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxRequestBodyBytes))
	var body requestBody
	if err := decoder.Decode(&body); err != nil {
		// 空体等价于空批次：Node 对 null payload 也返回 200 + 空数组。
		if errors.Is(err, io.EOF) {
			return nil, true
		}
		writeError(response, http.StatusBadRequest, "invalid_json_body", "请求体不是合法 JSON")
		return nil, false
	}
	if len(body.Sessions) > handler.maxBatch {
		writeError(response, http.StatusBadRequest, "too_many_sessions",
			"单批会话数超过上限 "+strconv.Itoa(handler.maxBatch))
		return nil, false
	}
	// 与 Node 一致：缺 provider 或 id 的条目直接跳过，不占位也不报错。
	items := make([]requestItem, 0, len(body.Sessions))
	for _, item := range body.Sessions {
		provider := strings.TrimSpace(item.Provider)
		sessionID := strings.TrimSpace(item.ID)
		if provider == "" || sessionID == "" {
			continue
		}
		items = append(items, requestItem{
			Provider:       provider,
			ID:             sessionID,
			ProjectDirName: strings.TrimSpace(item.ProjectDirName),
			AccountRef:     strings.TrimSpace(item.AccountRef),
		})
	}
	return items, true
}

// readPreviews 按输入顺序并发读取，单条失败只标注该条。
func (handler *Handler) readPreviews(parent context.Context, items []requestItem) []previewView {
	views := make([]previewView, len(items))
	if len(items) == 0 {
		return views
	}
	ctx, cancel := context.WithTimeout(parent, handler.timeout)
	defer cancel()

	results := make([]Preview, len(items))
	failures := make([]error, len(items))
	semaphore := make(chan struct{}, handler.concurrency)
	var wait sync.WaitGroup
	for index, item := range items {
		wait.Add(1)
		go func(index int, item requestItem) {
			defer wait.Done()
			select {
			case semaphore <- struct{}{}:
			case <-ctx.Done():
				failures[index] = ctx.Err()
				return
			}
			defer func() { <-semaphore }()
			results[index], failures[index] = handler.readOne(ctx, item)
		}(index, item)
	}
	wait.Wait()

	for index, item := range items {
		view := previewView{
			Provider: item.Provider,
			ID:       item.ID,
			Model:    results[index].Model,
			Preview:  results[index].Preview,
		}
		if item.ProjectDirName != "" {
			view.ProjectDirName = item.ProjectDirName
		}
		if item.AccountRef != "" {
			view.AccountRef = item.AccountRef
		}
		if failures[index] != nil {
			view.Error = previewErrorCode(failures[index])
		}
		views[index] = view
	}
	return views
}

// readOne 包一层 recover：单个 Reader 的 panic 不能带走整个进程。
func (handler *Handler) readOne(ctx context.Context, item requestItem) (preview Preview, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			preview = Preview{}
			err = ErrReadFailed
		}
	}()
	return handler.reader.ReadPreview(ctx, PreviewRequest{
		Provider:       item.Provider,
		SessionID:      item.ID,
		ProjectDirName: item.ProjectDirName,
		AccountRef:     item.AccountRef,
	})
}

// previewErrorCode 把读取错误翻成稳定错误码。
func previewErrorCode(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrUnsupportedProvider):
		return errorCodeUnsupportedProvider
	case errors.Is(err, ErrSessionNotFound):
		return errorCodeSessionNotFound
	case errors.Is(err, ErrInvalidSessionRef):
		return errorCodeInvalidSessionRef
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return errorCodeTimeout
	default:
		return errorCodeReadFailed
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
