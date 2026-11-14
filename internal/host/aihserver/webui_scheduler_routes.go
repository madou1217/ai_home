package aihserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
	"github.com/madou1217/ai_home/internal/runtime/windowactivation"
	"github.com/madou1217/ai_home/internal/transport/http/webuiproviderclearbrokenapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprovidercliupgradeapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiwindowactivationapi"
)

// webuiSchedulerPorts 允许组合根（composition.go / webuiroutes.go）或单测注入已启停管理的调度器实例与探测端口。
type webuiSchedulerPorts struct {
	UpgradeScheduler   *providercliupgrade.Scheduler
	WindowScheduler    *windowactivation.Scheduler
	UpgradeConfig      *providercliupgrade.SchedulerConfig
	WindowConfig       *windowactivation.SchedulerConfig
	ResolveOrigin      func() string
	ClientKey          func() string
	LocalHandler       http.Handler
	SkipSchedulerStart bool
}

// buildWebUISchedulerRoutes 装配 provider CLI 自动升级与窗口激活的管理路由及对应调度器。
func buildWebUISchedulerRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	return buildWebUISchedulerRoutesWithPorts(dependencies, webuiSchedulerPorts{})
}

// buildWebUISchedulerRoutesWithPorts 支持注入受生命周期托管的调度器与推理回环端口。
func buildWebUISchedulerRoutesWithPorts(
	dependencies webuiRouteDependencies,
	ports webuiSchedulerPorts,
) ([]webuiRoute, error) {
	aiHome := resolveSchedulerAIHomeDir(dependencies)
	depsCopy := dependencies
	depsCopy.AIHomeDir = aiHome

	upgradeSched := ports.UpgradeScheduler
	if upgradeSched == nil && aiHome != "" && dependencies.Catalog != nil {
		upgradeSched = NewUpgradeScheduler(depsCopy, ports)
		if !ports.SkipSchedulerStart {
			upgradeSched.Start(context.Background())
		}
	}

	windowSched := ports.WindowScheduler
	if windowSched == nil && aiHome != "" {
		windowSched = NewWindowActivationScheduler(depsCopy, ports)
		if !ports.SkipSchedulerStart {
			windowSched.Start(context.Background())
		}
	}

	providerUpgrade, err := webuiprovidercliupgradeapi.NewHandler(webuiprovidercliupgradeapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		AIHomeDir:  aiHome,
		Catalog:    dependencies.Catalog,
		Scheduler:  upgradeSched,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 provider CLI 升级接口失败: %w", err)
	}

	clearBroken, err := webuiproviderclearbrokenapi.NewHandler(webuiproviderclearbrokenapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		AIHomeDir:  aiHome,
		Catalog:    dependencies.Catalog,
		Scheduler:  upgradeSched,
		Status: func(context.Context) (any, error) {
			return webuiprovidercliupgradeapi.SnapshotWithScheduler(aiHome, dependencies.Catalog, upgradeSched), nil
		},
	})
	if err != nil {
		return nil, fmt.Errorf("创建解除升级熔断接口失败: %w", err)
	}

	windowActivation, err := webuiwindowactivationapi.NewHandler(webuiwindowactivationapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		AIHomeDir:  aiHome,
		Scheduler:  windowSched,
	})
	if err != nil {
		return nil, fmt.Errorf("创建窗口激活接口失败: %w", err)
	}

	return []webuiRoute{
		{Pattern: "GET " + webuiprovidercliupgradeapi.Path, Handler: providerUpgrade},
		{Pattern: "POST " + webuiproviderclearbrokenapi.Path + webuiproviderclearbrokenapi.ClearBrokenSuffix, Handler: clearBroken},
		// 浏览器同构别名由 router 统一生成。
		{Pattern: "GET " + webuiwindowactivationapi.Path + "/{provider}/{accountRef}/window-activation", Handler: windowActivation},
		{Pattern: "POST " + webuiwindowactivationapi.Path + "/{provider}/{accountRef}/window-activation", Handler: windowActivation},

	}, nil
}

// NewUpgradeScheduler 构建绑定真实探测、安装与沙箱强判据的 CLI 自动升级调度器。
func NewUpgradeScheduler(dependencies webuiRouteDependencies, ports webuiSchedulerPorts) *providercliupgrade.Scheduler {
	aiHome := resolveSchedulerAIHomeDir(dependencies)
	realDeps := providercliupgrade.NewRealDeps(providercliupgrade.RealDepsOptions{
		AIHomeDir:   aiHome,
		HostHomeDir: strings.TrimSpace(dependencies.HostHomeDir),
		Catalog:     dependencies.Catalog,
	})
	cfg := resolveUpgradeSchedulerConfig(ports.UpgradeConfig)
	return providercliupgrade.NewScheduler(providercliupgrade.SchedulerOptions{
		AIHomeDir: aiHome,
		Catalog:   dependencies.Catalog,
		RealDeps:  realDeps,
		Config:    cfg,
	})
}

// NewWindowActivationScheduler 构建绑定 SQLite 账号库、运行态视图与 /v1/* 探测端口的窗口激活调度器。
func NewWindowActivationScheduler(dependencies webuiRouteDependencies, ports webuiSchedulerPorts) *windowactivation.Scheduler {
	aiHome := resolveSchedulerAIHomeDir(dependencies)
	cfg := resolveWindowSchedulerConfig(aiHome, ports.WindowConfig)
	var accountSource windowactivation.AccountSource
	if dependencies.Store != nil {
		accountSource = &schedulerAccountSource{
			store:          dependencies.Store,
			accountRuntime: dependencies.AccountRuntime,
		}
	}
	return windowactivation.NewScheduler(windowactivation.SchedulerOptions{
		AIHomeDir:     aiHome,
		Config:        cfg,
		Accounts:      accountSource,
		ResolveOrigin: ports.ResolveOrigin,
		ClientKey:     ports.ClientKey,
		LocalHandler:  ports.LocalHandler,
	})
}

func resolveSchedulerAIHomeDir(dependencies webuiRouteDependencies) string {
	aiHome := strings.TrimSpace(dependencies.AIHomeDir)
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	if aiHome == "" && hostHome != "" {
		aiHome = filepath.Join(hostHome, ".ai_home")
	}
	return aiHome
}

func resolveUpgradeSchedulerConfig(override *providercliupgrade.SchedulerConfig) providercliupgrade.SchedulerConfig {
	var cfg providercliupgrade.SchedulerConfig
	if override != nil {
		cfg = *override
	}
	if cfg.Enabled == nil {
		if val, ok := parseEnvBool("AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE"); ok {
			cfg.Enabled = &val
		}
	}
	if cfg.ApplyEnabled == nil {
		if val, ok := parseEnvBool("AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_APPLY"); ok {
			cfg.ApplyEnabled = &val
		}
	}
	if cfg.IntervalMs <= 0 {
		if val, ok := parseEnvInt64("AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_INTERVAL_MS"); ok && val > 0 {
			cfg.IntervalMs = val
		}
	}
	if cfg.StartDelayMs == nil {
		if val, ok := parseEnvInt64("AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_START_DELAY_MS"); ok && val >= 0 {
			cfg.StartDelayMs = &val
		}
	}
	return cfg
}

func resolveWindowSchedulerConfig(aiHomeDir string, override *windowactivation.SchedulerConfig) windowactivation.SchedulerConfig {
	saved := windowactivation.ReadSavedServerConfig(context.Background(), aiHomeDir)
	cfg := windowactivation.SchedulerConfig{
		Enabled:           saved.Enabled,
		DefaultIntervalMs: saved.DefaultIntervalMs,
		MinIntervalMs:     saved.MinIntervalMs,
		TickInterval:      windowactivation.DefaultTickInterval,
		StartDelay:        windowactivation.DefaultStartDelay,
		BatchSize:         windowactivation.DefaultBatchSize,
		ProbeTimeout:      windowactivation.DefaultProbeTimeout,
	}
	if val, ok := parseEnvBool("AIH_SERVER_WINDOW_ACTIVATION"); ok {
		cfg.Enabled = val
	}
	if val, ok := parseEnvInt64("AIH_SERVER_WINDOW_ACTIVATION_MIN_INTERVAL_MS"); ok && val > 0 {
		cfg.MinIntervalMs = val
	}
	if val, ok := parseEnvInt64("AIH_SERVER_WINDOW_ACTIVATION_DEFAULT_INTERVAL_MS"); ok && val > 0 {
		cfg.DefaultIntervalMs = val
	}
	if val, ok := parseEnvInt64("AIH_SERVER_WINDOW_ACTIVATION_TICK_INTERVAL_MS"); ok && val > 0 {
		cfg.TickInterval = time.Duration(val) * time.Millisecond
	}
	if val, ok := parseEnvInt64("AIH_SERVER_WINDOW_ACTIVATION_START_DELAY_MS"); ok && val >= 0 {
		cfg.StartDelay = time.Duration(val) * time.Millisecond
	}
	if val, ok := parseEnvInt64("AIH_SERVER_WINDOW_ACTIVATION_BATCH_SIZE"); ok && val > 0 {
		cfg.BatchSize = int(val)
	}
	if val, ok := parseEnvInt64("AIH_SERVER_WINDOW_ACTIVATION_PROBE_TIMEOUT_MS"); ok && val > 0 {
		cfg.ProbeTimeout = time.Duration(val) * time.Millisecond
	}
	if override != nil {
		cfg = *override
	}
	return windowactivation.NormalizeSchedulerConfig(cfg)
}

func parseEnvBool(key string) (bool, bool) {
	raw, exists := os.LookupEnv(key)
	if !exists {
		return false, false
	}
	trimmed := strings.ToLower(strings.TrimSpace(raw))
	switch trimmed {
	case "1", "true", "yes", "on":
		return true, true
	case "0", "false", "no", "off":
		return false, true
	default:
		return false, false
	}
}

func parseEnvInt64(key string) (int64, bool) {
	raw, exists := os.LookupEnv(key)
	if !exists {
		return 0, false
	}
	parsed, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// schedulerAccountSource 将 Go SQLite Store 与 AccountRuntime 适配为 windowactivation.AccountSource。
type schedulerAccountSource struct {
	store          *sqliteaccount.Store
	accountRuntime any
}

func (s *schedulerAccountSource) ListAccounts(ctx context.Context) ([]windowactivation.AccountSnapshot, error) {
	if s == nil || s.store == nil {
		return nil, nil
	}
	overviews, err := listAllAccountOverviews(ctx, s.store)
	if err != nil {
		return nil, err
	}

	docsByRef := make(map[string]usagecore.Document)
	if docs, err := s.store.ListUsageDocuments(ctx, usageapp.DocumentQuery{}); err == nil {
		for _, doc := range docs {
			docsByRef[doc.AccountRef().String()] = doc
		}
	}

	persistedStates := make(map[string]runtimecore.AccountState)
	if states, err := s.store.ListAccountStates(ctx); err == nil {
		for _, st := range states {
			persistedStates[st.AccountRef().String()] = st
		}
	}

	liveViews := make(map[string]runtimeapp.AccountView)
	if snapshotter, ok := s.accountRuntime.(runtimeapp.Snapshotter); ok && snapshotter != nil {
		for _, view := range snapshotter.RuntimeSnapshot() {
			liveViews[view.AccountRef.String()] = view
		}
	}

	now := time.Now()
	out := make([]windowactivation.AccountSnapshot, 0, len(overviews))
	for _, ov := range overviews {
		acct := ov.Account()
		ref := acct.Ref().String()
		status := "up"
		if !acct.Enabled() {
			status = "down"
		}
		runtimeStatus := "healthy"
		runtimeReason := ""
		if st, ok := persistedStates[ref]; ok {
			derived := st.DeriveStatus(now)
			if derived.Status() != "" && derived.Status() != "healthy" {
				runtimeStatus = derived.Status()
				runtimeReason = derived.Reason()
			}
		}
		var lastActivityAtMs int64
		if view, ok := liveViews[ref]; ok {
			if !view.LastSuccessAt.IsZero() {
				lastActivityAtMs = view.LastSuccessAt.UnixMilli()
			}
			if len(view.Blocks) > 0 && runtimeStatus == "healthy" {
				runtimeStatus = schedulerRuntimeStatusFromKind(view.LastFailureKind)
				if runtimeReason == "" {
					runtimeReason = string(view.Blocks[0])
				}
			}
		}

		snap := extractWindowUsageSnapshot(ov, docsByRef[ref])
		out = append(out, windowactivation.AccountSnapshot{
			Provider:         acct.ProviderID(),
			AccountRef:       ref,
			Enabled:          acct.Enabled(),
			APIKeyMode:       ov.AuthKind() == "api-key",
			Status:           status,
			RuntimeStatus:    runtimeStatus,
			RuntimeReason:    runtimeReason,
			LastActivityAtMs: lastActivityAtMs,
			UsageSnapshot:    snap,
		})
	}
	return out, nil
}

func (s *schedulerAccountSource) ListAccountModels(ctx context.Context, accountRef string) ([]string, error) {
	if s == nil || s.store == nil {
		return nil, nil
	}
	catalog, err := s.store.ListAllAccountModels(ctx)
	if err != nil {
		return nil, err
	}
	for _, set := range catalog.Sets {
		if set.AccountRef.String() == accountRef {
			models := make([]string, 0, len(set.Models))
			for _, m := range set.Models {
				if id := strings.TrimSpace(string(m.ModelID())); id != "" {
					models = append(models, id)
				}
			}
			return models, nil
		}
	}
	return nil, nil
}

func listAllAccountOverviews(ctx context.Context, store *sqliteaccount.Store) ([]accountapp.AccountOverview, error) {
	var all []accountapp.AccountOverview
	var afterRef accounts.AccountRef
	for {
		query, err := accountapp.NewOverviewQuery(afterRef, accountapp.MaxOverviewLimit)
		if err != nil {
			return nil, err
		}
		batch, err := store.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		if len(batch) == 0 {
			break
		}
		all = append(all, batch...)
		if len(batch) < accountapp.MaxOverviewLimit {
			break
		}
		afterRef = batch[len(batch)-1].Account().Ref()
	}
	return all, nil
}

func extractWindowUsageSnapshot(ov accountapp.AccountOverview, doc usagecore.Document) *windowactivation.UsageSnapshot {
	if doc.IsValid() && len(doc.Payload()) > 0 {
		if parsed := parseUsageDocumentSnapshot(doc.Payload(), doc.CapturedAt().UnixMilli()); parsed != nil {
			return parsed
		}
	}
	snap, ok := ov.UsageSnapshot()
	if !ok {
		return nil
	}
	entries := make([]windowactivation.UsageEntry, 0, len(snap.Entries()))
	for _, entry := range snap.Entries() {
		var resetAtMs int64
		if !entry.ResetAt().IsZero() {
			resetAtMs = entry.ResetAt().UnixMilli()
		}
		entries = append(entries, windowactivation.UsageEntry{
			WindowMinutes: entry.WindowSeconds() / 60,
			ResetAtMs:     resetAtMs,
		})
	}
	return &windowactivation.UsageSnapshot{
		CapturedAtMs: snap.CapturedAt().UnixMilli(),
		Entries:      entries,
	}
}

func parseUsageDocumentSnapshot(raw []byte, fallbackCapturedMs int64) *windowactivation.UsageSnapshot {
	var decoded struct {
		CapturedAt any              `json:"capturedAt"`
		Entries    []map[string]any `json:"entries"`
		Models     []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil
	}
	capturedMs := windowactivation.NonNegativeInt64(decoded.CapturedAt)
	if capturedMs <= 0 {
		capturedMs = fallbackCapturedMs
	}
	out := &windowactivation.UsageSnapshot{
		CapturedAtMs: capturedMs,
	}
	for _, item := range decoded.Entries {
		resetIn, _ := item["resetIn"].(string)
		out.Entries = append(out.Entries, windowactivation.UsageEntry{
			WindowMinutes: windowactivation.NonNegativeInt64(item["windowMinutes"]),
			ResetAtMs:     windowactivation.NonNegativeInt64(item["resetAtMs"]),
			ResetIn:       resetIn,
		})
	}
	for _, item := range decoded.Models {
		resetIn, _ := item["resetIn"].(string)
		out.Models = append(out.Models, windowactivation.UsageEntry{
			WindowMinutes: windowactivation.NonNegativeInt64(item["windowMinutes"]),
			ResetAtMs:     windowactivation.NonNegativeInt64(item["resetAtMs"]),
			ResetIn:       resetIn,
		})
	}
	if len(out.Entries) == 0 && len(out.Models) == 0 && out.CapturedAtMs <= 0 {
		return nil
	}
	return out
}

func schedulerRuntimeStatusFromKind(kind string) string {
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
		return "healthy"
	}
}
