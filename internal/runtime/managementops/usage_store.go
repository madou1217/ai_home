package managementops

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/usagepricing"
	_ "modernc.org/sqlite"
)

const (
	statsCacheTTL              = 5 * time.Second
	maxStatsCacheEntries       = 64
	pricingCustomRefreshWindow = 3 * time.Second
	pricingActiveCatalogKVKey  = "active:model_usage_pricing"
	nativeOutcomeRetentionMS   = 91 * 24 * 60 * 60 * 1000
	pricingPerMillion          = 1_000_000.0
)

var (
	accountRefRe               = regexp.MustCompile(`^acct_[0-9a-f]{20}$`)
	sourceHashRe               = regexp.MustCompile(`^[0-9a-f]{16}$`)
	codebuddyMessageEventKeyRe = regexp.MustCompile(`^codebuddy:message:[a-f0-9]{16}:[a-f0-9]{16}:usage$`)
	codebuddyIdeEventKeyRe     = regexp.MustCompile(`^codebuddy:ide-request:[a-f0-9]{16}:[a-f0-9]{16}:usage$`)
	kimiFileEventKeyRe         = regexp.MustCompile(`^kimi:file:([0-9a-f]{16}):[0-9]+:(usage|prompt)$`)
	zcodeUsageIDRe             = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$`)
	codebuddyFamilyProviders   = []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"}
	codebuddyFamilyProviderSet = map[string]struct{}{
		"codebuddy":   {},
		"codebuddycn": {},
		"workbuddy":   {},
		"workbuddycn": {},
	}
)

// UsageRecordInput 表示待入库的一条模型用量记录。
type UsageRecordInput struct {
	EventKey                 string
	Provider                 string
	AccountRef               string
	SessionID                string
	RequestID                string
	SourceKind               string
	Model                    string
	InputTokens              int64
	OutputTokens             int64
	CacheReadInputTokens     int64
	CacheCreationInputTokens int64
	ReasoningOutputTokens    int64
	TotalTokens              int64
	CostUSD                  *float64
	TimestampMS              int64
	Project                  string
	CWD                      string
	GitBranch                string
}

type normalizedUsageRecord struct {
	EventKey                 string
	Provider                 string
	AccountRef               string
	SessionID                string
	RequestID                string
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

// UsageSessionInput 表示待写入或更新的会话元数据记录。
type UsageSessionInput struct {
	Provider    string
	SessionID   string
	Project     string
	CWD         string
	GitBranch   string
	StartedAtMS int64
	UpdatedAtMS int64
	PromptCount int
}

// UsagePromptEventInput 表示一条用户输入提示词事件。
type UsagePromptEventInput struct {
	EventKey    string
	Provider    string
	SessionID   string
	TimestampMS int64
}

// UsageFileState 表示文件扫描增量游标与上下文。
type UsageFileState struct {
	FilePath    string         `json:"filePath,omitempty"`
	Size        int64          `json:"size"`
	Offset      int64          `json:"offset"`
	ScanContext map[string]any `json:"scanContext,omitempty"`
}

// ZcodeUsageOwnerInput 表示 Zcode 会话写者延迟归属修正项。
type ZcodeUsageOwnerInput struct {
	UsageID     string
	AccountRef  string
	SessionID   string
	TimestampMS int64
}

// NativeOutcomeInput 表示原生 CLI 会话结果记录。
type NativeOutcomeInput struct {
	EventKey    string
	AccountRef  string
	Provider    string
	SessionID   string
	Outcome     string
	TimestampMS int64
}

// FileProjectionReplaceInput 表示 codex/grok 单文件投影原子替换参数。
type FileProjectionReplaceInput struct {
	Provider       string
	SourceHash     string
	FilePath       string
	UsageRecords   []UsageRecordInput
	PromptEvents   []UsagePromptEventInput
	SessionRecords []UsageSessionInput
	FileState      UsageFileState
}

// KimiFileProjectionInput 表示 kimi 单文件增量或替换投影参数。
type KimiFileProjectionInput struct {
	SourceHash        string
	FilePath          string
	SessionID         string
	ExpectedFileState *UsageFileState
	UsageRecords      []UsageRecordInput
	PromptEvents      []UsagePromptEventInput
	SessionRecords    []UsageSessionInput
	FileState         UsageFileState
}

// KimiTranscriptProjectionInput 表示 kimi 全量物理文件集合重放替换参数。
type KimiTranscriptProjectionInput struct {
	SourcePaths    []string
	FileStates     []UsageFileState
	UsageRecords   []UsageRecordInput
	PromptEvents   []UsagePromptEventInput
	SessionRecords []UsageSessionInput
}

type pricingCacheEntry struct {
	catalog     *usagepricing.Catalog
	activeSrc   string
	customIndex map[string]modelcatalogsettings.CustomPricing
	loadedAt    time.Time
}

type statsCacheEntry struct {
	cachedAt time.Time
	value    UsageStatsSummary
}

// UsageStore 管理 app-state.db 中的 model_usage_* 与投影查询。
type UsageStore struct {
	db          *sql.DB
	ownsDB      bool
	dbPath      string
	providerIDs []string
	attribution *usagepricing.AttributionIndex
	now         func() time.Time
	reqReader   *requestLogReader

	writeMu sync.Mutex

	pricingMu    sync.RWMutex
	pricingCache *pricingCacheEntry

	statsMu    sync.Mutex
	statsCache map[string]statsCacheEntry
}

// NewUsageStore 打开（必要时初始化）app-state.db 中的用量表并返回 UsageStore。
func NewUsageStore(ctx context.Context, dbPath string, providerIDs []string, nowFn func() time.Time) (*UsageStore, error) {
	cleaned := strings.TrimSpace(dbPath)
	if cleaned == "" {
		return nil, fmt.Errorf("app-state 数据库路径不能为空")
	}
	if dir := filepath.Dir(cleaned); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("创建用量数据库目录失败: %w", err)
		}
	}
	fileURL := sqlitefile.URL(cleaned)
	query := fileURL.Query()
	query.Set("mode", "rwc")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "journal_mode(WAL)")
	fileURL.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", fileURL.String())
	if err != nil {
		return nil, fmt.Errorf("打开用量数据库失败: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	if ctx == nil {
		ctx = context.Background()
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("连接用量数据库失败: %w", err)
	}
	store, err := newUsageStoreInternal(ctx, db, true, cleaned, providerIDs, nowFn)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

// NewUsageStoreWithDB 使用已有 *sql.DB 构造 UsageStore（主要用于测试注入）。
func NewUsageStoreWithDB(db *sql.DB, providerIDs []string, nowFn func() time.Time) (*UsageStore, error) {
	if db == nil {
		return nil, fmt.Errorf("用量数据库连接不能为空")
	}
	return newUsageStoreInternal(context.Background(), db, false, "", providerIDs, nowFn)
}

func newUsageStoreInternal(
	ctx context.Context,
	db *sql.DB,
	ownsDB bool,
	dbPath string,
	providerIDs []string,
	nowFn func() time.Time,
) (*UsageStore, error) {
	if nowFn == nil {
		nowFn = time.Now
	}
	copiedProviders := append([]string(nil), providerIDs...)
	var logPath string
	if dbPath != "" {
		logPath = filepath.Join(filepath.Dir(dbPath), "logs", "server.log")
	}
	store := &UsageStore{
		db:          db,
		ownsDB:      ownsDB,
		dbPath:      dbPath,
		providerIDs: copiedProviders,
		attribution: usagepricing.NewAttributionIndex(copiedProviders),
		now:         nowFn,
		reqReader:   newRequestLogReader(logPath),
		statsCache:  make(map[string]statsCacheEntry),
	}
	if err := store.ensureSchema(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

// Close 释放由 NewUsageStore 打开的数据库连接。
func (s *UsageStore) Close() error {
	if s == nil || !s.ownsDB || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// DB 返回底层数据库连接。
func (s *UsageStore) DB() *sql.DB {
	if s == nil {
		return nil
	}
	return s.db
}

func (s *UsageStore) ensureSchema(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	statements := []string{
		`PRAGMA busy_timeout = 5000`,
		`CREATE TABLE IF NOT EXISTS app_kv (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS model_usage_records (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_key TEXT NOT NULL UNIQUE,
			provider TEXT NOT NULL,
			account_ref TEXT NOT NULL DEFAULT '' CHECK (
				account_ref = '' OR (
					length(account_ref) = 25
					AND substr(account_ref, 1, 5) = 'acct_'
					AND substr(account_ref, 6) NOT GLOB '*[^0-9a-f]*'
				)
			),
			session_id TEXT NOT NULL DEFAULT '',
			request_id TEXT NOT NULL DEFAULT '',
			source_kind TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
			cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
			reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0,
			timestamp_ms INTEGER NOT NULL,
			project TEXT NOT NULL DEFAULT '',
			cwd TEXT NOT NULL DEFAULT '',
			git_branch TEXT NOT NULL DEFAULT '',
			created_at_ms INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS model_usage_sessions (
			provider TEXT NOT NULL,
			session_id TEXT NOT NULL,
			project TEXT NOT NULL DEFAULT '',
			cwd TEXT NOT NULL DEFAULT '',
			git_branch TEXT NOT NULL DEFAULT '',
			started_at_ms INTEGER NOT NULL DEFAULT 0,
			updated_at_ms INTEGER NOT NULL DEFAULT 0,
			prompt_count INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY(provider, session_id)
		)`,
		`CREATE TABLE IF NOT EXISTS model_usage_prompt_events (
			event_key TEXT NOT NULL UNIQUE,
			provider TEXT NOT NULL,
			session_id TEXT NOT NULL,
			timestamp_ms INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS model_usage_file_state (
			path TEXT PRIMARY KEY,
			size INTEGER NOT NULL DEFAULT 0,
			offset INTEGER NOT NULL DEFAULT 0,
			scan_context TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS model_usage_pricing (
			model TEXT PRIMARY KEY,
			input_cost_per_token REAL NOT NULL DEFAULT 0,
			output_cost_per_token REAL NOT NULL DEFAULT 0,
			cache_read_input_token_cost REAL NOT NULL DEFAULT 0,
			cache_creation_input_token_cost REAL NOT NULL DEFAULT 0,
			reasoning_output_token_cost REAL NOT NULL DEFAULT 0,
			context_cost_tiers_json TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT '',
			updated_at_ms INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS native_account_outcomes (
			event_key TEXT NOT NULL UNIQUE,
			account_ref TEXT NOT NULL DEFAULT '' CHECK (
				account_ref = '' OR (
					length(account_ref) = 25
					AND substr(account_ref, 1, 5) = 'acct_'
					AND substr(account_ref, 6) NOT GLOB '*[^0-9a-f]*'
				)
			),
			provider TEXT NOT NULL,
			session_id TEXT NOT NULL DEFAULT '',
			outcome TEXT NOT NULL,
			timestamp_ms INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_model_usage_timestamp ON model_usage_records(timestamp_ms)`,
		`CREATE INDEX IF NOT EXISTS idx_model_usage_provider_model ON model_usage_records(provider, model)`,
		`CREATE INDEX IF NOT EXISTS idx_model_usage_session ON model_usage_records(provider, session_id)`,
		`CREATE INDEX IF NOT EXISTS idx_model_usage_account_time ON model_usage_records(account_ref, timestamp_ms)`,
		`CREATE INDEX IF NOT EXISTS idx_model_usage_prompt_timestamp ON model_usage_prompt_events(timestamp_ms)`,
		`CREATE INDEX IF NOT EXISTS idx_native_account_outcomes_time ON native_account_outcomes(timestamp_ms)`,
		`CREATE INDEX IF NOT EXISTS idx_native_account_outcomes_account_time ON native_account_outcomes(account_ref, timestamp_ms)`,
	}
	for _, stmt := range statements {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("初始化用量数据库表结构失败: %w", err)
		}
	}
	return nil
}

// InvalidateStatsCache 清空内存短时统计缓存。
func (s *UsageStore) InvalidateStatsCache() {
	if s == nil {
		return
	}
	s.statsMu.Lock()
	s.statsCache = make(map[string]statsCacheEntry)
	s.statsMu.Unlock()
}

type pricingResolverSnapshot struct {
	catalog     *usagepricing.Catalog
	customIndex map[string]modelcatalogsettings.CustomPricing
}

func (s *UsageStore) loadPricingSnapshot(ctx context.Context, conn *sql.Conn) (pricingResolverSnapshot, error) {
	now := s.now()
	s.pricingMu.RLock()
	cached := s.pricingCache
	if cached != nil && now.Sub(cached.loadedAt) <= pricingCustomRefreshWindow {
		s.pricingMu.RUnlock()
		return pricingResolverSnapshot{
			catalog:     cached.catalog,
			customIndex: cached.customIndex,
		}, nil
	}
	s.pricingMu.RUnlock()

	s.pricingMu.Lock()
	defer s.pricingMu.Unlock()
	if s.pricingCache != nil && now.Sub(s.pricingCache.loadedAt) <= pricingCustomRefreshWindow {
		return pricingResolverSnapshot{
			catalog:     s.pricingCache.catalog,
			customIndex: s.pricingCache.customIndex,
		}, nil
	}

	activeSource := readActivePricingSourceConn(ctx, s.db, conn)
	pricingMap, err := readPricingTableConn(ctx, s.db, conn, activeSource)
	if err != nil {
		return pricingResolverSnapshot{}, err
	}
	customIndex := readCustomPricingIndex(ctx, s.db, conn, s.dbPath)
	entry := &pricingCacheEntry{
		catalog:     usagepricing.NewCatalog(pricingMap),
		activeSrc:   activeSource,
		customIndex: customIndex,
		loadedAt:    now,
	}
	s.pricingCache = entry
	return pricingResolverSnapshot{
		catalog:     entry.catalog,
		customIndex: entry.customIndex,
	}, nil
}

func readActivePricingSourceConn(ctx context.Context, db *sql.DB, conn *sql.Conn) string {
	const q = `SELECT value FROM app_kv WHERE key = ?`
	var raw string
	var err error
	if conn != nil {
		err = conn.QueryRowContext(ctx, q, pricingActiveCatalogKVKey).Scan(&raw)
	} else {
		err = db.QueryRowContext(ctx, q, pricingActiveCatalogKVKey).Scan(&raw)
	}
	if err != nil || strings.TrimSpace(raw) == "" {
		return ""
	}
	var payload struct {
		Source string `json:"source"`
	}
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return ""
	}
	return strings.TrimSpace(payload.Source)
}

func readPricingTableConn(ctx context.Context, db *sql.DB, conn *sql.Conn, activeSource string) (map[string]usagepricing.Record, error) {
	query := `
		SELECT model, input_cost_per_token, output_cost_per_token,
		       cache_read_input_token_cost, cache_creation_input_token_cost,
		       reasoning_output_token_cost, context_cost_tiers_json
		FROM model_usage_pricing`
	var args []any
	if activeSource != "" {
		query += ` WHERE source = ?`
		args = append(args, activeSource)
	}
	var (
		rows *sql.Rows
		err  error
	)
	if conn != nil {
		rows, err = conn.QueryContext(ctx, query, args...)
	} else {
		rows, err = db.QueryContext(ctx, query, args...)
	}
	if err != nil {
		if isSQLiteMissingTable(err) {
			return map[string]usagepricing.Record{}, nil
		}
		return nil, fmt.Errorf("读取模型定价表失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := make(map[string]usagepricing.Record)
	for rows.Next() {
		var (
			model                                         string
			input, output, cacheRead, cacheCreate, reason float64
			tiersJSON                                     sql.NullString
		)
		if err := rows.Scan(&model, &input, &output, &cacheRead, &cacheCreate, &reason, &tiersJSON); err != nil {
			return nil, fmt.Errorf("扫描模型定价行失败: %w", err)
		}
		trimmed := strings.TrimSpace(model)
		if trimmed == "" {
			continue
		}
		rec := usagepricing.Record{
			Model:                       trimmed,
			InputCostPerToken:           clampNonNegFloat(input),
			OutputCostPerToken:          clampNonNegFloat(output),
			CacheReadInputTokenCost:     clampNonNegFloat(cacheRead),
			CacheCreationInputTokenCost: clampNonNegFloat(cacheCreate),
			ContextCostTiers:            parsePricingTiersJSON(tiersJSON.String),
		}
		if reason >= 0 {
			copied := reason
			rec.ReasoningOutputTokenCost = &copied
		}
		if normalized := usagepricing.NormalizeRecord(trimmed, rec); normalized != nil {
			out[trimmed] = *normalized
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历模型定价行失败: %w", err)
	}
	return out, nil
}

func parsePricingTiersJSON(raw string) []usagepricing.Tier {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "[]" {
		return nil
	}
	var rawTiers []usagepricing.RawTier
	if json.Unmarshal([]byte(trimmed), &rawTiers) != nil {
		return nil
	}
	tiers := make([]usagepricing.Tier, 0, len(rawTiers))
	for _, rt := range rawTiers {
		size := 0.0
		if rt.Size != nil && *rt.Size > 0 {
			size = *rt.Size
		}
		if size <= 0 {
			continue
		}
		tiers = append(tiers, usagepricing.Tier{
			Size:                        size,
			InputCostPerToken:           rt.InputCostPerToken,
			OutputCostPerToken:          rt.OutputCostPerToken,
			CacheReadInputTokenCost:     rt.CacheReadInputTokenCost,
			CacheCreationInputTokenCost: rt.CacheCreationInputTokenCost,
			ReasoningOutputTokenCost:    rt.ReasoningOutputTokenCost,
		})
	}
	return tiers
}

func readCustomPricingIndex(ctx context.Context, db *sql.DB, conn *sql.Conn, dbPath string) map[string]modelcatalogsettings.CustomPricing {
	var raw string
	var err error
	const q = `SELECT value FROM app_kv WHERE key = ?`
	if conn != nil {
		err = conn.QueryRowContext(ctx, q, modelcatalogsettings.DatabaseKey).Scan(&raw)
	} else {
		err = db.QueryRowContext(ctx, q, modelcatalogsettings.DatabaseKey).Scan(&raw)
	}
	var settings modelcatalogsettings.Settings
	if err == nil && strings.TrimSpace(raw) != "" {
		settings = modelcatalogsettings.Normalize(raw)
	} else if dbPath != "" {
		loaded, loadErr := modelcatalogsettings.Load(ctx, dbPath)
		if loadErr == nil {
			settings = loaded
		}
	}
	out := make(map[string]modelcatalogsettings.CustomPricing)
	for _, am := range settings.AccountModels {
		if am.CustomPricing == nil {
			continue
		}
		accountRef := strings.TrimSpace(am.AccountRef)
		modelID := strings.ToLower(strings.TrimSpace(am.ID))
		if accountRef == "" || modelID == "" {
			continue
		}
		out[accountRef+"\x00"+modelID] = *am.CustomPricing
	}
	return out
}

func (snap pricingResolverSnapshot) resolve(idx *usagepricing.AttributionIndex, model, provider, accountRef string) *usagepricing.Record {
	var base *usagepricing.Record
	if snap.catalog != nil {
		identity := idx.Resolve(model, provider)
		base = snap.catalog.Match(identity)
	}
	trimmedRef := strings.TrimSpace(accountRef)
	trimmedModel := strings.TrimSpace(model)
	if trimmedRef == "" || trimmedModel == "" {
		return base
	}
	custom, ok := snap.customIndex[trimmedRef+"\x00"+strings.ToLower(trimmedModel)]
	if !ok {
		return base
	}
	merged := usagepricing.Record{
		Model:                       trimmedModel,
		InputCostPerToken:           mergeCustomPrice(custom.Input, baseVal(base, func(r *usagepricing.Record) float64 { return r.InputCostPerToken })),
		OutputCostPerToken:          mergeCustomPrice(custom.Output, baseVal(base, func(r *usagepricing.Record) float64 { return r.OutputCostPerToken })),
		CacheReadInputTokenCost:     mergeCustomPrice(custom.CacheRead, baseVal(base, func(r *usagepricing.Record) float64 { return r.CacheReadInputTokenCost })),
		CacheCreationInputTokenCost: mergeCustomPrice(custom.CacheWrite, baseVal(base, func(r *usagepricing.Record) float64 { return r.CacheCreationInputTokenCost })),
	}
	if base != nil && base.Model != "" {
		merged.Model = base.Model
	}
	if base != nil && base.ReasoningOutputTokenCost != nil {
		copied := *base.ReasoningOutputTokenCost
		merged.ReasoningOutputTokenCost = &copied
	}
	return &merged
}

func mergeCustomPrice(customVal *float64, fallback float64) float64 {
	if customVal != nil && !math.IsNaN(*customVal) && !math.IsInf(*customVal, 0) && *customVal >= 0 {
		return *customVal / pricingPerMillion
	}
	if math.IsNaN(fallback) || math.IsInf(fallback, 0) || fallback < 0 {
		return 0
	}
	return fallback
}

func baseVal(base *usagepricing.Record, getter func(*usagepricing.Record) float64) float64 {
	if base == nil {
		return 0
	}
	return getter(base)
}

func clampNonNegFloat(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0
	}
	return v
}

func isSQLiteMissingTable(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "no such table")
}

func isValidAccountRef(value string) bool {
	return accountRefRe.MatchString(strings.TrimSpace(value))
}

func normalizeUsageRecordInput(in UsageRecordInput, idx *usagepricing.AttributionIndex, pricing pricingResolverSnapshot) (*normalizedUsageRecord, error) {
	provider := strings.ToLower(strings.TrimSpace(in.Provider))
	model := strings.TrimSpace(in.Model)
	ts := in.TimestampMS
	eventKey := strings.TrimSpace(in.EventKey)
	if provider == "" || model == "" || ts <= 0 || eventKey == "" {
		return nil, nil
	}
	accountRef := strings.TrimSpace(in.AccountRef)
	if accountRef != "" && !isValidAccountRef(accountRef) {
		return nil, errors.New("model_usage_account_ref_invalid")
	}
	inputTokens := maxInt64(0, in.InputTokens)
	outputTokens := maxInt64(0, in.OutputTokens)
	cacheRead := maxInt64(0, in.CacheReadInputTokens)
	cacheCreate := maxInt64(0, in.CacheCreationInputTokens)
	reasoning := maxInt64(0, in.ReasoningOutputTokens)
	total := maxInt64(0, in.TotalTokens)
	if total == 0 {
		total = inputTokens + outputTokens + cacheRead + cacheCreate + reasoning
	}
	var cost float64
	if in.CostUSD != nil && !math.IsNaN(*in.CostUSD) && !math.IsInf(*in.CostUSD, 0) {
		cost = clampNonNegFloat(*in.CostUSD)
	} else {
		pRec := pricing.resolve(idx, model, provider, accountRef)
		if pRec != nil {
			cost = usagepricing.CalculateCostUSD(usagepricing.Usage{
				InputTokens:              inputTokens,
				OutputTokens:             outputTokens,
				CacheReadInputTokens:     cacheRead,
				CacheCreationInputTokens: cacheCreate,
				ReasoningOutputTokens:    reasoning,
			}, pRec)
		}
	}
	return &normalizedUsageRecord{
		EventKey:                 eventKey,
		Provider:                 provider,
		AccountRef:               accountRef,
		SessionID:                strings.TrimSpace(in.SessionID),
		RequestID:                strings.TrimSpace(in.RequestID),
		SourceKind:               strings.TrimSpace(in.SourceKind),
		Model:                    model,
		InputTokens:              inputTokens,
		OutputTokens:             outputTokens,
		CacheReadInputTokens:     cacheRead,
		CacheCreationInputTokens: cacheCreate,
		ReasoningOutputTokens:    reasoning,
		TotalTokens:              total,
		CostUSD:                  cost,
		TimestampMS:              ts,
		Project:                  strings.TrimSpace(in.Project),
		CWD:                      strings.TrimSpace(in.CWD),
		GitBranch:                strings.TrimSpace(in.GitBranch),
	}, nil
}

func (s *UsageStore) runImmediateTx(ctx context.Context, fn func(*sql.Tx) error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// InsertUsageBatch 幂等批量写入模型用量行。
func (s *UsageStore) InsertUsageBatch(ctx context.Context, records []UsageRecordInput) (int, error) {
	if s == nil || s.db == nil || len(records) == 0 {
		return 0, nil
	}
	pricing, err := s.loadPricingSnapshot(ctx, nil)
	if err != nil {
		return 0, err
	}
	normalized := make([]*normalizedUsageRecord, 0, len(records))
	for _, raw := range records {
		item, normErr := normalizeUsageRecordInput(raw, s.attribution, pricing)
		if normErr != nil {
			return 0, normErr
		}
		if item != nil {
			normalized = append(normalized, item)
		}
	}
	if len(normalized) == 0 {
		return 0, nil
	}
	var written int
	if err := s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		var txErr error
		written, txErr = insertNormalizedUsageTx(ctx, tx, normalized, s.now().UnixMilli())
		return txErr
	}); err != nil {
		return 0, err
	}
	if written > 0 {
		s.InvalidateStatsCache()
	}
	return written, nil
}

func insertNormalizedUsageTx(ctx context.Context, tx *sql.Tx, items []*normalizedUsageRecord, createdAtMS int64) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT OR IGNORE INTO model_usage_records (
			event_key, provider, account_ref, session_id, request_id, source_kind, model,
			input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
			reasoning_output_tokens, total_tokens, cost_usd, timestamp_ms,
			project, cwd, git_branch, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, err
	}
	defer func() { _ = stmt.Close() }()
	inserted := 0
	for _, r := range items {
		res, execErr := stmt.ExecContext(ctx,
			r.EventKey, r.Provider, r.AccountRef, r.SessionID, r.RequestID, r.SourceKind, r.Model,
			r.InputTokens, r.OutputTokens, r.CacheReadInputTokens, r.CacheCreationInputTokens,
			r.ReasoningOutputTokens, r.TotalTokens, r.CostUSD, r.TimestampMS,
			r.Project, r.CWD, r.GitBranch, createdAtMS,
		)
		if execErr != nil {
			return inserted, execErr
		}
		if rows, _ := res.RowsAffected(); rows > 0 {
			inserted++
		}
	}
	return inserted, nil
}

// UpsertSessions 增量合并或更新会话元数据。
func (s *UsageStore) UpsertSessions(ctx context.Context, records []UsageSessionInput) (int, error) {
	if s == nil || s.db == nil || len(records) == 0 {
		return 0, nil
	}
	cleaned := normalizeSessionInputs(records)
	if len(cleaned) == 0 {
		return 0, nil
	}
	var count int
	err := s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		var txErr error
		count, txErr = upsertNormalizedSessionsTx(ctx, tx, cleaned)
		return txErr
	})
	return count, err
}

func normalizeSessionInputs(records []UsageSessionInput) []UsageSessionInput {
	out := make([]UsageSessionInput, 0, len(records))
	for _, r := range records {
		provider := strings.ToLower(strings.TrimSpace(r.Provider))
		sessionID := strings.TrimSpace(r.SessionID)
		if provider == "" || sessionID == "" {
			continue
		}
		promptCount := r.PromptCount
		if promptCount < 0 {
			promptCount = 0
		}
		out = append(out, UsageSessionInput{
			Provider:    provider,
			SessionID:   sessionID,
			Project:     strings.TrimSpace(r.Project),
			CWD:         strings.TrimSpace(r.CWD),
			GitBranch:   strings.TrimSpace(r.GitBranch),
			StartedAtMS: maxInt64(0, r.StartedAtMS),
			UpdatedAtMS: maxInt64(0, r.UpdatedAtMS),
			PromptCount: promptCount,
		})
	}
	return out
}

func upsertNormalizedSessionsTx(ctx context.Context, tx *sql.Tx, items []UsageSessionInput) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO model_usage_sessions (
			provider, session_id, project, cwd, git_branch, started_at_ms, updated_at_ms, prompt_count
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider, session_id) DO UPDATE SET
			project = CASE WHEN excluded.project != '' THEN excluded.project ELSE model_usage_sessions.project END,
			cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE model_usage_sessions.cwd END,
			git_branch = CASE WHEN excluded.git_branch != '' THEN excluded.git_branch ELSE model_usage_sessions.git_branch END,
			started_at_ms = CASE
				WHEN model_usage_sessions.started_at_ms = 0 THEN excluded.started_at_ms
				WHEN excluded.started_at_ms = 0 THEN model_usage_sessions.started_at_ms
				WHEN excluded.started_at_ms < model_usage_sessions.started_at_ms THEN excluded.started_at_ms
				ELSE model_usage_sessions.started_at_ms
			END,
			updated_at_ms = CASE
				WHEN excluded.updated_at_ms > model_usage_sessions.updated_at_ms THEN excluded.updated_at_ms
				ELSE model_usage_sessions.updated_at_ms
			END,
			prompt_count = model_usage_sessions.prompt_count + excluded.prompt_count`)
	if err != nil {
		return 0, err
	}
	defer func() { _ = stmt.Close() }()
	for _, r := range items {
		if _, err := stmt.ExecContext(ctx, r.Provider, r.SessionID, r.Project, r.CWD, r.GitBranch, r.StartedAtMS, r.UpdatedAtMS, r.PromptCount); err != nil {
			return 0, err
		}
	}
	return len(items), nil
}

func replaceNormalizedSessionsTx(ctx context.Context, tx *sql.Tx, items []UsageSessionInput) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO model_usage_sessions (
			provider, session_id, project, cwd, git_branch, started_at_ms, updated_at_ms, prompt_count
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider, session_id) DO UPDATE SET
			project = excluded.project,
			cwd = excluded.cwd,
			git_branch = excluded.git_branch,
			started_at_ms = excluded.started_at_ms,
			updated_at_ms = excluded.updated_at_ms,
			prompt_count = excluded.prompt_count`)
	if err != nil {
		return 0, err
	}
	defer func() { _ = stmt.Close() }()
	for _, r := range items {
		if _, err := stmt.ExecContext(ctx, r.Provider, r.SessionID, r.Project, r.CWD, r.GitBranch, r.StartedAtMS, r.UpdatedAtMS, r.PromptCount); err != nil {
			return 0, err
		}
	}
	return len(items), nil
}

// InsertPromptEvents 幂等批量写入提示词事件。
func (s *UsageStore) InsertPromptEvents(ctx context.Context, events []UsagePromptEventInput) (int, error) {
	if s == nil || s.db == nil || len(events) == 0 {
		return 0, nil
	}
	cleaned := normalizePromptEventInputs(events)
	if len(cleaned) == 0 {
		return 0, nil
	}
	var inserted int
	err := s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		var txErr error
		inserted, txErr = insertNormalizedPromptEventsTx(ctx, tx, cleaned)
		return txErr
	})
	return inserted, err
}

func normalizePromptEventInputs(events []UsagePromptEventInput) []UsagePromptEventInput {
	out := make([]UsagePromptEventInput, 0, len(events))
	for _, e := range events {
		provider := strings.ToLower(strings.TrimSpace(e.Provider))
		sessionID := strings.TrimSpace(e.SessionID)
		eventKey := strings.TrimSpace(e.EventKey)
		if provider == "" || sessionID == "" || eventKey == "" || e.TimestampMS <= 0 {
			continue
		}
		out = append(out, UsagePromptEventInput{
			EventKey:    eventKey,
			Provider:    provider,
			SessionID:   sessionID,
			TimestampMS: e.TimestampMS,
		})
	}
	return out
}

func insertNormalizedPromptEventsTx(ctx context.Context, tx *sql.Tx, items []UsagePromptEventInput) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT OR IGNORE INTO model_usage_prompt_events (
			event_key, provider, session_id, timestamp_ms
		) VALUES (?, ?, ?, ?)`)
	if err != nil {
		return 0, err
	}
	defer func() { _ = stmt.Close() }()
	inserted := 0
	for _, e := range items {
		res, execErr := stmt.ExecContext(ctx, e.EventKey, e.Provider, e.SessionID, e.TimestampMS)
		if execErr != nil {
			return inserted, execErr
		}
		if rows, _ := res.RowsAffected(); rows > 0 {
			inserted++
		}
	}
	return inserted, nil
}

// GetFileState 读取单个文件的增量扫描状态；不存在时返回零值。
func (s *UsageStore) GetFileState(ctx context.Context, filePath string) (UsageFileState, error) {
	if s == nil || s.db == nil {
		return UsageFileState{}, nil
	}
	cleaned := strings.TrimSpace(filePath)
	if cleaned == "" {
		return UsageFileState{}, nil
	}
	var size, offset int64
	var rawContext string
	err := s.db.QueryRowContext(ctx, `
		SELECT size, offset, scan_context
		FROM model_usage_file_state
		WHERE path = ?`, cleaned).Scan(&size, &offset, &rawContext)
	if errors.Is(err, sql.ErrNoRows) {
		return UsageFileState{FilePath: cleaned}, nil
	}
	if err != nil {
		return UsageFileState{}, err
	}
	var parsed map[string]any
	if strings.TrimSpace(rawContext) != "" {
		_ = json.Unmarshal([]byte(rawContext), &parsed)
	}
	return UsageFileState{
		FilePath:    cleaned,
		Size:        maxInt64(0, size),
		Offset:      maxInt64(0, offset),
		ScanContext: parsed,
	}, nil
}

// SetFileState 更新单个文件的扫描游标状态。
func (s *UsageStore) SetFileState(ctx context.Context, filePath string, state UsageFileState) error {
	if s == nil || s.db == nil {
		return nil
	}
	cleaned := strings.TrimSpace(filePath)
	if cleaned == "" {
		return nil
	}
	ctxText := ""
	if len(state.ScanContext) > 0 {
		if b, err := json.Marshal(state.ScanContext); err == nil {
			ctxText = string(b)
		}
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO model_usage_file_state(path, size, offset, scan_context)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			size = excluded.size,
			offset = excluded.offset,
			scan_context = excluded.scan_context`,
		cleaned, maxInt64(0, state.Size), maxInt64(0, state.Offset), ctxText,
	)
	return err
}

func writeFileStateTx(ctx context.Context, tx *sql.Tx, filePath string, state UsageFileState) error {
	cleaned := strings.TrimSpace(filePath)
	ctxText := ""
	if len(state.ScanContext) > 0 {
		if b, err := json.Marshal(state.ScanContext); err == nil {
			ctxText = string(b)
		}
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO model_usage_file_state(path, size, offset, scan_context)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			size = excluded.size,
			offset = excluded.offset,
			scan_context = excluded.scan_context`,
		cleaned, maxInt64(0, state.Size), maxInt64(0, state.Offset), ctxText,
	)
	return err
}

// ReadFileUsageAccountRefs 读取某个 Codex 转写文件已入库的 event_key -> account_ref 映射。
func (s *UsageStore) ReadFileUsageAccountRefs(ctx context.Context, provider, sourceHash string) (map[string]string, error) {
	p := strings.ToLower(strings.TrimSpace(provider))
	h := strings.TrimSpace(sourceHash)
	if s == nil || s.db == nil || p != "codex" || !sourceHashRe.MatchString(h) {
		return map[string]string{}, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT event_key, account_ref FROM model_usage_records
		WHERE provider = ? AND event_key GLOB ?`, p, fmt.Sprintf("%s:file:%s:*", p, h))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := make(map[string]string)
	for rows.Next() {
		var eventKey, accountRef string
		if scanErr := rows.Scan(&eventKey, &accountRef); scanErr != nil {
			return nil, scanErr
		}
		out[eventKey] = accountRef
	}
	return out, rows.Err()
}

// ReplaceFileProjection 原子重放并替换 codex/grok 单文件衍生的全部投影行。
func (s *UsageStore) ReplaceFileProjection(ctx context.Context, input FileProjectionReplaceInput) (int, int, error) {
	if s == nil || s.db == nil {
		return 0, 0, nil
	}
	provider := strings.ToLower(strings.TrimSpace(input.Provider))
	sourceHash := strings.TrimSpace(input.SourceHash)
	filePath := strings.TrimSpace(input.FilePath)
	if (provider != "codex" && provider != "grok") || !sourceHashRe.MatchString(sourceHash) || filePath == "" || sourceHash != StableHash(filePath) {
		return 0, 0, errors.New("model_usage_file_projection_scope_invalid")
	}
	pricing, err := s.loadPricingSnapshot(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	eventPrefix := fmt.Sprintf("%s:file:%s:", provider, sourceHash)
	usageRecords := make([]*normalizedUsageRecord, 0, len(input.UsageRecords))
	for _, raw := range input.UsageRecords {
		item, normErr := normalizeUsageRecordInput(raw, s.attribution, pricing)
		if normErr != nil {
			return 0, 0, normErr
		}
		if item == nil {
			continue
		}
		if item.Provider != provider || (provider == "grok" && item.SourceKind != "session_jsonl") ||
			!strings.HasPrefix(item.EventKey, eventPrefix) || !strings.HasSuffix(item.EventKey, ":usage") {
			return 0, 0, errors.New("model_usage_file_projection_scope_invalid")
		}
		usageRecords = append(usageRecords, item)
	}
	promptEvents := normalizePromptEventInputs(input.PromptEvents)
	for _, p := range promptEvents {
		if p.Provider != provider || !strings.HasPrefix(p.EventKey, eventPrefix) || !strings.HasSuffix(p.EventKey, ":prompt") {
			return 0, 0, errors.New("model_usage_file_projection_scope_invalid")
		}
	}
	sessionRecords := normalizeSessionInputs(input.SessionRecords)
	for _, sr := range sessionRecords {
		if sr.Provider != provider {
			return 0, 0, errors.New("model_usage_file_projection_scope_invalid")
		}
	}
	var recordsInserted, promptsInserted int
	err = s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		if _, delErr := tx.ExecContext(ctx, `DELETE FROM model_usage_records WHERE provider = ? AND event_key GLOB ?`, provider, eventPrefix+"*:usage"); delErr != nil {
			return delErr
		}
		if _, delErr := tx.ExecContext(ctx, `DELETE FROM model_usage_prompt_events WHERE provider = ? AND event_key GLOB ?`, provider, eventPrefix+"*:prompt"); delErr != nil {
			return delErr
		}
		var insErr error
		recordsInserted, insErr = insertNormalizedUsageTx(ctx, tx, usageRecords, s.now().UnixMilli())
		if insErr != nil {
			return insErr
		}
		promptsInserted, insErr = insertNormalizedPromptEventsTx(ctx, tx, promptEvents)
		if insErr != nil {
			return insErr
		}
		if _, insErr = replaceNormalizedSessionsTx(ctx, tx, sessionRecords); insErr != nil {
			return insErr
		}
		return writeFileStateTx(ctx, tx, filePath, input.FileState)
	})
	if err == nil {
		s.InvalidateStatsCache()
	}
	return recordsInserted, promptsInserted, err
}

func (s *UsageStore) normalizeKimiFileProjection(ctx context.Context, input KimiFileProjectionInput) (
	eventPrefix string,
	usageRecords []*normalizedUsageRecord,
	promptEvents []UsagePromptEventInput,
	sessionRecords []UsageSessionInput,
	err error,
) {
	sourceHash := strings.TrimSpace(input.SourceHash)
	filePath := strings.TrimSpace(input.FilePath)
	sessionID := strings.TrimSpace(input.SessionID)
	if !sourceHashRe.MatchString(sourceHash) || filePath == "" || sessionID == "" || sourceHash != StableHash(filePath) {
		return "", nil, nil, nil, errors.New("model_usage_kimi_file_projection_scope_invalid")
	}
	pricing, pErr := s.loadPricingSnapshot(ctx, nil)
	if pErr != nil {
		return "", nil, nil, nil, pErr
	}
	eventPrefix = fmt.Sprintf("kimi:file:%s:", sourceHash)
	for _, raw := range input.UsageRecords {
		item, normErr := normalizeUsageRecordInput(raw, s.attribution, pricing)
		if normErr != nil {
			return "", nil, nil, nil, normErr
		}
		if item == nil {
			continue
		}
		if item.Provider != "kimi" || item.SourceKind != "session_jsonl" || item.SessionID != sessionID ||
			!strings.HasPrefix(item.EventKey, eventPrefix) || !strings.HasSuffix(item.EventKey, ":usage") {
			return "", nil, nil, nil, errors.New("model_usage_kimi_file_projection_scope_invalid")
		}
		usageRecords = append(usageRecords, item)
	}
	for _, p := range normalizePromptEventInputs(input.PromptEvents) {
		if p.Provider != "kimi" || p.SessionID != sessionID ||
			!strings.HasPrefix(p.EventKey, eventPrefix) || !strings.HasSuffix(p.EventKey, ":prompt") {
			return "", nil, nil, nil, errors.New("model_usage_kimi_file_projection_scope_invalid")
		}
		promptEvents = append(promptEvents, p)
	}
	cleanedSessions := normalizeSessionInputs(input.SessionRecords)
	if len(cleanedSessions) > 1 {
		return "", nil, nil, nil, errors.New("model_usage_kimi_file_projection_scope_invalid")
	}
	for _, sr := range cleanedSessions {
		if sr.Provider != "kimi" || sr.SessionID != sessionID {
			return "", nil, nil, nil, errors.New("model_usage_kimi_file_projection_scope_invalid")
		}
		sessionRecords = append(sessionRecords, sr)
	}
	return eventPrefix, usageRecords, promptEvents, sessionRecords, nil
}

func assertExpectedKimiFileStateTx(ctx context.Context, tx *sql.Tx, filePath string, expected *UsageFileState) error {
	if expected == nil {
		return errors.New("model_usage_kimi_file_projection_scope_invalid")
	}
	var size, offset int64
	var rawCtx string
	err := tx.QueryRowContext(ctx, `SELECT size, offset, scan_context FROM model_usage_file_state WHERE path = ?`, filePath).Scan(&size, &offset, &rawCtx)
	if errors.Is(err, sql.ErrNoRows) {
		size = 0
		offset = 0
		rawCtx = ""
	} else if err != nil {
		return err
	}
	var curCtx, expCtx map[string]any
	if strings.TrimSpace(rawCtx) != "" {
		_ = json.Unmarshal([]byte(rawCtx), &curCtx)
	}
	if len(expected.ScanContext) > 0 {
		expCtx = expected.ScanContext
	}
	curBytes, _ := json.Marshal(curCtx)
	expBytes, _ := json.Marshal(expCtx)
	if maxInt64(0, size) != maxInt64(0, expected.Size) || maxInt64(0, offset) != maxInt64(0, expected.Offset) || string(curBytes) != string(expBytes) {
		return errors.New("model_usage_kimi_file_projection_stale")
	}
	return nil
}

func refreshKimiSessionPromptCountsTx(ctx context.Context, tx *sql.Tx, sessionIDs []string) error {
	seen := make(map[string]struct{}, len(sessionIDs))
	for _, id := range sessionIDs {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			continue
		}
		if _, dup := seen[trimmed]; dup {
			continue
		}
		seen[trimmed] = struct{}{}
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM model_usage_prompt_events WHERE provider = 'kimi' AND session_id = ?`, trimmed).Scan(&count); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE model_usage_sessions SET prompt_count = ? WHERE provider = 'kimi' AND session_id = ?`, count, trimmed); err != nil {
			return err
		}
	}
	return nil
}

// AppendKimiFileProjection 原子增量追加 Kimi 文件投影。
func (s *UsageStore) AppendKimiFileProjection(ctx context.Context, input KimiFileProjectionInput) (int, int, error) {
	if s == nil || s.db == nil {
		return 0, 0, nil
	}
	_, usageRecords, promptEvents, sessionRecords, err := s.normalizeKimiFileProjection(ctx, input)
	if err != nil {
		return 0, 0, err
	}
	var recordsInserted, promptsInserted int
	err = s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		if checkErr := assertExpectedKimiFileStateTx(ctx, tx, strings.TrimSpace(input.FilePath), input.ExpectedFileState); checkErr != nil {
			return checkErr
		}
		var insErr error
		recordsInserted, insErr = insertNormalizedUsageTx(ctx, tx, usageRecords, s.now().UnixMilli())
		if insErr != nil {
			return insErr
		}
		promptsInserted, insErr = insertNormalizedPromptEventsTx(ctx, tx, promptEvents)
		if insErr != nil {
			return insErr
		}
		sessions := make([]UsageSessionInput, len(sessionRecords))
		for i, sr := range sessionRecords {
			sr.PromptCount = promptsInserted
			sessions[i] = sr
		}
		if _, insErr = upsertNormalizedSessionsTx(ctx, tx, sessions); insErr != nil {
			return insErr
		}
		return writeFileStateTx(ctx, tx, strings.TrimSpace(input.FilePath), input.FileState)
	})
	if err == nil && recordsInserted > 0 {
		s.InvalidateStatsCache()
	}
	return recordsInserted, promptsInserted, err
}

// ReplaceKimiFileProjection 原子替换单个 Kimi 文件对应的用量/提示词投影。
func (s *UsageStore) ReplaceKimiFileProjection(ctx context.Context, input KimiFileProjectionInput) (int, int, error) {
	if s == nil || s.db == nil {
		return 0, 0, nil
	}
	eventPrefix, usageRecords, promptEvents, sessionRecords, err := s.normalizeKimiFileProjection(ctx, input)
	if err != nil {
		return 0, 0, err
	}
	var recordsInserted, promptsInserted int
	err = s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		if checkErr := assertExpectedKimiFileStateTx(ctx, tx, strings.TrimSpace(input.FilePath), input.ExpectedFileState); checkErr != nil {
			return checkErr
		}
		affectedSessions := []string{strings.TrimSpace(input.SessionID)}
		eventGlob := eventPrefix + "*"
		rows, qErr := tx.QueryContext(ctx, `
			SELECT session_id FROM model_usage_records WHERE provider = 'kimi' AND event_key GLOB ?
			UNION
			SELECT session_id FROM model_usage_prompt_events WHERE provider = 'kimi' AND event_key GLOB ?`,
			eventGlob, eventGlob)
		if qErr != nil {
			return qErr
		}
		for rows.Next() {
			var sid string
			if scanErr := rows.Scan(&sid); scanErr == nil && strings.TrimSpace(sid) != "" {
				affectedSessions = append(affectedSessions, sid)
			}
		}
		_ = rows.Close()
		if _, delErr := tx.ExecContext(ctx, `DELETE FROM model_usage_records WHERE provider = 'kimi' AND event_key GLOB ?`, eventPrefix+"*:usage"); delErr != nil {
			return delErr
		}
		if _, delErr := tx.ExecContext(ctx, `DELETE FROM model_usage_prompt_events WHERE provider = 'kimi' AND event_key GLOB ?`, eventPrefix+"*:prompt"); delErr != nil {
			return delErr
		}
		var insErr error
		recordsInserted, insErr = insertNormalizedUsageTx(ctx, tx, usageRecords, s.now().UnixMilli())
		if insErr != nil {
			return insErr
		}
		promptsInserted, insErr = insertNormalizedPromptEventsTx(ctx, tx, promptEvents)
		if insErr != nil {
			return insErr
		}
		zeroed := make([]UsageSessionInput, len(sessionRecords))
		for i, sr := range sessionRecords {
			sr.PromptCount = 0
			zeroed[i] = sr
		}
		if _, insErr = upsertNormalizedSessionsTx(ctx, tx, zeroed); insErr != nil {
			return insErr
		}
		if refreshErr := refreshKimiSessionPromptCountsTx(ctx, tx, affectedSessions); refreshErr != nil {
			return refreshErr
		}
		return writeFileStateTx(ctx, tx, strings.TrimSpace(input.FilePath), input.FileState)
	})
	if err == nil {
		s.InvalidateStatsCache()
	}
	return recordsInserted, promptsInserted, err
}

// ReconcileCodebuddyUsageBatch 幂等校正 CodeBuddy 系列消息级用量投影。
func (s *UsageStore) ReconcileCodebuddyUsageBatch(ctx context.Context, records []UsageRecordInput) (int, error) {
	if s == nil || s.db == nil || len(records) == 0 {
		return 0, nil
	}
	pricing, err := s.loadPricingSnapshot(ctx, nil)
	if err != nil {
		return 0, err
	}
	normalized := make([]*normalizedUsageRecord, 0, len(records))
	for _, raw := range records {
		item, normErr := normalizeUsageRecordInput(raw, s.attribution, pricing)
		if normErr != nil {
			return 0, normErr
		}
		if item == nil {
			continue
		}
		if _, ok := codebuddyFamilyProviderSet[item.Provider]; !ok {
			return 0, errors.New("codebuddy_usage_projection_scope_invalid")
		}
		isSessionJSONL := item.SourceKind == "session_jsonl" && codebuddyMessageEventKeyRe.MatchString(item.EventKey)
		isDesktop := item.SourceKind == "desktop_history" && codebuddyIdeEventKeyRe.MatchString(item.EventKey)
		if !isSessionJSONL && !isDesktop {
			return 0, errors.New("codebuddy_usage_projection_scope_invalid")
		}
		normalized = append(normalized, item)
	}
	if len(normalized) == 0 {
		return 0, nil
	}
	var changed int
	err = s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		upsertStmt, prepErr := tx.PrepareContext(ctx, `
			INSERT INTO model_usage_records (
				event_key, provider, account_ref, session_id, request_id, source_kind, model,
				input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
				reasoning_output_tokens, total_tokens, cost_usd, timestamp_ms,
				project, cwd, git_branch, created_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(event_key) DO UPDATE SET
				provider = excluded.provider, account_ref = excluded.account_ref,
				request_id = excluded.request_id, model = excluded.model,
				input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
				cache_read_input_tokens = excluded.cache_read_input_tokens,
				cache_creation_input_tokens = excluded.cache_creation_input_tokens,
				reasoning_output_tokens = excluded.reasoning_output_tokens,
				total_tokens = excluded.total_tokens, cost_usd = excluded.cost_usd,
				timestamp_ms = excluded.timestamp_ms, project = excluded.project, cwd = excluded.cwd
			WHERE model_usage_records.provider IS NOT excluded.provider
				OR model_usage_records.account_ref IS NOT excluded.account_ref
				OR model_usage_records.request_id IS NOT excluded.request_id
				OR model_usage_records.model IS NOT excluded.model
				OR model_usage_records.input_tokens IS NOT excluded.input_tokens
				OR model_usage_records.output_tokens IS NOT excluded.output_tokens
				OR model_usage_records.cache_read_input_tokens IS NOT excluded.cache_read_input_tokens
				OR model_usage_records.cache_creation_input_tokens IS NOT excluded.cache_creation_input_tokens
				OR model_usage_records.reasoning_output_tokens IS NOT excluded.reasoning_output_tokens
				OR model_usage_records.total_tokens IS NOT excluded.total_tokens
				OR model_usage_records.cost_usd IS NOT excluded.cost_usd
				OR model_usage_records.timestamp_ms IS NOT excluded.timestamp_ms
				OR model_usage_records.project IS NOT excluded.project
				OR model_usage_records.cwd IS NOT excluded.cwd`)
		if prepErr != nil {
			return prepErr
		}
		defer func() { _ = upsertStmt.Close() }()

		delStmt, delPrepErr := tx.PrepareContext(ctx, `
			DELETE FROM model_usage_records
			WHERE provider IN ('codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn')
				AND session_id = ?
				AND substr(event_key, -22, 16) = ?
				AND event_key != ?`)
		if delPrepErr != nil {
			return delPrepErr
		}
		defer func() { _ = delStmt.Close() }()

		createdAtMS := s.now().UnixMilli()
		for _, r := range normalized {
			if len(r.EventKey) >= 22 && r.SessionID != "" {
				msgHash := r.EventKey[len(r.EventKey)-22 : len(r.EventKey)-6]
				if msgHash != "" {
					if _, delErr := delStmt.ExecContext(ctx, r.SessionID, msgHash, r.EventKey); delErr != nil {
						return delErr
					}
				}
			}
			res, execErr := upsertStmt.ExecContext(ctx,
				r.EventKey, r.Provider, r.AccountRef, r.SessionID, r.RequestID,
				r.SourceKind, r.Model, r.InputTokens, r.OutputTokens,
				r.CacheReadInputTokens, r.CacheCreationInputTokens, r.ReasoningOutputTokens,
				r.TotalTokens, r.CostUSD, r.TimestampMS, r.Project, r.CWD, r.GitBranch, createdAtMS,
			)
			if execErr != nil {
				return execErr
			}
			if rows, _ := res.RowsAffected(); rows > 0 {
				changed += int(rows)
			}
		}
		return nil
	})
	if err == nil && changed > 0 {
		s.InvalidateStatsCache()
	}
	return changed, err
}

// ReconcileZcodeUsageOwnershipBatch 根据写者侧审计证据补齐未归属 Zcode 记录的账号引用。
func (s *UsageStore) ReconcileZcodeUsageOwnershipBatch(ctx context.Context, records []ZcodeUsageOwnerInput) (int, error) {
	if s == nil || s.db == nil || len(records) == 0 {
		return 0, nil
	}
	var changed int
	err := s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		stmt, prepErr := tx.PrepareContext(ctx, `
			UPDATE model_usage_records SET account_ref = ?
			WHERE event_key = ? AND provider = 'zcode' AND source_kind = 'session_db'
				AND account_ref = '' AND session_id = ? AND timestamp_ms = ?`)
		if prepErr != nil {
			return prepErr
		}
		defer func() { _ = stmt.Close() }()
		for _, rec := range records {
			ref := strings.TrimSpace(rec.AccountRef)
			uid := strings.TrimSpace(rec.UsageID)
			sid := strings.TrimSpace(rec.SessionID)
			if !isValidAccountRef(ref) || !zcodeUsageIDRe.MatchString(uid) || sid == "" || rec.TimestampMS <= 0 {
				return errors.New("zcode_usage_owner_scope_invalid")
			}
			res, execErr := stmt.ExecContext(ctx, ref, "zcode:model_usage:"+uid, sid, rec.TimestampMS)
			if execErr != nil {
				return execErr
			}
			if rows, _ := res.RowsAffected(); rows > 0 {
				changed += int(rows)
			}
		}
		return nil
	})
	if err == nil && changed > 0 {
		s.InvalidateStatsCache()
	}
	return changed, err
}

// InsertNativeOutcomes 幂等写入原生 CLI 派生账号结果（91 天滚动保留）。
func (s *UsageStore) InsertNativeOutcomes(ctx context.Context, records []NativeOutcomeInput) (int, error) {
	if s == nil || s.db == nil || len(records) == 0 {
		return 0, nil
	}
	cleaned := make([]NativeOutcomeInput, 0, len(records))
	for _, r := range records {
		ek := strings.TrimSpace(r.EventKey)
		ref := strings.TrimSpace(r.AccountRef)
		prov := strings.ToLower(strings.TrimSpace(r.Provider))
		sid := strings.TrimSpace(r.SessionID)
		outcome := strings.TrimSpace(r.Outcome)
		if ek == "" || prov == "" || outcome == "" || r.TimestampMS <= 0 {
			continue
		}
		if ref != "" && !isValidAccountRef(ref) {
			continue
		}
		cleaned = append(cleaned, NativeOutcomeInput{
			EventKey:    ek,
			AccountRef:  ref,
			Provider:    prov,
			SessionID:   sid,
			Outcome:     outcome,
			TimestampMS: r.TimestampMS,
		})
	}
	if len(cleaned) == 0 {
		return 0, nil
	}
	var changed int
	err := s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		stmt, prepErr := tx.PrepareContext(ctx, `
			INSERT INTO native_account_outcomes (
				event_key, account_ref, provider, session_id, outcome, timestamp_ms
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(event_key) DO UPDATE SET
				account_ref = excluded.account_ref,
				provider = excluded.provider,
				session_id = excluded.session_id,
				outcome = excluded.outcome,
				timestamp_ms = excluded.timestamp_ms`)
		if prepErr != nil {
			return prepErr
		}
		defer func() { _ = stmt.Close() }()
		for _, r := range cleaned {
			res, execErr := stmt.ExecContext(ctx, r.EventKey, r.AccountRef, r.Provider, r.SessionID, r.Outcome, r.TimestampMS)
			if execErr != nil {
				return execErr
			}
			if rows, _ := res.RowsAffected(); rows > 0 {
				changed += int(rows)
			}
		}
		cutoff := s.now().UnixMilli() - nativeOutcomeRetentionMS
		_, _ = tx.ExecContext(ctx, `DELETE FROM native_account_outcomes WHERE timestamp_ms < ?`, cutoff)
		return nil
	})
	return changed, err
}

func randomHexID(bytesLen int) string {
	buf := make([]byte, bytesLen)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func checkCanonicalAccountRef(ref string) error {
	if ref == "" {
		return nil
	}
	if _, err := accountcore.ParseAccountRef(ref); err != nil {
		return err
	}
	return nil
}

// Keep appstate reference compiled for callers opening shared db paths.
func resolveUsageAppStateDBPath(aiHomeDir string) (string, error) {
	return appstate.DatabasePath(aiHomeDir)
}

// UsageOwnerRecord 描述已落库记录的归属快照（供增量扫描与对账读取）。
type UsageOwnerRecord struct {
	EventKey   string
	Provider   string
	AccountRef string
}

// ReadUsageOwnersByEventGlob 读取匹配 event_key GLOB 模式的已有记录归属。
func (s *UsageStore) ReadUsageOwnersByEventGlob(ctx context.Context, pattern string) (map[string]UsageOwnerRecord, error) {
	out := make(map[string]UsageOwnerRecord)
	if s == nil || s.db == nil {
		return out, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT event_key, provider, account_ref
		FROM model_usage_records
		WHERE event_key GLOB ?`, strings.TrimSpace(pattern))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var rec UsageOwnerRecord
		if scanErr := rows.Scan(&rec.EventKey, &rec.Provider, &rec.AccountRef); scanErr != nil {
			return nil, scanErr
		}
		out[rec.EventKey] = rec
	}
	return out, rows.Err()
}

// ReadUsageOwnerByEventKey 读取单条 event_key 的已有记录归属。
func (s *UsageStore) ReadUsageOwnerByEventKey(ctx context.Context, eventKey string) (UsageOwnerRecord, bool, error) {
	if s == nil || s.db == nil || strings.TrimSpace(eventKey) == "" {
		return UsageOwnerRecord{}, false, nil
	}
	var rec UsageOwnerRecord
	err := s.db.QueryRowContext(ctx, `
		SELECT event_key, provider, account_ref
		FROM model_usage_records
		WHERE event_key = ?
		LIMIT 1`, strings.TrimSpace(eventKey)).Scan(&rec.EventKey, &rec.Provider, &rec.AccountRef)
	if errors.Is(err, sql.ErrNoRows) {
		return UsageOwnerRecord{}, false, nil
	}
	if err != nil {
		return UsageOwnerRecord{}, false, err
	}
	return rec, true, nil
}

// ReadAccountRefsByProvider 读取 app-state account_refs 台账中的指定 Provider 账号列表。
func (s *UsageStore) ReadAccountRefsByProvider(ctx context.Context, provider string) ([]string, error) {
	if s == nil || s.db == nil || strings.TrimSpace(provider) == "" {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT account_ref
		FROM account_refs
		WHERE provider = ?
		ORDER BY account_ref`, strings.ToLower(strings.TrimSpace(provider)))
	if err != nil {
		if isSQLiteMissingTable(err) {
			return nil, nil
		}
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var refs []string
	for rows.Next() {
		var ref string
		if scanErr := rows.Scan(&ref); scanErr != nil {
			return nil, scanErr
		}
		if trimmed := strings.TrimSpace(ref); trimmed != "" {
			refs = append(refs, trimmed)
		}
	}
	return refs, rows.Err()
}
