package pricingcatalog

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/usagepricing"
)

const (
	CatalogSourceSchemaVersion = 1
	reviewFileName             = "reviews.json"
	sourcesDirName             = "sources"
)

var (
	sourceIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,127}$`)

	// ErrStoreUnavailable 表示未配置有效的 AIHomeDir。
	ErrStoreUnavailable = errors.New("pricing_source_store_unavailable")
	// ErrSourceIDInvalid 表示价格源 ID 格式不合法或存在路径风险。
	ErrSourceIDInvalid = errors.New("pricing_source_id_invalid")
	// ErrReviewPendingMissing 表示待批准的候选快照不存在。
	ErrReviewPendingMissing = errors.New("pricing_review_pending_missing")
)

// SourceMeta 描述已持久化快照文件的来源元数据。
type SourceMeta struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"`
	Name       string   `json:"name,omitempty"`
	URL        string   `json:"url,omitempty"`
	License    string   `json:"license,omitempty"`
	Authority  *float64 `json:"authority,omitempty"`
	Confidence *float64 `json:"confidence,omitempty"`
	FetchedAt  string   `json:"fetchedAt"`
}

// SourceDocument 对应 <AIHomeDir>/pricing/sources/<id>.json 与 .pending.json。
type SourceDocument struct {
	SchemaVersion int          `json:"schemaVersion"`
	SourceID      string       `json:"sourceId"`
	Source        SourceMeta   `json:"source"`
	FetchedAt     string       `json:"fetchedAt"`
	AppliedAt     string       `json:"appliedAt"`
	Quotes        []PriceQuote `json:"quotes"`
}

type rawSourceDocument struct {
	SchemaVersion int               `json:"schemaVersion"`
	SourceID      string            `json:"sourceId"`
	Source        SourceMeta        `json:"source"`
	FetchedAt     string            `json:"fetchedAt"`
	AppliedAt     string            `json:"appliedAt"`
	Quotes        []json.RawMessage `json:"quotes"`
}

// SourceSummary 用于 /sources 列表与 doctor 报告的轻量化摘要（quotes 为条数）。
type SourceSummary struct {
	SourceID  string     `json:"sourceId"`
	Source    SourceMeta `json:"source"`
	FetchedAt string     `json:"fetchedAt"`
	AppliedAt string     `json:"appliedAt"`
	Quotes    int        `json:"quotes"`
}

// DoctorSourceSummary 用于 /plugins/doctor 的 pricing.sources 字段。
type DoctorSourceSummary struct {
	SourceID  string `json:"sourceId"`
	Kind      string `json:"kind"`
	FetchedAt string `json:"fetchedAt"`
	Quotes    int    `json:"quotes"`
}

// QuoteSnapshot 是新增模型进入复核队列时携带的摘要快照。
type QuoteSnapshot struct {
	Provider     string      `json:"provider"`
	Model        string      `json:"model"`
	Status       string      `json:"status"`
	Input        *float64    `json:"input"`
	Output       *float64    `json:"output"`
	CacheRead    *float64    `json:"cacheRead"`
	CacheWrite   *float64    `json:"cacheWrite"`
	CacheWrite1h *float64    `json:"cacheWrite1h"`
	Reasoning    *float64    `json:"reasoning"`
	Tiers        []PriceTier `json:"tiers"`
}

// QuoteChange 描述两次价格快照之间的单条差异。
type QuoteChange struct {
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Change    string `json:"change"`
	Dimension string `json:"dimension,omitempty"`
	Previous  any    `json:"previous,omitempty"`
	Next      any    `json:"next,omitempty"`
}

// ReviewItem 对应 reviews.json 中的一条人工复核记录。
type ReviewItem struct {
	ID         string `json:"id"`
	SourceID   string `json:"sourceId"`
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	Change     string `json:"change"`
	Dimension  string `json:"dimension"`
	Previous   any    `json:"previous"`
	Next       any    `json:"next"`
	DetectedAt string `json:"detectedAt"`
	Status     string `json:"status"`
	SourceURL  string `json:"sourceUrl"`
	ResolvedAt string `json:"resolvedAt,omitempty"`
}

type reviewsDocument struct {
	SchemaVersion int          `json:"schemaVersion"`
	Items         []ReviewItem `json:"items"`
}

// ApplySnapshotInput 是向 Store 提交采集快照的入参。
type ApplySnapshotInput struct {
	SourceID         string
	Source           SourceMeta
	RawQuotes        []json.RawMessage
	NormalizedQuotes []PriceQuote
	FetchedAt        string
	RequireReview    *bool
}

// ApplySnapshotOutcome 描述一次快照提交的结果。
type ApplySnapshotOutcome struct {
	Applied        bool          `json:"applied"`
	ReviewRequired bool          `json:"reviewRequired"`
	Changes        []QuoteChange `json:"changes"`
	Reviews        []ReviewItem  `json:"reviews"`
	FetchedAt      string        `json:"fetchedAt"`
}

// ApproveOutcome 描述人工批准候选快照的结果。
type ApproveOutcome struct {
	SourceID  string `json:"sourceId"`
	AppliedAt string `json:"appliedAt"`
	Quotes    int    `json:"quotes"`
}

// RejectOutcome 描述人工拒绝候选快照的结果。
type RejectOutcome struct {
	SourceID string `json:"sourceId"`
	Rejected bool   `json:"rejected"`
}

// StoreOption 配置 Store 行为（主要用于测试注入时钟）。
type StoreOption func(*Store)

// WithStoreClock 注入自定义时钟。
func WithStoreClock(now func() time.Time) StoreOption {
	return func(store *Store) {
		if now != nil {
			store.now = now
		}
	}
}

// Store 管理 <AIHomeDir>/pricing 下的价格源快照与复核队列。
type Store struct {
	mu          sync.Mutex
	aiHomeDir   string
	root        string
	sourcesDir  string
	reviewsFile string
	now         func() time.Time
}

// NewStore 创建价格快照与复核存储；aiHomeDir 为空时返回 ErrStoreUnavailable。
func NewStore(aiHomeDir string, opts ...StoreOption) (*Store, error) {
	trimmed := strings.TrimSpace(aiHomeDir)
	if trimmed == "" {
		return nil, ErrStoreUnavailable
	}
	root := filepath.Join(trimmed, "pricing")
	store := &Store{
		aiHomeDir:   trimmed,
		root:        root,
		sourcesDir:  filepath.Join(root, sourcesDirName),
		reviewsFile: filepath.Join(root, reviewFileName),
		now:         time.Now,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(store)
		}
	}
	return store, nil
}

// ValidateSourceID 校验并规整价格源 ID，阻断目录穿越与非法字符。
func ValidateSourceID(value string) (string, error) {
	id := strings.TrimSpace(value)
	if !sourceIDPattern.MatchString(id) {
		return "", ErrSourceIDInvalid
	}
	return id, nil
}

// fileSafeID 将 ":" 编码为 "%3A"，避免与合法 "__" 等名称冲突且保持可逆。
func fileSafeID(id string) string {
	return strings.ReplaceAll(id, ":", "%3A")
}

func (store *Store) sourceFile(id string) string {
	return filepath.Join(store.sourcesDir, fileSafeID(id)+".json")
}

func (store *Store) pendingFile(id string) string {
	return filepath.Join(store.sourcesDir, fileSafeID(id)+".pending.json")
}

func (store *Store) ensureDirs() error {
	if store == nil || store.sourcesDir == "" {
		return ErrStoreUnavailable
	}
	return os.MkdirAll(store.sourcesDir, 0o700)
}

func (store *Store) atomicWriteJSON(target string, payload any) error {
	if err := store.ensureDirs(); err != nil {
		return err
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(payload); err != nil {
		return err
	}
	var suffix [4]byte
	_, _ = rand.Read(suffix[:])
	tmpPath := fmt.Sprintf("%s.%d.%s.tmp", target, os.Getpid(), hex.EncodeToString(suffix[:]))
	file, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	writeErr := func() error {
		defer func() { _ = file.Close() }()
		if _, err := file.Write(buf.Bytes()); err != nil {
			return err
		}
		return file.Close()
	}()
	if writeErr != nil {
		_ = os.Remove(tmpPath)
		return writeErr
	}
	_ = os.Chmod(tmpPath, 0o600)
	if err := os.Rename(tmpPath, target); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func readDocumentFromFile(path string) (*SourceDocument, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var doc rawSourceDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, false
	}
	if doc.SchemaVersion != CatalogSourceSchemaVersion {
		return nil, false
	}
	quotes := make([]PriceQuote, 0, len(doc.Quotes))
	for _, rawQuote := range doc.Quotes {
		if q, err := NormalizeQuote(rawQuote); err == nil {
			quotes = append(quotes, q)
		}
	}
	return &SourceDocument{
		SchemaVersion: doc.SchemaVersion,
		SourceID:      strings.TrimSpace(doc.SourceID),
		Source:        doc.Source,
		FetchedAt:     doc.FetchedAt,
		AppliedAt:     doc.AppliedAt,
		Quotes:        quotes,
	}, true
}

func (store *Store) readSourceLocked(id string) (*SourceDocument, bool) {
	return readDocumentFromFile(store.sourceFile(id))
}

func (store *Store) readPendingLocked(id string) (*SourceDocument, bool) {
	return readDocumentFromFile(store.pendingFile(id))
}

func (store *Store) loadReviewsLocked() reviewsDocument {
	raw, err := os.ReadFile(store.reviewsFile)
	if err != nil {
		return reviewsDocument{SchemaVersion: CatalogSourceSchemaVersion, Items: []ReviewItem{}}
	}
	var doc reviewsDocument
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Items == nil {
		return reviewsDocument{SchemaVersion: CatalogSourceSchemaVersion, Items: []ReviewItem{}}
	}
	return reviewsDocument{SchemaVersion: CatalogSourceSchemaVersion, Items: doc.Items}
}

func (store *Store) persistReviewsLocked(doc reviewsDocument) error {
	if doc.Items == nil {
		doc.Items = []ReviewItem{}
	}
	doc.SchemaVersion = CatalogSourceSchemaVersion
	return store.atomicWriteJSON(store.reviewsFile, doc)
}

func (store *Store) queueReviewsLocked(sourceID string, changes []QuoteChange, sourceURL string) ([]ReviewItem, error) {
	doc := store.loadReviewsLocked()
	at := formatISOString(store.now())
	added := make([]ReviewItem, 0, len(changes))
	for _, change := range changes {
		dimOrChange := change.Dimension
		if dimOrChange == "" {
			dimOrChange = change.Change
		}
		nextJSON, _ := json.Marshal(change.Next)
		if change.Next == nil {
			nextJSON = []byte(`""`)
		}
		seed := fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%s\x00%s",
			sourceID, change.Provider, change.Model, dimOrChange, string(nextJSON), at)
		sum := sha256.Sum256([]byte(seed))
		id := hex.EncodeToString(sum[:])[:24]
		added = append(added, ReviewItem{
			ID:         id,
			SourceID:   sourceID,
			Provider:   change.Provider,
			Model:      change.Model,
			Change:     change.Change,
			Dimension:  change.Dimension,
			Previous:   change.Previous,
			Next:       change.Next,
			DetectedAt: at,
			Status:     "pending",
			SourceURL:  sourceURL,
		})
	}
	filtered := make([]ReviewItem, 0, len(doc.Items)+len(added))
	for _, item := range doc.Items {
		if item.SourceID == sourceID && item.Status == "pending" {
			continue
		}
		filtered = append(filtered, item)
	}
	filtered = append(filtered, added...)
	doc.Items = filtered
	if err := store.persistReviewsLocked(doc); err != nil {
		return nil, err
	}
	return added, nil
}

func (store *Store) markSourceReviewsLocked(sourceID string, status string) error {
	doc := store.loadReviewsLocked()
	changed := false
	resolvedAt := formatISOString(store.now())
	for idx := range doc.Items {
		if doc.Items[idx].SourceID == sourceID && doc.Items[idx].Status == "pending" {
			doc.Items[idx].Status = status
			doc.Items[idx].ResolvedAt = resolvedAt
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return store.persistReviewsLocked(doc)
}

// ReadSource 读取指定来源的已生效快照。
func (store *Store) ReadSource(sourceID string) (*SourceDocument, bool, error) {
	id, err := ValidateSourceID(sourceID)
	if err != nil {
		return nil, false, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	doc, ok := store.readSourceLocked(id)
	return doc, ok, nil
}

// GetPending 读取指定来源的待复核候选快照。
func (store *Store) GetPending(sourceID string) (*SourceDocument, bool, error) {
	id, err := ValidateSourceID(sourceID)
	if err != nil {
		return nil, false, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	doc, ok := store.readPendingLocked(id)
	return doc, ok, nil
}

// ListSources 列出所有已生效的价格源快照（按 sourceId 升序）。
func (store *Store) ListSources() ([]SourceDocument, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.listSourcesLocked()
}

func (store *Store) listSourcesLocked() ([]SourceDocument, error) {
	if store.sourcesDir == "" {
		return nil, ErrStoreUnavailable
	}
	entries, err := os.ReadDir(store.sourcesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []SourceDocument{}, nil
		}
		return nil, err
	}
	sources := make([]SourceDocument, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".pending.json") {
			continue
		}
		doc, ok := readDocumentFromFile(filepath.Join(store.sourcesDir, name))
		if !ok || doc.SourceID == "" {
			continue
		}
		sources = append(sources, *doc)
	}
	sort.SliceStable(sources, func(left, right int) bool {
		return sources[left].SourceID < sources[right].SourceID
	})
	return sources, nil
}

// ListReviews 返回复核列表（按 detectedAt 降序），status 非空时做精确过滤。
func (store *Store) ListReviews(status string) []ReviewItem {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.listReviewsLocked(status)
}

func (store *Store) listReviewsLocked(status string) []ReviewItem {
	filter := strings.TrimSpace(status)
	doc := store.loadReviewsLocked()
	items := make([]ReviewItem, 0, len(doc.Items))
	for _, item := range doc.Items {
		if filter != "" && item.Status != filter {
			continue
		}
		items = append(items, item)
	}
	sort.SliceStable(items, func(left, right int) bool {
		return items[left].DetectedAt > items[right].DetectedAt
	})
	return items
}

// ApplySnapshot 提交一次已成功采集的快照。
//
// 首次采集直接生效；价格不变时只更新 fetchedAt；价格发生变更且 RequireReview!=false 时
// 仅写 pending 与 reviews 队列，保留旧快照继续作为计费事实。
func (store *Store) ApplySnapshot(input ApplySnapshotInput) (ApplySnapshotOutcome, error) {
	rawID := strings.TrimSpace(input.SourceID)
	if rawID == "" {
		rawID = strings.TrimSpace(input.Source.ID)
	}
	sourceID, err := ValidateSourceID(rawID)
	if err != nil {
		return ApplySnapshotOutcome{}, err
	}

	quotes := make([]PriceQuote, 0, len(input.NormalizedQuotes)+len(input.RawQuotes))
	quotes = append(quotes, input.NormalizedQuotes...)
	for _, rawQuote := range input.RawQuotes {
		if q, qErr := NormalizeQuote(rawQuote); qErr == nil {
			quotes = append(quotes, q)
		}
	}

	store.mu.Lock()
	defer store.mu.Unlock()

	fetchedAt := strings.TrimSpace(input.FetchedAt)
	if fetchedAt == "" {
		fetchedAt = formatISOString(store.now())
	} else if parsed, ok := parseFlexibleTimestamp(fetchedAt); ok {
		fetchedAt = formatISOString(parsed)
	}

	kind := strings.TrimSpace(input.Source.Kind)
	if kind == "" {
		kind = KindUnknown
	}
	sourceMeta := input.Source
	sourceMeta.ID = sourceID
	sourceMeta.Kind = kind
	sourceMeta.URL = strings.TrimSpace(sourceMeta.URL)
	sourceMeta.FetchedAt = fetchedAt

	previous, hasPrevious := store.readSourceLocked(sourceID)
	appliedAt := fetchedAt
	if hasPrevious && previous.AppliedAt != "" {
		appliedAt = previous.AppliedAt
	}
	doc := SourceDocument{
		SchemaVersion: CatalogSourceSchemaVersion,
		SourceID:      sourceID,
		Source:        sourceMeta,
		FetchedAt:     fetchedAt,
		AppliedAt:     appliedAt,
		Quotes:        quotes,
	}

	if !hasPrevious {
		if err := store.atomicWriteJSON(store.sourceFile(sourceID), doc); err != nil {
			return ApplySnapshotOutcome{}, err
		}
		return ApplySnapshotOutcome{
			Applied:   true,
			Changes:   []QuoteChange{},
			Reviews:   []ReviewItem{},
			FetchedAt: fetchedAt,
		}, nil
	}

	changes := diffQuotes(previous.Quotes, quotes)
	if len(changes) == 0 {
		updated := *previous
		updated.Source = sourceMeta
		updated.FetchedAt = fetchedAt
		if err := store.atomicWriteJSON(store.sourceFile(sourceID), updated); err != nil {
			return ApplySnapshotOutcome{}, err
		}
		return ApplySnapshotOutcome{
			Applied:   true,
			Changes:   []QuoteChange{},
			Reviews:   []ReviewItem{},
			FetchedAt: fetchedAt,
		}, nil
	}

	requireReview := input.RequireReview == nil || *input.RequireReview
	if !requireReview {
		if err := store.atomicWriteJSON(store.sourceFile(sourceID), doc); err != nil {
			return ApplySnapshotOutcome{}, err
		}
		if err := store.markSourceReviewsLocked(sourceID, "superseded"); err != nil {
			return ApplySnapshotOutcome{}, err
		}
		_ = os.Remove(store.pendingFile(sourceID))
		return ApplySnapshotOutcome{
			Applied:   true,
			Changes:   changes,
			Reviews:   []ReviewItem{},
			FetchedAt: fetchedAt,
		}, nil
	}

	if err := store.atomicWriteJSON(store.pendingFile(sourceID), doc); err != nil {
		return ApplySnapshotOutcome{}, err
	}
	queued, err := store.queueReviewsLocked(sourceID, changes, sourceMeta.URL)
	if err != nil {
		return ApplySnapshotOutcome{}, err
	}
	return ApplySnapshotOutcome{
		Applied:        false,
		ReviewRequired: true,
		Changes:        changes,
		Reviews:        queued,
		FetchedAt:      fetchedAt,
	}, nil
}

// ApproveSource 批准候选快照，将其提升为已生效快照并关闭 pending 复核记录。
func (store *Store) ApproveSource(sourceID string) (ApproveOutcome, error) {
	id, err := ValidateSourceID(sourceID)
	if err != nil {
		return ApproveOutcome{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()

	pending, ok := store.readPendingLocked(id)
	if !ok {
		return ApproveOutcome{}, ErrReviewPendingMissing
	}
	appliedAt := formatISOString(store.now())
	pending.SourceID = id
	pending.AppliedAt = appliedAt
	if err := store.atomicWriteJSON(store.sourceFile(id), pending); err != nil {
		return ApproveOutcome{}, err
	}
	_ = os.Remove(store.pendingFile(id))
	if err := store.markSourceReviewsLocked(id, "approved"); err != nil {
		return ApproveOutcome{}, err
	}
	return ApproveOutcome{
		SourceID:  id,
		AppliedAt: appliedAt,
		Quotes:    len(pending.Quotes),
	}, nil
}

// RejectSource 拒绝候选快照，删除 pending 文件并保留当前生效快照不变。
func (store *Store) RejectSource(sourceID string) (RejectOutcome, error) {
	id, err := ValidateSourceID(sourceID)
	if err != nil {
		return RejectOutcome{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()

	_ = os.Remove(store.pendingFile(id))
	if err := store.markSourceReviewsLocked(id, "rejected"); err != nil {
		return RejectOutcome{}, err
	}
	return RejectOutcome{
		SourceID: id,
		Rejected: true,
	}, nil
}

// BuildPricingRecords 把所有已生效快照合并为 models.dev 兼容的 per-token 定价记录。
// 复用 usagepricing.RawRecord / RawTier，不复制定价记录结构定义。
func (store *Store) BuildPricingRecords() ([]usagepricing.RawRecord, error) {
	store.mu.Lock()
	sources, err := store.listSourcesLocked()
	now := store.now()
	store.mu.Unlock()
	if err != nil {
		return nil, err
	}

	type quoteGroup struct {
		provider string
		model    string
		quotes   []PriceQuote
	}
	groups := make(map[string]*quoteGroup)
	order := make([]string, 0)
	for _, src := range sources {
		for _, q := range src.Quotes {
			key := q.Provider + "\x00" + q.Model
			grp, exists := groups[key]
			if !exists {
				grp = &quoteGroup{provider: q.Provider, model: q.Model}
				groups[key] = grp
				order = append(order, key)
			}
			grp.quotes = append(grp.quotes, q)
		}
	}

	records := make([]usagepricing.RawRecord, 0, len(order))
	for _, key := range order {
		grp := groups[key]
		merged := MergeNormalizedQuotes(grp.quotes, MergeOptions{
			Provider: grp.provider,
			Model:    grp.model,
			Now:      now,
		})
		if merged.Status == StatusUnknown {
			continue
		}
		modelKey := grp.provider + "/" + grp.model
		tiers := make([]usagepricing.RawTier, 0, len(merged.Tiers))
		for _, tier := range merged.Tiers {
			size := tier.When.ContextTokensGt
			tiers = append(tiers, usagepricing.RawTier{
				Size:                        &size,
				InputCostPerToken:           perMillionToPerToken(tier.Input),
				OutputCostPerToken:          perMillionToPerToken(tier.Output),
				CacheReadInputTokenCost:     perMillionToPerToken(tier.CacheRead),
				CacheCreationInputTokenCost: perMillionToPerToken(tier.CacheWrite),
				ReasoningOutputTokenCost:    perMillionToPerToken(tier.Reasoning),
			})
		}
		record := usagepricing.RawRecord{
			Model:                       &modelKey,
			InputCostPerToken:           perMillionToPerToken(merged.Input),
			OutputCostPerToken:          perMillionToPerToken(merged.Output),
			CacheReadInputTokenCost:     perMillionToPerToken(merged.CacheRead),
			CacheCreationInputTokenCost: perMillionToPerToken(merged.CacheWrite),
			ReasoningOutputTokenCost:    perMillionToPerToken(merged.Reasoning),
			ContextCostTiers:            tiers,
		}
		if record.InputCostPerToken == nil &&
			record.OutputCostPerToken == nil &&
			record.CacheReadInputTokenCost == nil &&
			record.CacheCreationInputTokenCost == nil &&
			record.ReasoningOutputTokenCost == nil &&
			len(record.ContextCostTiers) == 0 {
			continue
		}
		records = append(records, record)
	}
	sort.SliceStable(records, func(left, right int) bool {
		return *records[left].Model < *records[right].Model
	})
	return records, nil
}

func perMillionToPerToken(val *float64) *float64 {
	if val == nil {
		return nil
	}
	converted := *val / 1_000_000
	return &converted
}

func quoteLookupKey(q PriceQuote) string {
	return strings.ToLower(q.Provider) + "\x00" + strings.ToLower(q.Model)
}

func makeQuoteSnapshot(q PriceQuote) QuoteSnapshot {
	tiers := q.Tiers
	if tiers == nil {
		tiers = []PriceTier{}
	}
	return QuoteSnapshot{
		Provider:     q.Provider,
		Model:        q.Model,
		Status:       q.Status,
		Input:        q.Input,
		Output:       q.Output,
		CacheRead:    q.CacheRead,
		CacheWrite:   q.CacheWrite,
		CacheWrite1h: q.CacheWrite1h,
		Reasoning:    q.Reasoning,
		Tiers:        tiers,
	}
}

func diffQuotes(previous []PriceQuote, next []PriceQuote) []QuoteChange {
	oldOrder := make([]string, 0, len(previous))
	oldMap := make(map[string]PriceQuote, len(previous))
	for _, q := range previous {
		key := quoteLookupKey(q)
		if _, exists := oldMap[key]; !exists {
			oldOrder = append(oldOrder, key)
		}
		oldMap[key] = q
	}

	changes := make([]QuoteChange, 0)
	for _, q := range next {
		key := quoteLookupKey(q)
		old, exists := oldMap[key]
		if !exists {
			changes = append(changes, QuoteChange{
				Provider: q.Provider,
				Model:    q.Model,
				Change:   "added",
				Next:     makeQuoteSnapshot(q),
			})
			continue
		}
		delete(oldMap, key)
		for _, dim := range PriceQuoteDimensions {
			oldVal := quoteDimension(old, dim)
			newVal := quoteDimension(q, dim)
			if !floatPtrEqual(oldVal, newVal) {
				changes = append(changes, QuoteChange{
					Provider:  q.Provider,
					Model:     q.Model,
					Change:    "changed",
					Dimension: dim,
					Previous:  oldVal,
					Next:      newVal,
				})
			}
		}
		if !tiersEqual(old.Tiers, q.Tiers) {
			changes = append(changes, QuoteChange{
				Provider: q.Provider,
				Model:    q.Model,
				Change:   "tiers_changed",
			})
		}
	}

	for _, key := range oldOrder {
		old, remaining := oldMap[key]
		if !remaining {
			continue
		}
		changes = append(changes, QuoteChange{
			Provider: old.Provider,
			Model:    old.Model,
			Change:   "removed",
		})
	}
	return changes
}

func floatPtrEqual(left, right *float64) bool {
	if left == nil && right == nil {
		return true
	}
	if left == nil || right == nil {
		return false
	}
	return *left == *right
}

func tiersEqual(left, right []PriceTier) bool {
	if len(left) == 0 && len(right) == 0 {
		return true
	}
	if len(left) != len(right) {
		return false
	}
	leftBytes, _ := json.Marshal(left)
	rightBytes, _ := json.Marshal(right)
	return bytes.Equal(leftBytes, rightBytes)
}
