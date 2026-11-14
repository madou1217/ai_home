// Package webuiaccountquotastatsapi 提供单账号额度与用量统计的 WebUI 只读处理器：
//
//	GET /v1/management/webui/accounts/{provider}/{accountRef}/quota-stats
//	GET /v0/webui/accounts/{provider}/{accountRef}/quota-stats
//
// 直接编排 Go 进程内的 QuotaStatsService 与 UsageBuckets 账本聚合，
// 零回环 HTTP 请求、零双进程拼装，统一支持 acct_*、CLI 数字序号、default 与历史映射引用。
package webuiaccountquotastatsapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/usageledger"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// Path 是管理面账号路径前缀。
	Path = "/v1/management/webui/accounts"
	// PublicPath 是浏览器公开账号路径前缀。
	PublicPath = "/v0/webui/accounts"
	// Suffix 是账号额度统计子资源名。
	Suffix = "quota-stats"

	maxWindowMinutes = 366 * 24 * 60
	maxBucketRows    = 400
	dayMS            = int64(24 * 60 * 60 * 1000)

	granularityWindow = "window"
	granularityDay    = usageledger.BucketGranularityDay
	granularityWeek   = usageledger.BucketGranularityWeek
)

var (
	// ErrInvalidDependencies 表示构造 Handler 缺少必要依赖。
	ErrInvalidDependencies = errors.New("webuiaccountquotastatsapi: 缺少必要依赖")
)

// Authorizer 判断请求是否通过管理面鉴权。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountLookup 校验账号是否存在并返回其归属 Provider。
type AccountLookup interface {
	LookupProvider(ctx context.Context, accountRef string) (string, bool, error)
}

// QuotaStatsReader 提供窗口期额度与消耗统计。
type QuotaStatsReader interface {
	BuildQuotaStats(ctx context.Context, query usageapp.QuotaStatsQuery) (usageapp.QuotaStatsResult, error)
}

// UsageBucketsReader 提供日/周时间桶 token 用量聚合。
type UsageBucketsReader interface {
	QueryUsageBuckets(ctx context.Context, query usageledger.Query, granularity string) ([]usageledger.BucketStats, error)
}

// Dependencies 汇总额度统计处理器的端口依赖。
type Dependencies struct {
	Authorizer   Authorizer
	Accounts     AccountLookup
	AIHomeDir    string
	QuotaStats   QuotaStatsReader
	UsageBuckets UsageBucketsReader
	Now          func() time.Time
}

// Handler 服务 GET .../accounts/{provider}/{accountRef}/quota-stats。
type Handler struct {
	authorizer   Authorizer
	accounts     AccountLookup
	aiHomeDir    string
	quotaStats   QuotaStatsReader
	usageBuckets UsageBucketsReader
	now          func() time.Time
}

// NewHandler 校验依赖并返回不可变的额度统计处理器。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.QuotaStats == nil || dependencies.UsageBuckets == nil {
		return nil, ErrInvalidDependencies
	}
	if dependencies.Accounts == nil && strings.TrimSpace(dependencies.AIHomeDir) == "" {
		return nil, ErrInvalidDependencies
	}
	clock := dependencies.Now
	if clock == nil {
		clock = time.Now
	}
	return &Handler{
		authorizer:   dependencies.Authorizer,
		accounts:     dependencies.Accounts,
		aiHomeDir:    strings.TrimSpace(dependencies.AIHomeDir),
		quotaStats:   dependencies.QuotaStats,
		usageBuckets: dependencies.UsageBuckets,
		now:          clock,
	}, nil
}

type rangeView struct {
	FromMS    int64 `json:"fromMs"`
	ToMS      int64 `json:"toMs"`
	RangeDays int   `json:"rangeDays"`
}

type scopeView struct {
	QuotaKey         string `json:"quotaKey"`
	Label            string `json:"label"`
	SampleCount      int64  `json:"sampleCount"`
	LastCapturedAtMS int64  `json:"lastCapturedAtMs"`
	Synthetic        bool   `json:"synthetic,omitempty"`
}

type dimensionView struct {
	WindowMinutes int64       `json:"windowMinutes"`
	Label         string      `json:"label"`
	Available     bool        `json:"available"`
	DataState     string      `json:"dataState"`
	Scopes        []scopeView `json:"scopes"`
}

type currentView struct {
	RemainingPct *float64 `json:"remainingPct"`
	ResetAtMS    int64    `json:"resetAtMs"`
	CapturedAtMS int64    `json:"capturedAtMs"`
}

type summaryView struct {
	WindowCount         int      `json:"windowCount"`
	CoveredWindowCount  int      `json:"coveredWindowCount"`
	TotalTokens         int64    `json:"totalTokens"`
	TotalCostUSD        *float64 `json:"totalCostUsd"`
	CostKnown           bool     `json:"costKnown"`
	RequestCount        int64    `json:"requestCount"`
	AvgConsumedPct      *float64 `json:"avgConsumedPct"`
	MaxConsumedPct      *float64 `json:"maxConsumedPct"`
	MinConsumedPct      *float64 `json:"minConsumedPct"`
	AvgTokensPerWindow  *int64   `json:"avgTokensPerWindow"`
	AvgCostUSDPerWindow *float64 `json:"avgCostUsdPerWindow"`
	LastResetAtMS       int64    `json:"lastResetAtMs"`
	NextCloseAtMS       int64    `json:"nextCloseAtMs"`
}

type windowRowView struct {
	Index              int      `json:"index"`
	AnchorAtMS         int64    `json:"anchorAtMs"`
	CloseAtMS          int64    `json:"closeAtMs"`
	ScheduledCloseAtMS int64    `json:"scheduledCloseAtMs"`
	Truncated          bool     `json:"truncated"`
	Live               bool     `json:"live"`
	RemainingStartPct  *float64 `json:"remainingStartPct"`
	RemainingEndPct    *float64 `json:"remainingEndPct"`
	RemainingMinPct    *float64 `json:"remainingMinPct"`
	ConsumedPct        *float64 `json:"consumedPct"`
	PeakConsumedPct    *float64 `json:"peakConsumedPct"`
	StartEstimated     bool     `json:"startEstimated"`
	SampleCount        int      `json:"sampleCount"`
	ObservedFromMS     int64    `json:"observedFromMs"`
	ObservedToMS       int64    `json:"observedToMs"`
	Tokens             int64    `json:"tokens"`
	CostUSD            *float64 `json:"costUsd"`
	CostKnown          bool     `json:"costKnown"`
	RequestCount       int64    `json:"requestCount"`
	Source             string   `json:"source"`
	Confidence         string   `json:"confidence"`
	ResetKind          string   `json:"resetKind"`
	Classification     string   `json:"classification"`
	PlanType           string   `json:"planType"`
	ApproximateClose   bool     `json:"approximateClose"`
	AnchorEstimated    bool     `json:"anchorEstimated"`
}

type usageBucketView struct {
	Index         int      `json:"index"`
	StartMS       int64    `json:"startMs"`
	EndMS         int64    `json:"endMs"`
	BucketStartMS int64    `json:"bucketStartMs"`
	Tokens        int64    `json:"tokens"`
	CostUSD       *float64 `json:"costUsd"`
	CostKnown     bool     `json:"costKnown"`
	RequestCount  int64    `json:"requestCount"`
}

type usageSummaryView struct {
	BucketCount         int      `json:"bucketCount"`
	TotalTokens         int64    `json:"totalTokens"`
	TotalCostUSD        *float64 `json:"totalCostUsd"`
	CostKnown           bool     `json:"costKnown"`
	RequestCount        int64    `json:"requestCount"`
	AvgTokensPerBucket  *int64   `json:"avgTokensPerBucket"`
	AvgCostUSDPerBucket *float64 `json:"avgCostUsdPerBucket"`
}

type statsResponse struct {
	OK            bool              `json:"ok"`
	Provider      string            `json:"provider"`
	AccountRef    string            `json:"accountRef"`
	GeneratedAtMS int64             `json:"generatedAtMs"`
	Range         rangeView         `json:"range"`
	Granularity   string            `json:"granularity"`
	Dimensions    []dimensionView   `json:"dimensions"`
	WindowMinutes int64             `json:"windowMinutes"`
	Scope         *scopeView        `json:"scope"`
	Current       *currentView      `json:"current"`
	Summary       summaryView       `json:"summary"`
	UsageBuckets  []usageBucketView `json:"usageBuckets"`
	UsageSummary  *usageSummaryView `json:"usageSummary"`
	Windows       []windowRowView   `json:"windows"`
	EmptyReason   *string           `json:"emptyReason"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// ServeHTTP 处理 GET .../accounts/{provider}/{accountRef}/quota-stats。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.quotaStats == nil || handler.usageBuckets == nil {
		writeError(response, http.StatusServiceUnavailable, "quota_stats_unavailable", "账号额度统计服务不可用")
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
	writeNoStoreHeaders(response)

	provider, rawRef, ok := extractTarget(request)
	if !ok {
		writeError(response, http.StatusBadRequest, "invalid_quota_stats_path", "无效的账号额度统计路径")
		return
	}

	parsedQuery, errCode, errMsg := parseStatsQuery(request.URL.Query(), handler.now)
	if errCode != "" {
		writeError(response, http.StatusBadRequest, errCode, errMsg)
		return
	}

	canonicalRef, found, err := handler.resolveAccount(request.Context(), provider, rawRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "build_quota_stats_failed", err.Error())
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, "account_not_found", "未找到 "+provider+" 账号 "+rawRef)
		return
	}

	result, err := handler.quotaStats.BuildQuotaStats(request.Context(), usageapp.QuotaStatsQuery{
		AccountRef:    canonicalRef,
		WindowMinutes: parsedQuery.windowMinutes,
		QuotaKey:      parsedQuery.scope,
		RangeDays:     parsedQuery.rangeDays,
		Now:           parsedQuery.anchor,
	})
	if err != nil {
		if errors.Is(err, usageapp.ErrInvalidQuotaStatsQuery) {
			writeError(response, http.StatusBadRequest, "invalid_quota_window", "无效的统计窗口参数")
			return
		}
		writeError(response, http.StatusInternalServerError, "build_quota_stats_failed", err.Error())
		return
	}

	hasWindowDimension := false
	for _, dim := range result.Dimensions {
		if dim.Available {
			hasWindowDimension = true
			break
		}
	}
	granularity := parsedQuery.granularity
	if granularity == "" {
		if hasWindowDimension {
			granularity = granularityWindow
		} else {
			granularity = granularityDay
		}
	}

	usageBuckets := make([]usageBucketView, 0)
	var usageSummary *usageSummaryView
	emptyReason := nullableString(result.EmptyReason)

	if granularity != granularityWindow {
		fromTime := time.UnixMilli(result.Range.FromMS).UTC()
		toTime := time.UnixMilli(result.Range.ToMS).UTC()
		if !toTime.After(fromTime) {
			toTime = parsedQuery.anchor.UTC()
			fromTime = toTime.Add(-time.Duration(parsedQuery.rangeDays) * 24 * time.Hour)
		}
		rawBuckets, bucketErr := handler.usageBuckets.QueryUsageBuckets(
			request.Context(),
			usageledger.Query{
				AccountRef: canonicalRef,
				From:       fromTime,
				To:         toTime,
			},
			granularity,
		)
		if bucketErr != nil {
			writeError(response, http.StatusInternalServerError, "build_quota_stats_failed", bucketErr.Error())
			return
		}
		usageBuckets, usageSummary = buildUsageBucketsAndSummary(rawBuckets, fromTime, toTime, granularity)
		hasUsage := false
		for _, bucket := range usageBuckets {
			if bucket.Tokens > 0 || bucket.RequestCount > 0 {
				hasUsage = true
				break
			}
		}
		if hasUsage {
			emptyReason = nil
		} else {
			noUsage := "no_usage_in_range"
			emptyReason = &noUsage
		}
	}

	writeJSON(response, http.StatusOK, statsResponse{
		OK:            true,
		Provider:      provider,
		AccountRef:    canonicalRef.String(),
		GeneratedAtMS: result.GeneratedAtMS,
		Range: rangeView{
			FromMS:    result.Range.FromMS,
			ToMS:      result.Range.ToMS,
			RangeDays: result.Range.RangeDays,
		},
		Granularity:   granularity,
		Dimensions:    mapDimensions(result.Dimensions),
		WindowMinutes: result.WindowMinutes,
		Scope:         mapScopePtr(result.Scope),
		Current:       mapCurrent(result.Current),
		Summary:       mapSummary(result.Summary),
		UsageBuckets:  usageBuckets,
		UsageSummary:  usageSummary,
		Windows:       mapWindows(result.Windows),
		EmptyReason:   emptyReason,
	})
}

type parsedStatsQuery struct {
	windowMinutes int64
	scope         string
	rangeDays     int
	granularity   string
	anchor        time.Time
}

func parseStatsQuery(values url.Values, clock func() time.Time) (parsedStatsQuery, string, string) {
	out := parsedStatsQuery{
		rangeDays: usageapp.DefaultQuotaStatsRangeDays,
		anchor:    clock().UTC(),
		scope:     strings.TrimSpace(values.Get("scope")),
	}

	if rawWindow := strings.TrimSpace(values.Get("window")); rawWindow != "" {
		windowMinutes, err := strconv.ParseInt(rawWindow, 10, 64)
		if err != nil || windowMinutes <= 0 || windowMinutes > maxWindowMinutes {
			return parsedStatsQuery{}, "invalid_quota_window", "窗口期必须是正整数分钟数"
		}
		out.windowMinutes = windowMinutes
	}

	rawRange := strings.TrimSpace(values.Get("rangeDays"))
	if rawRange == "" {
		rawRange = strings.TrimSpace(values.Get("range_days"))
	}
	if rawRange != "" {
		rangeDays, err := strconv.Atoi(rawRange)
		if err != nil || rangeDays <= 0 {
			return parsedStatsQuery{}, "invalid_quota_range_days", "统计范围必须是 1–90 天整数"
		}
		if rangeDays < usageapp.MinQuotaStatsRangeDays {
			rangeDays = usageapp.MinQuotaStatsRangeDays
		}
		if rangeDays > usageapp.MaxQuotaStatsRangeDays {
			rangeDays = usageapp.MaxQuotaStatsRangeDays
		}
		out.rangeDays = rangeDays
	}

	if rawGranularity := strings.ToLower(strings.TrimSpace(values.Get("granularity"))); rawGranularity != "" {
		switch rawGranularity {
		case granularityWindow, granularityDay, granularityWeek:
			out.granularity = rawGranularity
		default:
			return parsedStatsQuery{}, "invalid_quota_granularity", "无效的统计粒度参数"
		}
	}

	if rawTo := strings.TrimSpace(values.Get("to")); rawTo != "" {
		if toMS, err := strconv.ParseInt(rawTo, 10, 64); err == nil && toMS > 0 {
			out.anchor = time.UnixMilli(toMS).UTC()
		} else if parsedTime, err := time.Parse(time.RFC3339Nano, rawTo); err == nil {
			out.anchor = parsedTime.UTC()
		}
	}
	return out, "", ""
}

func extractTarget(request *http.Request) (string, string, bool) {
	if request == nil || request.URL == nil {
		return "", "", false
	}
	rawPath := request.URL.EscapedPath()
	if rawPath == "" {
		rawPath = request.URL.Path
	}
	for _, prefix := range []string{Path + "/", PublicPath + "/"} {
		if rest, ok := strings.CutPrefix(rawPath, prefix); ok {
			parts := strings.Split(rest, "/")
			if len(parts) == 3 && parts[2] == Suffix {
				provider, errP := url.PathUnescape(parts[0])
				ref, errR := url.PathUnescape(parts[1])
				if errP != nil || errR != nil {
					return "", "", false
				}
				provider = strings.ToLower(strings.TrimSpace(provider))
				ref = strings.TrimSpace(ref)
				if provider != "" && ref != "" {
					return provider, ref, true
				}
			}
		}
	}
	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	ref := strings.TrimSpace(request.PathValue("accountRef"))
	if provider != "" && ref != "" {
		if unescaped, err := url.PathUnescape(ref); err == nil {
			ref = strings.TrimSpace(unescaped)
		}
		return provider, ref, ref != ""
	}
	return "", "", false
}

func (handler *Handler) resolveAccount(
	ctx context.Context,
	provider string,
	rawRef string,
) (accountcore.AccountRef, bool, error) {
	candidates := make([]string, 0, 3)
	candidates = append(candidates, rawRef)

	if handler.aiHomeDir != "" {
		if resolved, ok, err := resolveFromAIHomeDir(ctx, handler.aiHomeDir, provider, rawRef); err != nil {
			return "", false, err
		} else if ok && resolved != "" && resolved != rawRef {
			candidates = append([]string{resolved}, candidates...)
		}
	}

	for _, candidate := range candidates {
		parsedRef, err := accountcore.ParseAccountRef(candidate)
		if err != nil {
			continue
		}
		if handler.accounts != nil {
			owner, found, lookupErr := handler.accounts.LookupProvider(ctx, parsedRef.String())
			if lookupErr != nil {
				return "", false, lookupErr
			}
			if found && strings.EqualFold(strings.TrimSpace(owner), provider) {
				return parsedRef, true, nil
			}
		}
		if handler.aiHomeDir != "" {
			owner, found, lookupErr := lookupProviderInDir(ctx, handler.aiHomeDir, parsedRef.String())
			if lookupErr != nil {
				return "", false, lookupErr
			}
			if found && strings.EqualFold(strings.TrimSpace(owner), provider) {
				return parsedRef, true, nil
			}
		}
	}
	return "", false, nil
}

func resolveFromAIHomeDir(ctx context.Context, aiHomeDir string, provider string, rawRef string) (string, bool, error) {
	aihPath := filepath.Join(aiHomeDir, "aih.db")
	if info, err := os.Stat(aihPath); err == nil && info.Mode().IsRegular() {
		db, openErr := appstate.OpenReadOnly(ctx, aihPath)
		if openErr == nil {
			defer func() { _ = db.Close() }()
			if strings.EqualFold(rawRef, "default") {
				var accountRef string
				qErr := db.QueryRowContext(ctx,
					`SELECT account_ref FROM account_defaults WHERE provider_id = ?`,
					provider,
				).Scan(&accountRef)
				if qErr == nil && strings.TrimSpace(accountRef) != "" {
					return strings.TrimSpace(accountRef), true, nil
				}
				if qErr != nil && !errors.Is(qErr, sql.ErrNoRows) && !isMissingTable(qErr) {
					return "", false, qErr
				}
			}
			if cliID, parseErr := strconv.ParseInt(rawRef, 10, 64); parseErr == nil && cliID > 0 {
				var accountRef string
				qErr := db.QueryRowContext(ctx,
					`SELECT account_ref FROM accounts WHERE provider_id = ? AND cli_account_id = ?`,
					provider, cliID,
				).Scan(&accountRef)
				if qErr == nil && strings.TrimSpace(accountRef) != "" {
					return strings.TrimSpace(accountRef), true, nil
				}
				if qErr != nil && !errors.Is(qErr, sql.ErrNoRows) && !isMissingTable(qErr) {
					return "", false, qErr
				}
			}
		}
	}

	table, err := accountrefmap.Load(ctx, aiHomeDir)
	if err != nil {
		return "", false, nil
	}
	mapped := strings.TrimSpace(table.GoRef(rawRef))
	if mapped != "" && mapped != rawRef {
		return mapped, true, nil
	}
	return "", false, nil
}

func lookupProviderInDir(ctx context.Context, aiHomeDir string, accountRef string) (string, bool, error) {
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return "", false, nil
	}
	return appstate.LookupAccountProvider(ctx, dbPath, accountRef)
}

func isMissingTable(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "no such table")
}

func buildUsageBucketsAndSummary(
	buckets []usageledger.BucketStats,
	from time.Time,
	to time.Time,
	granularity string,
) ([]usageBucketView, *usageSummaryView) {
	byStart := make(map[int64]usageledger.BucketStats, len(buckets))
	for _, bucket := range buckets {
		byStart[bucket.StartMS] = bucket
	}
	fromUTC := from.UTC()
	toUTC := to.UTC()
	cursor := usageledger.BucketStart(fromUTC, granularity)
	rows := make([]usageBucketView, 0, 32)
	var totalTokens int64
	var requestCount int64

	for index := 0; cursor.Before(toUTC) && index < maxBucketRows; index++ {
		next := usageledger.BucketEnd(cursor, granularity)
		row := usageBucketView{
			Index:         index,
			StartMS:       cursor.UnixMilli(),
			EndMS:         next.UnixMilli(),
			BucketStartMS: cursor.UnixMilli(),
			CostUSD:       nil,
			CostKnown:     false,
		}
		if fromUTC.After(cursor) {
			row.StartMS = fromUTC.UnixMilli()
		}
		if next.After(toUTC) {
			row.EndMS = toUTC.UnixMilli()
		}
		if bucket, exists := byStart[row.BucketStartMS]; exists {
			row.Tokens = int64(bucket.Tokens)
			row.RequestCount = int64(bucket.RequestCount)
		}
		totalTokens += row.Tokens
		requestCount += row.RequestCount
		rows = append(rows, row)
		cursor = next
	}

	var avgTokens *int64
	if len(rows) > 0 {
		rounded := int64(math.Round(float64(totalTokens) / float64(len(rows))))
		avgTokens = &rounded
	}
	summary := &usageSummaryView{
		BucketCount:         len(rows),
		TotalTokens:         totalTokens,
		TotalCostUSD:        nil,
		CostKnown:           false,
		RequestCount:        requestCount,
		AvgTokensPerBucket:  avgTokens,
		AvgCostUSDPerBucket: nil,
	}
	return rows, summary
}

func mapDimensions(dimensions []usageapp.QuotaStatsDimension) []dimensionView {
	out := make([]dimensionView, 0, len(dimensions))
	for _, dim := range dimensions {
		scopes := make([]scopeView, 0, len(dim.Scopes))
		for _, sc := range dim.Scopes {
			scopes = append(scopes, mapScope(sc))
		}
		out = append(out, dimensionView{
			WindowMinutes: dim.WindowMinutes,
			Label:         dim.Label,
			Available:     dim.Available,
			DataState:     dim.DataState,
			Scopes:        scopes,
		})
	}
	return out
}

func mapScope(sc usageapp.QuotaStatsScope) scopeView {
	return scopeView{
		QuotaKey:         sc.QuotaKey,
		Label:            sc.Label,
		SampleCount:      sc.SampleCount,
		LastCapturedAtMS: sc.LastCapturedAtMS,
		Synthetic:        sc.Synthetic,
	}
}

func mapScopePtr(sc *usageapp.QuotaStatsScope) *scopeView {
	if sc == nil {
		return nil
	}
	mapped := mapScope(*sc)
	return &mapped
}

func mapCurrent(cur *usageapp.QuotaStatsCurrent) *currentView {
	if cur == nil {
		return nil
	}
	return &currentView{
		RemainingPct: cur.RemainingPct,
		ResetAtMS:    cur.ResetAtMS,
		CapturedAtMS: cur.CapturedAtMS,
	}
}

func mapSummary(sum usageapp.QuotaStatsSummary) summaryView {
	return summaryView{
		WindowCount:         sum.WindowCount,
		CoveredWindowCount:  sum.CoveredWindowCount,
		TotalTokens:         sum.TotalTokens,
		TotalCostUSD:        sum.TotalCostUSD,
		CostKnown:           sum.CostKnown,
		RequestCount:        sum.RequestCount,
		AvgConsumedPct:      sum.AvgConsumedPct,
		MaxConsumedPct:      sum.MaxConsumedPct,
		MinConsumedPct:      sum.MinConsumedPct,
		AvgTokensPerWindow:  sum.AvgTokensPerWindow,
		AvgCostUSDPerWindow: sum.AvgCostUSDPerWindow,
		LastResetAtMS:       sum.LastResetAtMS,
		NextCloseAtMS:       sum.NextCloseAtMS,
	}
}

func mapWindows(windows []usageapp.QuotaStatsWindow) []windowRowView {
	out := make([]windowRowView, 0, len(windows))
	for _, w := range windows {
		out = append(out, windowRowView{
			Index:              w.Index,
			AnchorAtMS:         w.AnchorAtMS,
			CloseAtMS:          w.CloseAtMS,
			ScheduledCloseAtMS: w.ScheduledCloseAtMS,
			Truncated:          w.Truncated,
			Live:               w.Live,
			RemainingStartPct:  w.RemainingStartPct,
			RemainingEndPct:    w.RemainingEndPct,
			RemainingMinPct:    w.RemainingMinPct,
			ConsumedPct:        w.ConsumedPct,
			PeakConsumedPct:    w.PeakConsumedPct,
			StartEstimated:     w.StartEstimated,
			SampleCount:        w.SampleCount,
			ObservedFromMS:     w.ObservedFromMS,
			ObservedToMS:       w.ObservedToMS,
			Tokens:             w.Tokens,
			CostUSD:            w.CostUSD,
			CostKnown:          w.CostKnown,
			RequestCount:       w.RequestCount,
			Source:             w.Source,
			Confidence:         w.Confidence,
			ResetKind:          w.ResetKind,
			Classification:     w.Classification,
			PlanType:           w.PlanType,
			ApproximateClose:   w.ApproximateClose,
			AnchorEstimated:    w.AnchorEstimated,
		})
	}
	return out
}

func nullableString(raw string) *string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func writeNoStoreHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorResponse{
		OK:      false,
		Error:   code,
		Message: message,
	})
}
