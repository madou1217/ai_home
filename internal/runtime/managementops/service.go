package managementops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/accountstate"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/webuimodelssnapshot"
)

// AccountRowPort 是账号行读模型的窄接口，由 transport/adapter 层适配注入。
type AccountRowPort interface {
	ListManagementAccountRows(ctx context.Context) ([]ManagementAccount, error)
}

// MetricsSnapshotPort 提供进程实时请求与队列指标。
type MetricsSnapshotPort interface {
	SnapshotMetrics() MetricsResponse
	SnapshotSessionAffinity() map[string]int
}

// ModelRefreshOutcome 描述一次模型目录刷新结果。
type ModelRefreshOutcome struct {
	UpdatedAtMS     int64
	Models          []string
	ScannedAccounts int
	Sources         int
	Source          string
	FirstError      string
}

// ModelCatalogPort 提供模型目录读取与按需上游刷新能力。
type ModelCatalogPort interface {
	RefreshModels(ctx context.Context) (ModelRefreshOutcome, error)
}

// ServerRestarterPort 触发宿主服务进程重启。
type ServerRestarterPort interface {
	RestartServer(ctx context.Context) (RestartResponse, error)
}

// ManagementOptions 配置 ManagementService。
type ManagementOptions struct {
	AIHomeDir        string
	HostHomeDir      string
	Catalog          *providers.Catalog
	Store            *sqliteaccount.Store
	AccountRuntime   any
	AccountRows      AccountRowPort
	Metrics          MetricsSnapshotPort
	ModelCatalog     ModelCatalogPort
	Restarter        ServerRestarterPort
	UsageStore       *UsageStore
	Host             string
	Port             int
	APIKeyConfigured bool
	ProviderMode     string
	Strategy         string
	Now              func() time.Time
	StartedAt        time.Time
}

type modelsCacheState struct {
	mu              sync.RWMutex
	updatedAt       int64
	models          []string
	scannedAccounts int
	sources         int
	source          string
	firstError      string
	signature       string
}

// ManagementService 聚合 Go Core 的管理面状态、账号运行态、模型目录、重载/冷却清理与状态索引维护。
type ManagementService struct {
	aiHomeDir        string
	hostHomeDir      string
	catalog          *providers.Catalog
	store            *sqliteaccount.Store
	accountRuntime   any
	accountRows      AccountRowPort
	metrics          MetricsSnapshotPort
	modelCatalog     ModelCatalogPort
	restarter        ServerRestarterPort
	usageStore       *UsageStore
	host             string
	port             int
	apiKeyConfigured bool
	providerMode     string
	strategy         string
	now              func() time.Time
	startedAt        time.Time

	modelsCache modelsCacheState
	mu          sync.RWMutex
	watchHub      *WatchHub
	usageJobsOnce sync.Once
	usageJobs     *UsageJobManager
}

// NewManagementService 创建管理面核心服务。
func NewManagementService(opts ManagementOptions) *ManagementService {
	host := strings.TrimSpace(opts.Host)
	if host == "" {
		host = DefaultServerHost
	}
	port := opts.Port
	if port <= 0 || port > 65535 {
		port = DefaultServerPort
	}
	providerMode := strings.TrimSpace(opts.ProviderMode)
	if providerMode == "" {
		providerMode = "auto"
	}
	strategy := strings.TrimSpace(opts.Strategy)
	if strategy == "" {
		strategy = "round_robin"
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	startedAt := opts.StartedAt
	if startedAt.IsZero() {
		startedAt = nowFn()
	}
	svc := &ManagementService{
		aiHomeDir:        strings.TrimSpace(opts.AIHomeDir),
		hostHomeDir:      strings.TrimSpace(opts.HostHomeDir),
		catalog:          opts.Catalog,
		store:            opts.Store,
		accountRuntime:   opts.AccountRuntime,
		accountRows:      opts.AccountRows,
		metrics:          opts.Metrics,
		modelCatalog:     opts.ModelCatalog,
		restarter:        opts.Restarter,
		usageStore:       opts.UsageStore,
		host:             host,
		port:             port,
		apiKeyConfigured: opts.APIKeyConfigured,
		providerMode:     providerMode,
		strategy:         strategy,
		now:              nowFn,
		startedAt:        startedAt,
	}
	svc.watchHub = NewWatchHub(svc)
	return svc
}

// Watch 返回关联的 SSE 监听枢纽。
func (s *ManagementService) Watch() *WatchHub {
	if s == nil {
		return nil
	}
	return s.watchHub
}

// UsageStore 返回绑定的模型用量存储实例。
func (s *ManagementService) UsageStore() *UsageStore {
	if s == nil {
		return nil
	}
	return s.usageStore
}

// UsageJobs 返回关联的模型用量异步扫描与渐进看板查询作业管理器。
func (s *ManagementService) UsageJobs() *UsageJobManager {
	if s == nil {
		return nil
	}
	s.usageJobsOnce.Do(func() {
		s.usageJobs = NewUsageJobManager(s)
	})
	return s.usageJobs
}

// AIHomeDir 返回当前配置的数据根目录。
func (s *ManagementService) AIHomeDir() string {
	if s == nil {
		return ""
	}
	return s.aiHomeDir
}

// HostHomeDir 返回宿主机用户目录。
func (s *ManagementService) HostHomeDir() string {
	if s == nil {
		return ""
	}
	return s.hostHomeDir
}

// ProviderIDs 返回已登记的规范 Provider ID 顺序列表。
func (s *ManagementService) ProviderIDs() []string {
	var defs []providers.Definition
	if s != nil && s.catalog != nil {
		defs = s.catalog.List()
	} else {
		defs = providers.BuiltinManifest().Providers
	}
	ids := make([]string, 0, len(defs))
	seen := make(map[string]struct{}, len(defs))
	for _, def := range defs {
		id := strings.ToLower(strings.TrimSpace(def.ID))
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids
}

// SupportsUsageScan 判定指定 Provider 是否声明支持本地用量扫描。
func (s *ManagementService) SupportsUsageScan(provider string) bool {
	target := strings.ToLower(strings.TrimSpace(provider))
	if target == "" {
		return false
	}
	if s != nil && s.catalog != nil {
		return s.catalog.Supports(target, providers.CapabilityUsageScan)
	}
	for _, def := range providers.BuiltinManifest().Providers {
		if strings.EqualFold(def.ID, target) {
			for _, capItem := range def.Capabilities {
				if capItem == providers.CapabilityUsageScan {
					return true
				}
			}
			return false
		}
	}
	return false
}

// Status 返回 /v0/management/status 的完整状态快照。
func (s *ManagementService) Status(ctx context.Context) StatusResponse {
	if s == nil {
		return StatusResponse{OK: false}
	}
	accountsResp, _ := s.Accounts(ctx)
	providerIDs := s.ProviderIDs()
	providersMap := make(map[string]ProviderStatus, len(providerIDs))
	for _, p := range providerIDs {
		providersMap[p] = ProviderStatus{Statuses: map[string]int{}}
	}
	var totals StatusTotals
	total := 0
	active := 0
	for _, acct := range accountsResp.Accounts {
		p := strings.ToLower(strings.TrimSpace(acct.Provider))
		if p == "" {
			p = "unknown"
		}
		ps, ok := providersMap[p]
		if !ok {
			ps = ProviderStatus{Statuses: map[string]int{}}
		}
		ps.Total++
		total++
		rs := strings.TrimSpace(acct.RuntimeStatus)
		if rs == "" {
			rs = "unknown"
		}
		ps.Statuses[rs]++
		if rs == "healthy" {
			ps.Active++
			active++
		}
		incrementStatusTotals(&totals, rs)
		providersMap[p] = ps
	}

	metrics := s.Metrics(ctx)
	affinity := map[string]int{}
	if s.metrics != nil {
		for k, v := range s.metrics.SnapshotSessionAffinity() {
			affinity[k] = v
		}
	}
	stickyTotal := 0
	for _, p := range providerIDs {
		v := affinity[p]
		affinity[p] = v
		stickyTotal += v
	}
	affinity["total"] = stickyTotal

	s.modelsCache.mu.RLock()
	modelsCached := len(s.modelsCache.models)
	modelsUpdatedAt := s.modelsCache.updatedAt
	s.modelsCache.mu.RUnlock()

	var registryUpdatedAt int64
	if s.store != nil {
		if stamp, err := s.store.AccountModelCatalogStamp(ctx); err == nil {
			registryUpdatedAt = stamp.UpdatedAtMS
			if modelsUpdatedAt == 0 {
				modelsUpdatedAt = stamp.UpdatedAtMS
			}
		}
		if modelsCached == 0 {
			if catalog, err := s.store.ListAllAccountModels(ctx); err == nil {
				modelsCached = countEffectiveCatalogModels(catalog)
			}
		}
	}

	uptime := int64(s.now().Sub(s.startedAt).Seconds())
	if uptime < 0 {
		uptime = 0
	}

	return StatusResponse{
		OK:                     true,
		Backend:                "go-core",
		Host:                   s.host,
		Port:                   s.port,
		APIKeyConfigured:       s.apiKeyConfigured,
		ProviderMode:           s.providerMode,
		Strategy:               s.strategy,
		TotalAccounts:          total,
		ActiveAccounts:         active,
		CooldownAccounts:       total - active,
		StatusTotals:           totals,
		Providers:              providersMap,
		SessionAffinity:        affinity,
		Queue:                  metrics.Queue,
		ModelsCached:           modelsCached,
		ModelsUpdatedAt:        modelsUpdatedAt,
		ModelRegistryUpdatedAt: registryUpdatedAt,
		SuccessRate:            metrics.SuccessRate,
		TimeoutRate:            metrics.TimeoutRate,
		TotalRequests:          metrics.TotalRequests,
		UptimeSec:              uptime,
	}
}

func incrementStatusTotals(totals *StatusTotals, status string) {
	switch status {
	case "healthy":
		totals.Healthy++
	case "rate_limited":
		totals.RateLimited++
	case "auth_invalid":
		totals.AuthInvalid++
	case "overloaded":
		totals.Overloaded++
	case "transient_network":
		totals.TransientNetwork++
	case "service_unavailable":
		totals.ServiceUnavailable++
	case "upstream_error":
		totals.UpstreamError++
	case "cooling_down":
		totals.CoolingDown++
	default:
		totals.Unknown++
	}
}

// Metrics 返回 /v0/management/metrics 指标快照。
func (s *ManagementService) Metrics(ctx context.Context) MetricsResponse {
	providerIDs := s.ProviderIDs()
	base := MetricsResponse{
		OK:               true,
		RouteCounts:      map[string]uint64{},
		ProviderCounts:   map[string]uint64{},
		ProviderSuccess:  map[string]uint64{},
		ProviderFailures: map[string]uint64{},
		Queue:            map[string]QueueSnapshot{},
		LastErrors:       []map[string]any{},
		AccountActivity:  map[string]any{},
	}
	if s != nil && s.metrics != nil {
		snap := s.metrics.SnapshotMetrics()
		base.TotalRequests = snap.TotalRequests
		base.TotalSuccess = snap.TotalSuccess
		base.TotalFailures = snap.TotalFailures
		base.TotalTimeouts = snap.TotalTimeouts
		base.SuccessRate = roundTo4(snap.SuccessRate)
		base.TimeoutRate = roundTo4(snap.TimeoutRate)
		if snap.RouteCounts != nil {
			base.RouteCounts = snap.RouteCounts
		}
		if snap.ProviderCounts != nil {
			base.ProviderCounts = snap.ProviderCounts
		}
		if snap.ProviderSuccess != nil {
			base.ProviderSuccess = snap.ProviderSuccess
		}
		if snap.ProviderFailures != nil {
			base.ProviderFailures = snap.ProviderFailures
		}
		if snap.Queue != nil {
			base.Queue = snap.Queue
		}
		if snap.LastErrors != nil {
			base.LastErrors = snap.LastErrors
		}
		if snap.Memory != nil {
			base.Memory = snap.Memory
		}
		if snap.RequestBodyBudget != nil {
			base.RequestBodyBudget = snap.RequestBodyBudget
		}
		if snap.AccountActivity != nil {
			base.AccountActivity = snap.AccountActivity
		}
	}
	for _, p := range providerIDs {
		if _, ok := base.Queue[p]; !ok {
			base.Queue[p] = QueueSnapshot{Name: p}
		}
	}
	return base
}

func roundTo4(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*10000) / 10000
}

// Models 读取或按需刷新全池可用模型目录。
func (s *ManagementService) Models(ctx context.Context, refresh bool, accountLimit int, ttl time.Duration) (ModelsResponse, error) {
	if s == nil {
		return ModelsResponse{}, ErrManagementUnavailable
	}
	if accountLimit <= 0 {
		accountLimit = DefaultModelAccountLimit
	}
	if ttl <= 0 {
		ttl = DefaultModelsCacheTTL
	}
	nowMS := s.now().UnixMilli()
	sig := fmt.Sprintf("mode=%s|limit=%d", s.providerMode, accountLimit)

	if !refresh {
		s.modelsCache.mu.RLock()
		if s.modelsCache.updatedAt > 0 && nowMS-s.modelsCache.updatedAt < ttl.Milliseconds() && s.modelsCache.signature == sig {
			cachedModels := append([]string(nil), s.modelsCache.models...)
			resp := ModelsResponse{
				OK:              true,
				Cached:          true,
				UpdatedAt:       s.modelsCache.updatedAt,
				ScannedAccounts: s.modelsCache.scannedAccounts,
				Sources:         s.modelsCache.sources,
				Source:          firstNonEmpty(s.modelsCache.source, "cache"),
				Models:          cachedModels,
				FirstError:      s.modelsCache.firstError,
			}
			s.modelsCache.mu.RUnlock()
			return resp, nil
		}
		s.modelsCache.mu.RUnlock()
	}

	var refreshed *ModelRefreshOutcome
	if refresh && s.modelCatalog != nil {
		outcome, err := s.modelCatalog.RefreshModels(ctx)
		if err != nil {
			refreshed = &ModelRefreshOutcome{
				UpdatedAtMS: nowMS,
				Source:      "error",
				FirstError:  err.Error(),
			}
		} else {
			refreshed = &outcome
		}
	}

	models, updatedAt, scannedAccounts, sources, source, firstError := s.collectDiscoveredModels(ctx, refreshed)
	if updatedAt <= 0 {
		updatedAt = nowMS
	}

	s.modelsCache.mu.Lock()
	s.modelsCache.updatedAt = updatedAt
	s.modelsCache.models = append([]string(nil), models...)
	s.modelsCache.scannedAccounts = scannedAccounts
	s.modelsCache.sources = sources
	s.modelsCache.source = source
	s.modelsCache.firstError = firstError
	s.modelsCache.signature = sig
	s.modelsCache.mu.Unlock()

	return ModelsResponse{
		OK:              true,
		Cached:          false,
		UpdatedAt:       updatedAt,
		ScannedAccounts: scannedAccounts,
		Sources:         sources,
		Source:          source,
		Models:          models,
		FirstError:      firstError,
	}, nil
}

func (s *ManagementService) collectDiscoveredModels(
	ctx context.Context,
	refreshed *ModelRefreshOutcome,
) (models []string, updatedAt int64, scannedAccounts int, sources int, source string, firstError string) {
	seen := make(map[string]struct{})
	addModel := func(id string) {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			return
		}
		if _, dup := seen[trimmed]; !dup {
			seen[trimmed] = struct{}{}
		}
	}

	source = "empty"
	if refreshed != nil {
		updatedAt = refreshed.UpdatedAtMS
		scannedAccounts = refreshed.ScannedAccounts
		sources = refreshed.Sources
		if refreshed.Source != "" {
			source = refreshed.Source
		}
		firstError = refreshed.FirstError
		for _, m := range refreshed.Models {
			addModel(m)
		}
	}

	if s.store != nil {
		if catalog, err := s.store.ListAllAccountModels(ctx); err == nil {
			if catalog.UpdatedAtMS > updatedAt {
				updatedAt = catalog.UpdatedAtMS
			}
			for _, set := range catalog.Sets {
				scannedAccounts++
				hasEffective := false
				for _, m := range set.Models {
					if m.Effective() {
						addModel(m.ModelID().String())
						hasEffective = true
					}
				}
				if hasEffective {
					sources++
					if source == "empty" {
						source = "store"
					}
				}
				if firstError == "" && strings.TrimSpace(set.LastErrorMessage) != "" {
					firstError = strings.TrimSpace(set.LastErrorMessage)
				}
			}
		}
	}

	if len(seen) == 0 && s.aiHomeDir != "" {
		if reader, err := webuimodelssnapshot.NewReader(s.aiHomeDir); err == nil {
			if snap, err := reader.Read(ctx); err == nil && snap != nil && snap.Available {
				if snap.UpdatedAtMS > updatedAt {
					updatedAt = snap.UpdatedAtMS
				}
				for _, list := range snap.ByAccount {
					scannedAccounts++
					if len(list) > 0 {
						sources++
						if source == "empty" {
							source = "snapshot"
						}
					}
					for _, id := range list {
						addModel(id)
					}
				}
				for _, msg := range snap.ErrorsByAccount {
					if firstError == "" && strings.TrimSpace(msg) != "" {
						firstError = strings.TrimSpace(msg)
					}
				}
			}
		}
	}

	models = make([]string, 0, len(seen))
	for m := range seen {
		models = append(models, m)
	}
	sort.Strings(models)
	return models, updatedAt, scannedAccounts, sources, source, firstError
}

func countEffectiveCatalogModels(catalog accountapp.AccountModelCatalog) int {
	seen := make(map[string]struct{})
	for _, set := range catalog.Sets {
		for _, m := range set.Models {
			if m.Effective() {
				seen[m.ModelID().String()] = struct{}{}
			}
		}
	}
	return len(seen)
}

// Accounts 返回全池账号管理与运行态组合视图。
func (s *ManagementService) Accounts(ctx context.Context) (AccountsResponse, error) {
	if s == nil {
		return AccountsResponse{}, ErrManagementUnavailable
	}
	now := s.now()
	nowMS := now.UnixMilli()

	var rows []ManagementAccount
	if s.accountRows != nil {
		listed, err := s.accountRows.ListManagementAccountRows(ctx)
		if err == nil {
			rows = listed
		}
	}
	if len(rows) == 0 && s.store != nil {
		overviews, err := s.listAllOverviews(ctx)
		if err == nil {
			rows = make([]ManagementAccount, 0, len(overviews))
			for _, ov := range overviews {
				rows = append(rows, accountFromOverview(ov))
			}
		}
	}

	// 读取 Go 持久运行态及内存调度视图，补齐冷却列表与阻塞原因。
	persistedStates := make(map[string]runtimecore.AccountState)
	if s.store != nil {
		if states, err := s.store.ListAccountStates(ctx); err == nil {
			for _, st := range states {
				persistedStates[st.AccountRef().String()] = st
			}
		}
	}
	liveViews := make(map[string]runtimeapp.AccountView)
	if snapshotter, ok := s.accountRuntime.(runtimeapp.Snapshotter); ok && snapshotter != nil {
		for _, view := range snapshotter.RuntimeSnapshot() {
			liveViews[view.AccountRef.String()] = view
		}
	}

	thresholdPct := s.UsageConfigThresholdPct(ctx)
	for i := range rows {
		ref := strings.TrimSpace(rows[i].AccountRef)
		if rows[i].ModelCooldowns == nil {
			rows[i].ModelCooldowns = map[string]int64{}
		}
		if rows[i].Status == "" {
			rows[i].Status = accountstate.StatusUp
		}
		if rows[i].RuntimeStatus == "" {
			rows[i].RuntimeStatus = "healthy"
		}
		if st, ok := persistedStates[ref]; ok {
			derived := st.DeriveStatus(now)
			if derived.Status() != "" && derived.Status() != "healthy" {
				rows[i].RuntimeStatus = derived.Status()
				if !derived.Until().IsZero() {
					rows[i].RuntimeUntil = derived.Until().UnixMilli()
					if rows[i].RuntimeUntil > rows[i].CooldownUntil {
						rows[i].CooldownUntil = rows[i].RuntimeUntil
					}
				}
				if derived.Reason() != "" {
					rows[i].RuntimeReason = derived.Reason()
				}
			}
			applyRuntimeDocumentCounters(&rows[i], st.Document(), nowMS)
		}
		if view, ok := liveViews[ref]; ok {
			applyRuntimeView(&rows[i], view, nowMS)
		}
		rows[i].ModelCooldownCount = len(rows[i].ModelCooldowns)
		if isBlockingRuntimeStatus(rows[i].RuntimeStatus) {
			rows[i].RemainingPct = nil
		}
		if !rows[i].Configured {
			if rows[i].SchedulableStatus == "" {
				rows[i].SchedulableStatus = "blocked_by_account_status"
				rows[i].SchedulableReason = "account_unconfigured"
			}
		} else if rows[i].Status == accountstate.StatusDown {
			rows[i].SchedulableStatus = "blocked_by_account_status"
			rows[i].SchedulableReason = "account_disabled"
		} else if isBlockingRuntimeStatus(rows[i].RuntimeStatus) {
			rows[i].SchedulableStatus = "blocked_by_runtime"
			rows[i].SchedulableReason = firstNonEmpty(rows[i].RuntimeReason, rows[i].RuntimeStatus)
		} else if rows[i].RemainingPct != nil && *rows[i].RemainingPct <= float64(maxInt(0, 100-thresholdPct)) && !rows[i].APIKeyMode {
			rows[i].SchedulableStatus = "blocked_by_quota"
			if rows[i].SchedulableReason == "" {
				rows[i].SchedulableReason = "usage_threshold_reached"
			}
		} else if rows[i].SchedulableStatus == "" {
			rows[i].SchedulableStatus = "schedulable"
		}
	}

	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Provider != rows[j].Provider {
			return rows[i].Provider < rows[j].Provider
		}
		return rows[i].AccountRef < rows[j].AccountRef
	})
	return AccountsResponse{
		OK:       true,
		Accounts: rows,
	}, nil
}

func (s *ManagementService) listAllOverviews(ctx context.Context) ([]accountapp.AccountOverview, error) {
	all := make([]accountapp.AccountOverview, 0, 32)
	cursor := accountcore.AccountRef("")
	for {
		query, err := accountapp.NewOverviewQuery(cursor, accountapp.MaxOverviewLimit)
		if err != nil {
			return nil, err
		}
		page, err := s.store.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		all = append(all, page...)
		if len(page) < accountapp.MaxOverviewLimit {
			return all, nil
		}
		last := page[len(page)-1].Account().Ref()
		if last == cursor {
			return all, nil
		}
		cursor = last
	}
}

func accountFromOverview(ov accountapp.AccountOverview) ManagementAccount {
	acct := ov.Account()
	status := accountstate.StatusUp
	if !acct.Enabled() {
		status = accountstate.StatusDown
	}
	var remainingPct *float64
	quotaStatus := "unknown"
	quotaReason := ""
	if q, ok := ov.QuotaState(); ok {
		if q.Status() != "" {
			quotaStatus = q.Status()
		}
		quotaReason = q.Reason()
		if q.HasNumericRemaining() {
			val := float64(q.RemainingBPS()) / 100.0
			remainingPct = &val
		}
	}
	planType := strings.TrimSpace(ov.SubscriptionRaw())
	if planType == "" {
		planType = strings.TrimSpace(ov.SubscriptionKind())
	}
	if !ov.HasCredential() {
		planType = "pending"
	} else if ov.AuthKind() == "api-key" {
		planType = "api-key"
	} else if planType == "" {
		planType = "oauth"
	}
	apiKeyMode := ov.AuthKind() == "api-key"
	var snapDoc any
	if snap, ok := ov.UsageSnapshot(); ok {
		entries := make([]map[string]any, 0, len(snap.Entries()))
		for _, e := range snap.Entries() {
			item := map[string]any{
				"limitId":       e.LimitID(),
				"limitName":     e.LimitName(),
				"bucket":        e.Bucket(),
				"kind":          string(e.Kind()),
				"scope":         string(e.Scope()),
				"scopeKey":      e.ScopeKey(),
				"windowSeconds": e.WindowSeconds(),
				"availability":  string(e.Availability()),
			}
			if bps, hasRem := e.RemainingBasisPoints(); hasRem {
				item["remainingPct"] = float64(bps) / 100.0
			}
			if !e.ResetAt().IsZero() {
				item["resetAt"] = e.ResetAt().UnixMilli()
			}
			entries = append(entries, item)
		}
		snapDoc = map[string]any{
			"provider":   snap.ProviderID(),
			"source":     snap.Source(),
			"planType":   snap.PlanType(),
			"capturedAt": snap.CapturedAt().UnixMilli(),
			"entries":    entries,
		}
	}
	return ManagementAccount{
		RuntimeStatus:  "healthy",
		AccountRef:     acct.Ref().String(),
		Provider:       acct.ProviderID(),
		Status:         status,
		Email:          ov.Email(),
		PlanType:       planType,
		Configured:     ov.HasCredential(),
		APIKeyMode:     apiKeyMode,
		RemainingPct:   remainingPct,
		UsageSnapshot:  snapDoc,
		QuotaStatus:    quotaStatus,
		QuotaReason:    quotaReason,
		HasAccessToken: ov.HasCredential() && !apiKeyMode,
		ModelCooldowns: map[string]int64{},
	}
}

func applyRuntimeDocumentCounters(target *ManagementAccount, raw []byte, nowMS int64) {
	if len(raw) == 0 {
		return
	}
	var doc struct {
		CooldownUntil       float64            `json:"cooldownUntil"`
		LastRefresh         float64            `json:"lastRefresh"`
		ConsecutiveFailures int                `json:"consecutiveFailures"`
		SuccessCount        int                `json:"successCount"`
		FailCount           int                `json:"failCount"`
		LastError           string             `json:"lastError"`
		LastFailureKind     string             `json:"lastFailureKind"`
		LastFailureReason   string             `json:"lastFailureReason"`
		ModelCooldowns      map[string]float64 `json:"modelCooldowns"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return
	}
	if doc.CooldownUntil > float64(nowMS) && int64(doc.CooldownUntil) > target.CooldownUntil {
		target.CooldownUntil = int64(doc.CooldownUntil)
	}
	if doc.LastRefresh > 0 {
		target.LastRefresh = int64(doc.LastRefresh)
	}
	target.ConsecutiveFailures = doc.ConsecutiveFailures
	target.SuccessCount = doc.SuccessCount
	target.FailCount = doc.FailCount
	if strings.TrimSpace(doc.LastError) != "" {
		target.LastError = strings.TrimSpace(doc.LastError)
	}
	for model, until := range doc.ModelCooldowns {
		if until > float64(nowMS) {
			target.ModelCooldowns[model] = int64(until)
		}
	}
}

func applyRuntimeView(target *ManagementAccount, view runtimeapp.AccountView, nowMS int64) {
	for _, m := range view.Models {
		if !m.CooldownUntil.IsZero() && m.CooldownUntil.UnixMilli() > nowMS {
			until := m.CooldownUntil.UnixMilli()
			target.ModelCooldowns[m.Model.String()] = until
			if until > target.CooldownUntil {
				target.CooldownUntil = until
			}
		}
	}
	if len(view.Blocks) > 0 && target.RuntimeStatus == "healthy" {
		target.RuntimeStatus = runtimeStatusFromKind(view.LastFailureKind)
		if target.RuntimeReason == "" {
			target.RuntimeReason = string(view.Blocks[0])
		}
	}
}

func runtimeStatusFromKind(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "auth_invalid":
		return "auth_invalid"
	case "rate_limited", "rate_limit":
		return "rate_limited"
	case "overloaded":
		return "overloaded"
	case "transient_network", "network":
		return "transient_network"
	case "service_unavailable":
		return "service_unavailable"
	case "upstream_error":
		return "upstream_error"
	default:
		if strings.TrimSpace(kind) != "" {
			return "cooling_down"
		}
		return "cooling_down"
	}
}

func isBlockingRuntimeStatus(status string) bool {
	s := strings.ToLower(strings.TrimSpace(status))
	return s != "" && s != "healthy" && s != "unknown"
}

// UsageConfigThresholdPct 读取 app-state.db config:usage 的 threshold_pct。
func (s *ManagementService) UsageConfigThresholdPct(ctx context.Context) int {
	if s == nil || s.aiHomeDir == "" {
		return DefaultUsageThresholdPct
	}
	dbPath, err := appstate.DatabasePath(s.aiHomeDir)
	if err != nil {
		return DefaultUsageThresholdPct
	}
	raw, found, err := appstate.ReadKV(ctx, dbPath, "config:usage")
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return DefaultUsageThresholdPct
	}
	var doc struct {
		ThresholdPct *int `json:"threshold_pct"`
	}
	if err := json.Unmarshal([]byte(raw), &doc); err != nil || doc.ThresholdPct == nil {
		return DefaultUsageThresholdPct
	}
	v := *doc.ThresholdPct
	if v < 1 {
		return 1
	}
	if v > 100 {
		return 100
	}
	return v
}

// Reload 刷新内存缓存并重新统计各 Provider 账号数量，随后广播 management watch。
func (s *ManagementService) Reload(ctx context.Context) (ReloadResponse, error) {
	if s == nil {
		return ReloadResponse{}, ErrManagementUnavailable
	}
	s.modelsCache.mu.Lock()
	s.modelsCache.updatedAt = 0
	s.modelsCache.signature = ""
	s.modelsCache.mu.Unlock()

	providerIDs := s.ProviderIDs()
	counts := make(map[string]int, len(providerIDs))
	for _, p := range providerIDs {
		counts[p] = 0
	}
	total := 0
	accountsResp, err := s.Accounts(ctx)
	if err != nil {
		return ReloadResponse{}, err
	}
	for _, acct := range accountsResp.Accounts {
		p := strings.ToLower(strings.TrimSpace(acct.Provider))
		if p != "" {
			counts[p]++
			total++
		}
	}
	if s.watchHub != nil {
		s.watchHub.NotifySnapshot(ctx, true)
	}
	return ReloadResponse{
		OK:        true,
		Reloaded:  total,
		Providers: counts,
	}, nil
}

// ClearCooldowns 清除全部账号在内存运行态与 aih.db 持久化运行态中的冷却与阻塞。
func (s *ManagementService) ClearCooldowns(ctx context.Context) error {
	if s == nil {
		return ErrManagementUnavailable
	}
	seenRefs := make(map[accountcore.AccountRef]struct{})
	if s.store != nil {
		if overviews, err := s.listAllOverviews(ctx); err == nil {
			for _, ov := range overviews {
				ref := ov.Account().Ref()
				if ref.IsValid() {
					seenRefs[ref] = struct{}{}
				}
			}
		}
		if states, err := s.store.ListAccountStates(ctx); err == nil {
			for _, st := range states {
				ref := st.AccountRef()
				if ref.IsValid() {
					seenRefs[ref] = struct{}{}
				}
			}
		}
	}
	if snapshotter, ok := s.accountRuntime.(runtimeapp.Snapshotter); ok && snapshotter != nil {
		for _, view := range snapshotter.RuntimeSnapshot() {
			if view.AccountRef.IsValid() {
				seenRefs[view.AccountRef] = struct{}{}
			}
		}
	}

	type runtimeRestorer interface {
		RestoreScheduling(context.Context, accountcore.AccountRef) error
	}
	restorer, hasRestorer := s.accountRuntime.(runtimeRestorer)
	for ref := range seenRefs {
		if hasRestorer && restorer != nil {
			if err := restorer.RestoreScheduling(ctx, ref); err != nil {
				return err
			}
		}
		if s.store != nil {
			if err := s.store.DeleteAccountState(ctx, ref); err != nil {
				return err
			}
		}
	}
	if s.watchHub != nil {
		s.watchHub.NotifySnapshot(ctx, true)
	}
	return nil
}

// Restart 通过已配置的重启端口通知宿主重启服务进程。
func (s *ManagementService) Restart(ctx context.Context) (RestartResponse, error) {
	if s == nil || s.restarter == nil {
		return RestartResponse{}, ErrRestartUnavailable
	}
	resp, err := s.restarter.RestartServer(ctx)
	if err != nil {
		return RestartResponse{}, err
	}
	if s.watchHub != nil {
		s.watchHub.NotifySnapshot(ctx, true)
	}
	return resp, nil
}

// StateIndexOperationalStatus 更新指定账号的操作状态（up/down），必要时自动补齐台账与投影行。
func (s *ManagementService) StateIndexOperationalStatus(ctx context.Context, input StateIndexOperationalStatusInput) (bool, error) {
	provider := strings.ToLower(strings.TrimSpace(input.Provider))
	refStr := strings.TrimSpace(input.AccountRef)
	status := accountcore.NormalizeAccountStatus(input.Status)
	if provider == "" || status == "" {
		return false, ErrInvalidStateIndexPayload
	}
	ref, err := accountcore.ParseAccountRef(refStr)
	if err != nil {
		return false, ErrInvalidStateIndexPayload
	}
	store, err := s.openStateIndexStore(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = store.Close() }()

	if err := store.EnsureAccountRef(ctx, ref.String(), provider); err != nil {
		return false, err
	}
	updated, err := store.SetStatus(ctx, ref.String(), status)
	if err != nil {
		return false, err
	}
	if !updated {
		updated, err = store.Upsert(ctx, buildAccountStateUpsertInput(ref.String(), provider, input.BaseState, &status))
		if err != nil {
			return false, err
		}
	}
	return updated, nil
}

// StateIndexRuntimeState 同步账号基础展示投影与 Go 侧运行态文档/阻塞物化。
func (s *ManagementService) StateIndexRuntimeState(ctx context.Context, input StateIndexRuntimeStateInput) (bool, error) {
	provider := strings.ToLower(strings.TrimSpace(input.Provider))
	refStr := strings.TrimSpace(input.AccountRef)
	if provider == "" {
		return false, ErrInvalidStateIndexPayload
	}
	ref, err := accountcore.ParseAccountRef(refStr)
	if err != nil {
		return false, ErrInvalidStateIndexPayload
	}
	store, err := s.openStateIndexStore(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = store.Close() }()

	if err := store.EnsureAccountRef(ctx, ref.String(), provider); err != nil {
		return false, err
	}
	updated, err := store.Upsert(ctx, buildAccountStateUpsertInput(ref.String(), provider, input.BaseState, input.BaseState.Status))
	if err != nil {
		return false, err
	}
	if s.store != nil {
		if len(input.RuntimeState) == 0 {
			_ = s.store.DeleteAccountState(ctx, ref)
		} else {
			doc, marshalErr := json.Marshal(input.RuntimeState)
			if marshalErr == nil {
				if runtimeState, stateErr := runtimecore.NewAccountState(runtimecore.AccountStateInput{
					AccountRef: ref,
					Document:   doc,
					UpdatedAt:  s.now(),
				}); stateErr == nil {
					var blockPtr *runtimecore.AccountBlock
					if block, ok := runtimeState.DeriveBlock(); ok {
						blockCopy := block
						blockPtr = &blockCopy
					}
					_ = s.store.ReplaceAccountState(ctx, runtimeState, blockPtr)
				}
			}
		}
	}
	return updated, nil
}

// StateIndexUpsert 更新或插入账号在 app-state.db 的基础展示投影。
func (s *ManagementService) StateIndexUpsert(ctx context.Context, input StateIndexUpsertInput) (bool, error) {
	provider := strings.ToLower(strings.TrimSpace(input.Provider))
	refStr := strings.TrimSpace(input.AccountRef)
	if provider == "" {
		return false, ErrInvalidStateIndexPayload
	}
	ref, err := accountcore.ParseAccountRef(refStr)
	if err != nil {
		return false, ErrInvalidStateIndexPayload
	}
	store, err := s.openStateIndexStore(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = store.Close() }()

	if err := store.EnsureAccountRef(ctx, ref.String(), provider); err != nil {
		return false, err
	}
	return store.Upsert(ctx, buildAccountStateUpsertInput(ref.String(), provider, input.State, input.State.Status))
}

// StateIndexPruneMissing 清理指定 Provider 下不再存在于 existingRefs 的陈旧投影行。
func (s *ManagementService) StateIndexPruneMissing(ctx context.Context, input StateIndexPruneMissingInput) (int, error) {
	provider := strings.ToLower(strings.TrimSpace(input.Provider))
	if provider == "" {
		return 0, ErrInvalidStateIndexPayload
	}
	store, err := s.openStateIndexStore(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = store.Close() }()

	return store.PruneMissing(ctx, provider, input.ExistingRefs)
}

func (s *ManagementService) openStateIndexStore(ctx context.Context) (*accountstate.Store, error) {
	if s == nil || s.aiHomeDir == "" {
		return nil, ErrStateIndexUnavailable
	}
	store, err := accountstate.Open(ctx, s.aiHomeDir)
	if err == nil {
		return store, nil
	}
	if errors.Is(err, accountstate.ErrDatabaseMissing) {
		return nil, ErrStateIndexUnavailable
	}
	return nil, err
}

func buildAccountStateUpsertInput(ref, provider string, base StateIndexBaseState, statusOverride *string) accountstate.UpsertInput {
	status := statusOverride
	if status != nil {
		trimmed := strings.TrimSpace(*status)
		if trimmed == "" {
			status = nil
		} else {
			norm := accountcore.NormalizeAccountStatus(trimmed)
			if norm != "" {
				status = &norm
			}
		}
	}
	return accountstate.UpsertInput{
		AccountRef:   ref,
		Provider:     provider,
		Status:       status,
		Configured:   base.Configured,
		APIKeyMode:   base.APIKeyMode,
		AuthMode:     base.AuthMode,
		RemainingPct: base.RemainingPct,
		DisplayName:  base.DisplayName,
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
