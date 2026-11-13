package pricingcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

var (
	// ErrInvalidServiceDependencies 表示 Service 缺少可用 Store。
	ErrInvalidServiceDependencies = errors.New("pricing_service_dependencies_invalid")
	// ErrInvalidMergeRequest 表示 merge-quotes 缺少必需参数。
	ErrInvalidMergeRequest = errors.New("invalid_payload")
)

// ServiceDependencies 配置 pricingcatalog.Service。
type ServiceDependencies struct {
	Store            *Store
	CommunitySources []CommunitySource
	HTTPClient       HTTPClient
	Now              func() time.Time
}

// SourcesPayload 对齐 GET /v0/plugins/pricing/sources 的响应契约。
type SourcesPayload struct {
	CommunitySources []CommunitySource `json:"communitySources"`
	Sources          []SourceSummary   `json:"sources"`
	Reviews          []ReviewItem      `json:"reviews"`
}

// DoctorReport 对齐 GET /v0/plugins/doctor 的 pricing 段。
type DoctorReport struct {
	Sources        []DoctorSourceSummary `json:"sources"`
	PendingReviews int                   `json:"pendingReviews"`
	Reviews        []ReviewItem          `json:"reviews"`
	Records        int                   `json:"records"`
	LastRun        *RefreshReport        `json:"lastRun"`
}

// StatusPayload 对齐 GET /v0/plugins/pricing/status（含可选 doctor 详情）。
type StatusPayload struct {
	Running        bool          `json:"running"`
	LastRun        *RefreshReport `json:"lastRun"`
	Sources        int           `json:"sources"`
	PendingReviews int           `json:"pendingReviews"`
	Records        int           `json:"records"`
	Doctor         *DoctorReport `json:"doctor,omitempty"`
}

// PluginSnapshotInput 承载 Node pricing.catalog 插件采集的原始快照。
type PluginSnapshotInput struct {
	ContributionID string            `json:"contributionId"`
	InstanceID     string            `json:"instanceId"`
	SourceID       string            `json:"sourceId"`
	Source         SourceMeta        `json:"source"`
	Quotes         []json.RawMessage `json:"quotes"`
	FetchedAt      string            `json:"fetchedAt"`
	GeneratedAt    string            `json:"generatedAt"`
	RequireReview  *bool             `json:"requireReview"`
	Error          string            `json:"error"`
	Detail         string            `json:"detail"`
}

// RefreshAttempt 记录全量刷新时单个来源的执行结果。
type RefreshAttempt struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Quotes int    `json:"quotes,omitempty"`
	Error  string `json:"error,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// AppliedPluginSourceResult 记录单个来源在 RefreshAll 中的快照提交结果。
type AppliedPluginSourceResult struct {
	SourceID       string        `json:"sourceId"`
	InstanceID     string        `json:"instanceId,omitempty"`
	Applied        bool          `json:"applied"`
	ReviewRequired bool          `json:"reviewRequired"`
	Changes        []QuoteChange `json:"changes"`
	Reviews        []ReviewItem  `json:"reviews"`
	FetchedAt      string        `json:"fetchedAt"`
}

// RefreshReport 对应全量刷新报告（兼容 catalog-sync.js 的 report 契约）。
type RefreshReport struct {
	OK            bool                           `json:"ok"`
	At            string                         `json:"at"`
	RuntimeActive bool                           `json:"runtimeActive"`
	Attempts      []RefreshAttempt               `json:"attempts"`
	Sources       []AppliedPluginSourceResult    `json:"sources"`
	Reviews       []ReviewItem                   `json:"reviews"`
	Community     []CommunitySourceRefreshResult `json:"community"`
}

// MergeQuotesRequest 是 merge-quotes 的入参。
type MergeQuotesRequest struct {
	Provider        string                `json:"provider"`
	Model           string                `json:"model"`
	AccountRef      string                `json:"accountRef"`
	Quotes          []json.RawMessage     `json:"quotes"`
	HostOverride    RawQuoteList          `json:"hostOverride"`
	Snapshot        *PluginSnapshotInput  `json:"snapshot"`
	SourceSnapshots []PluginSnapshotInput `json:"sourceSnapshots"`
}

// MergeQuotesResult 是 merge-quotes 的结果。
type MergeQuotesResult struct {
	Quote           MergedPriceQuote       `json:"quote"`
	Contributions   int                    `json:"contributions"`
	Snapshot        *ApplySnapshotOutcome  `json:"snapshot,omitempty"`
	SourceSnapshots []ApplySnapshotOutcome `json:"sourceSnapshots,omitempty"`
}

// Service 编排价格快照存储、人工复核队列、社区价格刷新与报价合并。
type Service struct {
	store            *Store
	communitySources []CommunitySource
	httpClient       HTTPClient
	now              func() time.Time

	mu      sync.Mutex
	lastRun *RefreshReport
}

// NewService 创建价格服务；缺少 Store 时失败关闭。
func NewService(deps ServiceDependencies) (*Service, error) {
	if deps.Store == nil {
		return nil, ErrInvalidServiceDependencies
	}
	sources := deps.CommunitySources
	if sources == nil {
		sources = DefaultCommunitySources()
	} else {
		sources = append([]CommunitySource(nil), sources...)
	}
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		store:            deps.Store,
		communitySources: sources,
		httpClient:       deps.HTTPClient,
		now:              now,
	}, nil
}

// SourcesPayload 返回社区来源目录、当前生效快照摘要与待复核列表。
func (service *Service) SourcesPayload() (SourcesPayload, error) {
	docs, err := service.store.ListSources()
	if err != nil {
		return SourcesPayload{}, err
	}
	summaries := make([]SourceSummary, 0, len(docs))
	for _, doc := range docs {
		summaries = append(summaries, SourceSummary{
			SourceID:  doc.SourceID,
			Source:    doc.Source,
			FetchedAt: doc.FetchedAt,
			AppliedAt: doc.AppliedAt,
			Quotes:    len(doc.Quotes),
		})
	}
	reviews := service.store.ListReviews("pending")
	return SourcesPayload{
		CommunitySources: append([]CommunitySource(nil), service.communitySources...),
		Sources:          summaries,
		Reviews:          reviews,
	}, nil
}

// ListReviews 按状态筛选复核记录。
func (service *Service) ListReviews(status string) []ReviewItem {
	return service.store.ListReviews(status)
}

// Status 返回价格服务运行状态；includeDoctor 为 true 时附带 /plugins/doctor 所需摘要。
func (service *Service) Status(includeDoctor bool) (StatusPayload, error) {
	docs, err := service.store.ListSources()
	if err != nil {
		return StatusPayload{}, err
	}
	pendingReviews := service.store.ListReviews("pending")
	records, err := service.store.BuildPricingRecords()
	if err != nil {
		return StatusPayload{}, err
	}

	service.mu.Lock()
	lastRun := cloneRefreshReport(service.lastRun)
	service.mu.Unlock()

	payload := StatusPayload{
		Running:        true,
		LastRun:        lastRun,
		Sources:        len(docs),
		PendingReviews: len(pendingReviews),
		Records:        len(records),
	}
	if includeDoctor {
		doctorSources := make([]DoctorSourceSummary, 0, len(docs))
		for _, doc := range docs {
			doctorSources = append(doctorSources, DoctorSourceSummary{
				SourceID:  doc.SourceID,
				Kind:      doc.Source.Kind,
				FetchedAt: doc.FetchedAt,
				Quotes:    len(doc.Quotes),
			})
		}
		limit := len(pendingReviews)
		if limit > 20 {
			limit = 20
		}
		payload.Doctor = &DoctorReport{
			Sources:        doctorSources,
			PendingReviews: len(pendingReviews),
			Reviews:        append([]ReviewItem(nil), pendingReviews[:limit]...),
			Records:        len(records),
			LastRun:        cloneRefreshReport(lastRun),
		}
	}
	return payload, nil
}

// RefreshSource 刷新指定的社区价格源，并强制走复核门（首次生效，后续变化入 pending）。
func (service *Service) RefreshSource(ctx context.Context, sourceID string) (CommunitySourceRefreshResult, error) {
	id := strings.TrimSpace(sourceID)
	target, found := service.findCommunitySource(id)
	if !found {
		return CommunitySourceRefreshResult{}, ErrCommunitySourceUnknown
	}
	quotes, fetchedAt, err := FetchCommunitySource(ctx, service.httpClient, target, service.now())
	if err != nil {
		return CommunitySourceRefreshResult{}, err
	}
	requireReview := true
	outcome, err := service.store.ApplySnapshot(ApplySnapshotInput{
		SourceID:         target.ID,
		NormalizedQuotes: quotes,
		FetchedAt:        fetchedAt,
		RequireReview:    &requireReview,
		Source: SourceMeta{
			ID:        target.ID,
			Kind:      target.Kind,
			URL:       target.URL,
			License:   target.License,
			FetchedAt: fetchedAt,
		},
	})
	if err != nil {
		return CommunitySourceRefreshResult{}, err
	}
	return CommunitySourceRefreshResult{
		SourceID:       target.ID,
		Applied:        outcome.Applied,
		ReviewRequired: outcome.ReviewRequired,
		Changes:        outcome.Changes,
		Reviews:        outcome.Reviews,
		FetchedAt:      outcome.FetchedAt,
		QuoteCount:     len(quotes),
	}, nil
}

// RefreshAll 先处理随请求提交的插件价格源快照，再依次刷新全部内置社区价格源。
func (service *Service) RefreshAll(ctx context.Context, pluginSnapshots []PluginSnapshotInput) (RefreshReport, error) {
	attempts := make([]RefreshAttempt, 0, len(pluginSnapshots)+len(service.communitySources))
	applied := make([]AppliedPluginSourceResult, 0)
	reviews := make([]ReviewItem, 0)
	community := make([]CommunitySourceRefreshResult, 0, len(service.communitySources))
	runtimeActive := len(pluginSnapshots) > 0

	for _, snap := range pluginSnapshots {
		if strings.TrimSpace(snap.Error) != "" {
			attemptID := strings.TrimSpace(snap.ContributionID)
			if attemptID == "" {
				attemptID = strings.TrimSpace(snap.SourceID)
			}
			attempts = append(attempts, RefreshAttempt{
				ID:     attemptID,
				OK:     false,
				Error:  strings.TrimSpace(snap.Error),
				Detail: strings.TrimSpace(snap.Detail),
			})
			continue
		}
		outcome, sourceID, err := service.applyPluginSnapshot(snap)
		attemptID := strings.TrimSpace(snap.ContributionID)
		if attemptID == "" {
			attemptID = sourceID
		}
		if err != nil {
			attempts = append(attempts, RefreshAttempt{
				ID:     attemptID,
				OK:     false,
				Error:  "pricing_catalog_failed",
				Detail: err.Error(),
			})
			continue
		}
		attempts = append(attempts, RefreshAttempt{
			ID:     attemptID,
			OK:     true,
			Quotes: len(snap.Quotes),
		})
		applied = append(applied, AppliedPluginSourceResult{
			SourceID:       sourceID,
			InstanceID:     strings.TrimSpace(snap.InstanceID),
			Applied:        outcome.Applied,
			ReviewRequired: outcome.ReviewRequired,
			Changes:        outcome.Changes,
			Reviews:        outcome.Reviews,
			FetchedAt:      outcome.FetchedAt,
		})
		reviews = append(reviews, outcome.Reviews...)
	}

	for _, src := range service.communitySources {
		res, err := service.RefreshSource(ctx, src.ID)
		if err != nil {
			okFalse := false
			community = append(community, CommunitySourceRefreshResult{
				SourceID: src.ID,
				OK:       &okFalse,
				Error:    err.Error(),
				Changes:  []QuoteChange{},
				Reviews:  []ReviewItem{},
			})
			attempts = append(attempts, RefreshAttempt{
				ID:    src.ID,
				OK:    false,
				Error: err.Error(),
			})
			continue
		}
		community = append(community, res)
		attempts = append(attempts, RefreshAttempt{
			ID:     src.ID,
			OK:     true,
			Quotes: res.QuoteCount,
		})
		if res.Applied {
			applied = append(applied, AppliedPluginSourceResult{
				SourceID:       res.SourceID,
				Applied:        res.Applied,
				ReviewRequired: res.ReviewRequired,
				Changes:        res.Changes,
				Reviews:        res.Reviews,
				FetchedAt:      res.FetchedAt,
			})
		}
		reviews = append(reviews, res.Reviews...)
	}

	allOK := true
	for _, attempt := range attempts {
		if !attempt.OK {
			allOK = false
			break
		}
	}
	report := RefreshReport{
		OK:            allOK,
		At:            formatISOString(service.now()),
		RuntimeActive: runtimeActive,
		Attempts:      attempts,
		Sources:       applied,
		Reviews:       reviews,
		Community:     community,
	}

	service.mu.Lock()
	service.lastRun = cloneRefreshReport(&report)
	service.mu.Unlock()
	return report, nil
}

// ApproveSource 批准候选快照并推进生效版本。
func (service *Service) ApproveSource(sourceID string) (ApproveOutcome, error) {
	return service.store.ApproveSource(sourceID)
}

// RejectSource 拒绝候选快照并保留当前生效快照。
func (service *Service) RejectSource(sourceID string) (RejectOutcome, error) {
	return service.store.RejectSource(sourceID)
}

// MergeQuotes 对采集到的报价执行宿主维度级合并，并在携带快照时通过同一复核存储落盘。
func (service *Service) MergeQuotes(req MergeQuotesRequest) (MergeQuotesResult, error) {
	provider := strings.ToLower(strings.TrimSpace(req.Provider))
	model := strings.TrimSpace(req.Model)
	if provider == "" || model == "" {
		return MergeQuotesResult{}, ErrInvalidMergeRequest
	}

	var result MergeQuotesResult
	if req.Snapshot != nil {
		outcome, _, err := service.applyPluginSnapshot(*req.Snapshot)
		if err != nil {
			return MergeQuotesResult{}, err
		}
		result.Snapshot = &outcome
	}
	if len(req.SourceSnapshots) > 0 {
		outcomes := make([]ApplySnapshotOutcome, 0, len(req.SourceSnapshots))
		for _, snap := range req.SourceSnapshots {
			outcome, _, err := service.applyPluginSnapshot(snap)
			if err != nil {
				return MergeQuotesResult{}, err
			}
			outcomes = append(outcomes, outcome)
		}
		result.SourceSnapshots = outcomes
	}

	merged := MergePriceQuotes(req.Quotes, MergeOptions{
		Provider:     provider,
		Model:        model,
		AccountRef:   strings.TrimSpace(req.AccountRef),
		HostOverride: req.HostOverride,
		Now:          service.now(),
	})
	result.Quote = merged
	result.Contributions = len(req.Quotes)
	return result, nil
}

func (service *Service) applyPluginSnapshot(snap PluginSnapshotInput) (ApplySnapshotOutcome, string, error) {
	sourceID := strings.TrimSpace(snap.SourceID)
	if sourceID == "" {
		sourceID = strings.TrimSpace(snap.Source.ID)
	}
	if sourceID == "" && strings.TrimSpace(snap.InstanceID) != "" && strings.TrimSpace(snap.ContributionID) != "" {
		sourceID = "plugin:" + strings.TrimSpace(snap.InstanceID) + ":" + strings.TrimSpace(snap.ContributionID)
	}
	fetchedAt := strings.TrimSpace(snap.FetchedAt)
	if fetchedAt == "" {
		fetchedAt = strings.TrimSpace(snap.GeneratedAt)
	}
	if fetchedAt == "" {
		fetchedAt = strings.TrimSpace(snap.Source.FetchedAt)
	}
	meta := snap.Source
	meta.ID = sourceID
	if strings.TrimSpace(meta.Kind) == "" {
		meta.Kind = KindCommunity
	}
	requireReview := true
	if snap.RequireReview != nil {
		requireReview = *snap.RequireReview
	}
	outcome, err := service.store.ApplySnapshot(ApplySnapshotInput{
		SourceID:      sourceID,
		Source:        meta,
		RawQuotes:     snap.Quotes,
		FetchedAt:     fetchedAt,
		RequireReview: &requireReview,
	})
	return outcome, sourceID, err
}

func (service *Service) findCommunitySource(id string) (CommunitySource, bool) {
	for _, src := range service.communitySources {
		if src.ID == id {
			return src, true
		}
	}
	return CommunitySource{}, false
}

func cloneRefreshReport(report *RefreshReport) *RefreshReport {
	if report == nil {
		return nil
	}
	copied := *report
	copied.Attempts = append([]RefreshAttempt(nil), report.Attempts...)
	copied.Sources = append([]AppliedPluginSourceResult(nil), report.Sources...)
	copied.Reviews = append([]ReviewItem(nil), report.Reviews...)
	copied.Community = append([]CommunitySourceRefreshResult(nil), report.Community...)
	return &copied
}
