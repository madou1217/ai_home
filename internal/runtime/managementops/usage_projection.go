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
	"time"

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
	ForkDescriptors       []forkDescriptor
	Attributions          []usageAttribution
	RecordHighWaterID     int64
	PromptHighWaterRowID  int64
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
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close() }()

	normalized := normalizeUsageQueryBounds(query)
	return s.prepareProjectionContextConn(ctx, conn, normalized)
}

func (s *UsageStore) prepareProjectionContextConn(ctx context.Context, conn *sql.Conn, query UsageQuery) (*UsageProjectionContext, error) {
	var recordHW, promptHW sql.NullInt64
	if err := conn.QueryRowContext(ctx, `
		SELECT
			(SELECT COALESCE(MAX(id), 0) FROM model_usage_records),
			(SELECT COALESCE(MAX(rowid), 0) FROM model_usage_prompt_events)`).Scan(&recordHW, &promptHW); err != nil {
		return nil, fmt.Errorf("读取用量高水位线失败: %w", err)
	}
	forks, err := readForkDescriptorsConn(ctx, conn)
	if err != nil {
		return nil, err
	}
	attrs, err := s.createAttributionsConn(ctx, conn, query, forks, recordHW.Int64)
	if err != nil {
		return nil, err
	}
	return &UsageProjectionContext{
		ForkDescriptors:      forks,
		Attributions:         attrs,
		RecordHighWaterID:    maxInt64(0, recordHW.Int64),
		PromptHighWaterRowID: maxInt64(0, promptHW.Int64),
	}, nil
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
	fromMS := maxInt64(0, query.FromMS-scannerAfterProxyWindowMS)
	toMS := query.ToMS + scannerBeforeProxyWindowMS
	if toMS < query.ToMS {
		toMS = math.MaxInt64
	}
	hw := recordHW
	if hw <= 0 {
		hw = math.MaxInt64
	}
	proxyRows, err := conn.QueryContext(ctx, `
		SELECT id, provider, account_ref, session_id, source_kind, model,
			input_tokens, output_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
			cost_usd, timestamp_ms
		FROM model_usage_records
		WHERE timestamp_ms BETWEEN ? AND ?
			AND id <= ?
			AND source_kind GLOB 'server_*'
			AND model != ''
			AND (
				input_tokens > 0 OR output_tokens > 0 OR cache_read_input_tokens > 0
				OR cache_creation_input_tokens > 0 OR reasoning_output_tokens > 0
			)
		ORDER BY timestamp_ms, id`, fromMS, toMS, hw)
	if err != nil {
		return nil, fmt.Errorf("查询代理请求观测行失败: %w", err)
	}
	var proxies []observationRow
	proxyByID := make(map[int64]observationRow)
	for proxyRows.Next() {
		var p observationRow
		if scanErr := proxyRows.Scan(
			&p.ID, &p.Provider, &p.AccountRef, &p.SessionID, &p.SourceKind, &p.Model,
			&p.InputTokens, &p.OutputTokens, &p.CacheReadInputTokens,
			&p.CacheCreationInputTokens, &p.ReasoningOutputTokens, &p.TotalTokens,
			&p.CostUSD, &p.TimestampMS,
		); scanErr != nil {
			_ = proxyRows.Close()
			return nil, scanErr
		}
		proxies = append(proxies, p)
		proxyByID[p.ID] = p
	}
	if err := proxyRows.Err(); err != nil {
		_ = proxyRows.Close()
		return nil, err
	}
	_ = proxyRows.Close()
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
	payload := make([]proxyJSONItem, len(proxies))
	for i, p := range proxies {
		payload[i] = proxyJSONItem{
			ID:               p.ID,
			TimestampMS:      p.TimestampMS,
			ContextTokens:    p.InputTokens + p.CacheReadInputTokens + p.CacheCreationInputTokens,
			OutputTokens:     p.OutputTokens,
			GenerationTokens: p.OutputTokens + p.ReasoningOutputTokens,
		}
	}
	serialized, _ := json.Marshal(payload)

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
		CROSS JOIN model_usage_records AS s INDEXED BY idx_model_usage_timestamp
			ON s.timestamp_ms BETWEEN p.timestamp_ms - ? AND p.timestamp_ms + ?
			AND s.input_tokens + s.cache_read_input_tokens + s.cache_creation_input_tokens = p.context_tokens
			AND (
				s.output_tokens = p.output_tokens
				OR s.output_tokens + s.reasoning_output_tokens = p.generation_tokens
			)
		WHERE s.source_kind IN ('session_jsonl', 'session_json')
			AND s.model != ''
			AND s.id <= ?
		ORDER BY s.timestamp_ms, s.id, p.proxy_id`,
		string(serialized), scannerBeforeProxyWindowMS, scannerAfterProxyWindowMS, hw,
	)
	if err != nil {
		return nil, fmt.Errorf("查询本地扫描配对候选失败: %w", err)
	}
	defer func() { _ = candRows.Close() }()

	forksByHash := make(map[string]forkDescriptor, len(forks))
	for _, f := range forks {
		forksByHash[f.SourceHash] = f
	}
	scannerByID := make(map[int64]observationRow)
	var candidates []matchCandidate
	for candRows.Next() {
		var row observationRow
		var proxyID int64
		if scanErr := candRows.Scan(
			&row.ID, &row.EventKey, &row.Provider, &row.AccountRef, &row.SessionID, &row.SourceKind, &row.Model,
			&row.InputTokens, &row.OutputTokens, &row.CacheReadInputTokens,
			&row.CacheCreationInputTokens, &row.ReasoningOutputTokens, &row.TotalTokens,
			&row.CostUSD, &row.TimestampMS, &row.Project, &row.CWD, &row.GitBranch,
			&proxyID,
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
		var sRank int64 = 1
		if strings.TrimSpace(projected.SessionID) != "" && strings.TrimSpace(projected.SessionID) == strings.TrimSpace(proxy.SessionID) {
			sRank = 0
		}
		candidates = append(candidates, matchCandidate{
			ScannerID:          projected.ID,
			ProxyID:            proxy.ID,
			ScannerTimestampMS: projected.TimestampMS,
			DeltaMS:            delta,
			SessionRank:        sRank,
		})
	}
	if err := candRows.Err(); err != nil {
		return nil, err
	}

	matches := matchObservationCandidates(candidates)
	if len(matches) == 0 {
		return nil, nil
	}

	pricingSnap, err := s.loadPricingSnapshot(ctx, conn)
	if err != nil {
		return nil, err
	}
	attrs := make([]usageAttribution, 0, len(matches))
	for _, m := range matches {
		sc := scannerByID[m.ScannerID]
		px := proxyByID[m.ProxyID]
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
			ScannerID:          m.ScannerID,
			ProxyID:            m.ProxyID,
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
	for _, stmt := range []string{
		`CREATE TEMP TABLE IF NOT EXISTS model_usage_read_fork_contexts (
			source_hash TEXT PRIMARY KEY,
			replay_pending INTEGER NOT NULL,
			boundary_offset INTEGER NOT NULL,
			session_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			project TEXT NOT NULL
		)`,
		`CREATE TEMP TABLE IF NOT EXISTS model_usage_read_attributions (
			scanner_id INTEGER PRIMARY KEY,
			proxy_id INTEGER NOT NULL UNIQUE,
			model TEXT NOT NULL,
			account_provider TEXT NOT NULL,
			account_ref TEXT NOT NULL,
			cost_usd REAL NOT NULL
		)`,
		`DELETE FROM temp.model_usage_read_fork_contexts`,
		`DELETE FROM temp.model_usage_read_attributions`,
	} {
		if _, err := conn.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("准备临时读投影表失败: %w", err)
		}
	}
	if pCtx == nil {
		return nil
	}
	if len(pCtx.ForkDescriptors) > 0 {
		stmt, err := conn.PrepareContext(ctx, `
			INSERT INTO temp.model_usage_read_fork_contexts (
				source_hash, replay_pending, boundary_offset, session_id, cwd, project
			) VALUES (?, ?, ?, ?, ?, ?)`)
		if err != nil {
			return err
		}
		for _, f := range pCtx.ForkDescriptors {
			rp := 0
			if f.ReplayPending {
				rp = 1
			}
			if _, err := stmt.ExecContext(ctx, f.SourceHash, rp, f.BoundaryOffset, f.SessionID, f.CWD, f.Project); err != nil {
				_ = stmt.Close()
				return err
			}
		}
		_ = stmt.Close()
	}
	if len(pCtx.Attributions) > 0 {
		stmt, err := conn.PrepareContext(ctx, `
			INSERT INTO temp.model_usage_read_attributions (
				scanner_id, proxy_id, model, account_provider, account_ref, cost_usd
			) VALUES (?, ?, ?, ?, ?, ?)`)
		if err != nil {
			return err
		}
		for _, a := range pCtx.Attributions {
			if _, err := stmt.ExecContext(ctx, a.ScannerID, a.ProxyID, a.Model, a.AccountProvider, a.AccountRef, a.CostUSD); err != nil {
				_ = stmt.Close()
				return err
			}
		}
		_ = stmt.Close()
	}
	return nil
}

func cleanupProjectionConn(conn *sql.Conn) {
	if conn == nil {
		return
	}
	_, _ = conn.ExecContext(context.Background(), `DROP TABLE IF EXISTS temp.model_usage_read_attributions`)
	_, _ = conn.ExecContext(context.Background(), `DROP TABLE IF EXISTS temp.model_usage_read_fork_contexts`)
}

func buildCanonicalProjectionCTE() string {
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
		legacyUnknownModel,
		promptOffsetText, promptOffsetText, promptOffsetText, promptOffsetText, promptOffsetText,
	)
}

func projectionBaseArgs(q UsageQuery, pCtx *UsageProjectionContext) []any {
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
	return []any{q.FromMS, q.ToMS, rHW, q.FromMS, q.ToMS, pHW}
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
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, "", nil, err
	}
	pCtx := prebuilt
	if pCtx == nil {
		var prepErr error
		pCtx, prepErr = s.prepareProjectionContextConn(ctx, conn, q)
		if prepErr != nil {
			_ = conn.Close()
			return nil, "", nil, prepErr
		}
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
	q := normalizeUsageQueryBounds(query)
	cacheKey := fmt.Sprintf("%d:%d:%s:%s:%s:%d", q.FromMS, q.ToMS, q.Provider, q.Model, q.SessionID, q.Limit)
	now := s.now()
	s.statsMu.Lock()
	if hit, ok := s.statsCache[cacheKey]; ok && now.Sub(hit.cachedAt) < statsCacheTTL {
		s.statsMu.Unlock()
		return hit.value, nil
	}
	s.statsMu.Unlock()

	conn, cte, pCtx, err := s.openPreparedProjection(ctx, q, nil)
	if err != nil {
		return UsageStatsSummary{}, err
	}
	defer func() {
		cleanupProjectionConn(conn)
		_ = conn.Close()
	}()

	stats, err := queryStatsConn(ctx, conn, cte, pCtx, q)
	if err != nil {
		return UsageStatsSummary{}, err
	}

	s.statsMu.Lock()
	if len(s.statsCache) >= maxStatsCacheEntries {
		var oldestKey string
		var oldestAt time.Time
		for k, entry := range s.statsCache {
			if oldestKey == "" || entry.cachedAt.Before(oldestAt) {
				oldestKey = k
				oldestAt = entry.cachedAt
			}
		}
		if oldestKey != "" {
			delete(s.statsCache, oldestKey)
		}
	}
	s.statsCache[cacheKey] = statsCacheEntry{cachedAt: now, value: stats}
	s.statsMu.Unlock()
	return stats, nil
}

func queryStatsConn(ctx context.Context, conn *sql.Conn, cte string, pCtx *UsageProjectionContext, q UsageQuery) (UsageStatsSummary, error) {
	uWhere, uArgs := buildProjectedWhereClause(q, "u", true, false)
	args := append(projectionBaseArgs(q, pCtx), uArgs...)
	var out UsageStatsSummary
	err := conn.QueryRowContext(ctx, fmt.Sprintf(`
		WITH %s
		SELECT
			COUNT(*) AS total_calls,
			COUNT(DISTINCT CASE WHEN u.session_id != '' THEN u.provider || ':' || u.session_id END) AS total_sessions,
			COALESCE(SUM(u.input_tokens), 0),
			COALESCE(SUM(u.output_tokens), 0),
			COALESCE(SUM(u.cache_read_input_tokens), 0),
			COALESCE(SUM(u.cache_creation_input_tokens), 0),
			COALESCE(SUM(u.reasoning_output_tokens), 0),
			COALESCE(SUM(u.total_tokens), 0),
			COALESCE(SUM(u.cost_usd), 0)
		FROM canonical_usage u
		WHERE %s`, cte, uWhere), args...).Scan(
		&out.TotalCalls, &out.TotalSessions,
		&out.InputTokens, &out.OutputTokens, &out.CacheReadInputTokens,
		&out.CacheCreationInputTokens, &out.ReasoningOutputTokens,
		&out.TotalTokens, &out.TotalCostUSD,
	)
	if err != nil {
		return UsageStatsSummary{}, fmt.Errorf("查询统计总览失败: %w", err)
	}
	pWhere, pArgs := buildProjectedWhereClause(q, "p", false, false)
	if err := conn.QueryRowContext(ctx, fmt.Sprintf(`
		WITH %s
		SELECT COUNT(*) FROM canonical_prompt_events p WHERE %s`, cte, pWhere),
		append(projectionBaseArgs(q, pCtx), pArgs...)...).Scan(&out.TotalPrompts); err != nil {
		return UsageStatsSummary{}, fmt.Errorf("查询提示词统计失败: %w", err)
	}
	out.TotalCostUSD = NormalizeUsageCostUSD(out.TotalCostUSD)
	return out, nil
}

// QueryCostByModel 查询按 Provider 与模型分组的用量汇总。
func (s *UsageStore) QueryCostByModel(ctx context.Context, query UsageQuery) ([]UsageModelItem, error) {
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
	return queryModelsConn(ctx, conn, cte, pCtx, q, false)
}

func queryModelsConn(ctx context.Context, conn *sql.Conn, cte string, pCtx *UsageProjectionContext, q UsageQuery, includeRefs bool) ([]UsageModelItem, error) {
	uWhere, uArgs := buildProjectedWhereClause(q, "u", true, false)
	args := append(projectionBaseArgs(q, pCtx), uArgs...)
	rows, err := conn.QueryContext(ctx, fmt.Sprintf(`
		WITH %s
		SELECT
			u.provider, u.model, COUNT(*) AS calls,
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
		GROUP BY u.provider, u.model
		ORDER BY cost_usd DESC, total_tokens DESC, calls DESC, u.model`, cte, uWhere), args...)
	if err != nil {
		return nil, fmt.Errorf("查询模型分布统计失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	items := make([]UsageModelItem, 0)
	for rows.Next() {
		var (
			item    UsageModelItem
			refsRaw string
		)
		if scanErr := rows.Scan(
			&item.Provider, &item.Model, &item.Calls,
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
		if includeRefs {
			item.AccountRefs = refs
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// QuerySessions 查询会话列表。
func (s *UsageStore) QuerySessions(ctx context.Context, query UsageQuery) ([]UsageSessionItem, error) {
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
	rWhere, rArgs := buildProjectedWhereClause(q, "r", true, false)
	args := append(projectionBaseArgs(q, pCtx), rArgs...)
	limitClause := ""
	if applyLimit {
		limitClause = "LIMIT ?"
		args = append(args, q.Limit)
	}
	rows, err := conn.QueryContext(ctx, fmt.Sprintf(`
		WITH %s
		SELECT
			r.provider, r.session_id,
			COALESCE(MAX(NULLIF(r.project, '')), '') AS usage_project,
			COALESCE(MAX(NULLIF(s.project, '')), '') AS session_project,
			COALESCE(MAX(NULLIF(r.cwd, '')), '') AS usage_cwd,
			COALESCE(MAX(NULLIF(s.cwd, '')), '') AS session_cwd,
			COALESCE(MAX(NULLIF(r.git_branch, '')), '') AS usage_git_branch,
			COALESCE(MAX(NULLIF(s.git_branch, '')), '') AS session_git_branch,
			MIN(r.timestamp_ms) AS usage_started_at_ms,
			COALESCE(MIN(NULLIF(s.started_at_ms, 0)), 0) AS session_started_at_ms,
			MAX(r.timestamp_ms) AS usage_updated_at_ms,
			COALESCE(MAX(NULLIF(s.updated_at_ms, 0)), 0) AS session_updated_at_ms,
			MAX(COALESCE(NULLIF(s.updated_at_ms, 0), r.timestamp_ms)) AS sort_updated_at_ms,
			COUNT(*) AS calls,
			COALESCE(SUM(r.input_tokens), 0),
			COALESCE(SUM(r.output_tokens), 0),
			COALESCE(SUM(r.cache_read_input_tokens), 0),
			COALESCE(SUM(r.cache_creation_input_tokens), 0),
			COALESCE(SUM(r.reasoning_output_tokens), 0),
			COALESCE(SUM(r.total_tokens), 0),
			COALESCE(SUM(r.cost_usd), 0),
			COALESCE(GROUP_CONCAT(DISTINCT NULLIF(r.account_ref, '')), ''),
			COALESCE(SUM(CASE WHEN r.account_ref = '' THEN 1 ELSE 0 END), 0)
		FROM canonical_usage r
		LEFT JOIN model_usage_sessions s
			ON s.provider = r.provider AND s.session_id = r.session_id
		WHERE %s AND r.session_id != ''
		GROUP BY r.provider, r.session_id
		ORDER BY sort_updated_at_ms DESC, r.provider, r.session_id
		%s`, cte, rWhere, limitClause), args...)
	if err != nil {
		return nil, fmt.Errorf("查询会话聚合列表失败: %w", err)
	}
	var parts []UsageSessionPart
	for rows.Next() {
		var (
			p             UsageSessionPart
			sortUpdated   int64
			accountRefRaw string
		)
		if scanErr := rows.Scan(
			&p.Provider, &p.SessionID,
			&p.UsageProject, &p.SessionProject,
			&p.UsageCWD, &p.SessionCWD,
			&p.UsageGitBranch, &p.SessionGitBranch,
			&p.UsageStartedAtMS, &p.SessionStartedAtMS,
			&p.UsageUpdatedAtMS, &p.SessionUpdatedAtMS,
			&sortUpdated,
			&p.Calls, &p.InputTokens, &p.OutputTokens, &p.CacheReadInputTokens,
			&p.CacheCreationInputTokens, &p.ReasoningOutputTokens,
			&p.TotalTokens, &p.CostUSD, &accountRefRaw, &p.UnattributedCalls,
		); scanErr != nil {
			_ = rows.Close()
			return nil, scanErr
		}
		p.CostUSD = NormalizeUsageCostUSD(p.CostUSD)
		p.AccountRefs = parseCommaAccountRefs(accountRefRaw)
		parts = append(parts, p)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()

	pWhere, pArgs := buildProjectedWhereClause(q, "p", false, false)
	pRows, err := conn.QueryContext(ctx, fmt.Sprintf(`
		WITH %s
		SELECT p.provider, p.session_id, COUNT(*)
		FROM canonical_prompt_events p
		WHERE %s AND p.session_id != ''
		GROUP BY p.provider, p.session_id`, cte, pWhere),
		append(projectionBaseArgs(q, pCtx), pArgs...)...)
	if err != nil {
		return nil, fmt.Errorf("查询会话提示词数量失败: %w", err)
	}
	defer func() { _ = pRows.Close() }()
	promptCounts := make(map[string]int)
	for pRows.Next() {
		var prov, sid string
		var cnt int
		if scanErr := pRows.Scan(&prov, &sid, &cnt); scanErr != nil {
			return nil, scanErr
		}
		promptCounts[prov+"\x00"+sid] = cnt
	}
	if err := pRows.Err(); err != nil {
		return nil, err
	}
	for i := range parts {
		parts[i].PromptCount = promptCounts[parts[i].Provider+"\x00"+parts[i].SessionID]
	}
	return parts, nil
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
	originMS, bucketMS, fromMS, toMS := ResolveUsageTrend(q.FromMS, q.ToMS, reqBucketMS, reqOriginMS)
	if originMS <= 0 || bucketMS <= 0 {
		return UsageTrend{FromMS: fromMS, ToMS: toMS, BucketMS: 0, Points: []UsageTrendPoint{}}, nil
	}
	uWhere, uArgs := buildProjectedWhereClause(q, "u", true, false)
	args := projectionBaseArgs(q, pCtx)
	args = append(args, originMS, bucketMS)
	args = append(args, uArgs...)

	rows, err := conn.QueryContext(ctx, fmt.Sprintf(`
		WITH %s
		SELECT
			CAST((u.timestamp_ms - ?) / ? AS INTEGER) AS bucket_index,
			COUNT(*) AS calls,
			COALESCE(SUM(u.input_tokens), 0),
			COALESCE(SUM(u.output_tokens), 0),
			COALESCE(SUM(u.cache_read_input_tokens), 0),
			COALESCE(SUM(u.cache_creation_input_tokens), 0),
			COALESCE(SUM(u.reasoning_output_tokens), 0),
			COALESCE(SUM(u.total_tokens), 0),
			COALESCE(SUM(u.cost_usd), 0)
		FROM canonical_usage u
		WHERE %s
		GROUP BY bucket_index
		ORDER BY bucket_index`, cte, uWhere), args...)
	if err != nil {
		return UsageTrend{}, fmt.Errorf("查询趋势分桶失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	byStart := make(map[int64]UsageTrendPoint)
	for rows.Next() {
		var idx int64
		var pt UsageTrendPoint
		if scanErr := rows.Scan(
			&idx, &pt.Calls, &pt.InputTokens, &pt.OutputTokens,
			&pt.CacheReadInputTokens, &pt.CacheCreationInputTokens,
			&pt.ReasoningOutputTokens, &pt.TotalTokens, &pt.CostUSD,
		); scanErr != nil {
			return UsageTrend{}, scanErr
		}
		pt.BucketStartMS = originMS + idx*bucketMS
		pt.CostUSD = NormalizeUsageCostUSD(pt.CostUSD)
		pt.CacheHitRate = CalculateCacheHitRate(pt.InputTokens, pt.CacheReadInputTokens, pt.CacheCreationInputTokens)
		byStart[pt.BucketStartMS] = pt
	}
	if err := rows.Err(); err != nil {
		return UsageTrend{}, err
	}
	starts := listTrendBucketStarts(fromMS, toMS, originMS, bucketMS)
	points := make([]UsageTrendPoint, 0, len(starts))
	for _, start := range starts {
		if pt, ok := byStart[start]; ok {
			points = append(points, pt)
		} else {
			points = append(points, UsageTrendPoint{BucketStartMS: start})
		}
	}
	return UsageTrend{
		FromMS:   fromMS,
		ToMS:     toMS,
		BucketMS: bucketMS,
		Points:   points,
	}, nil
}

// QueryDashboard 一次性返回完整用量看板聚合结果。
func (s *UsageStore) QueryDashboard(ctx context.Context, query UsageQuery) (UsageDashboardPayload, error) {
	if s == nil || s.db == nil {
		return UsageDashboardPayload{}, ErrUsageUnavailable
	}
	q := normalizeUsageQueryBounds(query)
	conn, cte, pCtx, err := s.openPreparedProjection(ctx, q, nil)
	if err != nil {
		return UsageDashboardPayload{}, err
	}
	defer func() {
		cleanupProjectionConn(conn)
		_ = conn.Close()
	}()

	stats, err := queryStatsConn(ctx, conn, cte, pCtx, q)
	if err != nil {
		return UsageDashboardPayload{}, err
	}
	models, err := queryModelsConn(ctx, conn, cte, pCtx, q, false)
	if err != nil {
		return UsageDashboardPayload{}, err
	}
	parts, err := querySessionPartsConn(ctx, conn, cte, pCtx, q, true)
	if err != nil {
		return UsageDashboardPayload{}, err
	}
	sessions := make([]UsageSessionItem, 0, len(parts))
	for _, p := range parts {
		sessions = append(sessions, materializeSessionFromPart(p))
	}
	trend, err := queryTrendConn(ctx, conn, cte, pCtx, q, 0, 0)
	if err != nil {
		return UsageDashboardPayload{}, err
	}
	modelOptions := models
	if q.Model != "" {
		unfiltered := q
		unfiltered.Model = ""
		modelOptions, err = queryModelsConn(ctx, conn, cte, pCtx, unfiltered, false)
		if err != nil {
			return UsageDashboardPayload{}, err
		}
	}
	return UsageDashboardPayload{
		Stats:        stats,
		Models:       models,
		Sessions:     sessions,
		ModelOptions: modelOptions,
		Trend:        trend,
	}, nil
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
	conn, cte, pCtx, err := s.openPreparedProjection(ctx, q, prebuilt)
	if err != nil {
		return UsageDashboardShard{}, err
	}
	defer func() {
		cleanupProjectionConn(conn)
		_ = conn.Close()
	}()

	stats, err := queryStatsConn(ctx, conn, cte, pCtx, q)
	if err != nil {
		return UsageDashboardShard{}, err
	}
	models, err := queryModelsConn(ctx, conn, cte, pCtx, q, true)
	if err != nil {
		return UsageDashboardShard{}, err
	}
	parts, err := querySessionPartsConn(ctx, conn, cte, pCtx, q, false)
	if err != nil {
		return UsageDashboardShard{}, err
	}
	trend, err := queryTrendConn(ctx, conn, cte, pCtx, q, overallTrendBucketMS, overallTrendOriginMS)
	if err != nil {
		return UsageDashboardShard{}, err
	}
	modelOptions := models
	if q.Model != "" {
		unfiltered := q
		unfiltered.Model = ""
		modelOptions, err = queryModelsConn(ctx, conn, cte, pCtx, unfiltered, true)
		if err != nil {
			return UsageDashboardShard{}, err
		}
	}
	return UsageDashboardShard{
		Stats:        stats,
		Models:       models,
		SessionParts: parts,
		ModelOptions: modelOptions,
		Trend:        trend,
	}, nil
}

// QueryBreakdown 查询按账号与模型交叉拆解的聚合详情。
func (s *UsageStore) QueryBreakdown(ctx context.Context, query UsageQuery) (UsageBreakdownResult, error) {
	if s == nil || s.db == nil {
		return UsageBreakdownResult{}, ErrUsageUnavailable
	}
	q := normalizeUsageQueryBounds(query)
	conn, cte, pCtx, err := s.openPreparedProjection(ctx, q, nil)
	if err != nil {
		return UsageBreakdownResult{}, err
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
			u.account_provider, u.account_ref, u.provider, u.model,
			COUNT(*) AS calls,
			COALESCE(SUM(u.input_tokens), 0),
			COALESCE(SUM(u.output_tokens), 0),
			COALESCE(SUM(u.cache_read_input_tokens), 0),
			COALESCE(SUM(u.cache_creation_input_tokens), 0),
			COALESCE(SUM(u.reasoning_output_tokens), 0),
			COALESCE(SUM(u.total_tokens), 0),
			COALESCE(SUM(u.cost_usd), 0)
		FROM canonical_usage u
		WHERE %s
		GROUP BY u.account_provider, u.account_ref, u.provider, u.model`, cte, uWhere), args...)
	if err != nil {
		return UsageBreakdownResult{}, fmt.Errorf("查询账号用量拆解失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	accountsMap := make(map[string]*UsageBreakdownAccount)
	for rows.Next() {
		var (
			acctProv, acctRef, prov, model            string
			calls                                     int
			inTok, outTok, cr, cc, reason, totalTok   int64
			costUSD                                   float64
		)
		if scanErr := rows.Scan(
			&acctProv, &acctRef, &prov, &model,
			&calls, &inTok, &outTok, &cr, &cc, &reason, &totalTok, &costUSD,
		); scanErr != nil {
			return UsageBreakdownResult{}, scanErr
		}
		ref := strings.TrimSpace(acctRef)
		key := ref
		if key == "" {
			key = "__unattributed__"
		}
		acc, exists := accountsMap[key]
		if !exists {
			effProv := ""
			if ref != "" {
				effProv = strings.TrimSpace(acctProv)
			}
			acc = &UsageBreakdownAccount{
				AccountRef:      ref,
				AccountProvider: effProv,
				Models:          make([]UsageModelItem, 0),
			}
			accountsMap[key] = acc
		} else if acc.AccountProvider != "" && strings.TrimSpace(acctProv) != "" && acc.AccountProvider != strings.TrimSpace(acctProv) {
			acc.AccountProvider = ""
		}

		mItem := UsageModelItem{
			Provider:                 prov,
			Model:                    model,
			Calls:                    calls,
			InputTokens:              inTok,
			OutputTokens:             outTok,
			CacheReadInputTokens:     cr,
			CacheCreationInputTokens: cc,
			ReasoningOutputTokens:    reason,
			TotalTokens:              totalTok,
			CostUSD:                  NormalizeUsageCostUSD(costUSD),
			CacheHitRate:             CalculateCacheHitRate(inTok, cr, cc),
		}
		acc.Models = append(acc.Models, mItem)
		acc.Calls += calls
		acc.InputTokens += inTok
		acc.OutputTokens += outTok
		acc.CacheReadInputTokens += cr
		acc.CacheCreationInputTokens += cc
		acc.ReasoningOutputTokens += reason
		acc.TotalTokens += totalTok
		acc.CostUSD += mItem.CostUSD
	}
	if err := rows.Err(); err != nil {
		return UsageBreakdownResult{}, err
	}

	var summary UsageBreakdownSummary
	type modelAgg struct {
		item        UsageModelItem
		accountRefs map[string]struct{}
	}
	modelsMap := make(map[string]*modelAgg)
	accounts := make([]UsageBreakdownAccount, 0, len(accountsMap))

	for _, acc := range accountsMap {
		acc.ModelCount = len(acc.Models)
		acc.CostUSD = NormalizeUsageCostUSD(acc.CostUSD)
		acc.CacheHitRate = CalculateCacheHitRate(acc.InputTokens, acc.CacheReadInputTokens, acc.CacheCreationInputTokens)
		sortUsageModels(acc.Models)
		accounts = append(accounts, *acc)

		if acc.AccountRef != "" {
			summary.AccountCount++
		} else {
			summary.UnattributedCalls += acc.Calls
		}
		summary.Calls += acc.Calls
		summary.InputTokens += acc.InputTokens
		summary.OutputTokens += acc.OutputTokens
		summary.CacheReadInputTokens += acc.CacheReadInputTokens
		summary.CacheCreationInputTokens += acc.CacheCreationInputTokens
		summary.ReasoningOutputTokens += acc.ReasoningOutputTokens
		summary.TotalTokens += acc.TotalTokens
		summary.CostUSD += acc.CostUSD

		for _, m := range acc.Models {
			mk := m.Provider + "\x00" + m.Model
			agg, ok := modelsMap[mk]
			if !ok {
				agg = &modelAgg{
					item:        UsageModelItem{Provider: m.Provider, Model: m.Model},
					accountRefs: make(map[string]struct{}),
				}
				modelsMap[mk] = agg
			}
			agg.item.Calls += m.Calls
			agg.item.InputTokens += m.InputTokens
			agg.item.OutputTokens += m.OutputTokens
			agg.item.CacheReadInputTokens += m.CacheReadInputTokens
			agg.item.CacheCreationInputTokens += m.CacheCreationInputTokens
			agg.item.ReasoningOutputTokens += m.ReasoningOutputTokens
			agg.item.TotalTokens += m.TotalTokens
			agg.item.CostUSD += m.CostUSD
			if acc.AccountRef != "" {
				agg.accountRefs[acc.AccountRef] = struct{}{}
			} else {
				agg.item.UnattributedCalls += m.Calls
			}
		}
	}

	sort.Slice(accounts, func(i, j int) bool {
		return compareUsageCostDesc(
			accounts[i].CostUSD, accounts[i].TotalTokens, accounts[i].Calls, accounts[i].AccountRef,
			accounts[j].CostUSD, accounts[j].TotalTokens, accounts[j].Calls, accounts[j].AccountRef,
		)
	})

	models := make([]UsageModelItem, 0, len(modelsMap))
	for _, agg := range modelsMap {
		item := agg.item
		item.CostUSD = NormalizeUsageCostUSD(item.CostUSD)
		item.AccountCount = len(agg.accountRefs)
		item.CacheHitRate = CalculateCacheHitRate(item.InputTokens, item.CacheReadInputTokens, item.CacheCreationInputTokens)
		models = append(models, item)
	}
	sortUsageModels(models)

	summary.CostUSD = NormalizeUsageCostUSD(summary.CostUSD)
	summary.CacheHitRate = CalculateCacheHitRate(summary.InputTokens, summary.CacheReadInputTokens, summary.CacheCreationInputTokens)
	return UsageBreakdownResult{
		Summary:  summary,
		Accounts: accounts,
		Models:   models,
	}, nil
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
