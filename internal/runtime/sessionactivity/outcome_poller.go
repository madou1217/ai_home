package sessionactivity

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// DefaultOutcomePollInterval 是原生会话结果轮询的默认周期。
	DefaultOutcomePollInterval = 5 * time.Minute
	// MinOutcomePollInterval 是轮询间隔下限。
	MinOutcomePollInterval = 30 * time.Second
	// MaxTrackedObservations 是 app-state KV 游标最多保留的观察条数。
	MaxTrackedObservations = 4000
	// ClineOutcomeStoreKey 是 Cline 会话结果游标在 app-state KV 的存储键。
	ClineOutcomeStoreKey = "cline-session-outcomes"
	// KiroOutcomeStoreKey 是 Kiro 回合结果游标在 app-state KV 的存储键。
	KiroOutcomeStoreKey = "kiro-session-outcomes"
)

var (
	clineSuccessStatuses = map[string]struct{}{
		"completed": {}, "complete": {}, "success": {}, "succeeded": {}, "ok": {}, "done": {},
	}
	clineFailureStatuses = map[string]struct{}{
		"failed": {}, "failure": {}, "error": {}, "errored": {},
	}
)

// OutcomeObservation 描述一次从原生会话提取出的待记账结果。
type OutcomeObservation struct {
	Key        string
	Marker     string
	Outcome    string
	AtMS       int64
	AccountRef string
}

// OutcomeRecordFunc 将已归属的结果写进账号健康结果桶。
type OutcomeRecordFunc func(ctx context.Context, accountRef, outcome string, atMS int64) bool

// OutcomeCursorReadFunc 读取持久化游标 JSON。
type OutcomeCursorReadFunc func(ctx context.Context, aiHomeDir, storeKey string) (string, bool, error)

// OutcomeCursorWriteFunc 写入持久化游标 JSON。
type OutcomeCursorWriteFunc func(ctx context.Context, aiHomeDir, storeKey, value string, updatedAt int64) error

// OutcomeCollectFunc 采集本轮原生会话结果观察。
type OutcomeCollectFunc func(ctx context.Context) []OutcomeObservation

// OutcomePollerOptions 配置原生会话结果轮询模板。
type OutcomePollerOptions struct {
	AIHomeDir     string
	StoreKey      string
	Interval      time.Duration
	RecordOutcome OutcomeRecordFunc
	Collect       OutcomeCollectFunc
	ReadCursor    OutcomeCursorReadFunc
	WriteCursor   OutcomeCursorWriteFunc
	Now           func() time.Time
}

// OutcomePollerSummary 是单轮结果扫描统计。
type OutcomePollerSummary struct {
	Scanned      int `json:"scanned"`
	Recorded     int `json:"recorded"`
	Unattributed int `json:"unattributed"`
	Skipped      int `json:"skipped"`
}

// orderedCursor 保持插入/更新顺序以便超限裁剪时淘汰最旧键。
type orderedCursor struct {
	values map[string]string
	order  []string
}

func newOrderedCursor() *orderedCursor {
	return &orderedCursor{
		values: make(map[string]string),
	}
}

func decodeOrderedCursor(raw string) *orderedCursor {
	c := newOrderedCursor()
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || !strings.HasPrefix(trimmed, "{") {
		return c
	}
	dec := json.NewDecoder(strings.NewReader(trimmed))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return c
	}
	for dec.More() {
		kTok, kErr := dec.Token()
		if kErr != nil {
			break
		}
		key, ok := kTok.(string)
		if !ok {
			break
		}
		var val any
		if vErr := dec.Decode(&val); vErr != nil {
			break
		}
		c.set(key, fmt.Sprint(val))
	}
	return c
}

func (c *orderedCursor) get(key string) (string, bool) {
	v, ok := c.values[key]
	return v, ok
}

func (c *orderedCursor) set(key, marker string) {
	if _, exists := c.values[key]; !exists {
		c.order = append(c.order, key)
	}
	c.values[key] = marker
}

func (c *orderedCursor) trim(limit int) {
	if limit <= 0 || len(c.order) <= limit {
		return
	}
	drop := len(c.order) - limit
	for _, oldKey := range c.order[:drop] {
		delete(c.values, oldKey)
	}
	c.order = append([]string(nil), c.order[drop:]...)
}

func (c *orderedCursor) marshalJSON() (string, error) {
	c.trim(MaxTrackedObservations)
	var buf bytes.Buffer
	buf.WriteByte('{')
	first := true
	for _, k := range c.order {
		v, ok := c.values[k]
		if !ok {
			continue
		}
		if !first {
			buf.WriteByte(',')
		}
		first = false
		kb, err := json.Marshal(k)
		if err != nil {
			return "", err
		}
		vb, err := json.Marshal(v)
		if err != nil {
			return "", err
		}
		buf.Write(kb)
		buf.WriteByte(':')
		buf.Write(vb)
	}
	buf.WriteByte('}')
	return buf.String(), nil
}

// OutcomePoller 实现原生 CLI 会话结果轮询的 Template Method。
type OutcomePoller struct {
	aiHomeDir     string
	storeKey      string
	interval      time.Duration
	recordOutcome OutcomeRecordFunc
	collect       OutcomeCollectFunc
	readCursorFn  OutcomeCursorReadFunc
	writeCursorFn OutcomeCursorWriteFunc
	nowFn         func() time.Time
	enabled       bool

	mu     sync.Mutex
	cursor *orderedCursor

	runMu   sync.Mutex
	running bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// NewOutcomePoller 构造通用原生会话结果轮询器。
func NewOutcomePoller(options OutcomePollerOptions) *OutcomePoller {
	aiHomeDir := strings.TrimSpace(options.AIHomeDir)
	storeKey := strings.TrimSpace(options.StoreKey)
	interval := options.Interval
	if interval <= 0 {
		interval = DefaultOutcomePollInterval
	}
	if interval < MinOutcomePollInterval {
		interval = MinOutcomePollInterval
	}
	readFn := options.ReadCursor
	if readFn == nil {
		readFn = defaultAppStateReadKV
	}
	writeFn := options.WriteCursor
	if writeFn == nil {
		writeFn = defaultAppStateWriteKV
	}
	collectFn := options.Collect
	if collectFn == nil {
		collectFn = func(context.Context) []OutcomeObservation { return nil }
	}
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	enabled := aiHomeDir != "" && storeKey != "" && options.RecordOutcome != nil
	return &OutcomePoller{
		aiHomeDir:     aiHomeDir,
		storeKey:      storeKey,
		interval:      interval,
		recordOutcome: options.RecordOutcome,
		collect:       collectFn,
		readCursorFn:  readFn,
		writeCursorFn: writeFn,
		nowFn:         nowFn,
		enabled:       enabled,
	}
}

// Interval 返回实际生效的轮询间隔。
func (p *OutcomePoller) Interval() time.Duration {
	return p.interval
}

// StoreKey 返回 app-state KV 游标键。
func (p *OutcomePoller) StoreKey() string {
	return p.storeKey
}

func defaultAppStateReadKV(ctx context.Context, aiHomeDir, storeKey string) (string, bool, error) {
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return "", false, err
	}
	return appstate.ReadKV(ctx, dbPath, storeKey)
}

func defaultAppStateWriteKV(ctx context.Context, aiHomeDir, storeKey, value string, updatedAt int64) error {
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return err
	}
	return appstate.WriteKV(ctx, dbPath, storeKey, value, updatedAt)
}

// Tick 执行单轮结果采集、游标去重与记账持久化。
func (p *OutcomePoller) Tick(ctx context.Context) OutcomePollerSummary {
	if ctx == nil {
		ctx = context.Background()
	}
	var summary OutcomePollerSummary
	if !p.enabled {
		return summary
	}

	p.mu.Lock()
	if p.cursor == nil {
		raw, found, _ := p.readCursorFn(ctx, p.aiHomeDir, p.storeKey)
		if found {
			p.cursor = decodeOrderedCursor(raw)
		} else {
			p.cursor = newOrderedCursor()
		}
	}
	p.mu.Unlock()

	observations := p.collect(ctx)
	dirty := false
	p.mu.Lock()
	state := p.cursor
	for _, obs := range observations {
		summary.Scanned++
		key := strings.TrimSpace(obs.Key)
		outcome := strings.TrimSpace(obs.Outcome)
		if key == "" || outcome == "" {
			summary.Skipped++
			continue
		}
		marker := strings.TrimSpace(obs.Marker)
		if marker == "" {
			marker = "1"
		}
		if existing, ok := state.get(key); ok && existing == marker {
			continue
		}
		accountRef := strings.TrimSpace(obs.AccountRef)
		if accountRef == "" {
			summary.Unattributed++
			continue
		}
		atMS := obs.AtMS
		if atMS <= 0 {
			atMS = p.nowFn().UnixMilli()
		}
		recorded := p.recordOutcome(ctx, accountRef, outcome, atMS)
		state.set(key, marker)
		dirty = true
		if recorded {
			summary.Recorded++
		}
	}
	var payload string
	if dirty {
		if encoded, err := state.marshalJSON(); err == nil {
			payload = encoded
		}
	}
	p.mu.Unlock()

	if dirty && payload != "" {
		_ = p.writeCursorFn(ctx, p.aiHomeDir, p.storeKey, payload, p.nowFn().UnixMilli())
	}
	return summary
}

// Start 启动定时轮询（先运行一轮再周期触发）。
func (p *OutcomePoller) Start(parent context.Context) bool {
	p.runMu.Lock()
	defer p.runMu.Unlock()
	if p.running || !p.enabled {
		return false
	}
	if parent == nil {
		parent = context.Background()
	}
	runCtx, cancel := context.WithCancel(parent)
	p.cancel = cancel
	p.running = true
	p.Tick(runCtx)
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		ticker := time.NewTicker(p.interval)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				p.Tick(runCtx)
			}
		}
	}()
	return true
}

// Stop 停止定时轮询并等待协程退出。
func (p *OutcomePoller) Stop() bool {
	p.runMu.Lock()
	if !p.running {
		p.runMu.Unlock()
		return false
	}
	cancel := p.cancel
	p.cancel = nil
	p.running = false
	p.runMu.Unlock()
	if cancel != nil {
		cancel()
	}
	p.wg.Wait()
	return true
}

// ClassifyClineSessionOutcome 将 Cline 会话记录终态映射为账号健康结果标签。
func ClassifyClineSessionOutcome(status string) string {
	normalized := strings.ToLower(strings.TrimSpace(status))
	if normalized == "" {
		return ""
	}
	if _, ok := clineSuccessStatuses[normalized]; ok {
		return "success"
	}
	if _, ok := clineFailureStatuses[normalized]; ok {
		return "unclassified"
	}
	return ""
}

type rawClineSessionRecord struct {
	SessionID string `json:"session_id"`
	Status    string `json:"status"`
	EndedAt   any    `json:"ended_at"`
	StartedAt any    `json:"started_at"`
	CWD       string `json:"cwd"`
}

// CollectClineSessionOutcomes 采集宿主 ~/.cline/data/sessions 下的会话终态观察。
func CollectClineSessionOutcomes(
	aiHomeDir, hostHomeDir string,
	registryEntries []RegistryEntry,
	nowMS int64,
) []OutcomeObservation {
	aiHome := strings.TrimSpace(aiHomeDir)
	hostHome := strings.TrimSpace(hostHomeDir)
	if aiHome == "" || hostHome == "" {
		return nil
	}
	if nowMS <= 0 {
		nowMS = time.Now().UnixMilli()
	}
	files := DiscoverClineSessionFiles(hostHome)
	if len(files) == 0 {
		return nil
	}
	ownership := NewRegistryScopeOwnership("cline", aiHome, registryEntries)
	observations := make([]OutcomeObservation, 0, len(files))
	for _, recordPath := range files {
		raw, err := os.ReadFile(recordPath)
		if err != nil {
			continue
		}
		var rec rawClineSessionRecord
		if json.Unmarshal(raw, &rec) != nil {
			continue
		}
		sessionID := strings.TrimSpace(rec.SessionID)
		if sessionID == "" {
			sessionID = strings.TrimSuffix(filepath.Base(recordPath), ".json")
		}
		endedAtMS := parseTimestampMS(rec.EndedAt)
		startedAtMS := parseTimestampMS(rec.StartedAt)
		outcome := ClassifyClineSessionOutcome(rec.Status)
		atMS := endedAtMS
		if atMS <= 0 {
			atMS = startedAtMS
		}
		if atMS <= 0 {
			atMS = nowMS
		}
		var accountRef string
		if outcome != "" {
			accountRef, _ = ownership.Resolve(strings.TrimSpace(rec.CWD), startedAtMS, 0)
		}
		observations = append(observations, OutcomeObservation{
			Key:        sessionID,
			Marker:     fmt.Sprintf("%s:%d", strings.TrimSpace(rec.Status), endedAtMS),
			Outcome:    outcome,
			AtMS:       atMS,
			AccountRef: strings.TrimSpace(accountRef),
		})
	}
	return observations
}

// ClinePollerOptions 配置 Cline 会话结果轮询器。
type ClinePollerOptions struct {
	AIHomeDir           string
	HostHomeDir         string
	StoreKey            string
	Interval            time.Duration
	RecordOutcome       OutcomeRecordFunc
	ReadCursor          OutcomeCursorReadFunc
	WriteCursor         OutcomeCursorWriteFunc
	ListRegistryEntries func() []RegistryEntry
	Now                 func() time.Time
}

// NewClineSessionOutcomePoller 构造 Cline 原生会话结果轮询器。
func NewClineSessionOutcomePoller(options ClinePollerOptions) *OutcomePoller {
	storeKey := strings.TrimSpace(options.StoreKey)
	if storeKey == "" {
		storeKey = ClineOutcomeStoreKey
	}
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	aiHomeDir := strings.TrimSpace(options.AIHomeDir)
	hostHomeDir := strings.TrimSpace(options.HostHomeDir)
	effectiveAIHome := ""
	if hostHomeDir != "" {
		effectiveAIHome = aiHomeDir
	}
	return NewOutcomePoller(OutcomePollerOptions{
		AIHomeDir:     effectiveAIHome,
		StoreKey:      storeKey,
		Interval:      options.Interval,
		RecordOutcome: options.RecordOutcome,
		ReadCursor:    options.ReadCursor,
		WriteCursor:   options.WriteCursor,
		Now:           nowFn,
		Collect: func(context.Context) []OutcomeObservation {
			var entries []RegistryEntry
			if options.ListRegistryEntries != nil {
				entries = options.ListRegistryEntries()
				if entries == nil {
					entries = []RegistryEntry{}
				}
			}
			return CollectClineSessionOutcomes(aiHomeDir, hostHomeDir, entries, nowFn().UnixMilli())
		},
	})
}

// ClassifyKiroTurnStatus 将 Kiro usage_summary.status 映射为结果标签。
func ClassifyKiroTurnStatus(status string) string {
	return ClassifyClineSessionOutcome(status)
}

// KiroTurnCollectorOptions 配置 Kiro 增量回合结果采集器。
type KiroTurnCollectorOptions struct {
	AIHomeDir           string
	HostHomeDir         string
	ListRegistryEntries func() []RegistryEntry
}

// KiroTurnCollector 按文件字节偏移增量读取 Kiro messages.jsonl 的 usage_summary 回合结果。
type KiroTurnCollector struct {
	aiHomeDir           string
	hostHomeDir         string
	listRegistryEntries func() []RegistryEntry

	mu      sync.Mutex
	offsets map[string]int64
}

// NewKiroTurnCollector 构造 Kiro 增量回合采集器。
func NewKiroTurnCollector(options KiroTurnCollectorOptions) *KiroTurnCollector {
	return &KiroTurnCollector{
		aiHomeDir:           strings.TrimSpace(options.AIHomeDir),
		hostHomeDir:         strings.TrimSpace(options.HostHomeDir),
		listRegistryEntries: options.ListRegistryEntries,
		offsets:             make(map[string]int64),
	}
}

type kiroTurnLine struct {
	ID        string `json:"id"`
	Timestamp any    `json:"timestamp"`
	Payload   struct {
		Type   string `json:"type"`
		Status string `json:"status"`
	} `json:"payload"`
}

// Collect 扫描 Kiro 会话流并产出新增的回合结果；同文件存在未归属观察时不推进该文件偏移。
func (c *KiroTurnCollector) Collect(context.Context) []OutcomeObservation {
	if c.aiHomeDir == "" || c.hostHomeDir == "" {
		return nil
	}
	files := DiscoverKiroSessionFiles(c.hostHomeDir)
	if len(files) == 0 {
		return nil
	}
	var preloaded []RegistryEntry
	if c.listRegistryEntries != nil {
		preloaded = c.listRegistryEntries()
		if preloaded == nil {
			preloaded = []RegistryEntry{}
		}
	}
	ownership := NewRegistryScopeOwnership("kiro", c.aiHomeDir, preloaded)

	c.mu.Lock()
	defer c.mu.Unlock()

	var observations []OutcomeObservation
	for _, filePath := range files {
		info, err := os.Stat(filePath)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		size := info.Size()
		from := c.offsets[filePath]
		if from > size {
			from = 0
		}
		if from >= size {
			continue
		}
		meta := ReadKiroSessionMeta(filePath)
		var fileObs []OutcomeObservation
		readRes := ReadJSONLFromOffset(filePath, from, func(line string, lineOffset int64) {
			var parsed kiroTurnLine
			if json.Unmarshal([]byte(line), &parsed) != nil {
				return
			}
			if parsed.Payload.Type != "usage_summary" {
				return
			}
			id := strings.TrimSpace(parsed.ID)
			if id == "" {
				id = fmt.Sprintf("offset:%d", lineOffset)
			}
			atMS := parseTimestampMS(parsed.Timestamp)
			status := strings.TrimSpace(parsed.Payload.Status)
			outcome := ClassifyKiroTurnStatus(status)
			var accountRef string
			if outcome != "" {
				accountRef, _ = ownership.Resolve(meta.Cwd, 0, atMS)
			}
			fileObs = append(fileObs, OutcomeObservation{
				Key:        "kiro:turn:" + id,
				Marker:     status,
				Outcome:    outcome,
				AtMS:       atMS,
				AccountRef: strings.TrimSpace(accountRef),
			})
		})
		observations = append(observations, fileObs...)
		blocked := false
		for _, obs := range fileObs {
			if obs.Outcome != "" && obs.AccountRef == "" {
				blocked = true
				break
			}
		}
		if !blocked {
			c.offsets[filePath] = readRes.EffectiveOffset()
		}
	}
	return observations
}

// KiroPollerOptions 配置 Kiro 回合结果轮询器。
type KiroPollerOptions struct {
	AIHomeDir           string
	HostHomeDir         string
	StoreKey            string
	Interval            time.Duration
	RecordOutcome       OutcomeRecordFunc
	ReadCursor          OutcomeCursorReadFunc
	WriteCursor         OutcomeCursorWriteFunc
	ListRegistryEntries func() []RegistryEntry
	Now                 func() time.Time
}

// NewKiroSessionOutcomePoller 构造 Kiro 原生会话结果轮询器。
func NewKiroSessionOutcomePoller(options KiroPollerOptions) *OutcomePoller {
	storeKey := strings.TrimSpace(options.StoreKey)
	if storeKey == "" {
		storeKey = KiroOutcomeStoreKey
	}
	collector := NewKiroTurnCollector(KiroTurnCollectorOptions{
		AIHomeDir:           options.AIHomeDir,
		HostHomeDir:         options.HostHomeDir,
		ListRegistryEntries: options.ListRegistryEntries,
	})
	return NewOutcomePoller(OutcomePollerOptions{
		AIHomeDir:     options.AIHomeDir,
		StoreKey:      storeKey,
		Interval:      options.Interval,
		RecordOutcome: options.RecordOutcome,
		ReadCursor:    options.ReadCursor,
		WriteCursor:   options.WriteCursor,
		Now:           options.Now,
		Collect:       collector.Collect,
	})
}

var _ = io.EOF
