package webuiprojectsapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// WatchPath 是项目级运行态 SSE 的管理契约路径。
	//
	//	Node: GET /v0/webui/projects/watch
	WatchPath = Path + "/watch"
	// SnapshotPath 让前端请求一次强制重建并广播最新快照。
	//
	//	Node: POST /v0/webui/projects/watch/snapshot
	SnapshotPath = WatchPath + "/snapshot"

	// DefaultWatchHeartbeat 与 Node PROJECTS_WATCH_HEARTBEAT_MS 一致。
	DefaultWatchHeartbeat = 30 * time.Second
	// watchDebounce 合并同一批文件事件；事件驱动，不是轮询。
	watchDebounce = 250 * time.Millisecond
	// watchSnapshotCoalesce 与 Node PROJECTS_DIRTY_COALESCE_MS 同口径：
	// 持续写会话文件时把整表重建合并到至多每 2s 一次。
	watchSnapshotCoalesce = 2 * time.Second
	// watchRuntimeStaleAfter 与 Node PROJECT_RUNTIME_STALE_MS 一致：
	// 超过这个时间没有生命周期事件的 working/waiting 不再算运行中。
	watchRuntimeStaleAfter = 10 * time.Minute
	// watchMaxTargets 是单次挂载的文件/目录监听上限，避免会话很多时耗尽 fd。
	watchMaxTargets = 4096
	// runtimeStateRelativeDir 是 Node 持久化 Provider hook 回合状态的位置。
	runtimeStateRelativeDir = "run/provider-session-state"
)

// projectWatchKind 区分一次文件事件影响的是项目快照还是运行态。
type projectWatchKind int

const (
	projectWatchKindProjects projectWatchKind = iota
	projectWatchKindRuntime
)

// projectWatchEvent 是事件源产出的最小事实：谁变了，不在这里解析内容。
type projectWatchEvent struct {
	kind projectWatchKind
	path string
}

// projectWatchSource 是「真实事件源」的端口。
//
// 生产实现是 fsnotify（macOS kqueue / Linux inotify）；测试注入假实现，
// 从而不依赖真实文件系统时序。Add/Remove 允许事件目标随项目目录增长而调整。
type projectWatchSource interface {
	Add(kind projectWatchKind, path string) error
	Remove(path string)
	Events() <-chan projectWatchEvent
	Close() error
}

// idleProjectWatchSource 在 fsnotify 不可用时保底：没有事件，但 SSE 仍能建立，
// 显式 snapshot 请求仍然生效。缺事件源不能被伪装成「没有变化」以外的结论。
type idleProjectWatchSource struct {
	events chan projectWatchEvent
	once   sync.Once
}

func newIdleProjectWatchSource() *idleProjectWatchSource {
	return &idleProjectWatchSource{events: make(chan projectWatchEvent)}
}

func (source *idleProjectWatchSource) Add(projectWatchKind, string) error { return nil }
func (source *idleProjectWatchSource) Remove(string)                      {}
func (source *idleProjectWatchSource) Events() <-chan projectWatchEvent   { return source.events }
func (source *idleProjectWatchSource) Close() error {
	source.once.Do(func() { close(source.events) })
	return nil
}

// projectWatchSubscriber 是一路 SSE 的投递队列。
//
// events 永不关闭：广播与取消可能并发，关闭 channel 会让仍在发送的一方 panic。
// 取消只关闭 done，由读循环退出。
type projectWatchSubscriber struct {
	events chan []byte
	done   chan struct{}
	once   sync.Once
}

func newProjectWatchSubscriber() *projectWatchSubscriber {
	return &projectWatchSubscriber{
		events: make(chan []byte, 16),
		done:   make(chan struct{}),
	}
}

func (subscriber *projectWatchSubscriber) stop() {
	subscriber.once.Do(func() { close(subscriber.done) })
}

// watchSnapshotEvent 与 Node buildProjectsSnapshotEvent 同形。
//
//	{"type":"snapshot","revision":n,"updatedAt":ms,"projects":[...]}
type watchSnapshotEvent struct {
	Type      string        `json:"type"`
	Revision  int64         `json:"revision"`
	UpdatedAt int64         `json:"updatedAt"`
	Projects  []projectView `json:"projects"`
}

// watchRuntimeEvent 与 Node 的 runtime 帧同形。
//
//	{"type":"runtime","runningSessionKeys":["provider:sessionId:projectDirName"]}
type watchRuntimeEvent struct {
	Type               string   `json:"type"`
	RunningSessionKeys []string `json:"runningSessionKeys"`
}

// projectWatchHub 持有 SSE 订阅、最新快照与运行态，并把事件源的变化合并成广播。
type projectWatchHub struct {
	handler   *Handler
	heartbeat time.Duration

	// refreshMu 串行化重建；force POST 与事件触发的重建共享同一把锁。
	refreshMu sync.Mutex

	mu            sync.Mutex
	active        bool
	source        projectWatchSource
	watched       map[string]projectWatchKind
	runtimeParent string
	targetsDirty  bool

	subscribers map[*projectWatchSubscriber]struct{}

	snapshot    []projectView
	hasSnapshot bool
	revision    int64
	updatedAt   int64

	runningKeys      []string
	lastLifecycleAt  int64
	lastSnapshotTime time.Time

	timer         *time.Timer
	snapshotDirty bool
	runtimeDirty  bool
	closed        bool
}

var (
	activeHubsMu sync.Mutex
	activeHubs   = map[string]map[*projectWatchHub]struct{}{}
)

func registerActiveHub(aiHomeDir string, hub *projectWatchHub) {
	key := filepath.Clean(strings.TrimSpace(aiHomeDir))
	if key == "" || key == "." || hub == nil {
		return
	}
	activeHubsMu.Lock()
	defer activeHubsMu.Unlock()
	if activeHubs[key] == nil {
		activeHubs[key] = make(map[*projectWatchHub]struct{})
	}
	activeHubs[key][hub] = struct{}{}
}

func unregisterActiveHub(aiHomeDir string, hub *projectWatchHub) {
	key := filepath.Clean(strings.TrimSpace(aiHomeDir))
	if key == "" || key == "." || hub == nil {
		return
	}
	activeHubsMu.Lock()
	defer activeHubsMu.Unlock()
	group := activeHubs[key]
	if group == nil {
		return
	}
	delete(group, hub)
	if len(group) == 0 {
		delete(activeHubs, key)
	}
}

// NotifyWatchers 触发指定 aiHomeDir 下所有活跃项目监听中心立即重建并广播快照。
func NotifyWatchers(ctx context.Context, aiHomeDir string) bool {
	key := filepath.Clean(strings.TrimSpace(aiHomeDir))
	if key == "" || key == "." {
		return false
	}
	activeHubsMu.Lock()
	group := activeHubs[key]
	hubs := make([]*projectWatchHub, 0, len(group))
	for hub := range group {
		hubs = append(hubs, hub)
	}
	activeHubsMu.Unlock()

	broadcasted := false
	for _, hub := range hubs {
		if hub.subscriberCount() > 0 {
			hub.refresh(ctx, true)
			if hub.broadcastSnapshot() {
				broadcasted = true
			}
		}
	}
	return broadcasted
}

// watch 返回本 Handler 唯一的项目事件中心（不启动 watcher）。
func (handler *Handler) watch() *projectWatchHub {
	handler.watchOnce.Do(func() {
		handler.watchHub = newProjectWatchHub(handler, handler.heartbeat)
		registerActiveHub(handler.aiHomeDir, handler.watchHub)
	})
	return handler.watchHub
}

// shutdownWatch 释放事件源；生产进程随 server 退出，测试用它回收 watcher。
func (handler *Handler) shutdownWatch() {
	if handler == nil || handler.watchHub == nil {
		return
	}
	handler.watchHub.shutdown()
}

func newProjectWatchHub(handler *Handler, heartbeat time.Duration) *projectWatchHub {
	if heartbeat <= 0 {
		heartbeat = DefaultWatchHeartbeat
	}
	return &projectWatchHub{
		handler:     handler,
		heartbeat:   heartbeat,
		subscribers: make(map[*projectWatchSubscriber]struct{}),
	}
}

// coalesce 是事件触发的快照重建合并窗口。
func (hub *projectWatchHub) coalesce() time.Duration {
	if hub.handler.watchCoalesce > 0 {
		return hub.handler.watchCoalesce
	}
	return watchSnapshotCoalesce
}

// runtimeStateDir 是 Node 写入回合状态的目录。
func (hub *projectWatchHub) runtimeStateDir() string {
	return filepath.Join(hub.handler.aiHomeDir, filepath.FromSlash(runtimeStateRelativeDir))
}

// start 惰性启动事件源：没有订阅者就不创建 watcher。
func (hub *projectWatchHub) start() {
	hub.mu.Lock()
	if hub.active || hub.closed {
		hub.mu.Unlock()
		return
	}
	hub.active = true
	hub.watched = make(map[string]projectWatchKind)
	factory := hub.handler.watchSourceFactory
	hub.mu.Unlock()

	source := projectWatchSource(nil)
	var err error
	if factory != nil {
		source, err = factory()
	} else {
		source, err = newFsnotifyProjectWatchSource()
	}
	if err != nil || source == nil {
		// watcher 创建失败（fd 用尽、文件系统不支持）时降级为「只在显式请求时重建」；
		// 不能因此让 SSE 建立失败。
		source = newIdleProjectWatchSource()
	}

	hub.mu.Lock()
	if hub.closed || !hub.active {
		hub.mu.Unlock()
		_ = source.Close()
		return
	}
	hub.source = source
	hub.mu.Unlock()

	go hub.consume(source)
	hub.syncTargets()

	hub.mu.Lock()
	hub.snapshotDirty = true
	hub.runtimeDirty = true
	hub.scheduleLocked(0)
	hub.mu.Unlock()
}

// stopIfIdle 在最后一路订阅离开后释放 watcher，避免后台空转。
func (hub *projectWatchHub) stopIfIdle() {
	hub.mu.Lock()
	if !hub.active || len(hub.subscribers) > 0 || hub.closed {
		hub.mu.Unlock()
		return
	}
	hub.active = false
	source := hub.source
	hub.source = nil
	hub.watched = nil
	hub.runtimeParent = ""
	hub.targetsDirty = false
	if hub.timer != nil {
		hub.timer.Stop()
		hub.timer = nil
	}
	hub.mu.Unlock()
	if source != nil {
		_ = source.Close()
	}
}

func (hub *projectWatchHub) consume(source projectWatchSource) {
	for event := range source.Events() {
		hub.handleEvent(event)
	}
}

func (hub *projectWatchHub) handleEvent(event projectWatchEvent) {
	hub.mu.Lock()
	if !hub.active || hub.closed {
		hub.mu.Unlock()
		return
	}
	switch event.kind {
	case projectWatchKindRuntime:
		// runtimeParent 非空表示状态目录还不存在、当前监视的是 run/：确认它出现后
		// 重新对齐目标，下一轮直接监听状态目录。
		if hub.runtimeParent != "" {
			if info, err := os.Stat(hub.runtimeStateDir()); err != nil || !info.IsDir() {
				hub.mu.Unlock()
				return
			}
			hub.targetsDirty = true
		}
		hub.runtimeDirty = true
	default:
		hub.snapshotDirty = true
		hub.targetsDirty = true
	}
	hub.scheduleLocked(watchDebounce)
	hub.mu.Unlock()
}

// scheduleLocked 只安排一次合并重建；已有定时器时不重复排队。
func (hub *projectWatchHub) scheduleLocked(delay time.Duration) {
	if hub.closed || !hub.active || hub.timer != nil {
		return
	}
	if delay < 0 {
		delay = 0
	}
	hub.timer = time.AfterFunc(delay, func() {
		hub.mu.Lock()
		hub.timer = nil
		hub.mu.Unlock()
		hub.refresh(context.Background(), false)
	})
}

func (hub *projectWatchHub) subscribe() *projectWatchSubscriber {
	subscriber := newProjectWatchSubscriber()
	hub.mu.Lock()
	if hub.closed {
		hub.mu.Unlock()
		subscriber.stop()
		return subscriber
	}
	hub.subscribers[subscriber] = struct{}{}
	hub.mu.Unlock()
	// 先登记再启动：启动期间的 stopIfIdle 不会把刚连上的这一路当成空闲。
	hub.start()
	return subscriber
}

func (hub *projectWatchHub) unsubscribe(subscriber *projectWatchSubscriber) {
	hub.mu.Lock()
	delete(hub.subscribers, subscriber)
	hub.mu.Unlock()
	subscriber.stop()
	hub.stopIfIdle()
}

func (hub *projectWatchHub) subscriberCount() int {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	return len(hub.subscribers)
}

// refresh 是唯一的重建入口：先读运行态，再按需重建项目快照。
//
// force=true 供 POST snapshot 使用：跳过节流，且即使内容不变也由调用方决定是否广播。
func (hub *projectWatchHub) refresh(ctx context.Context, force bool) {
	hub.refreshMu.Lock()
	defer hub.refreshMu.Unlock()

	hub.mu.Lock()
	if hub.closed {
		hub.mu.Unlock()
		return
	}
	needSnapshot := hub.snapshotDirty || force
	needRuntime := hub.runtimeDirty || force
	needTargets := hub.targetsDirty
	hub.snapshotDirty = false
	hub.runtimeDirty = false
	hub.targetsDirty = false
	if needSnapshot && !force && !hub.lastSnapshotTime.IsZero() {
		if elapsed := time.Since(hub.lastSnapshotTime); elapsed < hub.coalesce() {
			hub.snapshotDirty = true
			hub.scheduleLocked(hub.coalesce() - elapsed)
			needSnapshot = false
		}
	}
	hub.mu.Unlock()

	if needRuntime {
		keys, lifecycleAt := readProjectRuntimeState(hub.runtimeStateDir(), time.Now())
		hub.mu.Lock()
		changed := !reflect.DeepEqual(hub.runningKeys, keys)
		if changed {
			hub.runningKeys = keys
		}
		if hub.lastLifecycleAt == 0 {
			hub.lastLifecycleAt = lifecycleAt
		} else if lifecycleAt > hub.lastLifecycleAt {
			// 回合开始/结束会改变会话排序与 updatedAt；合并进下一次快照重建。
			hub.lastLifecycleAt = lifecycleAt
			hub.snapshotDirty = true
			hub.scheduleLocked(watchDebounce)
		}
		hub.mu.Unlock()
		if changed {
			hub.broadcastRuntime()
		}
	}

	if needSnapshot {
		scanCtx, cancel := context.WithTimeout(ctx, hub.handler.scanTimeout)
		projects, truncated := hub.handler.collect(scanCtx, aggregateOptions{})
		cancel()

		hub.mu.Lock()
		hub.lastSnapshotTime = time.Now()
		changed := false
		// 扫描被预算/超时截断时不覆盖已有完整快照；首次建立仍使用部分结果。
		if !truncated || !hub.hasSnapshot {
			if !hub.hasSnapshot {
				changed = true
			} else {
				changed = !reflect.DeepEqual(hub.snapshot, projects)
			}
			if changed {
				hub.revision++
				if hub.revision <= 0 {
					hub.revision = 1
				}
				hub.updatedAt = time.Now().UnixMilli()
				hub.snapshot = projects
				hub.hasSnapshot = true
			}
		}
		hub.mu.Unlock()

		if changed {
			hub.broadcastSnapshot()
		}
		needTargets = true
	}

	if needTargets {
		hub.syncTargets()
	}
}

// syncTargets 把事件目标对齐到当前真实存在的扫描根。
//
// 只增删差异项：持续重建时不会反复关闭/打开同一个 watcher。
func (hub *projectWatchHub) syncTargets() {
	targets := hub.handler.collectWatchTargets()

	hub.mu.Lock()
	source := hub.source
	if source == nil || !hub.active || hub.closed {
		hub.mu.Unlock()
		return
	}
	toRemove := make([]string, 0)
	for path := range hub.watched {
		if _, keep := targets[path]; !keep {
			toRemove = append(toRemove, path)
		}
	}
	toAdd := make(map[string]projectWatchKind)
	for path, kind := range targets {
		if _, exists := hub.watched[path]; !exists {
			toAdd[path] = kind
		}
	}
	hub.runtimeParent = ""
	for path, kind := range targets {
		if kind == projectWatchKindRuntime && strings.HasSuffix(path, string(filepath.Separator)+"run") {
			hub.runtimeParent = path
		}
	}
	hub.mu.Unlock()

	for _, path := range toRemove {
		source.Remove(path)
		hub.mu.Lock()
		delete(hub.watched, path)
		hub.mu.Unlock()
	}
	for path, kind := range toAdd {
		if source.Add(kind, path) != nil {
			continue
		}
		hub.mu.Lock()
		if hub.watched != nil {
			hub.watched[path] = kind
		}
		hub.mu.Unlock()
	}
}

func (hub *projectWatchHub) snapshotFrame() []byte {
	hub.mu.Lock()
	if !hub.hasSnapshot {
		hub.mu.Unlock()
		return nil
	}
	event := watchSnapshotEvent{
		Type:      "snapshot",
		Revision:  hub.revision,
		UpdatedAt: hub.updatedAt,
		Projects:  hub.snapshot,
	}
	hub.mu.Unlock()
	payload, err := json.Marshal(event)
	if err != nil {
		return nil
	}
	return payload
}

func (hub *projectWatchHub) runtimeFrame() []byte {
	hub.mu.Lock()
	keys := append([]string{}, hub.runningKeys...)
	hub.mu.Unlock()
	payload, err := json.Marshal(watchRuntimeEvent{Type: "runtime", RunningSessionKeys: keys})
	if err != nil {
		return nil
	}
	return payload
}

// broadcast 永不阻塞事件循环：慢订阅者积压满队列就断开，浏览器会自行重连。
func (hub *projectWatchHub) broadcast(payload []byte) bool {
	hub.mu.Lock()
	if hub.closed || len(hub.subscribers) == 0 {
		hub.mu.Unlock()
		return false
	}
	targets := make([]*projectWatchSubscriber, 0, len(hub.subscribers))
	for subscriber := range hub.subscribers {
		targets = append(targets, subscriber)
	}
	hub.mu.Unlock()

	delivered := false
	for _, subscriber := range targets {
		select {
		case <-subscriber.done:
			continue
		case subscriber.events <- payload:
			delivered = true
		default:
			// 队列满：断开这一路，避免拖慢整个 hub。
			hub.unsubscribe(subscriber)
		}
	}
	return delivered
}

func (hub *projectWatchHub) broadcastSnapshot() bool {
	payload := hub.snapshotFrame()
	if payload == nil {
		return false
	}
	return hub.broadcast(payload)
}

func (hub *projectWatchHub) broadcastRuntime() bool {
	return hub.broadcast(hub.runtimeFrame())
}

func (hub *projectWatchHub) shutdown() {
	if hub != nil && hub.handler != nil {
		unregisterActiveHub(hub.handler.aiHomeDir, hub)
	}
	hub.mu.Lock()
	if hub.closed {
		hub.mu.Unlock()
		return
	}
	hub.closed = true
	hub.active = false
	source := hub.source
	hub.source = nil
	if hub.timer != nil {
		hub.timer.Stop()
		hub.timer = nil
	}
	subscribers := make([]*projectWatchSubscriber, 0, len(hub.subscribers))
	for subscriber := range hub.subscribers {
		subscribers = append(subscribers, subscriber)
	}
	hub.subscribers = make(map[*projectWatchSubscriber]struct{})
	hub.mu.Unlock()
	if source != nil {
		_ = source.Close()
	}
	for _, subscriber := range subscribers {
		subscriber.stop()
	}
}

// collectWatchTargets 收集真实存在的监听目标。
//
// 目录监听负责结构变化（新项目/新会话文件/新账号投影）；数据库文件与 -wal
// 监听负责 SQLite 写入。会话 JSONL 的纯追加不改目录项，由 Provider hook 写入的
// run/provider-session-state 事件驱动刷新，不额外轮询文件 mtime。
func (handler *Handler) collectWatchTargets() map[string]projectWatchKind {
	targets := make(map[string]projectWatchKind, 256)
	add := func(kind projectWatchKind, path string) {
		if len(targets) >= watchMaxTargets {
			return
		}
		cleaned := filepath.Clean(strings.TrimSpace(path))
		if cleaned == "" || cleaned == "." {
			return
		}
		info, err := os.Lstat(cleaned)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return
		}
		if _, exists := targets[cleaned]; !exists {
			targets[cleaned] = kind
		}
	}
	addTree := func(kind projectWatchKind, root string, maxDepth int) {
		var walk func(string, int)
		walk = func(dir string, depth int) {
			if len(targets) >= watchMaxTargets {
				return
			}
			add(kind, dir)
			if depth >= maxDepth {
				return
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				return
			}
			for _, entry := range entries {
				if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
					continue
				}
				walk(filepath.Join(dir, entry.Name()), depth+1)
			}
		}
		walk(root, 0)
	}
	addDatabase := func(path string) {
		add(projectWatchKindProjects, path)
		add(projectWatchKindProjects, path+"-wal")
	}
	addGlob := func(pattern string) {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			return
		}
		for _, match := range matches {
			addDatabase(match)
		}
	}

	hostHome := handler.hostHomeDir
	add(projectWatchKindProjects, hostHome)

	claudeDir := filepath.Join(hostHome, ".claude")
	add(projectWatchKindProjects, claudeDir)
	add(projectWatchKindProjects, filepath.Join(claudeDir, "history.jsonl"))
	claudeProjects := filepath.Join(claudeDir, "projects")
	addTree(projectWatchKindProjects, claudeProjects, 1)

	codexDir := filepath.Join(hostHome, ".codex")
	add(projectWatchKindProjects, codexDir)
	add(projectWatchKindProjects, filepath.Join(codexDir, "config.toml"))
	add(projectWatchKindProjects, filepath.Join(codexDir, ".codex-global-state.json"))
	add(projectWatchKindProjects, filepath.Join(codexDir, "session_index.jsonl"))
	addTree(projectWatchKindProjects, filepath.Join(codexDir, "sessions"), 3)
	addTree(projectWatchKindProjects, filepath.Join(codexDir, "sqlite"), 0)
	addGlob(filepath.Join(codexDir, "state_*.sqlite"))
	addGlob(filepath.Join(codexDir, "sqlite", "state_*.sqlite"))

	geminiDir := filepath.Join(hostHome, ".gemini")
	add(projectWatchKindProjects, geminiDir)
	add(projectWatchKindProjects, filepath.Join(geminiDir, "trustedFolders.json"))
	add(projectWatchKindProjects, filepath.Join(geminiDir, "projects.json"))
	addTree(projectWatchKindProjects, filepath.Join(geminiDir, "tmp"), 3)
	addTree(projectWatchKindProjects, filepath.Join(geminiDir, "history"), 2)

	opencodeDir := filepath.Join(hostHome, ".local", "share", "opencode")
	add(projectWatchKindProjects, opencodeDir)
	addDatabase(filepath.Join(opencodeDir, "opencode.db"))

	clineDir := filepath.Join(hostHome, ".cline")
	add(projectWatchKindProjects, clineDir)
	add(projectWatchKindProjects, filepath.Join(clineDir, "data"))
	add(projectWatchKindProjects, filepath.Join(clineDir, "data", "db"))
	addTree(projectWatchKindProjects, filepath.Join(clineDir, "data", "sessions"), 1)
	addDatabase(filepath.Join(clineDir, "data", "db", "sessions.db"))

	for _, dirName := range []string{".codebuddy", ".codebuddy-cn", ".workbuddy-ai", ".workbuddy"} {
		configDir := filepath.Join(hostHome, dirName)
		add(projectWatchKindProjects, configDir)
		addTree(projectWatchKindProjects, filepath.Join(configDir, "projects"), 1)
		addDatabase(filepath.Join(configDir, "workbuddy.db"))
	}

	// 账号投影型 Provider：变化来自 auth-projections 下新账号目录或各自的会话库。
	if handler.aiHomeDir != "" {
		clineRoot := filepath.Join(handler.aiHomeDir, "run", "auth-projections", "cline")
		add(projectWatchKindProjects, clineRoot)
		if entries, err := os.ReadDir(clineRoot); err == nil {
			for _, entry := range entries {
				if !entry.IsDir() {
					continue
				}
				dataDir := filepath.Join(clineRoot, entry.Name(), ".cline", "data")
				add(projectWatchKindProjects, dataDir)
				add(projectWatchKindProjects, filepath.Join(dataDir, "db"))
				addDatabase(filepath.Join(dataDir, "db", "sessions.db"))
			}
		}
	}

	// 监听 app-state.db 变更（手动打开/移除项目、远程工作区增删）。
	if handler.aiHomeDir != "" {
		addDatabase(filepath.Join(handler.aiHomeDir, "app-state.db"))
	}

	// 运行态事件源：Node 的 hook 状态目录。目录尚未创建时先盯住 run/ 发现它。
	runtimeDir := filepath.Join(handler.aiHomeDir, filepath.FromSlash(runtimeStateRelativeDir))
	if info, err := os.Stat(runtimeDir); err == nil && info.IsDir() {
		add(projectWatchKindRuntime, runtimeDir)
	} else {
		add(projectWatchKindRuntime, filepath.Join(handler.aiHomeDir, "run"))
	}
	return targets
}

// runtimeStateFile 只声明本切面需要的字段；其余状态原样忽略。
type runtimeStateFile struct {
	Version int `json:"version"`
	Session struct {
		Provider       string `json:"provider"`
		SessionID      string `json:"sessionId"`
		ProjectPath    string `json:"projectPath"`
		ProjectDirName string `json:"projectDirName"`
	} `json:"session"`
	LastEventAt int64  `json:"lastEventAt"`
	TurnState   string `json:"turnState"`
	LastEvent   struct {
		Type string `json:"type"`
		At   int64  `json:"at"`
	} `json:"lastEvent"`
}

// readProjectRuntimeState 读取全部 hook 状态文件，产出运行中的会话 key。
//
// 运行态 key 与前端 getSessionRunKey 一致：provider:sessionId:projectDirName。
// 只有 working/waiting 且最近 10 分钟有事件才算运行中；否则崩溃残留的 working
// 会让界面永远转圈。
func readProjectRuntimeState(dir string, now time.Time) ([]string, int64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{}, 0
	}
	nowMS := now.UnixMilli()
	seen := make(map[string]bool, len(entries))
	latestLifecycleAt := int64(0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		content, readErr := os.ReadFile(filepath.Join(dir, entry.Name()))
		if readErr != nil {
			continue
		}
		var state runtimeStateFile
		if json.Unmarshal(content, &state) != nil || state.Version != 1 {
			continue
		}
		provider := strings.ToLower(trimSpace(state.Session.Provider))
		sessionID := trimSpace(state.Session.SessionID)
		if provider == "" || sessionID == "" {
			continue
		}
		eventAt := state.LastEventAt
		if state.LastEvent.At > eventAt {
			eventAt = state.LastEvent.At
		}
		if eventAt > latestLifecycleAt && isRuntimeLifecycleEvent(state.LastEvent.Type) {
			latestLifecycleAt = eventAt
		}
		if !isRuntimeActiveTurn(state.TurnState) {
			continue
		}
		if state.LastEventAt <= 0 || nowMS-state.LastEventAt > watchRuntimeStaleAfter.Milliseconds() {
			continue
		}
		key := provider + ":" + sessionID + ":" + trimSpace(state.Session.ProjectDirName)
		seen[key] = true
	}
	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys, latestLifecycleAt
}

func isRuntimeActiveTurn(turnState string) bool {
	switch strings.ToLower(trimSpace(turnState)) {
	case "working", "waiting":
		return true
	default:
		return false
	}
}

func isRuntimeLifecycleEvent(eventType string) bool {
	switch strings.ToLower(trimSpace(eventType)) {
	case "turn-started", "turn-completed", "turn-failed", "turn-interrupted", "session-opened", "session-closed":
		return true
	default:
		return false
	}
}

// serveWatch 是项目级 SSE：connected → 缓存快照 → runtime → 增量帧。
func (handler *Handler) serveWatch(responseWriter http.ResponseWriter, request *http.Request) {
	flusher, ok := responseWriter.(http.Flusher)
	if !ok {
		writeError(responseWriter, http.StatusInternalServerError, "sse_unsupported", "SSE 不可用")
		return
	}
	responseWriter.Header().Set("Content-Type", "text/event-stream")
	responseWriter.Header().Set("Cache-Control", "no-cache")
	responseWriter.Header().Set("Connection", "keep-alive")
	responseWriter.Header().Set("X-Accel-Buffering", "no")
	responseWriter.WriteHeader(http.StatusOK)

	write := func(payload []byte) bool {
		if _, err := fmt.Fprintf(responseWriter, "data: %s\n\n", payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !write([]byte(`{"type":"connected"}`)) {
		return
	}

	hub := handler.watch()
	subscriber := hub.subscribe()
	defer hub.unsubscribe(subscriber)

	if snapshot := hub.snapshotFrame(); snapshot != nil {
		if !write(snapshot) {
			return
		}
	}
	if runtime := hub.runtimeFrame(); runtime != nil {
		if !write(runtime) {
			return
		}
	}

	heartbeat := time.NewTicker(hub.heartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-subscriber.done:
			return
		case payload := <-subscriber.events:
			if !write(payload) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(responseWriter, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// serveSnapshot 对应 Node handleWebUiProjectsSnapshotRequest：
// 强制重建并广播；没有订阅者时不启动 watcher，直接回答 broadcasted=false。
func (handler *Handler) serveSnapshot(responseWriter http.ResponseWriter, request *http.Request) {
	hub := handler.watch()
	broadcasted := false
	if hub.subscriberCount() > 0 {
		hub.refresh(request.Context(), true)
		broadcasted = hub.broadcastSnapshot()
	}
	writeJSON(responseWriter, http.StatusAccepted, struct {
		OK          bool  `json:"ok"`
		Accepted    bool  `json:"accepted"`
		Broadcasted bool  `json:"broadcasted"`
		RequestedAt int64 `json:"requestedAt"`
	}{
		OK:          true,
		Accepted:    true,
		Broadcasted: broadcasted,
		RequestedAt: time.Now().UnixMilli(),
	})
}
