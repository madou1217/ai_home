// Package webuiaccountoutcomesapi 组装 WebUI 账号页状态条视图（90 天日桶 + 24 小时桶）。
//
// 数据聚合三路来源并与 Node account-outcomes-view 保持同一契约：
//  1. Go account_outcomes（aih.db，按 Go account_ref）；
//  2. Node node-account-outcomes KV（app-state.db app_kv，按 Node account_ref）；
//  3. 原生 CLI native_account_outcomes 表（app-state.db，按 Node account_ref，按本地时区分桶）。
package webuiaccountoutcomesapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// Path 是 WebUI 账号结果汇总契约路径。
	Path = "/v1/management/webui/account-outcomes"

	// DayCount 与 HourCount 与 Node account-outcomes-view 对齐。
	DayCount  = 90
	HourCount = 24
	hourMS    = int64(time.Hour / time.Millisecond)

	nodeOutcomesKVKey = "node-account-outcomes"
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
	appState := handler.loadAppState(ctx, dayFrom, hourFrom)

	if !goAvailable && !appState.available {
		return ViewData{}, false
	}

	// 汇总候选 accountRef：先保留 Node account_refs 顺序，再补入纯 Go 记录中的新引用。
	seen := make(map[string]struct{}, len(appState.accountRefs)+len(goDays)+len(goHours))
	orderedRefs := make([]string, 0, len(appState.accountRefs)+len(goDays)+len(goHours))
	addRef := func(ref string) {
		trimmed := strings.TrimSpace(ref)
		if trimmed == "" {
			return
		}
		if _, exists := seen[trimmed]; exists {
			return
		}
		seen[trimmed] = struct{}{}
		orderedRefs = append(orderedRefs, trimmed)
	}
	for _, ref := range appState.accountRefs {
		addRef(ref)
	}
	extraGoRefs := make([]string, 0)
	for goRef := range goDays {
		extraGoRefs = append(extraGoRefs, goRef)
	}
	for goRef := range goHours {
		if _, exists := goDays[goRef]; !exists {
			extraGoRefs = append(extraGoRefs, goRef)
		}
	}
	sort.Strings(extraGoRefs)
	for _, goRef := range extraGoRefs {
		mapped := appState.refMap.NodeRef(goRef)
		if mapped == "" {
			mapped = goRef
		}
		addRef(mapped)
	}

	accounts := make([]AccountView, 0, len(orderedRefs))
	for _, nodeRef := range orderedRefs {
		goRef := appState.refMap.GoRef(nodeRef)
		dayBuckets := mergeBuckets(
			mergeBuckets(goDays[goRef], appState.nodeDays[nodeRef]),
			appState.nativeDays[nodeRef],
		)
		hourBuckets := mergeBuckets(
			mergeBuckets(goHours[goRef], appState.nodeHours[nodeRef]),
			appState.nativeHours[nodeRef],
		)
		if len(dayBuckets) == 0 && len(hourBuckets) == 0 {
			continue
		}
		accounts = append(accounts, AccountView{
			AccountRef: nodeRef,
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

type appStateData struct {
	available   bool
	refMap      accountrefmap.Table
	accountRefs []string
	nodeDays    map[string]bucketMap
	nodeHours   map[string]bucketMap
	nativeDays  map[string]bucketMap
	nativeHours map[string]bucketMap
}

func (handler *Handler) loadAppState(ctx context.Context, dayFrom int64, hourFrom int64) appStateData {
	if handler.aiHomeDir == "" {
		return appStateData{}
	}
	dbPath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		return appStateData{}
	}
	if _, statErr := os.Stat(dbPath); statErr != nil {
		return appStateData{}
	}
	db, err := appstate.OpenReadOnly(ctx, dbPath)
	if err != nil {
		return appStateData{}
	}
	defer func() { _ = db.Close() }()

	refMap, _ := accountrefmap.Load(ctx, handler.aiHomeDir)
	data := appStateData{
		available:   true,
		refMap:      refMap,
		accountRefs: queryAccountRefs(ctx, db),
		nodeDays:    map[string]bucketMap{},
		nodeHours:   map[string]bucketMap{},
		nativeDays:  map[string]bucketMap{},
		nativeHours: map[string]bucketMap{},
	}

	if rawNodeKV, found, kvErr := appstate.ReadKV(ctx, dbPath, nodeOutcomesKVKey); kvErr == nil && found {
		decodeNodeOutcomesKV(rawNodeKV, dayFrom, hourFrom, data.nodeDays, data.nodeHours)
	}
	loadNativeOutcomes(ctx, db, dayFrom, hourFrom, handler.location, data.nativeDays, data.nativeHours)
	return data
}

func queryAccountRefs(ctx context.Context, db *sql.DB) []string {
	rows, err := db.QueryContext(ctx, `SELECT account_ref FROM account_refs ORDER BY provider, account_ref`)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	var refs []string
	for rows.Next() {
		var ref string
		if scanErr := rows.Scan(&ref); scanErr != nil {
			continue
		}
		if trimmed := strings.TrimSpace(ref); trimmed != "" {
			refs = append(refs, trimmed)
		}
	}
	return refs
}

type nodeKVPayload struct {
	Accounts map[string][]struct {
		Granularity string           `json:"granularity"`
		StartMS     int64            `json:"startMs"`
		Success     int64            `json:"success"`
		Failures    map[string]int64 `json:"failures"`
	} `json:"accounts"`
}

func decodeNodeOutcomesKV(
	raw string,
	dayFrom int64,
	hourFrom int64,
	dayOut map[string]bucketMap,
	hourOut map[string]bucketMap,
) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "null" {
		return
	}
	var payload nodeKVPayload
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return
	}
	for ref, entries := range payload.Accounts {
		accountRef := strings.TrimSpace(ref)
		if accountRef == "" {
			continue
		}
		for _, entry := range entries {
			target := dayOut
			minStart := dayFrom
			if entry.Granularity == "hour" {
				target = hourOut
				minStart = hourFrom
			}
			if entry.StartMS < minStart {
				continue
			}
			if entry.Success > 0 {
				addCount(target, accountRef, entry.StartMS, accountoutcomes.OutcomeSuccess, entry.Success)
			}
			for outcome, count := range entry.Failures {
				name := strings.TrimSpace(outcome)
				if name == "" || count <= 0 {
					continue
				}
				addCount(target, accountRef, entry.StartMS, name, count)
			}
		}
	}
}

func loadNativeOutcomes(
	ctx context.Context,
	db *sql.DB,
	dayFrom int64,
	hourFrom int64,
	loc *time.Location,
	dayOut map[string]bucketMap,
	hourOut map[string]bucketMap,
) {
	rows, err := db.QueryContext(ctx, `
		SELECT account_ref, outcome, timestamp_ms
		FROM native_account_outcomes
		WHERE timestamp_ms >= ?
		ORDER BY timestamp_ms ASC`, dayFrom)
	if err != nil {
		return
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var ref, outcome string
		var tsMS int64
		if scanErr := rows.Scan(&ref, &outcome, &tsMS); scanErr != nil {
			continue
		}
		accountRef := strings.TrimSpace(ref)
		name := strings.TrimSpace(outcome)
		if accountRef == "" || name == "" || tsMS < dayFrom {
			continue
		}
		at := time.UnixMilli(tsMS)
		dayStart := accountoutcomes.BucketStart(at, accountoutcomes.Day, loc)
		if dayStart >= dayFrom {
			addCount(dayOut, accountRef, dayStart, name, 1)
		}
		if tsMS >= hourFrom {
			hourStart := accountoutcomes.BucketStart(at, accountoutcomes.Hour, loc)
			if hourStart >= hourFrom {
				addCount(hourOut, accountRef, hourStart, name, 1)
			}
		}
	}
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
