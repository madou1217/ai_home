package sessionactivity

import (
	"context"
	"database/sql"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

const (
	// DefaultSessionPollInterval 是持久 CLI 会话活跃探测的默认周期。
	DefaultSessionPollInterval = 5 * time.Second
	// MinSessionPollInterval 是探测周期下限。
	MinSessionPollInterval = 1 * time.Second
	// MinSessionRuntimeTTL 至少覆盖两个探测周期，防止单次 tmux 忙/超时造成闪断。
	MinSessionRuntimeTTL = 12 * time.Second
	// MinTurnActiveWindow 是 pane 活动视为「仍在跑回合」的最小静默窗口。
	MinTurnActiveWindow = 30 * time.Second
	// ScopesCacheTTL 是已知账号集合缓存有效期。
	ScopesCacheTTL = 30 * time.Second
)

// AccountEnabledFunc 判断指定账号在配置层是否仍启用（status != down）。
type AccountEnabledFunc func(ctx context.Context, provider, accountRef string) bool

// SessionPollerOptions 配置持久 CLI 会话活跃探测轮询器。
type SessionPollerOptions struct {
	AIHomeDir              string
	HostHomeDir            string
	Activity               *AccountActivity
	Catalog                *providers.Catalog
	Tmux                   TmuxRunner
	Interval               time.Duration
	TTL                    time.Duration
	TurnActiveWindow       time.Duration
	ListAccountRefs        func(ctx context.Context) []AccountRefRecord
	ListRegistryEntries    func() []RegistryEntry
	IsAccountEnabled       AccountEnabledFunc
	ResolveHarnessTurnMode func(harnessID string) string
	Probes                 []HarnessProbe
	ProcessAlive           func(pid int) (alive bool, known bool)
	Now                    func() time.Time
}

// SessionActivitySummary 记录单轮探测的可观测统计。
type SessionActivitySummary struct {
	TmuxAvailable        bool           `json:"tmuxAvailable"`
	Scopes               int            `json:"scopes"`
	SkippedDisabled      int            `json:"skippedDisabled"`
	AccountsWithSessions int            `json:"accountsWithSessions"`
	Sessions             int            `json:"sessions"`
	Attached             int            `json:"attached"`
	Marked               int            `json:"marked"`
	TurnActive           int            `json:"turnActive"`
	TurnIdle             int            `json:"turnIdle"`
	TurnSources          map[string]int `json:"turnSources"`
}

// SessionActivityPoller 周期性扫描持久 tmux 会话并结合 harness 探针更新 AccountActivity。
type SessionActivityPoller struct {
	aiHomeDir              string
	hostHomeDir            string
	activity               *AccountActivity
	tmux                   TmuxRunner
	interval               time.Duration
	ttl                    time.Duration
	turnActiveWindow       time.Duration
	listAccountRefs        func(ctx context.Context) []AccountRefRecord
	listRegistryEntries    func() []RegistryEntry
	isAccountEnabled       AccountEnabledFunc
	resolveHarnessTurnMode func(harnessID string) string
	probes                 []HarnessProbe
	processAlive           func(pid int) (alive bool, known bool)
	nowFn                  func() time.Time

	mu            sync.Mutex
	knownScopes   map[string]map[string]struct{}
	knownScopesAt int64

	runMu   sync.Mutex
	running bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// NewSQLiteAccountEnabledChecker 返回只读查询 aih.db accounts.enabled 的默认判定器；
// 数据库或记录缺失时返回 true，与 Node account-session-activity 保持一致。
func NewSQLiteAccountEnabledChecker(aiHomeDir string) AccountEnabledFunc {
	root := strings.TrimSpace(aiHomeDir)
	return func(ctx context.Context, provider, accountRef string) bool {
		if root == "" {
			return true
		}
		ref := strings.TrimSpace(accountRef)
		if ref == "" {
			return true
		}
		aihDBPath := filepath.Join(root, "aih.db")
		info, err := os.Stat(aihDBPath)
		if err != nil || !info.Mode().IsRegular() {
			return true
		}
		db, err := sql.Open("sqlite", "file:"+sqlitefile.Path(aihDBPath)+"?mode=ro&_busy_timeout=5000")
		if err != nil {
			return true
		}
		defer db.Close()
		if ctx == nil {
			ctx = context.Background()
		}
		prov := strings.ToLower(strings.TrimSpace(provider))
		var enabled int
		if prov != "" {
			err = db.QueryRowContext(
				ctx,
				`SELECT enabled FROM accounts WHERE provider_id = ? AND account_ref = ? LIMIT 1`,
				prov, ref,
			).Scan(&enabled)
		} else {
			err = db.QueryRowContext(
				ctx,
				`SELECT enabled FROM accounts WHERE account_ref = ? LIMIT 1`,
				ref,
			).Scan(&enabled)
		}
		if err != nil {
			return true
		}
		return enabled != 0
	}
}

// NewSessionActivityPoller 构造持久会话活跃轮询器。
func NewSessionActivityPoller(options SessionPollerOptions) *SessionActivityPoller {
	aiHomeDir := strings.TrimSpace(options.AIHomeDir)
	hostHomeDir := strings.TrimSpace(options.HostHomeDir)
	interval := options.Interval
	if interval <= 0 {
		interval = DefaultSessionPollInterval
	}
	if interval < MinSessionPollInterval {
		interval = MinSessionPollInterval
	}
	ttl := options.TTL
	if ttl <= 0 {
		ttl = interval * 3
	}
	if ttl < MinSessionRuntimeTTL {
		ttl = MinSessionRuntimeTTL
	}
	turnWindow := options.TurnActiveWindow
	if turnWindow <= 0 {
		turnWindow = maxDuration(MinTurnActiveWindow, interval*2)
	}
	if turnWindow < interval*2 {
		turnWindow = interval * 2
	}

	tmuxRunner := options.Tmux
	if tmuxRunner == nil {
		tmuxRunner = NewOSTmuxRunner()
	}
	listAccountRefs := options.ListAccountRefs
	if listAccountRefs == nil {
		listAccountRefs = func(ctx context.Context) []AccountRefRecord {
			return ListAccountRefsFromStores(ctx, aiHomeDir)
		}
	}
	listRegistryEntries := options.ListRegistryEntries
	if listRegistryEntries == nil {
		listRegistryEntries = func() []RegistryEntry {
			return ListPersistentRegistryEntries(aiHomeDir)
		}
	}
	isAccountEnabled := options.IsAccountEnabled
	if isAccountEnabled == nil {
		isAccountEnabled = NewSQLiteAccountEnabledChecker(aiHomeDir)
	}
	resolveTurnMode := options.ResolveHarnessTurnMode
	if resolveTurnMode == nil {
		catalog := options.Catalog
		resolveTurnMode = func(harnessID string) string {
			if catalog != nil {
				if def, ok := catalog.Get(strings.ToLower(strings.TrimSpace(harnessID))); ok {
					if mode := strings.ToLower(strings.TrimSpace(string(def.SessionSync.Mode))); mode != "" {
						return mode
					}
				}
			}
			return "external"
		}
	}
	probes := options.Probes
	if len(probes) == 0 {
		probes = BuiltinHarnessProbes()
	} else {
		copied := make([]HarnessProbe, len(probes))
		copy(copied, probes)
		probes = copied
	}
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}

	return &SessionActivityPoller{
		aiHomeDir:              aiHomeDir,
		hostHomeDir:            hostHomeDir,
		activity:               options.Activity,
		tmux:                   tmuxRunner,
		interval:               interval,
		ttl:                    ttl,
		turnActiveWindow:       turnWindow,
		listAccountRefs:        listAccountRefs,
		listRegistryEntries:    listRegistryEntries,
		isAccountEnabled:       isAccountEnabled,
		resolveHarnessTurnMode: resolveTurnMode,
		probes:                 probes,
		processAlive:           options.ProcessAlive,
		nowFn:                  nowFn,
	}
}

// Interval 返回配置后的轮询间隔。
func (p *SessionActivityPoller) Interval() time.Duration {
	return p.interval
}

// TTL 返回标记存活时间。
func (p *SessionActivityPoller) TTL() time.Duration {
	return p.ttl
}

// TurnActiveWindow 返回活动认定时间窗。
func (p *SessionActivityPoller) TurnActiveWindow() time.Duration {
	return p.turnActiveWindow
}

type probeScope struct {
	harnessID  string
	accountRef string
}

func (p *SessionActivityPoller) readKnownScopes(ctx context.Context) map[string]map[string]struct{} {
	nowMS := p.nowFn().UnixMilli()
	p.mu.Lock()
	if p.knownScopes != nil && nowMS-p.knownScopesAt < ScopesCacheTTL.Milliseconds() {
		cached := p.knownScopes
		p.mu.Unlock()
		return cached
	}
	p.mu.Unlock()

	scopes := make(map[string]map[string]struct{})
	for _, record := range p.listAccountRefs(ctx) {
		prov := strings.ToLower(strings.TrimSpace(record.Provider))
		ref := strings.TrimSpace(record.AccountRef)
		if prov == "" || ref == "" {
			continue
		}
		set, ok := scopes[prov]
		if !ok {
			set = make(map[string]struct{})
			scopes[prov] = set
		}
		set[ref] = struct{}{}
	}

	p.mu.Lock()
	p.knownScopes = scopes
	p.knownScopesAt = p.nowFn().UnixMilli()
	p.mu.Unlock()
	return scopes
}

func (p *SessionActivityPoller) listScopes(ctx context.Context, entries []RegistryEntry) []probeScope {
	known := p.readKnownScopes(ctx)
	seen := make(map[string]struct{})
	var scopes []probeScope
	for _, entry := range entries {
		prov := strings.ToLower(strings.TrimSpace(entry.Provider))
		ref := strings.TrimSpace(entry.AccountRef)
		if prov == "" || ref == "" || entry.Gateway {
			continue
		}
		if knownRefs, hasProvider := known[prov]; hasProvider {
			if _, ok := knownRefs[ref]; !ok {
				continue
			}
		}
		key := prov + ":" + ref
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		scopes = append(scopes, probeScope{
			harnessID:  prov,
			accountRef: ref,
		})
	}
	return scopes
}

// Tick 执行单轮会话探测并更新 AccountActivity。
func (p *SessionActivityPoller) Tick(ctx context.Context) SessionActivitySummary {
	if ctx == nil {
		ctx = context.Background()
	}
	summary := SessionActivitySummary{
		TurnSources: make(map[string]int),
	}
	if p.aiHomeDir == "" || p.activity == nil {
		return summary
	}

	detect := p.tmux.Detect(ctx)
	summary.TmuxAvailable = detect.Available
	if !detect.Available {
		return summary
	}

	registryEntries := p.listRegistryEntries()
	scopes := p.listScopes(ctx, registryEntries)
	summary.Scopes = len(scopes)
	nowMS := p.nowFn().UnixMilli()
	tickCache := make(map[string]any)

	for _, scope := range scopes {
		if ctx.Err() != nil {
			break
		}
		if !p.isAccountEnabled(ctx, scope.harnessID, scope.accountRef) {
			summary.SkippedDisabled++
			continue
		}
		sessions := p.tmux.ListSessionsForAccount(ctx, detect.Command, scope.harnessID, scope.accountRef, true)
		live := make([]TmuxSession, 0, len(sessions))
		attached := 0
		for _, sess := range sessions {
			if sess.PaneDead {
				continue
			}
			live = append(live, sess)
			if sess.Attached {
				attached++
			}
		}
		if len(live) == 0 {
			continue
		}
		p.activity.MarkRuntime(scope.harnessID, scope.accountRef, len(live), attached, p.ttl)
		summary.AccountsWithSessions++
		summary.Sessions += len(live)
		summary.Attached += attached
		summary.Marked++
		p.applyHarnessTurnSignals(scope, live, registryEntries, nowMS, &summary, tickCache)
	}
	return summary
}

func (p *SessionActivityPoller) applyHarnessTurnSignals(
	scope probeScope,
	live []TmuxSession,
	registryEntries []RegistryEntry,
	nowMS int64,
	summary *SessionActivitySummary,
	tickCache map[string]any,
) {
	turnMode := strings.ToLower(strings.TrimSpace(p.resolveHarnessTurnMode(scope.harnessID)))
	if turnMode == "" {
		turnMode = "external"
	}
	probeCtx := &ProbeContext{
		HarnessID:          scope.harnessID,
		AccountRef:         scope.accountRef,
		Sessions:           live,
		NowMS:              nowMS,
		TurnActiveWindowMS: p.turnActiveWindow.Milliseconds(),
		TurnMode:           turnMode,
		AIHomeDir:          p.aiHomeDir,
		HostHomeDir:        p.hostHomeDir,
		Cache:              tickCache,
		RegistryEntries:    registryEntries,
		ProcessAlive:       p.processAlive,
	}
	var signals []TurnSignal
	for _, probe := range ProbesForHarness(p.probes, scope.harnessID) {
		sig := safeRunProbe(probe, probeCtx)
		if sig == nil || sig.State == TurnUnknown {
			continue
		}
		src := strings.TrimSpace(sig.Source)
		if src == "" {
			src = probe.ID
		}
		signals = append(signals, TurnSignal{
			State:          sig.State,
			Authority:      strings.ToLower(strings.TrimSpace(sig.Authority)),
			Decisive:       sig.Decisive,
			LastActivityAt: maxInt64(0, sig.LastActivityAt),
			Source:         src,
		})
	}
	decision := CombineTurnSignals(signals)
	switch decision.Action {
	case "active":
		p.activity.MarkSessionTurn(scope.harnessID, scope.accountRef, maxDuration(p.turnActiveWindow, p.ttl))
		summary.TurnActive++
		countTurnSource(summary, decision.Source)
	case "idle":
		p.activity.EndSessionTurn(scope.harnessID, scope.accountRef)
		summary.TurnIdle++
		countTurnSource(summary, decision.Source)
	}
}

func safeRunProbe(probe HarnessProbe, ctx *ProbeContext) *TurnSignal {
	if probe.Probe == nil {
		return nil
	}
	return probe.Probe(ctx)
}

func countTurnSource(summary *SessionActivitySummary, source string) {
	key := strings.TrimSpace(source)
	if key == "" {
		key = "unknown"
	}
	summary.TurnSources[key]++
}

// Start 启动持久 CLI 会话周期轮询（先同步探测一轮再进入定时器）。
func (p *SessionActivityPoller) Start(parent context.Context) bool {
	p.runMu.Lock()
	defer p.runMu.Unlock()
	if p.running || p.aiHomeDir == "" || p.activity == nil {
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

// Stop 停止轮询并等待后台协程退出。
func (p *SessionActivityPoller) Stop() bool {
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

func maxDuration(a, b time.Duration) time.Duration {
	if a >= b {
		return a
	}
	return b
}

func maxInt64(a, b int64) int64 {
	if a >= b {
		return a
	}
	return b
}
