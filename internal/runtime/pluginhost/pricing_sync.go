package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
)

const (
	// PricingCatalogCapability 是插件采集价格目录的能力名。
	PricingCatalogCapability    = "pricing.catalog"
	defaultPricingSyncInterval  = 24 * time.Hour
	minPricingSyncInterval      = 60 * time.Second
	defaultPricingDebounceDelay = 300 * time.Millisecond
	defaultPricingInvokeTimeout = 15 * time.Second
)

// PricingSyncOptions 配置插件价格采集与社区价格刷新任务。
type PricingSyncOptions struct {
	Runtime         *Runtime
	PricingService  *pricingcatalog.Service
	RefreshInterval time.Duration
	DebounceDelay   time.Duration
	InvokeTimeout   time.Duration
	OnApplied       func(context.Context)
	OnLog           func(string)
	Now             func() time.Time
}

// PricingSync 定期或在插件代次变化时，从 pricing.catalog 插件及社区来源刷新价格快照，
// 若有任何来源生效应用（Applied == true），触发 OnApplied 回调。
type PricingSync struct {
	runtime         *Runtime
	pricingService  *pricingcatalog.Service
	refreshInterval time.Duration
	debounceDelay   time.Duration
	invokeTimeout   time.Duration
	onApplied       func(context.Context)
	onLog           func(string)
	now             func() time.Time

	syncMu        sync.Mutex
	stateMu       sync.Mutex
	started       bool
	stopped       bool
	runCtx        context.Context
	runCancel     context.CancelFunc
	stopCh        chan struct{}
	doneCh        chan struct{}
	debounceTimer *time.Timer
	lastReport    *pricingcatalog.RefreshReport
	bgWG          sync.WaitGroup
}

// NewPricingSync 构造价格目录同步调度器。
func NewPricingSync(options PricingSyncOptions) (*PricingSync, error) {
	if options.PricingService == nil {
		return nil, errors.New("PricingSync 缺少 PricingService")
	}
	interval := options.RefreshInterval
	if interval <= 0 {
		interval = defaultPricingSyncInterval
	} else if interval < minPricingSyncInterval {
		interval = minPricingSyncInterval
	}
	debounce := options.DebounceDelay
	if debounce <= 0 {
		debounce = defaultPricingDebounceDelay
	}
	timeout := options.InvokeTimeout
	if timeout <= 0 {
		timeout = defaultPricingInvokeTimeout
	}
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	runCtx, runCancel := context.WithCancel(context.Background())
	return &PricingSync{
		runtime:         options.Runtime,
		pricingService:  options.PricingService,
		refreshInterval: interval,
		debounceDelay:   debounce,
		invokeTimeout:   timeout,
		onApplied:       options.OnApplied,
		onLog:           options.OnLog,
		now:             nowFn,
		runCtx:          runCtx,
		runCancel:       runCancel,
		stopCh:          make(chan struct{}),
		doneCh:          make(chan struct{}),
	}, nil
}

// Start 启动周期性价格刷新定时器（幂等）。
func (s *PricingSync) Start(ctx context.Context) error {
	if s == nil {
		return nil
	}
	s.stateMu.Lock()
	if s.stopped || s.started {
		s.stateMu.Unlock()
		return nil
	}
	s.started = true
	stopCh := s.stopCh
	doneCh := s.doneCh
	s.stateMu.Unlock()

	go func() {
		defer close(doneCh)
		ticker := time.NewTicker(s.refreshInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				_ = s.SyncNow(s.runCtx)
			}
		}
	}()
	return nil
}

// Stop 停止定时器及防抖调度并等待后台协程结束。
func (s *PricingSync) Stop() {
	if s == nil {
		return
	}
	s.stateMu.Lock()
	if s.stopped {
		s.stateMu.Unlock()
		return
	}
	s.stopped = true
	if s.debounceTimer != nil {
		s.debounceTimer.Stop()
		s.debounceTimer = nil
	}
	waitDone := s.started
	if s.runCancel != nil {
		s.runCancel()
	}
	close(s.stopCh)
	doneCh := s.doneCh
	s.stateMu.Unlock()

	if waitDone {
		<-doneCh
	}
	s.bgWG.Wait()
}

// NotifyRuntimeChanged 在插件代次切换或退避恢复后以防抖触发一次价格采集。
func (s *PricingSync) NotifyRuntimeChanged() {
	if s == nil {
		return
	}
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if s.stopped {
		return
	}
	if s.debounceTimer != nil {
		s.debounceTimer.Reset(s.debounceDelay)
		return
	}
	s.debounceTimer = time.AfterFunc(s.debounceDelay, func() {
		s.stateMu.Lock()
		if s.stopped {
			s.stateMu.Unlock()
			return
		}
		s.bgWG.Add(1)
		s.stateMu.Unlock()
		defer s.bgWG.Done()
		ctx, cancel := context.WithTimeout(s.runCtx, 2*time.Minute)
		defer cancel()
		_ = s.SyncNow(ctx)
	})
}

// SyncNow 立即执行一轮插件 pricing.catalog 采集 + 社区来源刷新（串行互斥）。
func (s *PricingSync) SyncNow(ctx context.Context) error {
	if s == nil || s.pricingService == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	nowISO := s.now().UTC().Format(time.RFC3339Nano)
	snapshots := s.collectPluginSnapshots(ctx, nowISO)

	report, err := s.pricingService.RefreshAll(ctx, snapshots)
	s.stateMu.Lock()
	reportCopy := report
	s.lastReport = &reportCopy
	s.stateMu.Unlock()
	if err != nil {
		return err
	}

	anyApplied := false
	for _, src := range report.Sources {
		if src.Applied {
			anyApplied = true
			break
		}
	}
	if anyApplied && s.onApplied != nil {
		s.onApplied(ctx)
	}
	return nil
}

// LastReport 返回最近一次价格目录刷新报告。
func (s *PricingSync) LastReport() *pricingcatalog.RefreshReport {
	if s == nil {
		return nil
	}
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if s.lastReport == nil {
		return nil
	}
	cp := *s.lastReport
	return &cp
}

func (s *PricingSync) collectPluginSnapshots(ctx context.Context, nowISO string) []pricingcatalog.PluginSnapshotInput {
	if s.runtime == nil {
		return nil
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return nil
	}
	defer lease.Release()

	chain := lease.Snapshot.Projection.ByCapability(PricingCatalogCapability)
	if len(chain) == 0 {
		return nil
	}
	results := make([]pricingcatalog.PluginSnapshotInput, 0, len(chain))
	for _, item := range chain {
		raw, err := s.runtime.Invoke(ctx, lease.Generation, item.ID, map[string]any{
			"schemaVersion": 1,
			"kind":          "catalog",
			"now":           nowISO,
		}, s.invokeTimeout)
		if err != nil {
			results = append(results, pricingcatalog.PluginSnapshotInput{
				ContributionID: item.ID,
				InstanceID:     item.InstanceID,
				Error:          firstNonEmpty(errorCode(err), "pricing_catalog_failed"),
				Detail:         err.Error(),
			})
			continue
		}
		snap, parseErr := buildNormalizedPricingSnapshot(raw, item.ID, item.InstanceID, nowISO)
		if parseErr != nil {
			results = append(results, pricingcatalog.PluginSnapshotInput{
				ContributionID: item.ID,
				InstanceID:     item.InstanceID,
				Error:          "pricing_catalog_invalid",
				Detail:         parseErr.Error(),
			})
			continue
		}
		results = append(results, snap)
	}
	return results
}

func buildNormalizedPricingSnapshot(raw json.RawMessage, contributionID, instanceID, nowISO string) (pricingcatalog.PluginSnapshotInput, error) {
	defaultSourceID := "plugin:" + instanceID + ":" + contributionID
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return pricingcatalog.PluginSnapshotInput{
			ContributionID: contributionID,
			InstanceID:     instanceID,
			SourceID:       defaultSourceID,
			Source:         pricingcatalog.SourceMeta{ID: defaultSourceID, Kind: "community", FetchedAt: nowISO},
			Quotes:         []json.RawMessage{},
			FetchedAt:      nowISO,
		}, nil
	}

	if strings.HasPrefix(trimmed, "[") {
		var quotes []json.RawMessage
		if err := json.Unmarshal(raw, &quotes); err != nil {
			return pricingcatalog.PluginSnapshotInput{}, err
		}
		return pricingcatalog.PluginSnapshotInput{
			ContributionID: contributionID,
			InstanceID:     instanceID,
			SourceID:       defaultSourceID,
			Source:         pricingcatalog.SourceMeta{ID: defaultSourceID, Kind: "community", FetchedAt: nowISO},
			Quotes:         quotes,
			FetchedAt:      nowISO,
		}, nil
	}

	var payload struct {
		Source        pricingcatalog.SourceMeta `json:"source"`
		Quotes        []json.RawMessage         `json:"quotes"`
		GeneratedAt   string                    `json:"generatedAt"`
		FetchedAt     string                    `json:"fetchedAt"`
		RequireReview *bool                     `json:"requireReview"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return pricingcatalog.PluginSnapshotInput{}, err
	}
	sourceID := strings.TrimSpace(payload.Source.ID)
	if sourceID == "" {
		sourceID = defaultSourceID
	}
	payload.Source.ID = sourceID
	if strings.TrimSpace(payload.Source.Kind) == "" {
		payload.Source.Kind = "community"
	}
	fetchedAt := firstNonEmpty(payload.GeneratedAt, payload.FetchedAt, payload.Source.FetchedAt, nowISO)
	payload.Source.FetchedAt = firstNonEmpty(payload.Source.FetchedAt, fetchedAt)
	if payload.Quotes == nil {
		payload.Quotes = []json.RawMessage{}
	}
	return pricingcatalog.PluginSnapshotInput{
		ContributionID: contributionID,
		InstanceID:     instanceID,
		SourceID:       sourceID,
		Source:         payload.Source,
		Quotes:         payload.Quotes,
		FetchedAt:      fetchedAt,
		GeneratedAt:    payload.GeneratedAt,
		RequireReview:  payload.RequireReview,
	}, nil
}
