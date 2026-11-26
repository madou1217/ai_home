// Package webuiaccountoutcomesapi 组装 WebUI 账号页状态条视图（90 天日桶 + 24 小时桶）。
//
// 数据聚合三路来源并与 Node account-outcomes-view 保持同一契约：
//  1. Go account_outcomes（aih.db，按 Go account_ref）；
//  2. Node node-account-outcomes KV（app-state.db app_kv，按 Node account_ref）；
//  3. 原生 CLI native_account_outcomes 表（app-state.db，按 Node account_ref，按本地时区分桶）。
package webuiaccountoutcomesapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountoutcomes"
)

const (
	// Path 是 WebUI 账号结果汇总契约路径。
	Path = "/v1/management/webui/account-outcomes"

	// DayCount 与 HourCount 与 Node account-outcomes-view 对齐。
	DayCount  = 90
	HourCount = 24
	hourMS    = int64(time.Hour / time.Millisecond)
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("账号结果 WebUI 接口依赖无效")

// Authorizer 校验 WebUI 管理请求的访问权限。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总组装账号结果视图所需的端口。
type Dependencies struct {
	Authorizer Authorizer
	GoOutcomes accountoutcomes.Reader
	AIHomeDir  string
	Location   *time.Location
	Now        func() time.Time
}

// BucketView 是单个时间桶的 JSON 视图。
type BucketView struct {
	StartMS  int64            `json:"startMs"`
	Success  int64            `json:"success"`
	Failures map[string]int64 `json:"failures"`
}

// AccountView 是单个账号在状态条上的稀疏桶视图。
type AccountView struct {
	AccountRef string       `json:"accountRef"`
	Days       []BucketView `json:"days"`
	Hours      []BucketView `json:"hours"`
}

// ViewData 是 GET /v1/management/webui/account-outcomes 返回的 data 字段。
type ViewData struct {
	GeneratedAt int64         `json:"generatedAt"`
	DayStarts   []int64       `json:"dayStarts"`
	HourStarts  []int64       `json:"hourStarts"`
	Accounts    []AccountView `json:"accounts"`
}

// Handler 处理 GET /v1/management/webui/account-outcomes。
type Handler struct {
	authorizer Authorizer
	goOutcomes accountoutcomes.Reader
	aiHomeDir  string
	location   *time.Location
	now        func() time.Time
}

// NewHandler 创建失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	loc := dependencies.Location
	if loc == nil {
		loc = time.Local
	}
	nowFn := dependencies.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		goOutcomes: dependencies.GoOutcomes,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
		location:   loc,
		now:        nowFn,
	}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "account_outcomes_unavailable"})
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized", "message": "需要管理密钥"})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}

	view, available := handler.buildView(request.Context())
	if !available {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "account_outcomes_unavailable"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "data": view})
}

func (handler *Handler) buildView(ctx context.Context) (ViewData, bool) {
	now := handler.now()
	nowMS := now.UnixMilli()
	dayStarts := buildDayStarts(now, handler.location)
	hourStarts := buildHourStarts(now, handler.location)
	dayFrom := dayStarts[0]
	hourFrom := hourStarts[0]

	goDays, goHours, goAvailable := handler.loadGoOutcomes(ctx, dayFrom, hourFrom)
	if !goAvailable {
		return ViewData{}, false
	}

	seen := make(map[string]struct{}, len(goDays)+len(goHours))
	orderedRefs := make([]string, 0, len(goDays)+len(goHours))
	for ref := range goDays {
		orderedRefs = append(orderedRefs, ref)
	}
	for ref := range goHours {
		if _, exists := seen[ref]; exists {
			continue
		}
		orderedRefs = append(orderedRefs, ref)
	}
	sort.Strings(orderedRefs)
	seen = make(map[string]struct{}, len(orderedRefs))
	for _, ref := range orderedRefs {
		seen[ref] = struct{}{}
	}

	accounts := make([]AccountView, 0, len(orderedRefs))
	for _, ref := range orderedRefs {
		dayBuckets := goDays[ref]
		hourBuckets := goHours[ref]
		if len(dayBuckets) == 0 && len(hourBuckets) == 0 {
			continue
		}
		accounts = append(accounts, AccountView{
			AccountRef: ref,
			Days:       sortedBuckets(dayBuckets),
			Hours:      sortedBuckets(hourBuckets),
		})
	}

	return ViewData{
		GeneratedAt: nowMS,
		DayStarts:   dayStarts,
		HourStarts:  hourStarts,
		Accounts:    accounts,
	}, true
}

func (handler *Handler) loadGoOutcomes(
	ctx context.Context,
	dayFrom int64,
	hourFrom int64,
) (map[string]bucketMap, map[string]bucketMap, bool) {
	if handler.goOutcomes == nil {
		return nil, nil, false
	}
	dayRows, dayErr := accountoutcomes.Query(ctx, handler.goOutcomes, accountoutcomes.Day, dayFrom)
	hourRows, hourErr := accountoutcomes.Query(ctx, handler.goOutcomes, accountoutcomes.Hour, hourFrom)
	if dayErr != nil || hourErr != nil {
		return nil, nil, false
	}
	return groupOutcomeBuckets(dayRows, dayFrom), groupOutcomeBuckets(hourRows, hourFrom), true
}

type bucketData struct {
	startMS  int64
	success  int64
	failures map[string]int64
}

type bucketMap map[int64]*bucketData

func groupOutcomeBuckets(rows []accountoutcomes.Bucket, fromMS int64) map[string]bucketMap {
	byAccount := make(map[string]bucketMap)
	for _, row := range rows {
		ref := row.AccountRef.String()
		if ref == "" || row.BucketStartMS < fromMS || row.Count <= 0 || strings.TrimSpace(row.Outcome) == "" {
			continue
		}
		addCount(byAccount, ref, row.BucketStartMS, row.Outcome, row.Count)
	}
	return byAccount
}

func addCount(target map[string]bucketMap, accountRef string, startMS int64, outcome string, count int64) {
	if count <= 0 || accountRef == "" || outcome == "" {
		return
	}
	buckets, exists := target[accountRef]
	if !exists {
		buckets = make(bucketMap)
		target[accountRef] = buckets
	}
	bucket, exists := buckets[startMS]
	if !exists {
		bucket = &bucketData{startMS: startMS, failures: make(map[string]int64)}
		buckets[startMS] = bucket
	}
	if outcome == accountoutcomes.OutcomeSuccess {
		bucket.success += count
		return
	}
	bucket.failures[outcome] += count
}

func mergeBuckets(primary bucketMap, extra bucketMap) bucketMap {
	if len(primary) == 0 && len(extra) == 0 {
		return nil
	}
	merged := make(bucketMap, len(primary)+len(extra))
	copyFrom := func(source bucketMap) {
		for startMS, bucket := range source {
			target, exists := merged[startMS]
			if !exists {
				target = &bucketData{startMS: startMS, failures: make(map[string]int64, len(bucket.failures))}
				merged[startMS] = target
			}
			target.success += bucket.success
			for kind, count := range bucket.failures {
				target.failures[kind] += count
			}
		}
	}
	copyFrom(primary)
	copyFrom(extra)
	return merged
}

func sortedBuckets(buckets bucketMap) []BucketView {
	if len(buckets) == 0 {
		return []BucketView{}
	}
	keys := make([]int64, 0, len(buckets))
	for startMS := range buckets {
		keys = append(keys, startMS)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	out := make([]BucketView, 0, len(keys))
	for _, startMS := range keys {
		bucket := buckets[startMS]
		out = append(out, BucketView{
			StartMS:  bucket.startMS,
			Success:  bucket.success,
			Failures: bucket.failures,
		})
	}
	return out
}

func buildDayStarts(now time.Time, loc *time.Location) []int64 {
	local := now.In(loc)
	starts := make([]int64, DayCount)
	for offset := DayCount - 1; offset >= 0; offset-- {
		starts[DayCount-1-offset] = time.Date(
			local.Year(), local.Month(), local.Day()-offset,
			0, 0, 0, 0, loc,
		).UnixMilli()
	}
	return starts
}

func buildHourStarts(now time.Time, loc *time.Location) []int64 {
	current := accountoutcomes.BucketStart(now, accountoutcomes.Hour, loc)
	starts := make([]int64, HourCount)
	for offset := HourCount - 1; offset >= 0; offset-- {
		starts[HourCount-1-offset] = current - int64(offset)*hourMS
	}
	return starts
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	encoded, err := json.Marshal(body)
	if err != nil {
		http.Error(response, "json_encode_failed", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_, _ = response.Write(encoded)
}
