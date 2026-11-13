package sessionevents

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

const (
	defaultDebounce          = 500 * time.Millisecond
	subscriberChannelBuffer  = 64
)

// Session 标识需要监听或派发事件的目标会话。
type Session struct {
	Provider       string `json:"provider"`
	SessionID      string `json:"sessionId"`
	ProjectDirName string `json:"projectDirName"`
	ProjectPath    string `json:"projectPath"`
}

// NormalizeSession 清理首尾空白并把 provider 统一为小写。
func NormalizeSession(input Session) Session {
	return Session{
		Provider:       strings.ToLower(strings.TrimSpace(input.Provider)),
		SessionID:      strings.TrimSpace(input.SessionID),
		ProjectDirName: strings.TrimSpace(input.ProjectDirName),
		ProjectPath:    strings.TrimSpace(input.ProjectPath),
	}
}

// IsCompatibleSession 判断两条会话描述是否指向同一个受监听目标。
// 任一方省略 projectDirName 或 projectPath 时按通配处理，与 Node session-event-bus.js 一致。
func IsCompatibleSession(left, right Session) bool {
	a := NormalizeSession(left)
	b := NormalizeSession(right)
	if a.Provider == "" || a.SessionID == "" || b.Provider == "" || b.SessionID == "" {
		return false
	}
	if a.Provider != b.Provider || a.SessionID != b.SessionID {
		return false
	}
	if a.ProjectDirName != "" && b.ProjectDirName != "" && a.ProjectDirName != b.ProjectDirName {
		return false
	}
	if a.ProjectPath != "" && b.ProjectPath != "" && a.ProjectPath != b.ProjectPath {
		return false
	}
	return true
}

// Event 是会话事件总线传播的事件负载。
type Event struct {
	Type           string         `json:"type"`
	Provider       string         `json:"provider"`
	SessionID      string         `json:"sessionId"`
	ProjectDirName string         `json:"projectDirName"`
	ProjectPath    string         `json:"projectPath"`
	Source         string         `json:"source"`
	Reason         string         `json:"reason"`
	At             int64          `json:"at"`
	EventName      string         `json:"eventName,omitempty"`
	Phase          string         `json:"phase,omitempty"`
	TranscriptPath string         `json:"transcriptPath,omitempty"`
	CWD            string         `json:"cwd,omitempty"`
	TurnID         string         `json:"turnId,omitempty"`
	RunID          string         `json:"runId,omitempty"`
	PromptID       string         `json:"promptId,omitempty"`
	Prompt         map[string]any `json:"prompt,omitempty"`
	RetryStatus    *RetryStatus   `json:"retryStatus,omitempty"`
}

// BusStats 暴露当前活跃会话与监听文件计数，用于诊断和测试。
type BusStats struct {
	Sessions     int
	Subscribers  int
	WatchedFiles int
}

// BusOptions 配置会话事件总线。
type BusOptions struct {
	HostHomeDir     string
	AIHomeDir       string
	Debounce        time.Duration
	Now             func() time.Time
	ResolveFilePath func(Session) string
}

type subscriber struct {
	ch   chan Event
	done chan struct{}
	once sync.Once
}

func (sub *subscriber) close() {
	sub.once.Do(func() {
		close(sub.done)
	})
}

type busEntry struct {
	key           string
	session       Session
	subscribers   map[*subscriber]struct{}
	watchPath     string
	watcher       *fsnotify.Watcher
	watchStop     chan struct{}
	watchDone     chan struct{}
	debounceTimer *time.Timer
	stopOnce      sync.Once
}

// Bus 维护按会话聚合的实时订阅与文件变更通知。
type Bus struct {
	mu              sync.Mutex
	entries         map[string]*busEntry
	closed          bool
	hostHomeDir     string
	aiHomeDir       string
	debounce        time.Duration
	now             func() time.Time
	resolveFilePath func(Session) string
}

// NewBus 创建一个线程安全的 Go 会话事件总线。
func NewBus(options BusOptions) *Bus {
	debounce := options.Debounce
	if debounce == 0 {
		debounce = defaultDebounce
	} else if debounce < 0 {
		debounce = 0
	}
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	resolveFn := options.ResolveFilePath
	if resolveFn == nil {
		hostHome := strings.TrimSpace(options.HostHomeDir)
		aiHome := strings.TrimSpace(options.AIHomeDir)
		resolveFn = func(session Session) string {
			return ResolveSessionFilePath(hostHome, aiHome, session.Provider, session.SessionID, session.ProjectDirName)
		}
	}
	return &Bus{
		entries:         make(map[string]*busEntry),
		hostHomeDir:     strings.TrimSpace(options.HostHomeDir),
		aiHomeDir:       strings.TrimSpace(options.AIHomeDir),
		debounce:        debounce,
		now:             nowFn,
		resolveFilePath: resolveFn,
	}
}

// Subscribe 注册会话订阅，并在 watchFile=true 且会话文件存在时启动 fsnotify 监听。
func (bus *Bus) Subscribe(rawSession Session, watchFile bool) (<-chan Event, <-chan struct{}, func()) {
	session := NormalizeSession(rawSession)
	key := sessionBusKey(session)
	if key == "" {
		done := make(chan struct{})
		close(done)
		return nil, done, func() {}
	}

	sub := &subscriber{
		ch:   make(chan Event, subscriberChannelBuffer),
		done: make(chan struct{}),
	}

	bus.mu.Lock()
	if bus.closed {
		bus.mu.Unlock()
		sub.close()
		return nil, sub.done, func() {}
	}
	entry, exists := bus.entries[key]
	if !exists {
		entry = &busEntry{
			key:         key,
			session:     session,
			subscribers: make(map[*subscriber]struct{}),
		}
		bus.entries[key] = entry
	}
	entry.subscribers[sub] = struct{}{}
	needWatch := watchFile && entry.watcher == nil
	bus.mu.Unlock()

	if needWatch {
		bus.startFileWatch(entry)
	}

	unsubscribe := func() {
		sub.close()
		var stopped *busEntry
		bus.mu.Lock()
		if current, ok := bus.entries[key]; ok && current == entry {
			delete(entry.subscribers, sub)
			if len(entry.subscribers) == 0 {
				delete(bus.entries, key)
				stopped = entry
			}
		}
		bus.mu.Unlock()
		if stopped != nil {
			bus.stopEntry(stopped)
		}
	}
	return sub.ch, sub.done, unsubscribe
}

// Publish 把事件广播给所有兼容该会话的订阅者。
func (bus *Bus) Publish(rawSession Session, event Event) bool {
	session := NormalizeSession(rawSession)
	if session.Provider == "" || session.SessionID == "" {
		return false
	}

	type target struct {
		sub     *subscriber
		payload Event
	}

	bus.mu.Lock()
	if bus.closed {
		bus.mu.Unlock()
		return false
	}
	var targets []target
	for _, entry := range bus.entries {
		if !IsCompatibleSession(session, entry.session) {
			continue
		}
		payload := bus.buildPayloadLocked(entry.session, session, event)
		for sub := range entry.subscribers {
			targets = append(targets, target{sub: sub, payload: payload})
		}
	}
	bus.mu.Unlock()

	for _, item := range targets {
		select {
		case <-item.sub.done:
		case item.sub.ch <- item.payload:
		default:
			// 慢消费者队列满时丢弃最旧未读还是跳过：这里不阻塞其他订阅者，也不把锁持有到网络写出。
		}
	}
	return true
}

// Stats 返回当前订阅及文件监听统计。
func (bus *Bus) Stats() BusStats {
	bus.mu.Lock()
	defer bus.mu.Unlock()
	stats := BusStats{Sessions: len(bus.entries)}
	for _, entry := range bus.entries {
		stats.Subscribers += len(entry.subscribers)
		if entry.watcher != nil {
			stats.WatchedFiles++
		}
	}
	return stats
}

// Close 关闭总线及所有活跃的 fsnotify 监听。
func (bus *Bus) Close() {
	bus.mu.Lock()
	if bus.closed {
		bus.mu.Unlock()
		return
	}
	bus.closed = true
	entries := make([]*busEntry, 0, len(bus.entries))
	for key, entry := range bus.entries {
		entries = append(entries, entry)
		for sub := range entry.subscribers {
			sub.close()
		}
		delete(bus.entries, key)
	}
	bus.mu.Unlock()

	for _, entry := range entries {
		bus.stopEntry(entry)
	}
}

func (bus *Bus) buildPayloadLocked(subscriber Session, published Session, event Event) Event {
	eventType := strings.TrimSpace(event.Type)
	if eventType == "" {
		eventType = "session:update"
	}
	projectDirName := strings.TrimSpace(event.ProjectDirName)
	if projectDirName == "" {
		projectDirName = published.ProjectDirName
	}
	if projectDirName == "" {
		projectDirName = subscriber.ProjectDirName
	}
	projectPath := strings.TrimSpace(event.ProjectPath)
	if projectPath == "" {
		projectPath = published.ProjectPath
	}
	if projectPath == "" {
		projectPath = subscriber.ProjectPath
	}
	if projectPath != "" {
		projectPath = CanonicalizePath(projectPath, bus.aiHomeDir, bus.hostHomeDir, subscriber.Provider)
	}
	source := strings.TrimSpace(event.Source)
	if source == "" {
		source = "unknown"
	}
	at := event.At
	if at <= 0 {
		at = bus.now().UnixMilli()
	}

	out := Event{
		Type:           eventType,
		Provider:       subscriber.Provider,
		SessionID:      subscriber.SessionID,
		ProjectDirName: projectDirName,
		ProjectPath:    projectPath,
		Source:         source,
		Reason:         strings.TrimSpace(event.Reason),
		At:             at,
		EventName:      strings.TrimSpace(event.EventName),
		Phase:          strings.TrimSpace(event.Phase),
		TranscriptPath: strings.TrimSpace(event.TranscriptPath),
		CWD:            strings.TrimSpace(event.CWD),
		TurnID:         strings.TrimSpace(event.TurnID),
		RunID:          strings.TrimSpace(event.RunID),
		PromptID:       strings.TrimSpace(event.PromptID),
		Prompt:         cloneMap(event.Prompt),
	}
	if event.RetryStatus != nil {
		copyRetry := *event.RetryStatus
		out.RetryStatus = &copyRetry
	}
	return out
}

func (bus *Bus) startFileWatch(entry *busEntry) {
	watchPath := strings.TrimSpace(bus.resolveFilePath(entry.session))
	if watchPath == "" {
		return
	}
	info, err := os.Stat(watchPath)
	if err != nil || info.IsDir() {
		return
	}
	cleanTarget := filepath.Clean(watchPath)
	parentDir := filepath.Dir(cleanTarget)

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return
	}
	// macOS kqueue 只在对文件本身 Add 时通知追加写，监听父目录则捕捉原子 rename 替换；
	// 两者同时挂载再用目标路径过滤，兼容追加写与原子替换两种转录落盘方式。
	if err := watcher.Add(parentDir); err != nil {
		_ = watcher.Close()
		return
	}
	_ = watcher.Add(cleanTarget)

	watchStop := make(chan struct{})
	watchDone := make(chan struct{})

	bus.mu.Lock()
	if bus.closed || len(entry.subscribers) == 0 || entry.watcher != nil {
		bus.mu.Unlock()
		close(watchDone)
		_ = watcher.Close()
		return
	}
	entry.watchPath = cleanTarget
	entry.watcher = watcher
	entry.watchStop = watchStop
	entry.watchDone = watchDone
	bus.mu.Unlock()

	go bus.watchLoop(entry, cleanTarget, watcher, watchStop, watchDone)
}

func (bus *Bus) watchLoop(
	entry *busEntry,
	targetPath string,
	watcher *fsnotify.Watcher,
	watchStop <-chan struct{},
	watchDone chan struct{},
) {
	defer close(watchDone)
	for {
		select {
		case <-watchStop:
			return
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}
			if event.Op&^fsnotify.Chmod == 0 {
				continue
			}
			if filepath.Clean(event.Name) != targetPath {
				continue
			}
			if event.Op&(fsnotify.Create|fsnotify.Rename) != 0 {
				_ = watcher.Add(targetPath)
			}
			bus.scheduleFileChanged(entry)
		case _, ok := <-watcher.Errors:
			if !ok {
				return
			}
		}
	}
}

func (bus *Bus) scheduleFileChanged(entry *busEntry) {
	bus.mu.Lock()
	if bus.closed || len(entry.subscribers) == 0 {
		bus.mu.Unlock()
		return
	}
	if entry.debounceTimer != nil {
		entry.debounceTimer.Stop()
	}
	debounce := bus.debounce
	entry.debounceTimer = time.AfterFunc(debounce, func() {
		bus.Publish(entry.session, Event{
			Type:   "session:file-changed",
			Source: "watcher",
			Reason: "file_changed",
			Phase:  "file-changed",
		})
	})
	bus.mu.Unlock()
}

func (bus *Bus) stopEntry(entry *busEntry) {
	if entry == nil {
		return
	}
	entry.stopOnce.Do(func() {
		bus.mu.Lock()
		if entry.debounceTimer != nil {
			entry.debounceTimer.Stop()
			entry.debounceTimer = nil
		}
		watcher := entry.watcher
		watchStop := entry.watchStop
		watchDone := entry.watchDone
		entry.watcher = nil
		entry.watchStop = nil
		entry.watchDone = nil
		bus.mu.Unlock()

		if watchStop != nil {
			close(watchStop)
		}
		if watcher != nil {
			_ = watcher.Close()
		}
		if watchDone != nil {
			<-watchDone
		}
	})
}

func sessionBusKey(session Session) string {
	if session.Provider == "" || session.SessionID == "" {
		return ""
	}
	return strings.Join([]string{
		session.Provider,
		session.SessionID,
		session.ProjectDirName,
		session.ProjectPath,
	}, ":")
}

func cloneMap(input map[string]any) map[string]any {
	if len(input) == 0 {
		return nil
	}
	out := make(map[string]any, len(input))
	for key, val := range input {
		out[key] = val
	}
	return out
}
