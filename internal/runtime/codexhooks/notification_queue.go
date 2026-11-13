package codexhooks

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
)

const (
	// DefaultNotificationQueueFileName 是 Codex 会话通知 JSONL 队列文件名。
	DefaultNotificationQueueFileName = "codex-session-notifications.jsonl"
	// DefaultNotificationMaxBytes 限制队列文件最大尺寸，超出时裁切较早记录。
	DefaultNotificationMaxBytes = 2 * 1024 * 1024
	// DefaultNotificationTrimWatermark 为低水位裁切比例（与 bounded-log-writer.js 一致）。
	DefaultNotificationTrimWatermark = 0.8
	// DefaultNotificationMaxReadBytes 限制单次增量读取的字节上限。
	DefaultNotificationMaxReadBytes = 256 * 1024
	// DefaultNotificationPollInterval 是桥接器默认后台增量扫描周期。
	DefaultNotificationPollInterval = 250 * time.Millisecond
)

// NotificationEvent 表示写入或读取队列的一条规范 Codex 会话通知。
type NotificationEvent struct {
	Provider       string `json:"provider"`
	SessionID      string `json:"sessionId"`
	Type           string `json:"type"`
	Source         string `json:"source"`
	Reason         string `json:"reason"`
	EventName      string `json:"eventName"`
	Phase          string `json:"phase"`
	At             int64  `json:"at"`
	ProjectDirName string `json:"projectDirName,omitempty"`
	ProjectPath    string `json:"projectPath,omitempty"`
	TurnID         string `json:"turnId,omitempty"`
	RunID          string `json:"runId,omitempty"`
}

// NotificationReadResult 返回一次增量读取的事件切片以及新的文件偏移。
type NotificationReadResult struct {
	Offset int64               `json:"offset"`
	Events []NotificationEvent `json:"events"`
}

// ResolveNotificationQueuePath 返回 $AI_HOME/run/codex/codex-session-notifications.jsonl 路径。
func ResolveNotificationQueuePath(aiHomeDir string) string {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return ""
	}
	return filepath.Join(root, "run", "codex", DefaultNotificationQueueFileName)
}

// SanitizeNotificationEvent 验证并规整 Codex 会话通知，非 codex 或缺少 sessionId 时返回 false。
func SanitizeNotificationEvent(raw NotificationEvent, nowFn func() time.Time) (NotificationEvent, bool) {
	provider := strings.ToLower(strings.TrimSpace(raw.Provider))
	sessionID := strings.TrimSpace(raw.SessionID)
	if provider != "codex" || sessionID == "" {
		return NotificationEvent{}, false
	}
	eventType := strings.TrimSpace(raw.Type)
	if eventType == "" {
		eventType = "session:updated"
	}
	source := strings.TrimSpace(raw.Source)
	if source == "" {
		source = "unknown"
	}
	at := raw.At
	if at <= 0 {
		if nowFn != nil {
			at = nowFn().UnixMilli()
		} else {
			at = time.Now().UnixMilli()
		}
	}
	return NotificationEvent{
		Provider:       provider,
		SessionID:      sessionID,
		Type:           eventType,
		Source:         source,
		Reason:         strings.TrimSpace(raw.Reason),
		EventName:      strings.TrimSpace(raw.EventName),
		Phase:          strings.TrimSpace(raw.Phase),
		At:             at,
		ProjectDirName: strings.TrimSpace(raw.ProjectDirName),
		ProjectPath:    strings.TrimSpace(raw.ProjectPath),
		TurnID:         strings.TrimSpace(raw.TurnID),
		RunID:          strings.TrimSpace(raw.RunID),
	}, true
}

// NotificationQueue 管理受限大小、按日归档、带并发互斥的 JSONL 会话通知队列。
type NotificationQueue struct {
	filePath string
	maxBytes int64
	keepDays int
	now      func() time.Time

	mu sync.Mutex
}

// NotificationQueueOptions 配置 NotificationQueue。
type NotificationQueueOptions struct {
	AIHomeDir string
	QueueFile string
	MaxBytes  int64
	KeepDays  int
	Now       func() time.Time
}

// NewNotificationQueue 创建 Codex 会话通知队列实例。
func NewNotificationQueue(opts NotificationQueueOptions) *NotificationQueue {
	filePath := strings.TrimSpace(opts.QueueFile)
	if filePath == "" {
		filePath = ResolveNotificationQueuePath(opts.AIHomeDir)
	}
	maxBytes := opts.MaxBytes
	if maxBytes <= 0 {
		maxBytes = DefaultNotificationMaxBytes
	}
	keepDays := opts.KeepDays
	if keepDays <= 0 {
		keepDays = 7
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &NotificationQueue{
		filePath: filePath,
		maxBytes: maxBytes,
		keepDays: keepDays,
		now:      nowFn,
	}
}

// FilePath 返回队列文件路径。
func (q *NotificationQueue) FilePath() string {
	return q.filePath
}

// Append 将合规的 Codex 会话通知追加到队列文件，必要时先按日归档或按低水位裁切旧内容。
func (q *NotificationQueue) Append(raw NotificationEvent) (bool, [32]byte) {
	var digest [32]byte
	if q == nil || q.filePath == "" {
		return false, digest
	}
	event, ok := SanitizeNotificationEvent(raw, q.now)
	if !ok {
		return false, digest
	}
	serialized, err := json.Marshal(event)
	if err != nil {
		return false, digest
	}
	payload := append(serialized, '\n')
	if int64(len(payload)) > q.maxBytes {
		return false, digest
	}
	digest = sha256.Sum256(serialized)

	q.mu.Lock()
	defer q.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(q.filePath), 0o755); err != nil {
		return false, digest
	}
	if q.rotateByDayLocked() {
		q.pruneDatedLogsLocked()
	}

	if info, err := os.Stat(q.filePath); err == nil {
		if info.Size()+int64(len(payload)) > q.maxBytes {
			lowWatermark := int64(float64(q.maxBytes) * DefaultNotificationTrimWatermark)
			retained := q.maxBytes - int64(len(payload))
			if lowWatermark < retained {
				retained = lowWatermark
			}
			if retained <= 0 {
				_ = os.Truncate(q.filePath, 0)
			} else if !trimQueueFileToRecentBytes(q.filePath, retained) {
				return false, digest
			}
		}
	}

	file, err := os.OpenFile(q.filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return false, digest
	}
	_, writeErr := file.Write(payload)
	closeErr := file.Close()
	_ = os.Chmod(q.filePath, 0o600)
	if errors.Join(writeErr, closeErr) != nil {
		return false, digest
	}
	return true, digest
}

func (q *NotificationQueue) rotateByDayLocked() bool {
	info, err := os.Stat(q.filePath)
	if err != nil || info.Size() == 0 {
		return false
	}
	fileDay := info.ModTime().Format("2006-01-02")
	today := q.now().Format("2006-01-02")
	if fileDay == today {
		return false
	}
	archived := q.filePath + "." + fileDay
	if fileExists(archived) {
		return false
	}
	return os.Rename(q.filePath, archived) == nil
}

func (q *NotificationQueue) pruneDatedLogsLocked() {
	dir := filepath.Dir(q.filePath)
	base := filepath.Base(q.filePath)
	prefix := base + "."
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var dated []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), prefix) {
			dated = append(dated, filepath.Join(dir, entry.Name()))
		}
	}
	if len(dated) <= q.keepDays {
		return
	}
	sort.Strings(dated)
	for _, stale := range dated[:len(dated)-q.keepDays] {
		_ = os.Remove(stale)
	}
}

func trimQueueFileToRecentBytes(filePath string, maxRetain int64) bool {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return false
	}
	if int64(len(data)) <= maxRetain {
		return true
	}
	tail := data[int64(len(data))-maxRetain:]
	if idx := bytes.IndexByte(tail, '\n'); idx >= 0 {
		tail = tail[idx+1:]
	}
	return atomicWriteFile(filePath, tail, 0o600) == nil
}

// ReadSince 从给定字节偏移量起增量读取已落盘的完整通知行。
func (q *NotificationQueue) ReadSince(offset int64, maxReadBytes int) NotificationReadResult {
	if q == nil || q.filePath == "" {
		return NotificationReadResult{Offset: maxInt64(0, offset), Events: []NotificationEvent{}}
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return readNotificationsSinceUnlocked(q.filePath, offset, maxReadBytes, q.now)
}

// ReadNotificationsSince 是无状态便捷读取函数，适合外部代理轮询队列文件。
func ReadNotificationsSince(queueFile string, offset int64, maxReadBytes int) NotificationReadResult {
	return readNotificationsSinceUnlocked(strings.TrimSpace(queueFile), offset, maxReadBytes, time.Now)
}

func readNotificationsSinceUnlocked(
	queueFile string,
	offset int64,
	maxReadBytes int,
	nowFn func() time.Time,
) NotificationReadResult {
	prevOffset := maxInt64(0, offset)
	if queueFile == "" {
		return NotificationReadResult{Offset: prevOffset, Events: []NotificationEvent{}}
	}
	info, err := os.Stat(queueFile)
	if err != nil {
		return NotificationReadResult{Offset: prevOffset, Events: []NotificationEvent{}}
	}
	size := info.Size()
	if size <= 0 {
		return NotificationReadResult{Offset: 0, Events: []NotificationEvent{}}
	}
	start := prevOffset
	if start > size {
		start = 0
	}
	readLimit := int64(maxReadBytes)
	if readLimit < 1024 {
		readLimit = DefaultNotificationMaxReadBytes
	}
	toRead := size - start
	if toRead > readLimit {
		toRead = readLimit
	}
	if toRead <= 0 {
		return NotificationReadResult{Offset: start, Events: []NotificationEvent{}}
	}

	file, err := os.Open(queueFile)
	if err != nil {
		return NotificationReadResult{Offset: start, Events: []NotificationEvent{}}
	}
	defer func() { _ = file.Close() }()
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return NotificationReadResult{Offset: start, Events: []NotificationEvent{}}
	}
	buf := make([]byte, toRead)
	n, err := io.ReadFull(file, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return NotificationReadResult{Offset: start, Events: []NotificationEvent{}}
	}
	chunk := buf[:n]
	// 只消费到最后一个完整换行符为止，避免并发写半行导致丢事件。
	lastNewline := bytes.LastIndexByte(chunk, '\n')
	if lastNewline < 0 {
		// 若单行尚未以 \n 结束但已是完整 JSON 且读到了文件末尾，仍允许消费，否则等待换行完成。
		trimmed := strings.TrimSpace(string(chunk))
		var raw NotificationEvent
		if start+int64(n) == size && trimmed != "" && json.Unmarshal([]byte(trimmed), &raw) == nil {
			if ev, ok := SanitizeNotificationEvent(raw, nowFn); ok {
				return NotificationReadResult{
					Offset: start + int64(n),
					Events: []NotificationEvent{ev},
				}
			}
		}
		return NotificationReadResult{Offset: start, Events: []NotificationEvent{}}
	}

	consumed := lastNewline + 1
	text := string(chunk[:consumed])
	var events []NotificationEvent
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		var parsed rawNotificationLine
		if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
			continue
		}
		ev := parsed.toEvent()
		if sanitized, ok := SanitizeNotificationEvent(ev, nowFn); ok {
			events = append(events, sanitized)
		}
	}
	if events == nil {
		events = []NotificationEvent{}
	}
	return NotificationReadResult{
		Offset: start + int64(consumed),
		Events: events,
	}
}

type rawNotificationLine struct {
	Provider       string `json:"provider"`
	SessionID      string `json:"sessionId"`
	SessionIDSnake string `json:"session_id"`
	Type           string `json:"type"`
	Source         string `json:"source"`
	Reason         string `json:"reason"`
	EventName      string `json:"eventName"`
	EventNameSnake string `json:"event_name"`
	Phase          string `json:"phase"`
	At             int64  `json:"at"`
	ProjectDirName string `json:"projectDirName"`
	ProjectPath    string `json:"projectPath"`
	TurnID         string `json:"turnId"`
	RunID          string `json:"runId"`
}

func (r rawNotificationLine) toEvent() NotificationEvent {
	sid := r.SessionID
	if sid == "" {
		sid = r.SessionIDSnake
	}
	evName := r.EventName
	if evName == "" {
		evName = r.EventNameSnake
	}
	return NotificationEvent{
		Provider:       r.Provider,
		SessionID:      sid,
		Type:           r.Type,
		Source:         r.Source,
		Reason:         r.Reason,
		EventName:      evName,
		Phase:          r.Phase,
		At:             r.At,
		ProjectDirName: r.ProjectDirName,
		ProjectPath:    r.ProjectPath,
		TurnID:         r.TurnID,
		RunID:          r.RunID,
	}
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// NotificationBridgeOptions 配置 Codex 会话通知桥接器。
type NotificationBridgeOptions struct {
	AIHomeDir    string
	QueueFile    string
	MaxBytes     int64
	KeepDays     int
	Bus          *sessionevents.Bus
	PollInterval time.Duration
	StartAtEnd   *bool
	Now          func() time.Time
}

// NotificationBridge 在 Go sessionevents.Bus、外部监听器与持久化 JSONL 队列之间双向安全桥接 Codex 通知。
type NotificationBridge struct {
	queue        *NotificationQueue
	bus          *sessionevents.Bus
	pollInterval time.Duration
	startAtEnd   bool

	mu          sync.Mutex
	offset      int64
	listeners   map[int]func(NotificationEvent)
	nextListID  int
	recentSelf  [][32]byte
	cancel      context.CancelFunc
	done        chan struct{}
	stopOnce    sync.Once
}

// NewNotificationBridge 创建队列桥接器；调用 Start 后将增量监听外部写入的队列事件并广播到 Bus 与监听者。
func NewNotificationBridge(opts NotificationBridgeOptions) *NotificationBridge {
	queue := NewNotificationQueue(NotificationQueueOptions{
		AIHomeDir: opts.AIHomeDir,
		QueueFile: opts.QueueFile,
		MaxBytes:  opts.MaxBytes,
		KeepDays:  opts.KeepDays,
		Now:       opts.Now,
	})
	pollInterval := opts.PollInterval
	if pollInterval <= 0 {
		pollInterval = DefaultNotificationPollInterval
	}
	startAtEnd := true
	if opts.StartAtEnd != nil {
		startAtEnd = *opts.StartAtEnd
	}
	var initialOffset int64
	if startAtEnd && queue.FilePath() != "" {
		if info, err := os.Stat(queue.FilePath()); err == nil {
			initialOffset = info.Size()
		}
	}
	return &NotificationBridge{
		queue:        queue,
		bus:          opts.Bus,
		pollInterval: pollInterval,
		startAtEnd:   startAtEnd,
		offset:       initialOffset,
		listeners:    make(map[int]func(NotificationEvent)),
	}
}

// Queue 返回底层 NotificationQueue。
func (b *NotificationBridge) Queue() *NotificationQueue {
	return b.queue
}

// AddListener 注册一个 Go 侧实时通知消费者，并返回取消函数。
func (b *NotificationBridge) AddListener(fn func(NotificationEvent)) func() {
	if b == nil || fn == nil {
		return func() {}
	}
	b.mu.Lock()
	id := b.nextListID
	b.nextListID++
	b.listeners[id] = fn
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		delete(b.listeners, id)
		b.mu.Unlock()
	}
}

// PublishSessionEvent 将一条 Go 会话事件持久化到队列文件并通知已注册监听者；非 codex 事件会被跳过。
func (b *NotificationBridge) PublishSessionEvent(session sessionevents.Session, ev sessionevents.Event) bool {
	if b == nil {
		return false
	}
	provider := strings.ToLower(strings.TrimSpace(ev.Provider))
	if provider == "" {
		provider = strings.ToLower(strings.TrimSpace(session.Provider))
	}
	sessionID := strings.TrimSpace(ev.SessionID)
	if sessionID == "" {
		sessionID = strings.TrimSpace(session.SessionID)
	}
	projectDir := strings.TrimSpace(ev.ProjectDirName)
	if projectDir == "" {
		projectDir = strings.TrimSpace(session.ProjectDirName)
	}
	projectPath := strings.TrimSpace(ev.ProjectPath)
	if projectPath == "" {
		projectPath = strings.TrimSpace(session.ProjectPath)
	}
	ok, digest := b.queue.Append(NotificationEvent{
		Provider:       provider,
		SessionID:      sessionID,
		Type:           ev.Type,
		Source:         ev.Source,
		Reason:         ev.Reason,
		EventName:      ev.EventName,
		Phase:          ev.Phase,
		At:             ev.At,
		ProjectDirName: projectDir,
		ProjectPath:    projectPath,
		TurnID:         ev.TurnID,
		RunID:          ev.RunID,
	})
	if !ok {
		return false
	}
	b.rememberSelfDigest(digest)
	sanitized, valid := SanitizeNotificationEvent(NotificationEvent{
		Provider:       provider,
		SessionID:      sessionID,
		Type:           ev.Type,
		Source:         ev.Source,
		Reason:         ev.Reason,
		EventName:      ev.EventName,
		Phase:          ev.Phase,
		At:             ev.At,
		ProjectDirName: projectDir,
		ProjectPath:    projectPath,
		TurnID:         ev.TurnID,
		RunID:          ev.RunID,
	}, b.queue.now)
	if valid {
		b.notifyListeners(sanitized)
	}
	return true
}

func (b *NotificationBridge) rememberSelfDigest(digest [32]byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.recentSelf = append(b.recentSelf, digest)
	if len(b.recentSelf) > 256 {
		b.recentSelf = b.recentSelf[len(b.recentSelf)-256:]
	}
}

func (b *NotificationBridge) consumeSelfDigest(ev NotificationEvent) bool {
	serialized, err := json.Marshal(ev)
	if err != nil {
		return false
	}
	digest := sha256.Sum256(serialized)
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, seen := range b.recentSelf {
		if seen == digest {
			b.recentSelf = append(b.recentSelf[:i], b.recentSelf[i+1:]...)
			return true
		}
	}
	return false
}

func (b *NotificationBridge) notifyListeners(ev NotificationEvent) {
	b.mu.Lock()
	cbs := make([]func(NotificationEvent), 0, len(b.listeners))
	for _, cb := range b.listeners {
		cbs = append(cbs, cb)
	}
	b.mu.Unlock()
	for _, cb := range cbs {
		cb(ev)
	}
}

// PollOnce 读取自上次扫描以来由外部（如 stdio 代理）写入的新通知，并派发到 Go Bus 与监听者。
func (b *NotificationBridge) PollOnce() []NotificationEvent {
	if b == nil || b.queue == nil {
		return nil
	}
	b.mu.Lock()
	offset := b.offset
	b.mu.Unlock()

	res := b.queue.ReadSince(offset, DefaultNotificationMaxReadBytes)

	b.mu.Lock()
	if res.Offset != offset {
		b.offset = res.Offset
	}
	b.mu.Unlock()

	var dispatched []NotificationEvent
	for _, ev := range res.Events {
		if b.consumeSelfDigest(ev) {
			continue
		}
		dispatched = append(dispatched, ev)
		if b.bus != nil {
			b.bus.Publish(sessionevents.Session{
				Provider:       ev.Provider,
				SessionID:      ev.SessionID,
				ProjectDirName: ev.ProjectDirName,
				ProjectPath:    ev.ProjectPath,
			}, sessionevents.Event{
				Type:           ev.Type,
				Provider:       ev.Provider,
				SessionID:      ev.SessionID,
				ProjectDirName: ev.ProjectDirName,
				ProjectPath:    ev.ProjectPath,
				Source:         ev.Source,
				Reason:         ev.Reason,
				At:             ev.At,
				EventName:      ev.EventName,
				Phase:          ev.Phase,
				TurnID:         ev.TurnID,
				RunID:          ev.RunID,
			})
		}
		b.notifyListeners(ev)
	}
	return dispatched
}

// Start 启动后台队列增量消费与总线桥接循环；多次调用幂等。
func (b *NotificationBridge) Start(ctx context.Context) {
	if b == nil {
		return
	}
	b.mu.Lock()
	if b.done != nil {
		b.mu.Unlock()
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	loopCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	b.cancel = cancel
	b.done = done
	interval := b.pollInterval
	b.mu.Unlock()

	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-loopCtx.Done():
				return
			case <-ticker.C:
				b.PollOnce()
			}
		}
	}()
}

// Stop 优雅停止后台桥接循环。
func (b *NotificationBridge) Stop() {
	if b == nil {
		return
	}
	b.stopOnce.Do(func() {
		b.mu.Lock()
		cancel := b.cancel
		done := b.done
		b.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if done != nil {
			<-done
		}
	})
}
