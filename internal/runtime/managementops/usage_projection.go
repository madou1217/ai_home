package managementops

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/usagepricing"
)

const (
	scannerAfterProxyWindowMS  int64 = 300_000
	scannerBeforeProxyWindowMS int64 = 5_000
	legacyUnknownModel               = "legacy-unknown"
	maxTrendPoints                   = 120
)

var (
	trendBucketCandidatesMS = []int64{
		5 * 60 * 1000,
		15 * 60 * 1000,
		60 * 60 * 1000,
		6 * 60 * 60 * 1000,
		24 * 60 * 60 * 1000,
		7 * 24 * 60 * 60 * 1000,
		30 * 24 * 60 * 60 * 1000,
	}
	codexFileEventPattern = regexp.MustCompile(`^codex:file:([0-9a-f]{16}):(\d+):(usage|prompt)$`)
	crossProviderSources  = map[string]map[string]bool{
		"agy":   {"server_code_assist_proxy": true},
		"codex": {"server_codex_proxy": true},
	}
)

// UsageProjectionContext 保存预先计算好的分叉上下文、高水位线及跨源归因配对结果。
type UsageProjectionContext struct {
	ForkDescriptors      []forkDescriptor
	Attributions         []usageAttribution
	RecordHighWaterID    int64
	PromptHighWaterRowID int64
}

type forkDescriptor struct {
	SourceHash     string
	ReplayPending  bool
	BoundaryOffset int64
	SessionID      string
	CWD            string
	Project        string
}

type usageAttribution struct {
	ScannerID          int64
	ProxyID            int64
	ScannerTimestampMS int64
	ProxyTimestampMS   int64
	Model              string
	AccountProvider    string
	AccountRef         string
	CostUSD            float64
}

type observationRow struct {
	ID                       int64
	EventKey                 string
	Provider                 string
	AccountRef               string
	SessionID                string
	SourceKind               string
	Model                    string
	InputTokens              int64
	OutputTokens             int64
	CacheReadInputTokens     int64
	CacheCreationInputTokens int64
	ReasoningOutputTokens    int64
	TotalTokens              int64
	CostUSD                  float64
	TimestampMS              int64
	Project                  string
	CWD                      string
	GitBranch                string
}

type matchCandidate struct {
	ScannerID          int64
	ProxyID            int64
	ScannerTimestampMS int64
	DeltaMS            int64
	SessionRank        int64
}

// ResolveUsageTrend 根据时间区间与可选显式分桶参数计算趋势桶定义。
func ResolveUsageTrend(fromMS, toMS, reqBucketMS, reqOriginMS int64) (originMS, bucketMS, clampedFrom, clampedTo int64) {
	if fromMS < 0 {
		fromMS = 0
	}
	if toMS < fromMS {
		toMS = fromMS
	}
	if reqBucketMS > 0 && reqOriginMS > 0 {
		return reqOriginMS, reqBucketMS, fromMS, toMS
	}
	spanMS := toMS - fromMS + 1
	if spanMS < 1 {
		spanMS = 1
	}
	chosen := int64(0)
	for _, cand := range trendBucketCandidatesMS {
		count := (spanMS + cand - 1) / cand
		if count <= maxTrendPoints {
			chosen = cand
			break
		}
	}
	if chosen <= 0 {
		chosen = (spanMS + maxTrendPoints - 1) / maxTrendPoints
	}
	if chosen <= 0 {
		chosen = 1
	}
	return fromMS, chosen, fromMS, toMS
}

func listTrendBucketStarts(fromMS, toMS, originMS, bucketMS int64) []int64 {
	if originMS <= 0 || bucketMS <= 0 || toMS < fromMS {
		return nil
	}
	firstIdx := (fromMS - originMS) / bucketMS
	if firstIdx < 0 {
		firstIdx = 0
	}
	lastIdx := (toMS - originMS) / bucketMS
	if lastIdx < firstIdx {
		lastIdx = firstIdx
	}
	count := int(lastIdx-firstIdx) + 1
	if count > 4096 {
		count = 4096
	}
	starts := make([]int64, 0, count)
	for i := 0; i < count; i++ {
		starts = append(starts, originMS+(firstIdx+int64(i))*bucketMS)
	}
	return starts
}

// PrepareDashboardProjection 预构建渐进查询跨分片复用的读投影上下文。
func (s *UsageStore) PrepareDashboardProjection(ctx context.Context, query UsageQuery) (*UsageProjectionContext, error) {
	if s == nil || s.db == nil {
		return nil, ErrUsageUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	normalized := normalizeUsageQueryBounds(query)
	return s.prepareDashboardProjectionCached(ctx, normalized)
}

func (s *UsageStore) prepareProjectionContextConn(ctx context.Context, conn *sql.Conn, query UsageQuery) (*UsageProjectionContext, error) {
	if s == nil || s.db == nil {
		return nil, ErrUsageUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	normalized := normalizeUsageQueryBounds(query)
	return s.prepareProjectionContextSnapshotConn(ctx, conn, normalized)
}

func readForkDescriptorsConn(ctx context.Context, conn *sql.Conn) ([]forkDescriptor, error) {
	rows, err := conn.QueryContext(ctx, `
		SELECT path, scan_context
		FROM model_usage_file_state
		WHERE scan_context != ''
			AND scan_context LIKE '%"codexForkSession":true%'`)
	if err != nil {
		return nil, fmt.Errorf("读取 Codex 分叉文件状态失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	byHash := make(map[string]forkDescriptor)
	ambiguous := make(map[string]struct{})
	for rows.Next() {
		var path, rawCtx string
		if scanErr := rows.Scan(&path, &rawCtx); scanErr != nil {
			return nil, scanErr
		}
		var ctxObj struct {
			CodexForkSession              bool   `json:"codexForkSession"`
			CodexForkSourceHash           string `json:"codexForkSourceHash"`
			CodexForkReplayPending        bool   `json:"codexForkReplayPending"`
			CodexForkReplayBoundaryOffset int64  `json:"codexForkReplayBoundaryOffset"`
			CodexForkCanonicalSessionID   string `json:"codexForkCanonicalSessionId"`
			SessionID                     string `json:"sessionId"`
			CodexForkCanonicalCWD         string `json:"codexForkCanonicalCwd"`
			CWD                           string `json:"cwd"`
			CodexForkCanonicalProject     string `json:"codexForkCanonicalProject"`
		}
		if json.Unmarshal([]byte(rawCtx), &ctxObj) != nil || !ctxObj.CodexForkSession {
			continue
		}
		hash := strings.ToLower(strings.TrimSpace(ctxObj.CodexForkSourceHash))
		if !sourceHashRe.MatchString(hash) {
			continue
		}
		if _, dup := byHash[hash]; dup {
			ambiguous[hash] = struct{}{}
			continue
		}
		byHash[hash] = forkDescriptor{
			SourceHash:     hash,
			ReplayPending:  ctxObj.CodexForkReplayPending,
			BoundaryOffset: maxInt64(0, ctxObj.CodexForkReplayBoundaryOffset),
			SessionID:      strings.TrimSpace(firstNonEmpty(ctxObj.CodexForkCanonicalSessionID, ctxObj.SessionID)),
			CWD:            strings.TrimSpace(firstNonEmpty(ctxObj.CodexForkCanonicalCWD, ctxObj.CWD)),
			Project:        strings.TrimSpace(ctxObj.CodexForkCanonicalProject),
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]forkDescriptor, 0, len(byHash))
	for hash, desc := range byHash {
		if _, isAmbig := ambiguous[hash]; isAmbig {
			continue
		}
		out = append(out, desc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SourceHash < out[j].SourceHash })
	return out, nil
}

func (s *UsageStore) createAttributionsConn(
	ctx context.Context,
	conn *sql.Conn,
	query UsageQuery,
	forks []forkDescriptor,
	recordHW int64,
) ([]usageAttribution, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	fromMS := maxInt64(0, query.FromMS-scannerAfterProxyWindowMS)
	toMS := query.ToMS + scannerBeforeProxyWindowMS
	if toMS < query.ToMS {
		toMS = math.MaxInt64
	}
	hw := recordHW
	if hw <= 0 {
		hw = math.MaxInt64
	}

	var hasCandidate int
	if err := conn.QueryRowContext(ctx, `
		SELECT 1
		FROM model_usage_records INDEXED BY idx_model_usage_timestamp
		WHERE timestamp_ms BETWEEN ? AND ?
			AND id <= ?
			AND source_kind IN ('session_jsonl', 'session_json')
			AND model != ''
		LIMIT 1`, fromMS, toMS, hw).Scan(&hasCandidate); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("检查扫描候选记录失败: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	proxyRows, err := conn.QueryContext(ctx, `
		SELECT
			id, provider, account_ref, session_id, source_kind, model,
			input_tokens, output_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
			cost_usd, timestamp_ms
		FROM model_usage_records
		WHERE timestamp_ms BETWEEN ? AND ?
			AND id <= ?
			AND source_kind GLOB 'server_*'
			AND model != ''
			AND (
				input_tokens > 0
				OR output_tokens > 0
				OR cache_read_input_tokens > 0
				OR cache_creation_input_tokens > 0
				OR reasoning_output_tokens > 0
			)
		ORDER BY timestamp_ms, id`, fromMS, toMS, hw)
	if err != nil {
		return nil, fmt.Errorf("读取代理请求观测记录失败: %w", err)
	}
	defer func() { _ = proxyRows.Close() }()

	var proxies []observationRow
	proxyByID := make(map[int64]observationRow)
	for proxyRows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var r observationRow
		if scanErr := proxyRows.Scan(
			&r.ID, &r.Provider, &r.AccountRef, &r.SessionID, &r.SourceKind, &r.Model,
			&r.InputTokens, &r.OutputTokens, &r.CacheReadInputTokens,
			&r.CacheCreationInputTokens, &r.ReasoningOutputTokens, &r.TotalTokens,
			&r.CostUSD, &r.TimestampMS,
		); scanErr != nil {
			return nil, scanErr
		}
		proxies = append(proxies, r)
		proxyByID[r.ID] = r
	}
	if err := proxyRows.Err(); err != nil {
		return nil, err
	}
	_ = proxyRows.Close()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(proxies) == 0 {
		return nil, nil
	}

	type proxyJSONItem struct {
		ID               int64 `json:"id"`
		TimestampMS      int64 `json:"timestampMs"`
		ContextTokens    int64 `json:"contextTokens"`
		OutputTokens     int64 `json:"outputTokens"`
		GenerationTokens int64 `json:"generationTokens"`
	}
	proxyItems := make([]proxyJSONItem, 0, len(proxies))
	for _, p := range proxies {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		proxyItems = append(proxyItems, proxyJSONItem{
			ID:               p.ID,
			TimestampMS:      p.TimestampMS,
			ContextTokens:    p.InputTokens + p.CacheReadInputTokens + p.CacheCreationInputTokens,
			OutputTokens:     p.OutputTokens,
			GenerationTokens: p.OutputTokens + p.ReasoningOutputTokens,
		})
	}
	serialized, err := json.Marshal(proxyItems)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	for _, stmt := range []string{
		`CREATE TEMP TABLE IF NOT EXISTS model_usage_read_session_candidates (
			id INTEGER PRIMARY KEY,
			event_key TEXT NOT NULL,
			provider TEXT NOT NULL,
			account_ref TEXT NOT NULL,
			session_id TEXT NOT NULL,
			source_kind TEXT NOT NULL,
			model TEXT NOT NULL,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_input_tokens INTEGER NOT NULL,
			cache_creation_input_tokens INTEGER NOT NULL,
			reasoning_output_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			cost_usd REAL NOT NULL,
			timestamp_ms INTEGER NOT NULL,
			project TEXT NOT NULL,
			cwd TEXT NOT NULL,
			git_branch TEXT NOT NULL,
			context_tokens INTEGER NOT NULL,
			generation_tokens INTEGER NOT NULL
		)`,
		`DELETE FROM temp.model_usage_read_session_candidates`,
		`CREATE INDEX IF NOT EXISTS temp.idx_usage_session_ctx ON model_usage_read_session_candidates(context_tokens, output_tokens, timestamp_ms)`,
		`CREATE INDEX IF NOT EXISTS temp.idx_usage_session_gen ON model_usage_read_session_candidates(context_tokens, generation_tokens, timestamp_ms)`,
	} {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if _, execErr := conn.ExecContext(ctx, stmt); execErr != nil {
			return nil, fmt.Errorf("准备扫描候选临时表失败: %w", execErr)
		}
	}
	if _, err := conn.ExecContext(ctx, `
		INSERT INTO temp.model_usage_read_session_candidates
		SELECT
			id, event_key, provider, account_ref, session_id, source_kind, model,
			input_tokens, output_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
			cost_usd, timestamp_ms, project, cwd, git_branch,
			input_tokens + cache_read_input_tokens + cache_creation_input_tokens,
			output_tokens + reasoning_output_tokens
		FROM model_usage_records
		WHERE timestamp_ms BETWEEN ? AND ?
			AND source_kind IN ('session_jsonl', 'session_json')
			AND model != ''
			AND id <= ?`, fromMS, toMS, hw); err != nil {
		return nil, fmt.Errorf("填充扫描候选临时表失败: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	candRows, err := conn.QueryContext(ctx, `
		WITH proxy_observations AS (
			SELECT
				CAST(json_extract(value, '$.id') AS INTEGER) AS proxy_id,
				CAST(json_extract(value, '$.timestampMs') AS INTEGER) AS timestamp_ms,
				CAST(json_extract(value, '$.contextTokens') AS INTEGER) AS context_tokens,
				CAST(json_extract(value, '$.outputTokens') AS INTEGER) AS output_tokens,
				CAST(json_extract(value, '$.generationTokens') AS INTEGER) AS generation_tokens
			FROM json_each(?)
		)
		SELECT
			s.id, s.event_key, s.provider, s.account_ref, s.session_id, s.source_kind, s.model,
			s.input_tokens, s.output_tokens, s.cache_read_input_tokens,
			s.cache_creation_input_tokens, s.reasoning_output_tokens, s.total_tokens,
			s.cost_usd, s.timestamp_ms, s.project, s.cwd, s.git_branch,
			p.proxy_id
		FROM proxy_observations p
		JOIN temp.model_usage_read_session_candidates s
			ON s.context_tokens = p.context_tokens
			AND (s.output_tokens = p.output_tokens OR s.generation_tokens = p.generation_tokens)
			AND s.timestamp_ms BETWEEN p.timestamp_ms - ? AND p.timestamp_ms + ?
		ORDER BY s.timestamp_ms, s.id, p.proxy_id`,
		string(serialized), scannerBeforeProxyWindowMS, scannerAfterProxyWindowMS)
	if err != nil {
		return nil, fmt.Errorf("查询跨源候选匹配失败: %w", err)
	}
	defer func() { _ = candRows.Close() }()

	forksByHash := make(map[string]forkDescriptor, len(forks))
	for _, f := range forks {
		forksByHash[f.SourceHash] = f
	}
	scannerByID := make(map[int64]observationRow)
	var candidates []matchCandidate
	for candRows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var (
			row     observationRow
			proxyID int64
		)
		if scanErr := candRows.Scan(
			&row.ID, &row.EventKey, &row.Provider, &row.AccountRef, &row.SessionID,
			&row.SourceKind, &row.Model, &row.InputTokens, &row.OutputTokens,
			&row.CacheReadInputTokens, &row.CacheCreationInputTokens,
			&row.ReasoningOutputTokens, &row.TotalTokens, &row.CostUSD,
			&row.TimestampMS, &row.Project, &row.CWD, &row.GitBranch, &proxyID,
		); scanErr != nil {
			return nil, scanErr
		}
		proxy, ok := proxyByID[proxyID]
		if !ok {
			continue
		}
		projected, keep := projectForkCandidateRow(row, forksByHash)
		if !keep || !areCandidatesCompatible(projected, proxy) {
			continue
		}
		scannerByID[projected.ID] = projected
		delta := projected.TimestampMS - proxy.TimestampMS
		if delta < 0 {
			delta = -delta
		}
		rank := int64(1)
		if strings.TrimSpace(projected.SessionID) != "" &&
			strings.TrimSpace(projected.SessionID) == strings.TrimSpace(proxy.SessionID) {
			rank = 0
		}
		candidates = append(candidates, matchCandidate{
			ScannerID:          projected.ID,
			ProxyID:            proxy.ID,
			ScannerTimestampMS: projected.TimestampMS,
			DeltaMS:            delta,
			SessionRank:        rank,
		})
	}
	if err := candRows.Err(); err != nil {
		return nil, err
	}
	_ = candRows.Close()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	matches := matchObservationCandidates(candidates)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(matches) == 0 {
		return nil, nil
	}

	pricingSnap, err := s.loadPricingSnapshotFreshConn(ctx, conn)
	if err != nil {
		return nil, err
	}
	attrs := make([]usageAttribution, 0, len(matches))
	for _, m := range matches {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		sc, sOK := scannerByID[m.ScannerID]
		px, pOK := proxyByID[m.ProxyID]
		if !sOK || !pOK {
			continue
		}
		model := s.attribution.FormatAttributedModel(sc.Provider, px.Provider, firstNonEmpty(px.Model, sc.Model))
		accountRef := strings.TrimSpace(px.AccountRef)
		pRec := pricingSnap.resolve(s.attribution, model, sc.Provider, accountRef)
		crossProvider := strings.ToLower(strings.TrimSpace(sc.Provider)) != strings.ToLower(strings.TrimSpace(px.Provider))
		costUSD := 0.0
		if pRec != nil {
			costUSD = usagepricing.CalculateCostUSD(usagepricing.Usage{
				InputTokens:              sc.InputTokens,
				OutputTokens:             sc.OutputTokens,
				CacheReadInputTokens:     sc.CacheReadInputTokens,
				CacheCreationInputTokens: sc.CacheCreationInputTokens,
				ReasoningOutputTokens:    sc.ReasoningOutputTokens,
			}, pRec)
		} else if !crossProvider {
			costUSD = clampNonNegFloat(sc.CostUSD)
		}
		attrs = append(attrs, usageAttribution{
			ScannerID:          sc.ID,
			ProxyID:            px.ID,
			ScannerTimestampMS: sc.TimestampMS,
			ProxyTimestampMS:   px.TimestampMS,
			Model:              model,
			AccountProvider:    strings.ToLower(strings.TrimSpace(px.Provider)),
			AccountRef:         accountRef,
			CostUSD:            costUSD,
		})
	}
	return attrs, nil
}

func projectForkCandidateRow(row observationRow, forksByHash map[string]forkDescriptor) (observationRow, bool) {
	if strings.ToLower(strings.TrimSpace(row.Provider)) != "codex" {
		return row, true
	}
	m := codexFileEventPattern.FindStringSubmatch(strings.TrimSpace(row.EventKey))
	if m == nil || m[3] != "usage" {
		return row, true
	}
	desc, ok := forksByHash[m[1]]
	if !ok {
		return row, true
	}
	if desc.ReplayPending {
		return row, false
	}
	if desc.BoundaryOffset <= 0 {
		return row, true
	}
	offset, err := strconv.ParseInt(m[2], 10, 64)
	if err != nil || offset <= desc.BoundaryOffset {
		return row, false
	}
	if desc.SessionID != "" {
		row.SessionID = desc.SessionID
	}
	if desc.CWD != "" {
		row.CWD = desc.CWD
	}
	if desc.Project != "" {
		row.Project = desc.Project
	}
	return row, true
}

func areCandidatesCompatible(scanner, proxy observationRow) bool {
	sp := strings.ToLower(strings.TrimSpace(scanner.Provider))
	pp := strings.ToLower(strings.TrimSpace(proxy.Provider))
	if sp == "" || pp == "" {
		return false
	}
	ss := strings.TrimSpace(scanner.SessionID)
	ps := strings.TrimSpace(proxy.SessionID)
	if ss != "" && ps != "" && ss != ps {
		return false
	}
	sa := strings.TrimSpace(scanner.AccountRef)
	pa := strings.TrimSpace(proxy.AccountRef)
	if sa != "" && pa != "" && sa != pa {
		return false
	}
	if sp == pp {
		return strings.EqualFold(strings.TrimSpace(scanner.Model), strings.TrimSpace(proxy.Model))
	}
	if sp != "claude" {
		return false
	}
	allowed := crossProviderSources[pp]
	return allowed != nil && allowed[strings.TrimSpace(proxy.SourceKind)]
}

func sortMatchCandidates(cands []matchCandidate) {
	sort.Slice(cands, func(i, j int) bool {
		l, r := cands[i], cands[j]
		if l.SessionRank != r.SessionRank {
			return l.SessionRank < r.SessionRank
		}
		if l.DeltaMS != r.DeltaMS {
			return l.DeltaMS < r.DeltaMS
		}
		if l.ScannerTimestampMS != r.ScannerTimestampMS {
			return l.ScannerTimestampMS < r.ScannerTimestampMS
		}
		if l.ScannerID != r.ScannerID {
			return l.ScannerID < r.ScannerID
		}
		return l.ProxyID < r.ProxyID
	})
}

func matchObservationCandidates(candidates []matchCandidate) []matchCandidate {
	if len(candidates) <= 1 {
		return append([]matchCandidate(nil), candidates...)
	}
	ordered := append([]matchCandidate(nil), candidates...)
	sortMatchCandidates(ordered)

	// Union-Find 对二部图连通分量切分后再跑最小费用最大流。
	scannerIdx := make(map[int64]int)
	proxyIdx := make(map[int64]int)
	var parent, size []int
	makeNode := func() int {
		id := len(parent)
		parent = append(parent, id)
		size = append(size, 1)
		return id
	}
	var find func(int) int
	find = func(x int) int {
		root := x
		for parent[root] != root {
			root = parent[root]
		}
		for parent[x] != x {
			next := parent[x]
			parent[x] = root
			x = next
		}
		return root
	}
	union := func(a, b int) {
		ra, rb := find(a), find(b)
		if ra == rb {
			return
		}
		if size[ra] < size[rb] {
			ra, rb = rb, ra
		}
		parent[rb] = ra
		size[ra] += size[rb]
	}

	for _, c := range ordered {
		sn, ok := scannerIdx[c.ScannerID]
		if !ok {
			sn = makeNode()
			scannerIdx[c.ScannerID] = sn
		}
		pn, ok := proxyIdx[c.ProxyID]
		if !ok {
			pn = makeNode()
			proxyIdx[c.ProxyID] = pn
		}
		union(sn, pn)
	}

	comps := make(map[int][]matchCandidate)
	for _, c := range ordered {
		r := find(scannerIdx[c.ScannerID])
		comps[r] = append(comps[r], c)
	}
	var matches []matchCandidate
	for _, comp := range comps {
		matches = append(matches, matchObservationComponent(comp)...)
	}
	sortMatchCandidates(matches)
	return matches
}

type residualEdge struct {
	to        int
	rev       int
	capacity  int
	cost      int64
	candidate *matchCandidate
}

func matchObservationComponent(candidates []matchCandidate) []matchCandidate {
	if len(candidates) <= 1 {
		return candidates
	}
	ordered := append([]matchCandidate(nil), candidates...)
	sortMatchCandidates(ordered)

	var scannerIDs, proxyIDs []int64
	sMap := make(map[int64]int)
	pMap := make(map[int64]int)
	for _, c := range ordered {
		if _, ok := sMap[c.ScannerID]; !ok {
			sMap[c.ScannerID] = len(scannerIDs)
			scannerIDs = append(scannerIDs, c.ScannerID)
		}
		if _, ok := pMap[c.ProxyID]; !ok {
			pMap[c.ProxyID] = len(proxyIDs)
			proxyIDs = append(proxyIDs, c.ProxyID)
		}
	}

	source := 0
	sOff := 1
	pOff := sOff + len(scannerIDs)
	sink := pOff + len(proxyIDs)
	graph := make([][]residualEdge, sink+1)
	addEdge := func(u, v int, cost int64, cand *matchCandidate) {
		f := residualEdge{to: v, rev: len(graph[v]), capacity: 1, cost: cost, candidate: cand}
		r := residualEdge{to: u, rev: len(graph[u]), capacity: 0, cost: -cost}
		graph[u] = append(graph[u], f)
		graph[v] = append(graph[v], r)
	}
	for i := range scannerIDs {
		addEdge(source, sOff+i, 0, nil)
	}
	for i := range proxyIDs {
		addEdge(pOff+i, sink, 0, nil)
	}

	maxMatches := int64(len(scannerIDs))
	if int64(len(proxyIDs)) < maxMatches {
		maxMatches = int64(len(proxyIDs))
	}
	var maxDelta int64
	for _, c := range ordered {
		if c.DeltaMS > maxDelta {
			maxDelta = c.DeltaMS
		}
	}
	sessionPenalty := (maxDelta * maxMatches) + 1
	for i := range ordered {
		cand := &ordered[i]
		cost := cand.SessionRank*sessionPenalty + cand.DeltaMS
		addEdge(sOff+sMap[cand.ScannerID], pOff+pMap[cand.ProxyID], cost, cand)
	}

	const infCost int64 = math.MaxInt64 / 4
	nNodes := sink + 1
	dist := make([]int64, nNodes)
	prevNode := make([]int, nNodes)
	prevEdge := make([]int, nNodes)
	for {
		for i := 0; i < nNodes; i++ {
			dist[i] = infCost
			prevNode[i] = -1
			prevEdge[i] = -1
		}
		dist[source] = 0
		for iter := 0; iter < nNodes-1; iter++ {
			changed := false
			for u := 0; u < nNodes; u++ {
				if dist[u] >= infCost {
					continue
				}
				for ei := range graph[u] {
					e := &graph[u][ei]
					if e.capacity < 1 {
						continue
					}
					nextDist := dist[u] + e.cost
					if nextDist < dist[e.to] {
						dist[e.to] = nextDist
						prevNode[e.to] = u
						prevEdge[e.to] = ei
						changed = true
					}
				}
			}
			if !changed {
				break
			}
		}
		if dist[sink] >= infCost {
			break
		}
		for v := sink; v != source; v = prevNode[v] {
			u := prevNode[v]
			ei := prevEdge[v]
			e := &graph[u][ei]
			e.capacity -= 1
			graph[v][e.rev].capacity += 1
		}
	}

	var out []matchCandidate
	for i := range scannerIDs {
		u := sOff + i
		for _, e := range graph[u] {
			if e.candidate != nil && e.capacity == 0 {
				out = append(out, *e.candidate)
			}
		}
	}
	sortMatchCandidates(out)
	return out
}

func materializeProjectionConn(ctx context.Context, conn *sql.Conn, pCtx *UsageProjectionContext) error {
	return populateProjectionTables(ctx, conn, pCtx)
}

func cleanupProjectionConn(conn *sql.Conn) {
	if conn == nil {
		return
	}
	_, _ = conn.ExecContext(context.Background(), `DROP TABLE IF EXISTS temp.model_usage_read_attributions`)
	_, _ = conn.ExecContext(context.Background(), `DROP TABLE IF EXISTS temp.model_usage_read_fork_contexts`)
	_, _ = conn.ExecContext(context.Background(), `DROP TABLE IF EXISTS temp.model_usage_read_session_candidates`)
}

func buildCanonicalProjectionCTE() string {
	return buildCanonicalProjectionCTEWithScope("")
}

// buildCanonicalProjectionCTEWithScope 在 usage_source 上追加作用域超集过滤（如 model/session），
// 只缩小扫描范围；精确性仍由 canonical_usage 上的范围过滤保证。
func buildCanonicalProjectionCTEWithScope(scopeClause string) string {
	usageOffsetText := "substr(r.event_key, 29, length(r.event_key) - 34)"
	promptOffsetText := "substr(p.event_key, 29, length(p.event_key) - 35)"
	return fmt.Sprintf(`
		fork_contexts AS (
			SELECT source_hash, replay_pending, boundary_offset, session_id, cwd, project
			FROM model_usage_read_fork_contexts
		),
		usage_attributions AS (
			SELECT scanner_id, proxy_id, model, account_provider, account_ref, cost_usd
			FROM model_usage_read_attributions
		),
		usage_source AS (
			SELECT r.*,
				CASE WHEN
					r.provider = 'codex'
					AND substr(r.event_key, 1, 11) = 'codex:file:'
					AND length(r.event_key) > 34
					AND length(substr(r.event_key, 12, 16)) = 16
					AND substr(r.event_key, 12, 16) NOT GLOB '*[^0-9a-f]*'
					AND substr(r.event_key, 28, 1) = ':'
					AND substr(r.event_key, -6) = ':usage'
					AND %s != ''
					AND %s NOT GLOB '*[^0-9]*'
					THEN substr(r.event_key, 12, 16)
					ELSE ''
				END AS fork_source_hash,
				CASE WHEN
					r.provider = 'codex'
					AND substr(r.event_key, 1, 11) = 'codex:file:'
					AND length(r.event_key) > 34
					AND substr(r.event_key, -6) = ':usage'
					AND %s != ''
					AND %s NOT GLOB '*[^0-9]*'
					THEN CAST(%s AS INTEGER)
					ELSE -1
				END AS fork_event_offset
			FROM model_usage_records r
			WHERE r.timestamp_ms BETWEEN ? AND ?
				AND r.id <= ?
				AND NOT (r.provider IN ('codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn') AND r.source_kind = 'native_session_done')
				%s
		),
		canonical_usage AS (
			SELECT
				u.id, u.event_key, u.provider,
				CASE WHEN trim(u.account_ref) != '' THEN u.provider ELSE COALESCE(a.account_provider, '') END AS account_provider,
				CASE WHEN trim(u.account_ref) != '' THEN u.account_ref ELSE COALESCE(a.account_ref, '') END AS account_ref,
				CASE WHEN
					f.source_hash IS NOT NULL AND f.replay_pending = 0
					AND f.boundary_offset > 0 AND u.fork_event_offset > f.boundary_offset
					THEN COALESCE(NULLIF(f.session_id, ''), u.session_id)
					ELSE u.session_id
				END AS session_id,
				u.request_id, u.source_kind,
				CASE
					WHEN trim(COALESCE(NULLIF(a.model, ''), u.model)) = '' THEN '%s'
					ELSE trim(COALESCE(NULLIF(a.model, ''), u.model))
				END AS model,
				u.input_tokens, u.output_tokens, u.cache_read_input_tokens,
				u.cache_creation_input_tokens, u.reasoning_output_tokens, u.total_tokens,
				CASE WHEN a.scanner_id IS NOT NULL THEN a.cost_usd ELSE u.cost_usd END AS cost_usd,
				u.timestamp_ms,
				CASE WHEN
					f.source_hash IS NOT NULL AND f.replay_pending = 0
					AND f.boundary_offset > 0 AND u.fork_event_offset > f.boundary_offset
					THEN COALESCE(NULLIF(f.project, ''), u.project)
					ELSE u.project
				END AS project,
				CASE WHEN
					f.source_hash IS NOT NULL AND f.replay_pending = 0
					AND f.boundary_offset > 0 AND u.fork_event_offset > f.boundary_offset
					THEN COALESCE(NULLIF(f.cwd, ''), u.cwd)
					ELSE u.cwd
				END AS cwd,
				u.git_branch
			FROM usage_source u
			LEFT JOIN fork_contexts f ON f.source_hash = u.fork_source_hash
			LEFT JOIN usage_attributions a ON a.scanner_id = u.id
			LEFT JOIN usage_attributions matched_proxy ON matched_proxy.proxy_id = u.id
			WHERE matched_proxy.proxy_id IS NULL
				AND NOT (
					f.source_hash IS NOT NULL
					AND (
						f.replay_pending = 1
						OR (f.boundary_offset > 0 AND u.fork_event_offset <= f.boundary_offset)
					)
				)
		),
		prompt_source AS (
			SELECT p.*,
				CASE WHEN
					p.provider = 'codex'
					AND substr(p.event_key, 1, 11) = 'codex:file:'
					AND length(p.event_key) > 35
					AND length(substr(p.event_key, 12, 16)) = 16
					AND substr(p.event_key, 12, 16) NOT GLOB '*[^0-9a-f]*'
					AND substr(p.event_key, 28, 1) = ':'
					AND substr(p.event_key, -7) = ':prompt'
					AND %s != ''
					AND %s NOT GLOB '*[^0-9]*'
					THEN substr(p.event_key, 12, 16)
					ELSE ''
				END AS fork_source_hash,
				CASE WHEN
					p.provider = 'codex'
					AND substr(p.event_key, 1, 11) = 'codex:file:'
					AND length(p.event_key) > 35
					AND substr(p.event_key, -7) = ':prompt'
					AND %s != ''
					AND %s NOT GLOB '*[^0-9]*'
					THEN CAST(%s AS INTEGER)
					ELSE -1
				END AS fork_event_offset
			FROM model_usage_prompt_events p
			WHERE p.timestamp_ms BETWEEN ? AND ?
				AND p.rowid <= ?
		),
		canonical_prompt_events AS (
			SELECT
				p.event_key, p.provider,
				CASE WHEN
					f.source_hash IS NOT NULL AND f.replay_pending = 0
					AND f.boundary_offset > 0 AND p.fork_event_offset > f.boundary_offset
					THEN COALESCE(NULLIF(f.session_id, ''), p.session_id)
					ELSE p.session_id
				END AS session_id,
				p.timestamp_ms
			FROM prompt_source p
			LEFT JOIN fork_contexts f ON f.source_hash = p.fork_source_hash
			WHERE NOT (
				f.source_hash IS NOT NULL
				AND (
					f.replay_pending = 1
					OR (f.boundary_offset > 0 AND p.fork_event_offset <= f.boundary_offset)
				)
			)
		)`,
		usageOffsetText, usageOffsetText, usageOffsetText, usageOffsetText, usageOffsetText,
		scopeClause,
		legacyUnknownModel,
		promptOffsetText, promptOffsetText, promptOffsetText, promptOffsetText, promptOffsetText,
	)
}

func projectionBaseArgs(q UsageQuery, pCtx *UsageProjectionContext) []any {
	return projectionBaseArgsWithScope(q, pCtx, nil)
}

// projectionBaseArgsWithScope 保持 CTE 占位符顺序：
// usage_source(From,To,RecordHW,scope...) -> prompt_source(From,To,PromptHW)。
func projectionBaseArgsWithScope(q UsageQuery, pCtx *UsageProjectionContext, scopeArgs []any) []any {
	rHW := int64(math.MaxInt64)
	pHW := int64(math.MaxInt64)
	if pCtx != nil {
		if pCtx.RecordHighWaterID >= 0 {
			rHW = pCtx.RecordHighWaterID
		}
		if pCtx.PromptHighWaterRowID >= 0 {
			pHW = pCtx.PromptHighWaterRowID
		}
	}
	args := make([]any, 0, 6+len(scopeArgs))
	args = append(args, q.FromMS, q.ToMS, rHW)
	args = append(args, scopeArgs...)
	args = append(args, q.FromMS, q.ToMS, pHW)
	return args
}

func buildProjectedWhereClause(q UsageQuery, alias string, includeModel, includeSession bool) (string, []any) {
	prefix := ""
	if alias != "" {
		prefix = alias + "."
	}
	var clauses []string
	var args []any
	if q.Provider != "" {
		clauses = append(clauses, prefix+"provider = ?")
		args = append(args, q.Provider)
	}
	if includeModel && q.Model != "" {
		clauses = append(clauses, prefix+"model = ?")
		args = append(args, q.Model)
	}
	if includeSession && q.SessionID != "" {
		clauses = append(clauses, prefix+"session_id = ?")
		args = append(args, q.SessionID)
	}
	if len(clauses) == 0 {
		return "1 = 1", nil
	}
	return strings.Join(clauses, " AND "), args
}

func (s *UsageStore) openPreparedProjection(ctx context.Context, q UsageQuery, prebuilt *UsageProjectionContext) (*sql.Conn, string, *UsageProjectionContext, error) {
	return s.openPreparedProjectionMode(ctx, q, prebuilt, true)
}

func (s *UsageStore) openPreparedProjectionMode(ctx context.Context, q UsageQuery, prebuilt *UsageProjectionContext, needTemp bool) (*sql.Conn, string, *UsageProjectionContext, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	pCtx := prebuilt
	if pCtx == nil {
		var prepErr error
		pCtx, prepErr = s.PrepareDashboardProjection(ctx, q)
		if prepErr != nil {
			return nil, "", nil, prepErr
		}
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, "", nil, err
	}
	if !needTemp {
		return conn, "", pCtx, nil
	}
	if err := materializeProjectionConn(ctx, conn, pCtx); err != nil {
		cleanupProjectionConn(conn)
		_ = conn.Close()
		return nil, "", nil, err
	}
	return conn, buildCanonicalProjectionCTE(), pCtx, nil
}

// QueryStats 查询用量聚合汇总指标。
func (s *UsageStore) QueryStats(ctx context.Context, query UsageQuery) (UsageStatsSummary, error) {
	if s == nil || s.db == nil {
		return UsageStatsSummary{}, ErrUsageUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return UsageStatsSummary{}, err
	}
	q := normalizeUsageQueryBounds(query)
	startRev, hasStartRev, hit, ok, revErr := s.lookupStatsRevisionCache(ctx, q)
	if revErr != nil {
		return UsageStatsSummary{}, revErr
	}
	if ok {
		return hit, nil
	}
	if stats, coldReady, coldErr := s.tryComputeColdSyncStats(ctx, q); coldErr != nil {
		return UsageStatsSummary{}, coldErr
	} else if coldReady {
		s.storeStatsRevisionCacheIfFresh(ctx, startRev, hasStartRev, q, stats)
		return stats, nil
	}

	conn, cte, pCtx, err := s.openPreparedProjectionMode(ctx, q, nil, false)
	if err != nil {
		return UsageStatsSummary{}, err
	}
	stats, queryErr := queryStatsConn(ctx, conn, cte, pCtx, q)
	cleanupProjectionConn(conn)
	_ = conn.Close()
	if queryErr != nil {
		return UsageStatsSummary{}, queryErr
	}

	s.storeStatsRevisionCacheIfFresh(ctx, startRev, hasStartRev, q, stats)
	return stats, nil
}

func queryStatsConn(ctx context.Context, conn *sql.Conn, cte string, pCtx *UsageProjectionContext, q UsageQuery) (UsageStatsSummary, error) {
	_ = cte
	return queryStatsWithRollupConn(ctx, conn, pCtx, q)
}

// QueryCostByModel 查询按 Provider 与模型分组的用量汇总。
func (s *UsageStore) QueryCostByModel(ctx context.Context, query UsageQuery) ([]UsageModelItem, error) {
	if s == nil || s.db == nil {
		return nil, ErrUsageUnavailable
	}
	q := normalizeUsageQueryBounds(query)
	if value, coldReady, coldErr := s.tryComputeColdSyncModels(ctx, q); coldErr != nil {
		return nil, coldErr
	} else if coldReady {
		return value, nil
	}
	conn, cte, pCtx, err := s.openPreparedProjectionMode(ctx, q, nil, false)
	if err != nil {
		return nil, err
	}
	defer func() {
		cleanupProjectionConn(conn)
		_ = conn.Close()
	}()
	return queryModelsConn(ctx, conn, cte, pCtx, q, false)
}

func queryModelsConn(ctx context.Context, conn *sql.Conn, cte string, pCtx *UsageProjectionContext, q UsageQuery, includeRefs bool) ([]UsageModelItem, error) {
	_ = cte
	return queryModelsWithRollupConn(ctx, conn, pCtx, q, includeRefs)
}

// QuerySessions 查询会话列表。
func (s *UsageStore) QuerySessions(ctx context.Context, query UsageQuery) ([]UsageSessionItem, error) {
	if s == nil || s.db == nil {
		return nil, ErrUsageUnavailable
	}
	q := normalizeUsageQueryBounds(query)
	if value, coldReady, coldErr := s.tryComputeColdSyncSessions(ctx, q); coldErr != nil {
		return nil, coldErr
	} else if coldReady {
		return value, nil
	}
	conn, cte, pCtx, err := s.openPreparedProjectionMode(ctx, q, nil, false)
	if err != nil {
		return nil, err
	}
	defer func() {
		cleanupProjectionConn(conn)
		_ = conn.Close()
	}()
	parts, err := querySessionPartsConn(ctx, conn, cte, pCtx, q, true)
	if err != nil {
		return nil, err
	}
	out := make([]UsageSessionItem, 0, len(parts))
	for _, part := range parts {
		out = append(out, materializeSessionFromPart(part))
	}
	return out, nil
}

func querySessionPartsConn(ctx context.Context, conn *sql.Conn, cte string, pCtx *UsageProjectionContext, q UsageQuery, applyLimit bool) ([]UsageSessionPart, error) {
	_ = cte
	return querySessionPartsWithRollupConn(ctx, conn, pCtx, q, applyLimit)
}

func materializeSessionFromPart(part UsageSessionPart) UsageSessionItem {
	started := part.SessionStartedAtMS
	if started == 0 {
		started = part.UsageStartedAtMS
	}
	updated := part.SessionUpdatedAtMS
	if updated == 0 {
		updated = part.UsageUpdatedAtMS
	}
	return UsageSessionItem{
		Provider:                 part.Provider,
		SessionID:                part.SessionID,
		Project:                  firstNonEmpty(part.UsageProject, part.SessionProject),
		CWD:                      firstNonEmpty(part.UsageCWD, part.SessionCWD),
		GitBranch:                firstNonEmpty(part.UsageGitBranch, part.SessionGitBranch),
		StartedAtMS:              started,
		UpdatedAtMS:              updated,
		PromptCount:              part.PromptCount,
		Calls:                    part.Calls,
		InputTokens:              part.InputTokens,
		OutputTokens:             part.OutputTokens,
		CacheReadInputTokens:     part.CacheReadInputTokens,
		CacheCreationInputTokens: part.CacheCreationInputTokens,
		ReasoningOutputTokens:    part.ReasoningOutputTokens,
		TotalTokens:              part.TotalTokens,
		CostUSD:                  NormalizeUsageCostUSD(part.CostUSD),
		AccountCount:             len(part.AccountRefs),
		UnattributedCalls:        part.UnattributedCalls,
		CacheHitRate:             CalculateCacheHitRate(part.InputTokens, part.CacheReadInputTokens, part.CacheCreationInputTokens),
	}
}

func queryTrendConn(ctx context.Context, conn *sql.Conn, cte string, pCtx *UsageProjectionContext, q UsageQuery, reqBucketMS, reqOriginMS int64) (UsageTrend, error) {
	_ = cte
	return queryTrendWithRollupConn(ctx, conn, pCtx, q, reqBucketMS, reqOriginMS)
}

// QueryDashboard 一次性返回完整用量看板聚合结果。
func (s *UsageStore) QueryDashboard(ctx context.Context, query UsageQuery) (UsageDashboardPayload, error) {
	if s == nil || s.db == nil {
		return UsageDashboardPayload{}, ErrUsageUnavailable
	}
	q := normalizeUsageQueryBounds(query)
	if value, coldReady, coldErr := s.tryComputeColdSyncDashboard(ctx, q); coldErr != nil {
		return UsageDashboardPayload{}, coldErr
	} else if coldReady {
		return value, nil
	}
	return s.queryDashboardWithRollup(ctx, q)
}

// QueryDashboardShard 查询单个时间分片的中间看板统计，供渐进看板合并使用。
func (s *UsageStore) QueryDashboardShard(
	ctx context.Context,
	shardQuery UsageQuery,
	overallTrendBucketMS, overallTrendOriginMS int64,
	prebuilt *UsageProjectionContext,
) (UsageDashboardShard, error) {
	if s == nil || s.db == nil {
		return UsageDashboardShard{}, ErrUsageUnavailable
	}
	q := normalizeUsageQueryBounds(shardQuery)
	return s.queryDashboardShardWithRollup(ctx, q, overallTrendBucketMS, overallTrendOriginMS, prebuilt)
}

// QuerySessionDetail 查询单个会话内各模型的消耗明细。
func (s *UsageStore) QuerySessionDetail(ctx context.Context, query UsageQuery) ([]UsageSessionModelDetail, error) {
	if s == nil || s.db == nil {
		return nil, ErrUsageUnavailable
	}
	q := normalizeUsageQueryBounds(query)
	conn, cte, pCtx, err := s.openPreparedProjection(ctx, q, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		cleanupProjectionConn(conn)
		_ = conn.Close()
	}()

	uWhere, uArgs := buildProjectedWhereClause(q, "u", true, true)
	args := append(projectionBaseArgs(q, pCtx), uArgs...)
	rows, err := conn.QueryContext(ctx, fmt.Sprintf(`
		WITH %s
		SELECT
			u.provider, u.session_id, u.model,
			COUNT(*) AS calls,
			COALESCE(SUM(u.input_tokens), 0),
			COALESCE(SUM(u.output_tokens), 0),
			COALESCE(SUM(u.cache_read_input_tokens), 0),
			COALESCE(SUM(u.cache_creation_input_tokens), 0),
			COALESCE(SUM(u.reasoning_output_tokens), 0),
			COALESCE(SUM(u.total_tokens), 0),
			COALESCE(SUM(u.cost_usd), 0),
			COALESCE(GROUP_CONCAT(DISTINCT NULLIF(u.account_ref, '')), ''),
			COALESCE(SUM(CASE WHEN u.account_ref = '' THEN 1 ELSE 0 END), 0)
		FROM canonical_usage u
		WHERE %s
		GROUP BY u.provider, u.session_id, u.model
		ORDER BY cost_usd DESC, total_tokens DESC, u.model`, cte, uWhere), args...)
	if err != nil {
		return nil, fmt.Errorf("查询会话模型明细失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := make([]UsageSessionModelDetail, 0)
	for rows.Next() {
		var (
			item    UsageSessionModelDetail
			refsRaw string
		)
		if scanErr := rows.Scan(
			&item.Provider, &item.SessionID, &item.Model, &item.Calls,
			&item.InputTokens, &item.OutputTokens, &item.CacheReadInputTokens,
			&item.CacheCreationInputTokens, &item.ReasoningOutputTokens,
			&item.TotalTokens, &item.CostUSD, &refsRaw, &item.UnattributedCalls,
		); scanErr != nil {
			return nil, scanErr
		}
		refs := parseCommaAccountRefs(refsRaw)
		item.CostUSD = NormalizeUsageCostUSD(item.CostUSD)
		item.AccountCount = len(refs)
		item.CacheHitRate = CalculateCacheHitRate(item.InputTokens, item.CacheReadInputTokens, item.CacheCreationInputTokens)
		out = append(out, item)
	}
	return out, rows.Err()
}

func parseCommaAccountRefs(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	seen := make(map[string]struct{}, len(parts))
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if !isValidAccountRef(trimmed) {
			continue
		}
		if _, dup := seen[trimmed]; dup {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func sortUsageModels(items []UsageModelItem) {
	sort.Slice(items, func(i, j int) bool {
		return compareUsageCostDesc(
			items[i].CostUSD, items[i].TotalTokens, items[i].Calls, items[i].Model,
			items[j].CostUSD, items[j].TotalTokens, items[j].Calls, items[j].Model,
		) || (items[i].CostUSD == items[j].CostUSD && items[i].TotalTokens == items[j].TotalTokens && items[i].Calls == items[j].Calls && items[i].Model == items[j].Model && items[i].Provider < items[j].Provider)
	})
}

func compareUsageCostDesc(lc float64, lt int64, lCalls int, lName string, rc float64, rt int64, rCalls int, rName string) bool {
	if lc != rc {
		return lc > rc
	}
	if lt != rt {
		return lt > rt
	}
	if lCalls != rCalls {
		return lCalls > rCalls
	}
	return lName < rName
}
