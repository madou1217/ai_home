package aihserver

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/peer"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
	"github.com/madou1217/ai_home/internal/runtime/retention"
	"github.com/madou1217/ai_home/internal/runtime/tokenrefreshdaemon"
	"github.com/madou1217/ai_home/internal/runtime/usagedaemons"
	"github.com/madou1217/ai_home/internal/transport/http/webuidaemonsapi"
	_ "modernc.org/sqlite"
)

const (
	daemonsPricingHTTPTimeout = 10 * time.Second
	daemonsPricingStaleAge    = 24 * time.Hour
)

var zcodeOwnerIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$`)

type zcodeOwnerRecord struct {
	UsageID     string
	AccountRef  string
	SessionID   string
	TimestampMS int64
}

type zcodeOwnerStore interface {
	ReconcileZcodeOwners(ctx context.Context, records []zcodeOwnerRecord) (int, error)
	Close() error
}

// webuiDaemonsPorts 允许调用方和测试注入时钟、间隔或替换底层扫描/刷新端口。
type webuiDaemonsPorts struct {
	Context                   context.Context
	Now                       func() time.Time
	PeerInterval              time.Duration
	PeerBatch                 int
	PeerDelivery              *peer.DeliveryOptions
	LogSweepInterval          time.Duration
	RuntimeSweepInterval      time.Duration
	QuotaProbeInterval        time.Duration
	QuotaProbePort            usagedaemons.QuotaProbePort
	UsageScanInterval         time.Duration
	UsageScanStartDelay       *time.Duration
	UsageScanPort             usagedaemons.UsageScanPort
	ProviderRefreshPort       usagedaemons.ProviderRefreshPort
	PricingService            *pricingcatalog.Service
	PricingHTTPClient         pricingcatalog.HTTPClient
	ZcodeOwnerStore           zcodeOwnerStore
	Runtime                   *backgroundDaemonsRuntime
	DisablePricingSync        bool
	TokenRefreshEnabled       *bool
	TokenRefreshInterval      time.Duration
	TokenRefreshStartDelay    *time.Duration
	TokenRefreshSkew          time.Duration
	TokenRefreshConcurrency   int
	TokenRefreshRetryDelay    time.Duration
	TokenRefreshTimeout       time.Duration
	DelegateCredentialRefresh bool
	CredentialResolver        tokenrefreshdaemon.CredentialRefresher
	TokenRefreshAccountStore  tokenrefreshdaemon.AccountStore
	TokenRefreshRuntime       tokenrefreshdaemon.AccountRuntimeNotifier
}

// backgroundDaemonsRuntime 统一托管 peer 补投、日志与目录保留、额度探测和用量扫描后台守护。
type backgroundDaemonsRuntime struct {
	now             func() time.Time
	peerDaemon      *peer.DispatchDaemon
	retentionDaemon *retention.Daemon
	quotaProbe      *usagedaemons.QuotaProbeScheduler
	usageScan       *usagedaemons.UsageScanScheduler
	providerRefresh *usagedaemons.ProviderRefreshCoordinator
	tokenRefresh    *tokenrefreshdaemon.Daemon
	ownedOwnerStore zcodeOwnerStore

	closeOnce sync.Once
}

// startBackgroundDaemons 创建并启动全部后台守护协程；返回的运行时实现 io.Closer 供停机关闭。
func startBackgroundDaemons(ctx context.Context, dependencies webuiRouteDependencies) (*backgroundDaemonsRuntime, error) {
	return startBackgroundDaemonsWithPorts(ctx, dependencies, webuiDaemonsPorts{})
}

func startBackgroundDaemonsWithPorts(
	ctx context.Context,
	dependencies webuiRouteDependencies,
	ports webuiDaemonsPorts,
) (*backgroundDaemonsRuntime, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	nowFn := ports.Now
	if nowFn == nil {
		nowFn = time.Now
	}

	aiHomeDir := strings.TrimSpace(dependencies.AIHomeDir)
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)

	rt := &backgroundDaemonsRuntime{
		now: nowFn,
	}

	// 1) Peer 空闲补投守护（强制 timeout=0 单点探测，不扫全量会话）。
	var peerDelivery peer.DeliveryOptions
	if ports.PeerDelivery != nil {
		peerDelivery = *ports.PeerDelivery
	}
	if peerDelivery.ServerBaseURL == nil {
		// chat commands 已由 Go 直接服务：优先指回本进程，Node 只在旧拓扑里兜底。
		selfBaseURL := strings.TrimSpace(dependencies.SelfBaseURL)
		nodeBaseURL := strings.TrimSpace(dependencies.NodeBaseURL)
		if selfBaseURL != "" {
			peerDelivery.ServerBaseURL = func() string { return selfBaseURL }
		} else {
			peerDelivery.ServerBaseURL = func() string { return nodeBaseURL }
		}
	}
	if peerDelivery.ManagementKey == nil && dependencies.ManagementKey != nil {
		peerDelivery.ManagementKey = dependencies.ManagementKey
	}
	peerAIHome := peer.ResolvePeerAIHomeDir(aiHomeDir, hostHomeDir, os.Getenv)
	if peerAIHome != "" {
		peerDaemon, err := peer.StartDispatchDaemon(ctx, peer.DispatchDaemonOptions{
			AIHomeDir:   peerAIHome,
			HostHomeDir: hostHomeDir,
			Interval:    ports.PeerInterval,
			Batch:       ports.PeerBatch,
			Delivery:    peerDelivery,
			Now:         nowFn,
		})
		if err != nil {
			_ = rt.Close()
			return nil, fmt.Errorf("启动 peer 补投守护失败: %w", err)
		}
		rt.peerDaemon = peerDaemon
	}

	// 2) 日志截断/按天归档清扫（启动 + 1h）与运行态目录回收（启动 + 6h）。
	if aiHomeDir != "" {
		retentionDaemon, err := retention.StartDaemon(ctx, retention.DaemonOptions{
			AIHomeDir:          aiHomeDir,
			CurrentHome:        os.Getenv("HOME"),
			Now:                nowFn,
			LogInterval:        ports.LogSweepInterval,
			RuntimeInterval:    ports.RuntimeSweepInterval,
			ActiveRefsProvider: buildActiveAccountRefsProvider(dependencies.Store, aiHomeDir),
		})
		if err != nil {
			_ = rt.Close()
			return nil, fmt.Errorf("启动保留期守护失败: %w", err)
		}
		rt.retentionDaemon = retentionDaemon
	}

	// 3) 账号额度后台探测调度器（优先端口注入，否则直连 sqliteaccount.Store + UsageService）。
	quotaSource := newAccountQuotaSourceAdapter(dependencies.Store)
	quotaPort := ports.QuotaProbePort
	if quotaPort == nil && dependencies.UsageService != nil {
		quotaPort = usageServiceQuotaPort{usage: dependencies.UsageService}
	}
	rt.quotaProbe = usagedaemons.NewQuotaProbeScheduler(usagedaemons.QuotaProbeOptions{
		Interval: ports.QuotaProbeInterval,
		Source:   quotaSource,
		Port:     quotaPort,
		Now:      nowFn,
	})
	if quotaSource != nil && quotaPort != nil {
		rt.quotaProbe.Start(ctx)
	}

	// 4) ZCode 账单归属对账存储与价格服务适配端口。
	ownerStore := ports.ZcodeOwnerStore
	if ownerStore == nil && aiHomeDir != "" {
		dbPath := filepath.Join(aiHomeDir, "app-state.db")
		if _, statErr := os.Stat(dbPath); statErr == nil {
			opened, openErr := openSQLiteZcodeOwnerStore(ctx, dbPath)
			if openErr == nil {
				ownerStore = opened
				rt.ownedOwnerStore = opened
			}
		}
	}

	pricingSvc := ports.PricingService
	if pricingSvc == nil {
		pricingSvc = dependencies.PricingService
	}
	if pricingSvc == nil && !ports.DisablePricingSync && aiHomeDir != "" {
		if store, storeErr := pricingcatalog.NewStore(aiHomeDir); storeErr == nil {
			httpClient := ports.PricingHTTPClient
			if httpClient == nil {
				httpClient = &http.Client{Timeout: daemonsPricingHTTPTimeout}
			}
			if svc, svcErr := pricingcatalog.NewService(pricingcatalog.ServiceDependencies{
				Store:      store,
				HTTPClient: httpClient,
				Now:        nowFn,
			}); svcErr == nil {
				pricingSvc = svc
			}
		}
	}

	scanPort := ports.UsageScanPort
	if scanPort == nil {
		scanPort = &hostUsageScanPort{
			aiHomeDir:  aiHomeDir,
			ownerStore: ownerStore,
			pricing:    pricingSvc,
			now:        nowFn,
		}
	}
	rt.usageScan = usagedaemons.NewUsageScanScheduler(usagedaemons.UsageScanSchedulerOptions{
		StartDelay: ports.UsageScanStartDelay,
		Interval:   ports.UsageScanInterval,
		Port:       scanPort,
		Now:        nowFn,
	})
	rt.usageScan.Start(ctx)

	refreshPort := ports.ProviderRefreshPort
	if refreshPort == nil {
		refreshPort = &hostProviderRefreshPort{
			aiHomeDir:  aiHomeDir,
			ownerStore: ownerStore,
		}
	}
	rt.providerRefresh = usagedaemons.NewProviderRefreshCoordinator(usagedaemons.ProviderRefreshOptions{
		HostHomeDir: hostHomeDir,
		AIHomeDir:   aiHomeDir,
		Port:        refreshPort,
		Now:         nowFn,
	})
	if err := rt.providerRefresh.Start(ctx); err != nil {
		_ = rt.Close()
		return nil, fmt.Errorf("启动 provider 用量监听守护失败: %w", err)
	}

	// 5) OAuth 令牌后台主动续期守护（受 DelegateCredentialRefresh 与 CredentialResolver 约束）。
	tokenAccountStore := ports.TokenRefreshAccountStore
	if tokenAccountStore == nil && dependencies.Store != nil {
		tokenAccountStore = dependencies.Store
	}
	tokenRuntime := resolveTokenRefreshRuntimeNotifier(ports.TokenRefreshRuntime, dependencies.AccountRuntime)
	rt.tokenRefresh = tokenrefreshdaemon.New(tokenrefreshdaemon.Options{
		Enabled:                   ports.TokenRefreshEnabled,
		DelegateCredentialRefresh: ports.DelegateCredentialRefresh,
		Interval:                  ports.TokenRefreshInterval,
		StartDelay:                ports.TokenRefreshStartDelay,
		Skew:                      ports.TokenRefreshSkew,
		Concurrency:               ports.TokenRefreshConcurrency,
		PerAccountTimeout:         ports.TokenRefreshTimeout,
		SuppressionRetryDelay:     ports.TokenRefreshRetryDelay,
		AIHomeDir:                 aiHomeDir,
		Store:                     tokenAccountStore,
		Refresher:                 ports.CredentialResolver,
		Runtime:                   tokenRuntime,
		Now:                       nowFn,
	})
	rt.tokenRefresh.Start(ctx)

	return rt, nil
}

// buildWebUIDaemonsRoutes 装配后台守护状态与触发控制路由，供 webuiroutes.go 直接接入。
func buildWebUIDaemonsRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	return buildWebUIDaemonsRoutesWithPorts(dependencies, webuiDaemonsPorts{})
}

func buildWebUIDaemonsRoutesWithPorts(
	dependencies webuiRouteDependencies,
	ports webuiDaemonsPorts,
) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}
	rt := ports.Runtime
	if rt == nil {
		var err error
		rt, err = startBackgroundDaemonsWithPorts(ports.Context, dependencies, ports)
		if err != nil {
			return nil, err
		}
	}
	return rt.Routes(dependencies.Authorizer)
}

// Routes 返回挂载了统一 Bearer 鉴权的后台守护控制路由列表。
func (r *backgroundDaemonsRuntime) Routes(authorizer webuidaemonsapi.Authorizer) ([]webuiRoute, error) {
	handler, err := webuidaemonsapi.NewHandler(webuidaemonsapi.Dependencies{
		Authorizer: authorizer,
		Controller: r,
	})
	if err != nil {
		return nil, fmt.Errorf("创建后台守护管理接口失败: %w", err)
	}
	return []webuiRoute{
		{Pattern: "GET " + webuidaemonsapi.StatusPath, Handler: handler},
		{Pattern: "POST " + webuidaemonsapi.TriggerPath, Handler: handler},
	}, nil
}

// NotifySessionEvent 将外部会话事件投递给 provider 用量增量刷新状态机。
func (r *backgroundDaemonsRuntime) NotifySessionEvent(ev usagedaemons.SessionEvent) bool {
	if r == nil || r.providerRefresh == nil {
		return false
	}
	return r.providerRefresh.NotifyEvent(ev)
}

// Status 返回所有后台守护与调度器的即时可观测状态。
func (r *backgroundDaemonsRuntime) Status(context.Context) webuidaemonsapi.StatusReport {
	nowMs := time.Now().UnixMilli()
	if r != nil && r.now != nil {
		nowMs = r.now().UnixMilli()
	}
	report := webuidaemonsapi.StatusReport{
		GeneratedAt: nowMs,
	}
	if r == nil {
		return report
	}
	if r.peerDaemon != nil {
		st := r.peerDaemon.State()
		report.Peer = &st
	}
	if r.retentionDaemon != nil {
		st := r.retentionDaemon.State()
		report.Retention = &st
	}
	if r.quotaProbe != nil {
		st := r.quotaProbe.State()
		report.QuotaProbe = &st
	}
	if r.usageScan != nil {
		st := r.usageScan.State()
		report.UsageScan = &st
	}
	if r.providerRefresh != nil {
		st := r.providerRefresh.State()
		report.ProviderRefresh = &st
	}
	if r.tokenRefresh != nil {
		st := r.tokenRefresh.State()
		report.TokenRefresh = &st
	}
	return report
}

// Trigger 按目标名称手动执行一轮指定守护或全部守护。
func (r *backgroundDaemonsRuntime) Trigger(ctx context.Context, req webuidaemonsapi.TriggerRequest) (webuidaemonsapi.TriggerResult, error) {
	target, err := webuidaemonsapi.NormalizeTarget(req.Daemon)
	if err != nil {
		return webuidaemonsapi.TriggerResult{}, err
	}
	results := make(map[string]any)
	runAll := target == "all"

	if (runAll || target == "peer") && r.peerDaemon != nil {
		summary, tickErr := r.peerDaemon.Tick(ctx)
		if tickErr != nil {
			results["peer"] = map[string]any{"ok": false, "error": tickErr.Error()}
		} else {
			results["peer"] = summary
		}
	}
	if (runAll || target == "logs") && r.retentionDaemon != nil {
		results["logs"] = r.retentionDaemon.TriggerLogs(ctx)
	}
	if (runAll || target == "retention") && r.retentionDaemon != nil {
		results["retention"] = r.retentionDaemon.TriggerRuntime(ctx)
	}
	if (runAll || target == "quota-probe") && r.quotaProbe != nil {
		summary, probeErr := r.quotaProbe.Tick(ctx)
		if probeErr != nil {
			results["quotaProbe"] = map[string]any{"ok": false, "error": probeErr.Error()}
		} else {
			results["quotaProbe"] = summary
		}
	}
	if (runAll || target == "usage-scan") && r.usageScan != nil {
		results["usageScan"] = r.usageScan.Trigger(ctx, "manual")
	}
	if (runAll || target == "provider-refresh") && r.providerRefresh != nil {
		records, refreshErr := r.providerRefresh.Trigger(ctx, req.Provider)
		if refreshErr != nil {
			results["providerRefresh"] = map[string]any{"ok": false, "records": records, "error": refreshErr.Error()}
		} else {
			results["providerRefresh"] = map[string]any{"ok": true, "records": records}
		}
	}
	if (runAll || target == "token-refresh") && r.tokenRefresh != nil {
		summary, refreshErr := r.tokenRefresh.Trigger(ctx, req.Provider)
		if refreshErr != nil {
			results["tokenRefresh"] = map[string]any{"ok": false, "error": refreshErr.Error()}
		} else {
			results["tokenRefresh"] = summary
		}
	}

	return webuidaemonsapi.TriggerResult{
		Target:  target,
		Results: results,
		Status:  r.Status(ctx),
	}, nil
}

// Close 实现 io.Closer，安全停止全部后台守护并释放自有数据库连接。
func (r *backgroundDaemonsRuntime) Close() error {
	if r == nil {
		return nil
	}
	var closeErr error
	r.closeOnce.Do(func() {
		if r.tokenRefresh != nil {
			_ = r.tokenRefresh.Close()
		}
		if r.providerRefresh != nil {
			_ = r.providerRefresh.Close()
		}
		if r.usageScan != nil {
			_ = r.usageScan.Close()
		}
		if r.quotaProbe != nil {
			_ = r.quotaProbe.Close()
		}
		if r.retentionDaemon != nil {
			_ = r.retentionDaemon.Close()
		}
		if r.peerDaemon != nil {
			_ = r.peerDaemon.Close()
		}
		if r.ownedOwnerStore != nil {
			closeErr = r.ownedOwnerStore.Close()
		}
	})
	return closeErr
}

func buildActiveAccountRefsProvider(store *sqliteaccount.Store, aiHomeDir string) retention.ActiveAccountRefsProvider {
	return func(ctx context.Context) ([]string, bool, error) {
		if store == nil {
			return nil, false, nil
		}
		refs := make(map[string]struct{})
		var afterRef accountcore.AccountRef
		for {
			query, err := accountapp.NewOverviewQuery(afterRef, accountapp.MaxOverviewLimit)
			if err != nil {
				return nil, false, err
			}
			overviews, err := store.ListAccountOverviews(ctx, query)
			if err != nil {
				return nil, false, err
			}
			for _, ov := range overviews {
				refStr := strings.TrimSpace(ov.Account().Ref().String())
				if refStr != "" {
					refs[refStr] = struct{}{}
				}
			}
			if len(overviews) < accountapp.MaxOverviewLimit {
				break
			}
			afterRef = overviews[len(overviews)-1].Account().Ref()
		}

		// 若存在 Node↔Go 账号引用映射，把对应的 Node ref 也加入活跃集合防止误杀 Node 创建的沙箱。
		if aiHomeDir != "" {
			if table, err := accountrefmap.Load(ctx, aiHomeDir); err == nil {
				for goRef := range refs {
					if nodeRef := strings.TrimSpace(table.NodeRef(goRef)); nodeRef != "" {
						refs[nodeRef] = struct{}{}
					}
				}
			}
		}

		out := make([]string, 0, len(refs))
		for ref := range refs {
			out = append(out, ref)
		}
		return out, true, nil
	}
}

type accountQuotaSourceAdapter struct {
	store *sqliteaccount.Store
}

func newAccountQuotaSourceAdapter(store *sqliteaccount.Store) usagedaemons.QuotaAccountSource {
	if store == nil {
		return nil
	}
	return &accountQuotaSourceAdapter{store: store}
}

func (a *accountQuotaSourceAdapter) ListQuotaAccounts(ctx context.Context) ([]usagedaemons.QuotaAccount, error) {
	if a == nil || a.store == nil {
		return nil, nil
	}
	var out []usagedaemons.QuotaAccount
	var afterRef accountcore.AccountRef
	for {
		query, err := accountapp.NewOverviewQuery(afterRef, accountapp.MaxOverviewLimit)
		if err != nil {
			return nil, err
		}
		overviews, err := a.store.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		for _, ov := range overviews {
			acc := ov.Account()
			if !acc.Enabled() || !ov.HasCredential() {
				continue
			}
			isAPIKey, apiErr := a.store.IsAPIKeyAccount(ctx, acc.Ref())
			if apiErr != nil {
				continue
			}
			var snap *usagedaemons.QuotaSnapshot
			if domainSnap, ok := ov.UsageSnapshot(); ok {
				entries := make([]usagedaemons.QuotaEntry, 0, len(domainSnap.Entries()))
				for _, entry := range domainSnap.Entries() {
					var remaining *float64
					if bps, has := entry.RemainingBasisPoints(); has {
						pct := float64(bps) / 100.0
						remaining = &pct
					}
					var resetAtMs int64
					if !entry.ResetAt().IsZero() {
						resetAtMs = entry.ResetAt().UnixMilli()
					}
					entries = append(entries, usagedaemons.QuotaEntry{
						RemainingPct: remaining,
						ResetAtMs:    resetAtMs,
					})
				}
				var capturedMs int64
				if !domainSnap.CapturedAt().IsZero() {
					capturedMs = domainSnap.CapturedAt().UnixMilli()
				}
				snap = &usagedaemons.QuotaSnapshot{
					CapturedAtMs: capturedMs,
					Entries:      entries,
				}
			}
			out = append(out, usagedaemons.QuotaAccount{
				Provider:   acc.ProviderID(),
				AccountRef: acc.Ref().String(),
				APIKeyMode: isAPIKey,
				Snapshot:   snap,
			})
		}
		if len(overviews) < accountapp.MaxOverviewLimit {
			break
		}
		afterRef = overviews[len(overviews)-1].Account().Ref()
	}
	return out, nil
}

type usageServiceQuotaPort struct {
	usage *usageapp.Service
}

func (p usageServiceQuotaPort) SupportsProvider(provider string) bool {
	return p.usage != nil && p.usage.SupportsProvider(strings.ToLower(strings.TrimSpace(provider)))
}

func (p usageServiceQuotaPort) ProbeAccountQuota(ctx context.Context, account usagedaemons.QuotaAccount) error {
	if p.usage == nil {
		return nil
	}
	ref, err := accountcore.ParseAccountRef(account.AccountRef)
	if err != nil {
		return err
	}
	_, err = p.usage.RefreshUsage(ctx, ref)
	return err
}

type hostUsageScanPort struct {
	aiHomeDir  string
	ownerStore zcodeOwnerStore
	pricing    *pricingcatalog.Service
	now        func() time.Time
}

func (p *hostUsageScanPort) ScanUsage(ctx context.Context, _ usagedaemons.UsageScanRequest) (usagedaemons.UsageScanResult, error) {
	reconciled, err := reconcileZcodeOwnership(ctx, p.aiHomeDir, p.ownerStore)
	if err != nil {
		return usagedaemons.UsageScanResult{}, err
	}
	return usagedaemons.UsageScanResult{
		RecordsScanned: reconciled,
		Summary: map[string]any{
			"zcodeReconciled": reconciled,
		},
	}, nil
}

func (p *hostUsageScanPort) SyncPricingIfStale(ctx context.Context) (map[string]any, error) {
	if p.pricing == nil {
		return map[string]any{"ok": true, "skipped": true, "reason": "pricing_unavailable"}, nil
	}
	st, err := p.pricing.Status(false)
	if err == nil && st.LastRun != nil && strings.TrimSpace(st.LastRun.At) != "" {
		parsedAt, parseErr := time.Parse(time.RFC3339Nano, st.LastRun.At)
		if parseErr != nil {
			parsedAt, parseErr = time.Parse(time.RFC3339, st.LastRun.At)
		}
		if parseErr == nil && p.now().Sub(parsedAt) < daemonsPricingStaleAge {
			return map[string]any{"ok": true, "skipped": true, "reason": "fresh"}, nil
		}
	}
	report, err := p.pricing.RefreshAll(ctx, nil)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ok": report.OK,
		"at": report.At,
	}, nil
}

type hostProviderRefreshPort struct {
	aiHomeDir  string
	ownerStore zcodeOwnerStore
}

func (p *hostProviderRefreshPort) ScanGrokSessionUsage(context.Context, string) (int, error) {
	return 0, nil
}

func (p *hostProviderRefreshPort) ScanCodebuddySessionUsage(context.Context, string, string) (int, error) {
	return 0, nil
}

func (p *hostProviderRefreshPort) ScanProviderNativeUsage(ctx context.Context, provider string) (int, error) {
	if strings.EqualFold(strings.TrimSpace(provider), "zcode") {
		return reconcileZcodeOwnership(ctx, p.aiHomeDir, p.ownerStore)
	}
	return 0, nil
}

type sqliteZcodeOwnerStore struct {
	db *sql.DB
}

func openSQLiteZcodeOwnerStore(ctx context.Context, dbPath string) (*sqliteZcodeOwnerStore, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, `PRAGMA busy_timeout = 5000`); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &sqliteZcodeOwnerStore{db: db}, nil
}

func (s *sqliteZcodeOwnerStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *sqliteZcodeOwnerStore) ReconcileZcodeOwners(ctx context.Context, records []zcodeOwnerRecord) (int, error) {
	if s == nil || s.db == nil || len(records) == 0 {
		return 0, nil
	}
	var tableExists int
	err := s.db.QueryRowContext(
		ctx,
		`SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = 'model_usage_records'`,
	).Scan(&tableExists)
	if err != nil || tableExists == 0 {
		return 0, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	stmt, err := tx.PrepareContext(ctx, `
		UPDATE model_usage_records SET account_ref = ?
		WHERE event_key = ? AND provider = 'zcode' AND source_kind = 'session_db'
			AND account_ref = '' AND session_id = ? AND timestamp_ms = ?`,
	)
	if err != nil {
		return 0, err
	}
	defer func() { _ = stmt.Close() }()

	changed := 0
	for _, rec := range records {
		ref := strings.TrimSpace(rec.AccountRef)
		uid := strings.TrimSpace(rec.UsageID)
		sid := strings.TrimSpace(rec.SessionID)
		if _, parseErr := accountcore.ParseAccountRef(ref); parseErr != nil || !zcodeOwnerIDPattern.MatchString(uid) || sid == "" || rec.TimestampMS <= 0 {
			return 0, errors.New("zcode_usage_owner_scope_invalid")
		}
		res, execErr := stmt.ExecContext(ctx, ref, "zcode:model_usage:"+uid, sid, rec.TimestampMS)
		if execErr != nil {
			return 0, execErr
		}
		if rows, _ := res.RowsAffected(); rows > 0 {
			changed += int(rows)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return changed, nil
}

func reconcileZcodeOwnership(ctx context.Context, aiHomeDir string, ownerStore zcodeOwnerStore) (int, error) {
	if strings.TrimSpace(aiHomeDir) == "" || ownerStore == nil {
		return 0, nil
	}
	zcodeRoot := filepath.Join(aiHomeDir, "run", "auth-projections", "zcode")
	entries, err := os.ReadDir(zcodeRoot)
	if err != nil {
		return 0, nil
	}
	resolvedAIHome, err := filepath.EvalSymlinks(aiHomeDir)
	if err != nil {
		return 0, nil
	}

	type usageKey struct {
		usageID     string
		sessionID   string
		timestampMs int64
	}
	claims := make(map[usageKey]map[string]zcodeOwnerRecord)

	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		accountRef := strings.TrimSpace(entry.Name())
		if _, err := accountcore.ParseAccountRef(accountRef); err != nil {
			continue
		}
		logPath := filepath.Join(zcodeRoot, accountRef, ".aih-runtime", "zcode-model-usage-owners.jsonl")
		info, err := os.Lstat(logPath)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			continue
		}
		expected := filepath.Join(resolvedAIHome, "run", "auth-projections", "zcode", accountRef, ".aih-runtime", "zcode-model-usage-owners.jsonl")
		physical, err := filepath.EvalSymlinks(logPath)
		if err != nil || physical != expected {
			continue
		}
		f, err := os.Open(logPath)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var rec struct {
				Version     int    `json:"version"`
				AccountRef  string `json:"accountRef"`
				UsageID     string `json:"usageId"`
				SessionID   string `json:"sessionId"`
				StartedAtMs int64  `json:"startedAtMs"`
				TimestampMs int64  `json:"timestampMs"`
			}
			if jsonErr := json.Unmarshal([]byte(line), &rec); jsonErr != nil {
				continue
			}
			if rec.Version != 1 || rec.AccountRef != accountRef ||
				!zcodeOwnerIDPattern.MatchString(rec.UsageID) ||
				!zcodeOwnerIDPattern.MatchString(rec.SessionID) ||
				rec.StartedAtMs <= 0 || rec.TimestampMs < rec.StartedAtMs {
				continue
			}
			key := usageKey{usageID: rec.UsageID, sessionID: rec.SessionID, timestampMs: rec.TimestampMs}
			byAcct, exists := claims[key]
			if !exists {
				byAcct = make(map[string]zcodeOwnerRecord)
				claims[key] = byAcct
			}
			byAcct[accountRef] = zcodeOwnerRecord{
				UsageID:     rec.UsageID,
				AccountRef:  accountRef,
				SessionID:   rec.SessionID,
				TimestampMS: rec.TimestampMs,
			}
		}
		_ = f.Close()
	}

	if len(claims) == 0 {
		return 0, nil
	}
	batch := make([]zcodeOwnerRecord, 0, len(claims))
	for _, byAcct := range claims {
		if len(byAcct) != 1 {
			continue
		}
		for _, item := range byAcct {
			batch = append(batch, item)
		}
	}
	if len(batch) == 0 {
		return 0, nil
	}
	return ownerStore.ReconcileZcodeOwners(ctx, batch)
}

func resolveTokenRefreshRuntimeNotifier(
	explicit tokenrefreshdaemon.AccountRuntimeNotifier,
	raw any,
) tokenrefreshdaemon.AccountRuntimeNotifier {
	if explicit != nil && !isTypedNilValue(explicit) {
		return explicit
	}
	if raw == nil || isTypedNilValue(raw) {
		return nil
	}
	notifier, ok := raw.(tokenrefreshdaemon.AccountRuntimeNotifier)
	if !ok || isTypedNilValue(notifier) {
		return nil
	}
	return notifier
}

func isTypedNilValue(val any) bool {
	if val == nil {
		return true
	}
	rv := reflect.ValueOf(val)
	switch rv.Kind() {
	case reflect.Ptr, reflect.Interface, reflect.Map, reflect.Slice, reflect.Chan, reflect.Func:
		return rv.IsNil()
	default:
		return false
	}
}
