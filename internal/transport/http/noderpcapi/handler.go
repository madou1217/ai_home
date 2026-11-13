// Package noderpcapi 提供控制面（Desktop / 远程面板）只读设备聚合 RPC 接口。
//
// 路由同时挂载在两套前缀下，确保直连与 Node WebUI 代理均零回退互通：
//   - /v1/management/node-rpc/<op>
//   - /v1/management/webui/node-rpc/<op>
//
// 7 个操作（均仅支持 GET + 管理密钥 Bearer 鉴权）：
//   1. device-status
//   2. device-nodes
//   3. device-accounts
//   4. device-sessions
//   5. device-node-sessions
//   6. device-session-messages
//   7. device-node-session-messages
package noderpcapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountliveapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
)

const (
	// Prefix 是直连管理面的 node-rpc 路由前缀。
	Prefix = "/v1/management/node-rpc/"
	// WebUIPrefix 是经 Node WebUI Go-Core 代理（限定 /v1/management/webui/）调用时的路由前缀。
	WebUIPrefix = "/v1/management/webui/node-rpc/"

	rowsPageSize = 250
	rowsMaxPages = 1000
)

// ErrInvalidDependencies 表示 Handler 缺少必要的鉴权器。
var ErrInvalidDependencies = errors.New("node-rpc 接口依赖无效")

// Authorizer 校验管理面请求鉴权。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountOverviewStore 提供无 AccountRows 时的账号基础投影兜底读取。
type AccountOverviewStore interface {
	ListAccountOverviews(ctx context.Context, query accountapp.OverviewQuery) ([]accountapp.AccountOverview, error)
}

// ModelStampReader 读取模型目录最近更新时间戳。
type ModelStampReader interface {
	AccountModelCatalogStamp(ctx context.Context) (accountapp.AccountModelCatalogStamp, error)
}

// StatusExtras 允许组合根提供额外的网关运行态计数与就绪度信息。
type StatusExtras struct {
	Backend                string
	ProviderMode           string
	Strategy               string
	ModelsCached           int
	ModelsUpdatedAt        int64
	ModelRegistryUpdatedAt int64
	SuccessRate            float64
	TimeoutRate            float64
	TotalRequests          uint64
}

// Dependencies 汇总 node-rpc 聚合接口依赖。
type Dependencies struct {
	Authorizer       Authorizer
	AIHomeDir        string
	HostHomeDir      string
	Catalog          *providers.Catalog
	AccountRows      webuiaccountsapi.Source
	OverviewStore    AccountOverviewStore
	States           webuiaccountliveapi.StateSource
	Runtime          webuiaccountliveapi.RuntimeSource
	ModelStampReader ModelStampReader
	StatusExtras     func(ctx context.Context) StatusExtras
	Hostname         string
	StartedAt        time.Time
	Now              func() time.Time
}

// Handler 服务全部 /v1/management/(webui/)node-rpc/* 只读端点。
type Handler struct {
	authorizer       Authorizer
	aiHomeDir        string
	hostHomeDir      string
	catalog          *providers.Catalog
	accountRows      webuiaccountsapi.Source
	overviewStore    AccountOverviewStore
	states           webuiaccountliveapi.StateSource
	runtime          webuiaccountliveapi.RuntimeSource
	modelStampReader ModelStampReader
	statusExtras     func(ctx context.Context) StatusExtras
	hostname         string
	startedAt        time.Time
	now              func() time.Time
}

// NewHandler 校验依赖并构造 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	aiHome := strings.TrimSpace(dependencies.AIHomeDir)
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	if hostHome == "" && aiHome != "" {
		hostHome = filepath.Dir(filepath.Clean(aiHome))
	}
	if aiHome == "" && hostHome != "" {
		aiHome = filepath.Join(hostHome, ".ai_home")
	}
	hostname := strings.TrimSpace(dependencies.Hostname)
	if hostname == "" {
		if resolved, err := os.Hostname(); err == nil {
			hostname = strings.TrimSpace(resolved)
		}
	}
	nowFn := dependencies.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	startedAt := dependencies.StartedAt
	if startedAt.IsZero() {
		startedAt = nowFn()
	}
	return &Handler{
		authorizer:       dependencies.Authorizer,
		aiHomeDir:        aiHome,
		hostHomeDir:      hostHome,
		catalog:          dependencies.Catalog,
		accountRows:      dependencies.AccountRows,
		overviewStore:    dependencies.OverviewStore,
		states:           dependencies.States,
		runtime:          dependencies.Runtime,
		modelStampReader: dependencies.ModelStampReader,
		statusExtras:     dependencies.StatusExtras,
		hostname:         hostname,
		startedAt:        startedAt,
		now:              nowFn,
	}, nil
}

// ServeHTTP 鉴权后分发 7 个 node-rpc 操作，未知操作返回 404 rpc_not_found。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{
			"ok":    false,
			"error": "node_rpc_unavailable",
		})
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{
			"ok":    false,
			"error": "unauthorized",
		})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{
			"ok":    false,
			"error": "method_not_allowed",
		})
		return
	}

	op := extractRPCOp(request.URL.Path)
	switch op {
	case "device-status":
		handler.handleDeviceStatus(response, request)
	case "device-nodes":
		handler.handleDeviceNodes(response)
	case "device-accounts":
		handler.handleDeviceAccounts(response, request)
	case "device-sessions":
		handler.handleDeviceSessions(response, request)
	case "device-node-sessions":
		handler.handleDeviceNodeSessions(response, request)
	case "device-session-messages":
		handler.handleDeviceSessionMessages(response, request, false)
	case "device-node-session-messages":
		handler.handleDeviceSessionMessages(response, request, true)
	default:
		writeJSON(response, http.StatusNotFound, map[string]any{
			"ok":    false,
			"error": "rpc_not_found",
		})
	}
}

func extractRPCOp(urlPath string) string {
	switch {
	case strings.HasPrefix(urlPath, WebUIPrefix):
		return strings.TrimPrefix(urlPath, WebUIPrefix)
	case strings.HasPrefix(urlPath, Prefix):
		return strings.TrimPrefix(urlPath, Prefix)
	default:
		return strings.Trim(urlPath, "/")
	}
}

// DeriveDeviceID 与 Node deriveDeviceId 同一算法：'node-' + sha256(hostname + '|' + aiHomeDir).slice(0, 12)。
func DeriveDeviceID(hostname, aiHomeDir string) string {
	sum := sha256.Sum256([]byte(hostname + "|" + aiHomeDir))
	return "node-" + hex.EncodeToString(sum[:])[:12]
}

type providerStatusBucket struct {
	Total    int            `json:"total"`
	Active   int            `json:"active"`
	Statuses map[string]int `json:"statuses"`
}

type queueSnapshot struct {
	Name           string `json:"name"`
	Running        int    `json:"running"`
	Queued         int    `json:"queued"`
	MaxConcurrency int    `json:"maxConcurrency"`
	QueueLimit     int    `json:"queueLimit"`
	TotalScheduled int    `json:"totalScheduled"`
	TotalRejected  int    `json:"totalRejected"`
}

type queueTotalsView struct {
	Running        int `json:"running"`
	Queued         int `json:"queued"`
	TotalScheduled int `json:"totalScheduled"`
	TotalRejected  int `json:"totalRejected"`
}

type deviceAccountItem struct {
	AccountRef         string   `json:"accountRef"`
	Provider           string   `json:"provider"`
	Label              string   `json:"label"`
	Status             string   `json:"status"`
	AuthMode           string   `json:"authMode"`
	PlanType           string   `json:"planType"`
	RuntimeStatus      string   `json:"runtimeStatus"`
	QuotaStatus        string   `json:"quotaStatus"`
	SchedulableStatus  string   `json:"schedulableStatus"`
	RemainingPct       *float64 `json:"remainingPct"`
	ModelCooldownCount int      `json:"modelCooldownCount"`
	LastRefresh        int64    `json:"lastRefresh"`
	SuccessCount       int64    `json:"successCount"`
	FailCount          int64    `json:"failCount"`
}

func (handler *Handler) handleDeviceStatus(response http.ResponseWriter, request *http.Request) {
	ctx := request.Context()
	now := handler.now()
	accounts := handler.collectDeviceAccounts(ctx, now)

	statusTotals := map[string]int{
		"healthy":             0,
		"rate_limited":        0,
		"auth_invalid":        0,
		"overloaded":          0,
		"transient_network":   0,
		"service_unavailable": 0,
		"upstream_error":      0,
		"cooling_down":        0,
		"unknown":             0,
	}

	providersMap := make(map[string]*providerStatusBucket)
	queueMap := make(map[string]queueSnapshot)
	ensureProvider := func(provider string) *providerStatusBucket {
		if existing, ok := providersMap[provider]; ok {
			return existing
		}
		bucket := &providerStatusBucket{Statuses: map[string]int{}}
		providersMap[provider] = bucket
		queueMap[provider] = queueSnapshot{Name: provider}
		return bucket
	}
	if handler.catalog != nil {
		for _, def := range handler.catalog.List() {
			ensureProvider(def.ID)
		}
	}

	totalAccounts := len(accounts)
	activeAccounts := 0
	for _, acct := range accounts {
		bucket := ensureProvider(acct.Provider)
		bucket.Total++
		key := acct.RuntimeStatus
		if key == "" {
			key = "unknown"
		}
		bucket.Statuses[key] = bucket.Statuses[key] + 1
		if key == "healthy" {
			bucket.Active++
			activeAccounts++
		}
		if _, known := statusTotals[key]; known {
			statusTotals[key]++
		} else {
			statusTotals["unknown"]++
		}
	}
	cooldownAccounts := totalAccounts - activeAccounts

	extras := handler.resolveStatusExtras(ctx)
	uptimeSec := int64(now.Sub(handler.startedAt).Seconds())
	if uptimeSec < 0 {
		uptimeSec = 0
	}

	writeJSON(response, http.StatusOK, map[string]any{
		"ok":  true,
		"rpc": "control_plane.device.status",
		"result": map[string]any{
			"status": map[string]any{
				"ok":                     true,
				"service":                "aih-control-plane",
				"serverTime":             now.UTC().Format("2006-01-02T15:04:05.000Z"),
				"uptimeSec":              uptimeSec,
				"backend":                extras.Backend,
				"providerMode":           extras.ProviderMode,
				"strategy":               extras.Strategy,
				"totalAccounts":          totalAccounts,
				"activeAccounts":         activeAccounts,
				"cooldownAccounts":       cooldownAccounts,
				"statusTotals":           statusTotals,
				"providers":              providersMap,
				"queue":                  queueMap,
				"queueTotals":            queueTotalsView{},
				"modelsCached":           extras.ModelsCached,
				"modelsUpdatedAt":        extras.ModelsUpdatedAt,
				"modelRegistryUpdatedAt": extras.ModelRegistryUpdatedAt,
				"successRate":            extras.SuccessRate,
				"timeoutRate":            extras.TimeoutRate,
				"totalRequests":          extras.TotalRequests,
			},
		},
	})
}

func (handler *Handler) resolveStatusExtras(ctx context.Context) StatusExtras {
	extras := StatusExtras{
		Backend:      "go-core",
		ProviderMode: "account-pool",
		Strategy:     "round-robin",
	}
	if handler.statusExtras != nil {
		custom := handler.statusExtras(ctx)
		if strings.TrimSpace(custom.Backend) != "" {
			extras.Backend = custom.Backend
		}
		if strings.TrimSpace(custom.ProviderMode) != "" {
			extras.ProviderMode = custom.ProviderMode
		}
		if strings.TrimSpace(custom.Strategy) != "" {
			extras.Strategy = custom.Strategy
		}
		extras.ModelsCached = custom.ModelsCached
		extras.ModelsUpdatedAt = custom.ModelsUpdatedAt
		extras.ModelRegistryUpdatedAt = custom.ModelRegistryUpdatedAt
		extras.SuccessRate = custom.SuccessRate
		extras.TimeoutRate = custom.TimeoutRate
		extras.TotalRequests = custom.TotalRequests
	}
	if extras.Strategy == "round-robin" && handler.aiHomeDir != "" {
		if dbPath, err := appstate.DatabasePath(handler.aiHomeDir); err == nil {
			if raw, found, readErr := appstate.ReadKV(ctx, dbPath, "config:server"); readErr == nil && found {
				var cfg struct {
					Strategy string `json:"strategy"`
				}
				if json.Unmarshal([]byte(raw), &cfg) == nil && strings.TrimSpace(cfg.Strategy) != "" {
					extras.Strategy = strings.TrimSpace(cfg.Strategy)
				}
			}
		}
	}
	if extras.ModelsUpdatedAt == 0 && handler.modelStampReader != nil {
		if stamp, err := handler.modelStampReader.AccountModelCatalogStamp(ctx); err == nil && stamp.UpdatedAtMS > 0 {
			extras.ModelsUpdatedAt = stamp.UpdatedAtMS
		}
	}
	return extras
}

func (handler *Handler) handleDeviceNodes(response http.ResponseWriter) {
	nowMS := handler.now().UnixMilli()
	startedMS := handler.startedAt.UnixMilli()
	if startedMS <= 0 {
		startedMS = nowMS
	}
	id := DeriveDeviceID(handler.hostname, handler.aiHomeDir)
	node := map[string]any{
		"id":                  id,
		"name":                handler.hostname,
		"role":                "server",
		"endpointPolicy":      "direct",
		"preferredTransports": []string{"http"},
		"capabilities":        []string{"device.status", "device.accounts", "device.sessions"},
		"fingerprint":         id,
		"tags":                []string{},
		"disabled":            false,
		"lastSeenAt":          nowMS,
		"connection": map[string]any{
			"status":    "online",
			"kind":      "http",
			"lastError": "",
		},
		"createdAt":  startedMS,
		"updatedAt":  nowMS,
		"transports": []any{},
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":  true,
		"rpc": "control_plane.device.nodes",
		"result": map[string]any{
			"nodes": []any{node},
		},
	})
}

func (handler *Handler) handleDeviceAccounts(response http.ResponseWriter, request *http.Request) {
	ctx := request.Context()
	now := handler.now()
	accounts := handler.collectDeviceAccounts(ctx, now)

	byProvider := make(map[string]int)
	byRuntimeStatus := make(map[string]int)
	bySchedulableStatus := make(map[string]int)
	active := 0
	for _, acct := range accounts {
		if acct.Status == "up" {
			active++
		}
		byProvider[acct.Provider] = byProvider[acct.Provider] + 1
		key := acct.RuntimeStatus
		if key == "" {
			key = "unknown"
		}
		byRuntimeStatus[key] = byRuntimeStatus[key] + 1
		bySchedulableStatus[key] = bySchedulableStatus[key] + 1
	}

	writeJSON(response, http.StatusOK, map[string]any{
		"ok":  true,
		"rpc": "control_plane.device.accounts",
		"result": map[string]any{
			"accounts": accounts,
			"summary": map[string]any{
				"total":               len(accounts),
				"active":              active,
				"byProvider":          byProvider,
				"byRuntimeStatus":     byRuntimeStatus,
				"bySchedulableStatus": bySchedulableStatus,
			},
		},
	})
}

var accountBlockStatus = map[string]string{
	"credentials_updated": "auth_invalid",
	"usage_snapshot":      "rate_limited",
	"billing_snapshot":    "service_unavailable",
	"account_status":      "service_unavailable",
	"policy_snapshot":     "service_unavailable",
}

func (handler *Handler) collectDeviceAccounts(ctx context.Context, now time.Time) []deviceAccountItem {
	states := handler.loadAccountStates(ctx)
	runtimeViews := handler.loadRuntimeViews()
	nowMS := now.UnixMilli()

	if handler.accountRows != nil {
		rows := handler.loadAllAccountRows(ctx)
		if rows != nil {
			items := make([]deviceAccountItem, 0, len(rows))
			for _, row := range rows {
				ref := strings.TrimSpace(row.AccountRef)
				if ref == "" {
					continue
				}
				label := firstNonEmpty(row.DisplayName, row.Email, row.DisplayID, ref)
				status := "up"
				if !row.Enabled {
					status = "down"
				}
				authMode := "oauth"
				if row.APIKeyMode || isAPIKeyMode(row.AuthMode) {
					authMode = "api-key"
				}
				items = append(items, enrichDeviceAccount(deviceAccountItem{
					AccountRef:   ref,
					Provider:     row.Provider,
					Label:        label,
					Status:       status,
					AuthMode:     authMode,
					PlanType:     row.PlanType,
					RemainingPct: row.RemainingPct,
					LastRefresh:  row.UpdatedAt,
				}, states[ref], runtimeViews[ref], now, nowMS))
			}
			return items
		}
	}

	if handler.overviewStore == nil {
		return []deviceAccountItem{}
	}
	overviews := handler.loadAllOverviews(ctx)
	items := make([]deviceAccountItem, 0, len(overviews))
	for _, ov := range overviews {
		acct := ov.Account()
		ref := strings.TrimSpace(acct.Ref().String())
		if ref == "" {
			continue
		}
		label := firstNonEmpty(ov.DisplayName(), ov.Email(), ref)
		status := "up"
		if !acct.Enabled() {
			status = "down"
		}
		authMode := "oauth"
		if isAPIKeyMode(ov.AuthMode()) || isAPIKeyMode(ov.AuthKind()) {
			authMode = "api-key"
		}
		var remainingPct *float64
		if q, found := ov.QuotaState(); found && q.HasNumericRemaining() {
			val := float64(q.RemainingBPS()) / 100.0
			remainingPct = &val
		}
		items = append(items, enrichDeviceAccount(deviceAccountItem{
			AccountRef:   ref,
			Provider:     acct.ProviderID(),
			Label:        label,
			Status:       status,
			AuthMode:     authMode,
			PlanType:     ov.SubscriptionKind(),
			RemainingPct: remainingPct,
			LastRefresh:  acct.UpdatedAt().UnixMilli(),
		}, states[ref], runtimeViews[ref], now, nowMS))
	}
	return items
}

func enrichDeviceAccount(
	item deviceAccountItem,
	state runtimecore.AccountState,
	view runtimeapp.AccountView,
	now time.Time,
	nowMS int64,
) deviceAccountItem {
	runtimeStatus := "healthy"
	var successCount, failCount int64
	var lastRefresh = item.LastRefresh
	modelCooldownCount := 0

	if state.AccountRef().String() != "" {
		derived := state.DeriveStatus(now)
		if derived.Status() != "" {
			runtimeStatus = derived.Status()
		}
		var doc struct {
			SuccessCount   *float64           `json:"successCount"`
			FailCount      *float64           `json:"failCount"`
			LastRefresh    *float64           `json:"lastRefresh"`
			ModelCooldowns map[string]float64 `json:"modelCooldowns"`
		}
		if json.Unmarshal(state.Document(), &doc) == nil {
			if doc.SuccessCount != nil && !math.IsNaN(*doc.SuccessCount) {
				successCount = int64(*doc.SuccessCount)
			}
			if doc.FailCount != nil && !math.IsNaN(*doc.FailCount) {
				failCount = int64(*doc.FailCount)
			}
			if doc.LastRefresh != nil && !math.IsNaN(*doc.LastRefresh) && int64(*doc.LastRefresh) > lastRefresh {
				lastRefresh = int64(*doc.LastRefresh)
			}
			for _, until := range doc.ModelCooldowns {
				if int64(until) > nowMS {
					modelCooldownCount++
				}
			}
		}
		if stateMS := state.UpdatedAt().UnixMilli(); stateMS > lastRefresh {
			lastRefresh = stateMS
		}
	}
	for _, block := range view.Blocks {
		if mapped, ok := accountBlockStatus[string(block)]; ok {
			runtimeStatus = mapped
			break
		}
	}

	item.RuntimeStatus = runtimeStatus
	item.SchedulableStatus = runtimeStatus
	item.ModelCooldownCount = modelCooldownCount
	item.LastRefresh = lastRefresh
	item.SuccessCount = successCount
	item.FailCount = failCount
	return item
}

func (handler *Handler) loadAllAccountRows(ctx context.Context) []webuiaccountsapi.Row {
	rows := make([]webuiaccountsapi.Row, 0)
	afterRef := ""
	for page := 0; page < rowsMaxPages; page++ {
		res, err := handler.accountRows.ListAccountRows(ctx, webuiaccountsapi.Query{
			AfterRef: afterRef,
			Limit:    rowsPageSize,
		})
		if err != nil {
			return nil
		}
		rows = append(rows, res.Rows...)
		if len(res.Rows) < rowsPageSize {
			break
		}
		last := strings.TrimSpace(res.Rows[len(res.Rows)-1].AccountRef)
		if last == "" || last == afterRef {
			break
		}
		afterRef = last
	}
	return rows
}

func (handler *Handler) loadAllOverviews(ctx context.Context) []accountapp.AccountOverview {
	all := make([]accountapp.AccountOverview, 0)
	var afterRef accountcore.AccountRef
	for page := 0; page < rowsMaxPages; page++ {
		query, err := accountapp.NewOverviewQuery(afterRef, rowsPageSize)
		if err != nil {
			break
		}
		batch, err := handler.overviewStore.ListAccountOverviews(ctx, query)
		if err != nil || len(batch) == 0 {
			break
		}
		all = append(all, batch...)
		if len(batch) < rowsPageSize {
			break
		}
		next := batch[len(batch)-1].Account().Ref()
		if next.String() == "" || next.String() == afterRef.String() {
			break
		}
		afterRef = next
	}
	return all
}

func (handler *Handler) loadAccountStates(ctx context.Context) map[string]runtimecore.AccountState {
	out := make(map[string]runtimecore.AccountState)
	if handler.states == nil {
		return out
	}
	list, err := handler.states.ListAccountStates(ctx)
	if err != nil {
		return out
	}
	for _, st := range list {
		if ref := st.AccountRef().String(); ref != "" {
			out[ref] = st
		}
	}
	return out
}

func (handler *Handler) loadRuntimeViews() map[string]runtimeapp.AccountView {
	out := make(map[string]runtimeapp.AccountView)
	if handler.runtime == nil {
		return out
	}
	for _, v := range handler.runtime.RuntimeSnapshot() {
		if ref := v.AccountRef.String(); ref != "" {
			out[ref] = v
		}
	}
	return out
}

func (handler *Handler) handleDeviceSessions(response http.ResponseWriter, request *http.Request) {
	result := handler.buildDeviceSessions(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":     true,
		"rpc":    "control_plane.device.sessions",
		"result": result,
	})
}

func (handler *Handler) handleDeviceNodeSessions(response http.ResponseWriter, request *http.Request) {
	nodeID := strings.TrimSpace(request.URL.Query().Get("nodeId"))
	localID := DeriveDeviceID(handler.hostname, handler.aiHomeDir)
	var result deviceSessionsResult
	if nodeID != "" && nodeID != localID {
		result = emptyDeviceSessionsResult()
	} else {
		result = handler.buildDeviceSessions(request.Context())
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":     true,
		"rpc":    "control_plane.device.node_sessions",
		"nodeId": nodeID,
		"result": result,
	})
}

func (handler *Handler) handleDeviceSessionMessages(response http.ResponseWriter, request *http.Request, withNode bool) {
	q := request.URL.Query()
	sessionRef := strings.TrimSpace(q.Get("sessionRef"))
	limit, _ := strconv.Atoi(strings.TrimSpace(q.Get("limit")))
	if limit < 0 {
		limit = 0
	}
	debug := strings.TrimSpace(q.Get("debug")) == "1"

	result, found := handler.buildSessionMessages(request.Context(), sessionRef, limit, debug)
	if !found {
		writeJSON(response, http.StatusNotFound, map[string]any{
			"ok":    false,
			"error": "session_not_found",
		})
		return
	}

	if withNode {
		nodeID := strings.TrimSpace(q.Get("nodeId"))
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":     true,
			"rpc":    "control_plane.device.node_session_messages",
			"nodeId": nodeID,
			"result": result,
		})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":     true,
		"rpc":    "control_plane.device.session_messages",
		"result": result,
	})
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func sortedMapKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func isAPIKeyMode(mode string) bool {
	trimmed := strings.ToLower(strings.TrimSpace(mode))
	return trimmed == "api-key" || trimmed == "api_key"
}
