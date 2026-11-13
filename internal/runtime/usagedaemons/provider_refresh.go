package usagedaemons

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

const (
	// DefaultWatcherDiscoveryInterval 是 CodeBuddy/ZCode 原生数据目录重发现周期（30 秒）。
	DefaultWatcherDiscoveryInterval = 30 * time.Second
)

// DefaultRefreshDelays 对齐 session-usage-refresh.js 的 [250ms, 1s, 3s] 分级重试窗。
var DefaultRefreshDelays = []time.Duration{
	250 * time.Millisecond,
	time.Second,
	3 * time.Second,
}

// ErrScanQueueFull 表示底层异步扫描队列已满的背压信号，驱动状态机沿退避序列重试而不刷错误日志。
var ErrScanQueueFull = errors.New("model_usage_scan_queue_full")

var (
	grokSessionIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	codebuddySessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

	codebuddyConfigDirByProvider = map[string]string{
		"codebuddy":   ".codebuddy",
		"codebuddycn": ".codebuddy-cn",
		"workbuddy":   ".workbuddy-ai",
		"workbuddycn": ".workbuddy",
	}
	codebuddyFamilyProviders = []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"}
	zcodeDatabaseFiles       = map[string]struct{}{
		"db.sqlite":     {},
		"db.sqlite-wal": {},
		"db.sqlite-shm": {},
	}
)

// SessionEvent 描述驱动 provider 用量增量刷新的会话事件或文件变化信号。
type SessionEvent struct {
	Type      string `json:"type"`
	Provider  string `json:"provider"`
	SessionID string `json:"sessionId"`
	Phase     string `json:"phase,omitempty"`
}

// SessionScanRequest 传给 provider 增量扫描端口的参数。
type SessionScanRequest struct {
	Provider       string   `json:"provider"`
	SessionID      string   `json:"sessionId"`
	UsageProviders []string `json:"usageProviders,omitempty"`
}

// ProviderRefreshPort 抽象 Grok / CodeBuddy / ZCode 的增量扫描与账单重算能力。
type ProviderRefreshPort interface {
	ScanGrokSessionUsage(ctx context.Context, sessionID string) (int, error)
	ScanCodebuddySessionUsage(ctx context.Context, provider, sessionID string) (int, error)
	ScanProviderNativeUsage(ctx context.Context, provider string) (int, error)
}

// ProviderRefreshOptions 配置三大 provider 增量用量刷新的监听与退避参数。
type ProviderRefreshOptions struct {
	Enabled           *bool
	HostHomeDir       string
	AIHomeDir         string
	Port              ProviderRefreshPort
	Delays            []time.Duration
	DiscoveryInterval time.Duration
	OnRefreshComplete func(ctx context.Context, req SessionScanRequest, records int) error
	Now               func() time.Time
}

// ProviderRefreshState 暴露三家 provider 用量刷新协调器的运行状态与统计计数。
type ProviderRefreshState struct {
	Running         bool   `json:"running"`
	Enabled         bool   `json:"enabled"`
	PortAvailable   bool   `json:"portAvailable"`
	PendingEntries  int    `json:"pendingEntries"`
	WatchedPaths    int    `json:"watchedPaths"`
	EventsReceived  int64  `json:"eventsReceived"`
	ScansExecuted   int64  `json:"scansExecuted"`
	BackpressureHits int64 `json:"backpressureHits"`
	LastRunAt       int64  `json:"lastRunAt"`
	LastProvider    string `json:"lastProvider,omitempty"`
	LastError       string `json:"lastError,omitempty"`
}

// IsGrokSessionID 检查会话 ID 是否合法。
func IsGrokSessionID(sessionID string) bool {
	return grokSessionIDPattern.MatchString(strings.TrimSpace(sessionID))
}

// IsCodebuddySessionID 检查 CodeBuddy 家族会话 ID 是否合法。
func IsCodebuddySessionID(sessionID string) bool {
	return codebuddySessionIDPattern.MatchString(strings.TrimSpace(sessionID))
}

// IsCodebuddyFamilyProvider 判断 provider 是否属于 CodeBuddy 共享账单家族。
func IsCodebuddyFamilyProvider(provider string) bool {
	_, ok := codebuddyConfigDirByProvider[strings.ToLower(strings.TrimSpace(provider))]
	return ok
}

// SameCodebuddyRegion 判断两个 CodeBuddy 家族成员是否共享同一区域账单（国内 cn / 国际站）。
func SameCodebuddyRegion(left, right string) bool {
	l := strings.ToLower(strings.TrimSpace(left))
	r := strings.ToLower(strings.TrimSpace(right))
	return IsCodebuddyFamilyProvider(l) && IsCodebuddyFamilyProvider(r) &&
		strings.HasSuffix(l, "cn") == strings.HasSuffix(r, "cn")
}

// IsTerminalSessionEvent 判断会话事件是否代表单轮完成/失败或会话关闭。
func IsTerminalSessionEvent(ev SessionEvent) bool {
	switch strings.TrimSpace(ev.Type) {
	case "session:turn-completed", "session:turn-failed", "session:closed":
		return true
	}
	switch strings.TrimSpace(ev.Phase) {
	case "turn-completed", "turn-failed":
		return true
	}
	return false
}

type refreshTarget struct {
	provider       string
	sessionID      string
	usageProviders []string
}

type refreshEntry struct {
	key             string
	target          refreshTarget
	revision        int
	attempt         int
	refreshRequired bool
	timer           *time.Timer
	gen             uint64
}

// ProviderRefreshCoordinator 合并托管 Grok、CodeBuddy 与 ZCode 的事件/文件防抖刷新状态机。
type ProviderRefreshCoordinator struct {
	enabled           bool
	hostHomeDir       string
	aiHomeDir         string
	port              ProviderRefreshPort
	delays            []time.Duration
	discoveryInterval time.Duration
	onComplete        func(context.Context, SessionScanRequest, int) error
	now               func() time.Time

	mu               sync.Mutex
	running          bool
	cancel           context.CancelFunc
	doneCh           chan struct{}
	runCtx           context.Context
	watcher          *fsnotify.Watcher
	watchedPaths     map[string]struct{}
	pending          map[string]*refreshEntry
	nextGen          uint64
	eventsReceived   int64
	scansExecuted    int64
	backpressureHits int64
	lastRunAt        int64
	lastProvider     string
	lastError        string
	scanWG           sync.WaitGroup
}

// NewProviderRefreshCoordinator 创建 Grok / CodeBuddy / ZCode 用量增量刷新协调器。
func NewProviderRefreshCoordinator(opts ProviderRefreshOptions) *ProviderRefreshCoordinator {
	enabled := true
	if opts.Enabled != nil {
		enabled = *opts.Enabled
	}
	delays := append([]time.Duration(nil), opts.Delays...)
	if len(delays) == 0 {
		delays = append([]time.Duration(nil), DefaultRefreshDelays...)
	}
	discovery := opts.DiscoveryInterval
	if discovery <= 0 {
		discovery = DefaultWatcherDiscoveryInterval
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &ProviderRefreshCoordinator{
		enabled:           enabled,
		hostHomeDir:       strings.TrimSpace(opts.HostHomeDir),
		aiHomeDir:         strings.TrimSpace(opts.AIHomeDir),
		port:              opts.Port,
		delays:            delays,
		discoveryInterval: discovery,
		onComplete:        opts.OnRefreshComplete,
		now:               nowFn,
		watchedPaths:      make(map[string]struct{}),
		pending:           make(map[string]*refreshEntry),
	}
}

// Start 幂等启动文件系统监听器、30s 目录再发现定时器与事件刷新调度。
func (c *ProviderRefreshCoordinator) Start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	c.mu.Lock()
	if c.running || !c.enabled || c.port == nil {
		c.mu.Unlock()
		return nil
	}
	watcher, _ := fsnotify.NewWatcher()
	runCtx, cancel := context.WithCancel(ctx)
	doneCh := make(chan struct{})
	c.running = true
	c.cancel = cancel
	c.doneCh = doneCh
	c.runCtx = runCtx
	c.watcher = watcher
	c.mu.Unlock()

	c.discoverRoots()
	go c.loop(runCtx, watcher, doneCh)
	return nil
}

func (c *ProviderRefreshCoordinator) loop(ctx context.Context, watcher *fsnotify.Watcher, doneCh chan struct{}) {
	defer func() {
		if watcher != nil {
			_ = watcher.Close()
		}
		c.scanWG.Wait()
		close(doneCh)
		c.mu.Lock()
		c.running = false
		c.cancel = nil
		c.doneCh = nil
		c.watcher = nil
		c.watchedPaths = make(map[string]struct{})
		for _, entry := range c.pending {
			if entry.timer != nil {
				entry.timer.Stop()
			}
		}
		c.pending = make(map[string]*refreshEntry)
		c.mu.Unlock()
	}()

	ticker := time.NewTicker(c.discoveryInterval)
	defer ticker.Stop()

	var eventsCh <-chan fsnotify.Event
	var errsCh <-chan error
	if watcher != nil {
		eventsCh = watcher.Events
		errsCh = watcher.Errors
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.discoverRoots()
		case err, ok := <-errsCh:
			if !ok {
				errsCh = nil
				continue
			}
			if err != nil {
				c.mu.Lock()
				c.lastError = err.Error()
				c.mu.Unlock()
			}
		case ev, ok := <-eventsCh:
			if !ok {
				eventsCh = nil
				continue
			}
			c.handleFSEvent(ev)
		}
	}
}

func (c *ProviderRefreshCoordinator) discoverRoots() {
	c.mu.Lock()
	if !c.running || c.watcher == nil {
		c.mu.Unlock()
		return
	}
	watcher := c.watcher
	c.mu.Unlock()

	candidates := c.collectWatchPaths()
	for _, p := range candidates {
		c.mu.Lock()
		_, already := c.watchedPaths[p]
		running := c.running
		c.mu.Unlock()
		if !running {
			return
		}
		if already {
			continue
		}
		if err := watcher.Add(p); err == nil {
			c.mu.Lock()
			c.watchedPaths[p] = struct{}{}
			c.mu.Unlock()
		}
	}
}

func (c *ProviderRefreshCoordinator) collectWatchPaths() []string {
	var paths []string
	seen := make(map[string]struct{})
	push := func(p string) {
		info, err := os.Lstat(p)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return
		}
		resolved, err := filepath.EvalSymlinks(p)
		if err != nil {
			resolved = p
		}
		if _, ok := seen[resolved]; ok {
			return
		}
		seen[resolved] = struct{}{}
		paths = append(paths, resolved)
	}

	if c.hostHomeDir != "" {
		// CodeBuddy/WorkBuddy 会话目录及其一级子项目目录
		for _, dirName := range codebuddyConfigDirByProvider {
			projRoot := filepath.Join(c.hostHomeDir, dirName, "projects")
			push(projRoot)
			if entries, err := os.ReadDir(projRoot); err == nil {
				for _, e := range entries {
					if e.IsDir() {
						push(filepath.Join(projRoot, e.Name()))
					}
				}
			}
		}
		// ZCode SQLite DB 及 WAL/SHM 文件
		zcodeDBRoot := filepath.Join(c.hostHomeDir, ".zcode", "cli", "db")
		push(zcodeDBRoot)
		for name := range zcodeDatabaseFiles {
			push(filepath.Join(zcodeDBRoot, name))
		}
	}
	if c.aiHomeDir != "" {
		// ZCode 账号投影下的 ownership 日志
		zcodeProjRoot := filepath.Join(c.aiHomeDir, "run", "auth-projections", "zcode")
		push(zcodeProjRoot)
		if entries, err := os.ReadDir(zcodeProjRoot); err == nil {
			for _, e := range entries {
				if e.IsDir() {
					push(filepath.Join(zcodeProjRoot, e.Name(), ".aih-runtime", "zcode-model-usage-owners.jsonl"))
				}
			}
		}
	}
	return paths
}

func (c *ProviderRefreshCoordinator) handleFSEvent(ev fsnotify.Event) {
	path := ev.Name
	base := filepath.Base(path)
	if base == "zcode-model-usage-owners.jsonl" {
		c.NotifyEvent(SessionEvent{Provider: "zcode", Type: "session:native-billing-changed"})
		return
	}
	if _, ok := zcodeDatabaseFiles[base]; ok && strings.Contains(filepath.ToSlash(path), "/.zcode/cli/db") {
		c.NotifyEvent(SessionEvent{Provider: "zcode", Type: "session:native-billing-changed"})
		if ev.Has(fsnotify.Create) || ev.Has(fsnotify.Rename) {
			c.discoverRoots()
		}
		return
	}
	slashed := filepath.ToSlash(path)
	for prov, dirName := range codebuddyConfigDirByProvider {
		marker := "/" + dirName + "/projects"
		if !strings.Contains(slashed, marker) {
			continue
		}
		if ev.Has(fsnotify.Create) || ev.Has(fsnotify.Rename) {
			if info, err := os.Stat(path); err == nil && info.IsDir() {
				c.discoverRoots()
				if entries, err := os.ReadDir(path); err == nil {
					for _, e := range entries {
						c.notifyCodebuddyFilename(prov, e.Name())
					}
				}
				return
			}
		}
		c.notifyCodebuddyFilename(prov, base)
		return
	}
}

func (c *ProviderRefreshCoordinator) notifyCodebuddyFilename(provider, filename string) {
	if !strings.HasSuffix(filename, ".jsonl") {
		return
	}
	sessionID := strings.TrimSuffix(filename, ".jsonl")
	if !IsCodebuddySessionID(sessionID) {
		return
	}
	c.NotifyEvent(SessionEvent{
		Provider:  provider,
		SessionID: sessionID,
		Type:      "session:file-changed",
	})
}

func resolveRefreshTarget(ev SessionEvent) (refreshTarget, bool) {
	provider := strings.ToLower(strings.TrimSpace(ev.Provider))
	switch {
	case provider == "grok":
		if IsGrokSessionID(ev.SessionID) && IsTerminalSessionEvent(ev) {
			return refreshTarget{
				provider:       "grok",
				sessionID:      strings.TrimSpace(ev.SessionID),
				usageProviders: []string{"grok"},
			}, true
		}
		return refreshTarget{}, false

	case provider == "zcode":
		if ev.Type == "session:native-billing-changed" || IsTerminalSessionEvent(ev) {
			return refreshTarget{
				provider:       "zcode",
				sessionID:      "native-billing",
				usageProviders: []string{"zcode"},
			}, true
		}
		return refreshTarget{}, false

	case IsCodebuddyFamilyProvider(provider):
		writerChanged := ev.Type == "session:native-writer-changed"
		if !writerChanged && !IsCodebuddySessionID(ev.SessionID) {
			return refreshTarget{}, false
		}
		if !writerChanged && !IsTerminalSessionEvent(ev) && ev.Type != "session:file-changed" {
			return refreshTarget{}, false
		}
		canonical := "codebuddy"
		if strings.HasSuffix(provider, "cn") {
			canonical = "codebuddycn"
		}
		var peers []string
		for _, member := range codebuddyFamilyProviders {
			if SameCodebuddyRegion(canonical, member) {
				peers = append(peers, member)
			}
		}
		sid := strings.TrimSpace(ev.SessionID)
		if writerChanged {
			sid = "native-billing"
		}
		return refreshTarget{
			provider:       canonical,
			sessionID:      sid,
			usageProviders: peers,
		}, true
	}
	return refreshTarget{}, false
}

// NotifyEvent 投递一条会话或文件事件到 [250ms, 1s, 3s] 防抖合流状态机。
func (c *ProviderRefreshCoordinator) NotifyEvent(ev SessionEvent) bool {
	target, ok := resolveRefreshTarget(ev)
	if !ok {
		return false
	}

	c.mu.Lock()
	if !c.running || !c.enabled || c.port == nil {
		c.mu.Unlock()
		return false
	}
	c.eventsReceived++
	key := target.provider + ":" + target.sessionID
	if existing, found := c.pending[key]; found {
		existing.revision++
		c.mu.Unlock()
		return true
	}
	c.nextGen++
	entry := &refreshEntry{
		key:    key,
		target: target,
		gen:    c.nextGen,
	}
	c.pending[key] = entry
	c.armEntryLocked(entry)
	c.mu.Unlock()
	return true
}

func (c *ProviderRefreshCoordinator) armEntryLocked(entry *refreshEntry) {
	delay := c.delays[entry.attempt]
	runCtx := c.runCtx
	gen := entry.gen
	key := entry.key
	entry.timer = time.AfterFunc(delay, func() {
		c.executeEntry(runCtx, key, gen)
	})
}

func (c *ProviderRefreshCoordinator) executeEntry(ctx context.Context, key string, gen uint64) {
	c.scanWG.Add(1)
	defer c.scanWG.Done()

	c.mu.Lock()
	if !c.running || c.port == nil || ctx.Err() != nil {
		c.mu.Unlock()
		return
	}
	entry, ok := c.pending[key]
	if !ok || entry.gen != gen {
		c.mu.Unlock()
		return
	}
	entry.timer = nil
	rev := entry.revision
	attempt := entry.attempt
	target := entry.target
	port := c.port
	c.mu.Unlock()

	req := SessionScanRequest{
		Provider:       target.provider,
		SessionID:      target.sessionID,
		UsageProviders: append([]string(nil), target.usageProviders...),
	}
	records, err := c.runPortScan(ctx, port, req)

	if err == nil && c.onComplete != nil {
		_ = c.onComplete(ctx, req, records)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.running || ctx.Err() != nil {
		return
	}
	current, stillThere := c.pending[key]
	if !stillThere || current != entry || current.gen != gen {
		return
	}

	c.lastRunAt = c.now().UnixMilli()
	c.lastProvider = target.provider

	finished := false
	if err != nil {
		if errors.Is(err, ErrScanQueueFull) || strings.Contains(err.Error(), ErrScanQueueFull.Error()) {
			c.backpressureHits++
		} else {
			c.lastError = err.Error()
		}
	} else {
		c.scansExecuted++
		c.lastError = ""
		entry.refreshRequired = entry.refreshRequired || records > 0
		finished = entry.refreshRequired || attempt == len(c.delays)-1
	}

	if rev != entry.revision {
		entry.attempt = 0
		if finished {
			entry.refreshRequired = false
		}
	} else if finished || attempt == len(c.delays)-1 {
		delete(c.pending, key)
		return
	} else {
		entry.attempt++
	}
	c.armEntryLocked(entry)
}

func (c *ProviderRefreshCoordinator) runPortScan(ctx context.Context, port ProviderRefreshPort, req SessionScanRequest) (int, error) {
	switch req.Provider {
	case "grok":
		return port.ScanGrokSessionUsage(ctx, req.SessionID)
	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		if req.SessionID == "native-billing" || req.SessionID == "" {
			return port.ScanProviderNativeUsage(ctx, req.Provider)
		}
		return port.ScanCodebuddySessionUsage(ctx, req.Provider, req.SessionID)
	case "zcode":
		return port.ScanProviderNativeUsage(ctx, "zcode")
	default:
		return 0, nil
	}
}

// Trigger 手动对单个或全部（provider=""|"all"）支持的 provider 执行一次原生账单同步。
func (c *ProviderRefreshCoordinator) Trigger(ctx context.Context, provider string) (int, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if c.port == nil {
		return 0, nil
	}
	target := strings.ToLower(strings.TrimSpace(provider))
	var targets []string
	switch target {
	case "", "all":
		targets = []string{"grok", "codebuddy", "codebuddycn", "zcode"}
	case "grok", "codebuddy", "codebuddycn", "zcode":
		targets = []string{target}
	default:
		targets = []string{target}
	}

	totalRecords := 0
	var lastErr error
	for _, p := range targets {
		n, err := c.port.ScanProviderNativeUsage(ctx, p)
		totalRecords += n
		if err != nil {
			lastErr = err
		} else if c.onComplete != nil {
			_ = c.onComplete(ctx, SessionScanRequest{Provider: p, SessionID: "manual"}, n)
		}
	}

	c.mu.Lock()
	c.scansExecuted++
	c.lastRunAt = c.now().UnixMilli()
	c.lastProvider = target
	if lastErr != nil {
		c.lastError = lastErr.Error()
	} else {
		c.lastError = ""
	}
	c.mu.Unlock()
	return totalRecords, lastErr
}

// State 返回并发安全的 provider 增量刷新运行状态快照。
func (c *ProviderRefreshCoordinator) State() ProviderRefreshState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return ProviderRefreshState{
		Running:          c.running,
		Enabled:          c.enabled,
		PortAvailable:    c.port != nil,
		PendingEntries:   len(c.pending),
		WatchedPaths:     len(c.watchedPaths),
		EventsReceived:   c.eventsReceived,
		ScansExecuted:    c.scansExecuted,
		BackpressureHits: c.backpressureHits,
		LastRunAt:        c.lastRunAt,
		LastProvider:     c.lastProvider,
		LastError:        c.lastError,
	}
}

// Stop 通知监听与延迟状态机停止并等待执行中扫描退出。
func (c *ProviderRefreshCoordinator) Stop() {
	c.mu.Lock()
	cancel := c.cancel
	doneCh := c.doneCh
	c.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if doneCh != nil {
		<-doneCh
	}
}

// Close 实现 io.Closer，安全停机。
func (c *ProviderRefreshCoordinator) Close() error {
	c.Stop()
	return nil
}
