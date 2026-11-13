// Package webuiaccountliveapi 提供账号页的实时视图契约（watch / 快照刷新）。
//
// 路由（由共享 wiring 注册，本包只导出模式常量）：
//
//	GET  /v1/management/webui/accounts/watch
//	POST /v1/management/webui/accounts/watch/snapshot
//
// 本切片把账号页的**实时状态机**从 Node 搬到 Go：快照装配、revision、增量 diff、
// 订阅广播都在 Go 进程内；Node 只保留 SSE 协议外壳（鉴权、帧边界、心跳、本地瞬时
// 事件），不再自己轮询账号源。
//
// 行数据复用账号页读模型（webuiaccountsapi）：Go 是账号/凭据/额度/运行态的事实源，
// 读模型给什么就发什么；这里额外补齐 Node 行曾经独有的展示字段（status / 运行态 /
// 最近使用 / token 用量），让 watch 快照与列表行保持同一口径。
package webuiaccountliveapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/core/usageledger"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
)

const (
	// Path 是账号页实时事件流的管理契约路径。
	//
	//	Node: GET /v0/webui/accounts/watch
	Path = "/v1/management/webui/accounts/watch"
	// SnapshotPath 让前端请求一次强制重建并广播最新快照。
	//
	//	Node: POST /v0/webui/accounts/watch/snapshot
	SnapshotPath = Path + "/snapshot"

	// DefaultHeartbeat 与 Node 的 ACCOUNTS_WATCH_HEARTBEAT_MS 一致。
	DefaultHeartbeat = 30 * time.Second
	// accountWatchDebounce 合并同一批 SQLite 文件事件；事件驱动，不是轮询。
	accountWatchDebounce = 250 * time.Millisecond
	// accountWatchCoalesce 限制持续写 WAL 时的整表重建频率。
	accountWatchCoalesce = 2 * time.Second
	// defaultTokenUsageTTL 与 Node 的 GO_TOKEN_USAGE_TTL_MS 一致。
	defaultTokenUsageTTL = 60 * time.Second
	// tokenUsageRetryDelay 与 Node 的 GO_TOKEN_USAGE_RETRY_MS 一致。
	tokenUsageRetryDelay = 30 * time.Second
	// rowsPageSize 是读模型分页大小（与 Node 的 limit:200 一致）。
	rowsPageSize = 200
	// rowsMaxPages 防止异常数据把一次快照装配变成无限翻页。
	rowsMaxPages = 10
	// subscriberQueue 是单路订阅的投递缓冲；慢订阅者积压满即断开，浏览器会自行重连。
	subscriberQueue = 32
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("账号实时视图接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// RowSource 是账号页读模型的数据端口（由 *webuiaccountsapi.SQLiteSource 实现）。
type RowSource interface {
	ListAccountRows(ctx context.Context, query webuiaccountsapi.Query) (webuiaccountsapi.Result, error)
}

// RuntimeSource 返回 Go 进程内账号运行态（冷却 / 熔断 / 最近结果）。
type RuntimeSource interface {
	RuntimeSnapshot() []runtimeapp.AccountView
}

// StateSource 返回 Node 推进来的账号运行态文档（派生 status/reason/until）。
type StateSource interface {
	ListAccountStates(ctx context.Context) ([]runtimecore.AccountState, error)
}

// TokenUsageSource 提供按账号的 token 用量读取（由 *sqliteaccount.Store 实现）。
type TokenUsageSource interface {
	QueryAccountTokenUsage(
		ctx context.Context,
		query usageledger.Query,
		tzOffsetMinutes int,
	) (usageledger.AccountTokenUsage, error)
}

// Dependencies 汇总实时视图的依赖。Runtime / States / TokenUsage 可以为空：
// 缺省时对应字段留空，不影响事件流本身。
type Dependencies struct {
	Authorizer Authorizer
	Rows       RowSource
	Runtime    RuntimeSource
	States     StateSource
	TokenUsage TokenUsageSource
	Catalog    *providers.Catalog
	// AIHomeDir 是 aih.db 所在的数据根，事件源只监听这里的数据库文件。
	AIHomeDir string
	// Heartbeat / Now 是测试时钟；空值时使用生产默认。
	Heartbeat time.Duration
	Now       func() time.Time
}

// Handler 是账号实时视图的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	hub        *Hub
	heartbeat  time.Duration
}

// NewHandler 校验依赖并启动后台刷新工人（没有订阅者时工人不扫描数据库）。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Rows == nil {
		return nil, ErrInvalidDependencies
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	heartbeat := dependencies.Heartbeat
	if heartbeat <= 0 {
		heartbeat = DefaultHeartbeat
	}
	hub := newHub(hubOptions{
		rows:       dependencies.Rows,
		runtime:    dependencies.Runtime,
		states:     dependencies.States,
		tokenUsage: dependencies.TokenUsage,
		catalog:    dependencies.Catalog,
		aiHomeDir:  dependencies.AIHomeDir,
		now:        now,
	})
	return &Handler{authorizer: dependencies.Authorizer, hub: hub, heartbeat: heartbeat}, nil
}

// Close 停止后台刷新工人；生产进程随 server 退出，测试用它回收 goroutine。
func (handler *Handler) Close() {
	if handler == nil || handler.hub == nil {
		return
	}
	handler.hub.close()
}

// Publish 把一条非账号帧广播到同一条事件流。
//
// 账号页上的瞬时作业（例如导入作业的 queued/running/终态）不在快照里，也不该
// 让浏览器另开轮询：它们和账号增量共用一条 SSE，浏览器只需要一个订阅。
// 没有订阅者时广播是空操作，不会为「没人看」的作业保留任何队列。
func (handler *Handler) Publish(payload any) {
	if handler == nil || handler.hub == nil {
		return
	}
	handler.hub.broadcastFrame(payload)
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorResponse struct {
	OK    bool      `json:"ok"`
	Error errorBody `json:"error"`
}

type snapshotResponse struct {
	OK             bool  `json:"ok"`
	Accepted       bool  `json:"accepted"`
	AlreadyRunning bool  `json:"alreadyRunning"`
	RequestedAt    int64 `json:"requestedAt"`
}

// ServeHTTP 同时服务事件流 GET 与快照刷新 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.hub == nil {
		writeError(response, http.StatusServiceUnavailable, "webui_accounts_watch_unavailable", "账号实时视图不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.URL.Path == SnapshotPath {
		handler.serveSnapshotRequest(response, request)
		return
	}
	handler.serveWatch(response, request)
}

func (handler *Handler) serveSnapshotRequest(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持请求快照刷新")
		return
	}
	requestedAt, alreadyRunning := handler.hub.requestRefresh()
	writeJSON(response, http.StatusAccepted, snapshotResponse{
		OK: true, Accepted: true, AlreadyRunning: alreadyRunning, RequestedAt: requestedAt,
	})
}

func (handler *Handler) serveWatch(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持事件流")
		return
	}
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, "streaming_unsupported", "当前连接不支持事件流")
		return
	}
	// 先挂事件源再装配快照：watcher 建立后的写入一定会进订阅队列，不会在
	// 「读快照完成 → 订阅建立」之间丢掉。首帧 snapshot 仍先于队列读出，因此
	// 不会出现「account 事件先到、旧 snapshot 后到」的覆盖。
	subscriber := handler.hub.subscribe()
	snapshot, revision, err := handler.hub.ensureSnapshot(request.Context())
	if err != nil {
		handler.hub.unsubscribe(subscriber)
		writeError(response, http.StatusServiceUnavailable, "webui_accounts_watch_unavailable", "账号实时视图数据源不可用")
		return
	}
	defer handler.hub.unsubscribe(subscriber)

	header := response.Header()
	header.Set("Content-Type", "text/event-stream; charset=utf-8")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	flusher.Flush()

	writeSseJSON(response, map[string]any{"type": "connected"})
	writeSseJSON(response, snapshotFrame{
		Type:                       "snapshot",
		Revision:                   revision,
		Accounts:                   snapshot,
		Hydrating:                  false,
		ProviderNativeCapabilities: handler.hub.capabilities(),
	})
	flusher.Flush()

	heartbeat := time.NewTicker(handler.heartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-subscriber.done:
			return
		case <-heartbeat.C:
			if !writeSseComment(response, "heartbeat") {
				return
			}
			flusher.Flush()
		case payload, open := <-subscriber.events:
			if !open {
				return
			}
			if _, err := response.Write(payload); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

type snapshotFrame struct {
	Type                       string                     `json:"type"`
	Revision                   int64                      `json:"revision"`
	Accounts                   []webuiaccountsapi.Row     `json:"accounts"`
	Hydrating                  bool                       `json:"hydrating"`
	ProviderNativeCapabilities map[string]json.RawMessage `json:"providerNativeCapabilities"`
}

type accountFrame struct {
	Type     string               `json:"type"`
	Revision int64                `json:"revision"`
	Account  webuiaccountsapi.Row `json:"account"`
}

type accountRemovedFrame struct {
	Type       string `json:"type"`
	Revision   int64  `json:"revision"`
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	Reason     string `json:"reason"`
	RemovedAt  int64  `json:"removedAt"`
}

type hydratedFrame struct {
	Type       string `json:"type"`
	Revision   int64  `json:"revision"`
	HydratedAt int64  `json:"hydratedAt"`
}

type snapshotRequestedFrame struct {
	Type        string `json:"type"`
	Revision    int64  `json:"revision"`
	RequestedAt int64  `json:"requestedAt"`
	Hydrating   bool   `json:"hydrating"`
}

func writeSseJSON(response http.ResponseWriter, payload any) bool {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	return writeSseFrame(response, "data: "+string(encoded)+"\n\n")
}

func writeSseComment(response http.ResponseWriter, comment string) bool {
	return writeSseFrame(response, ": "+strings.TrimSpace(comment)+"\n\n")
}

func writeSseFrame(response http.ResponseWriter, frame string) bool {
	if response == nil {
		return false
	}
	if _, err := response.Write([]byte(frame)); err != nil {
		return false
	}
	return true
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: errorBody{Code: code, Message: message}})
}

func unixMilli(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.UnixMilli()
}

func sortedRefs(rows map[string]webuiaccountsapi.Row) []string {
	refs := make([]string, 0, len(rows))
	for ref := range rows {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	return refs
}

// numberFromAny 把 JSON 解出来的数字（float64 / json.Number / int）折成整数。
func numberFromAny(value any) int64 {
	switch typed := value.(type) {
	case float64:
		if typed > 0 {
			return int64(typed)
		}
	case int64:
		if typed > 0 {
			return typed
		}
	case int:
		if typed > 0 {
			return int64(typed)
		}
	case json.Number:
		if parsed, err := typed.Int64(); err == nil && parsed > 0 {
			return parsed
		}
	case string:
		if parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64); err == nil && parsed > 0 {
			return parsed
		}
	}
	return 0
}
