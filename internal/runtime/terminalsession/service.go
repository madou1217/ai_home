// Package terminalsession 在 pty 之上提供可复用的交互式终端会话服务。
//
// 语义对齐 Node 侧 lib/server/webui-terminal-routes.js：
//   - 按 sessionKey 复用同一会话，重复 open 返回 reused；
//   - 输出进入有上限的回放缓冲，重连时先回放再接实时输出；
//   - resize 会夹取到 2..500 列、1..200 行，重复尺寸不重复下发；
//   - 空闲会话按 lastActivity 回收，持久会话与仍有订阅者的会话不回收；
//   - kill 会终止 PTY、关闭全部订阅并移除会话。
//
// 传输层（SSE 分帧、base64、mux 聚合、16ms 输出批处理、HTTP 路由）不在此包内；
// 本包只负责宿主进程与回放状态。
package terminalsession

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

var (
	ErrInvalidSpec     = errors.New("terminal session spec invalid")
	ErrSessionNotFound = errors.New("terminal session not found")
	ErrTooManySessions = errors.New("too many terminal sessions")
	ErrSessionExited   = errors.New("terminal session exited")
	ErrServiceClosed   = errors.New("terminal session service closed")
)

const (
	DefaultMaxSessions    = 24
	DefaultMaxBufferBytes = 256 * 1024
	DefaultIdleTimeout    = 30 * time.Minute
	DefaultExitRetention  = 30 * time.Second
	DefaultQueueSize      = 256

	defaultReadBufferSize = 32 * 1024
	minCols               = 2
	maxCols               = 500
	minRows               = 1
	maxRows               = 200
	sessionKeyMaxLength   = 192
)

// Status 是会话进程状态；kill 后会话直接移出服务，不会停留在 killed。
type Status string

const (
	StatusRunning Status = "running"
	StatusExited  Status = "exited"
)

// FrameType 是订阅帧类型，对应 Node SSE 的 output / exit。
type FrameType string

const (
	FrameOutput FrameType = "output"
	FrameExit   FrameType = "exit"
)

// Spec 是创建会话的输入。Key 与 Node 的 sessionKey 同义；Durable 表示
// 底层是 tmux 等外层客户端，回放时需要剥掉过期的终端能力查询。
type Spec struct {
	Key        string
	Path       string
	Args       []string
	Env        []string
	Dir        string
	Size       pty.Size
	Durable    bool
	Persistent bool
}

// Snapshot 是会话的只读投影，字段对应 Node open/attach 的返回。
type Snapshot struct {
	ID         string
	Key        string
	Path       string
	Dir        string
	Cols       uint16
	Rows       uint16
	Durable    bool
	Persistent bool
	Status     Status
	ExitCode   int
	CreatedAt  time.Time
	UpdatedAt  time.Time
	FinishedAt time.Time
	Reused     bool
}

// Frame 是订阅者收到的一帧；Data 仅 output 帧有值。
type Frame struct {
	Type     FrameType
	Data     []byte
	ExitCode int
	Reason   string
}

// Subscription 持有回放帧与后续实时帧。C 关闭表示会话结束或订阅被摘除。
type Subscription struct {
	C <-chan Frame

	frames    chan Frame
	service   *Service
	sessionID string
	closed    bool
	once      sync.Once
}

// Close 取消订阅；对已结束的会话可安全重复调用。
func (subscription *Subscription) Close() {
	if subscription == nil || subscription.service == nil {
		return
	}
	subscription.once.Do(func() { subscription.service.removeSubscription(subscription) })
}

// Options 是服务级限制；零值使用 Node 默认值，负的 IdleTimeout /
// ExitRetention 表示关闭对应回收策略。
type Options struct {
	MaxSessions    int
	MaxBufferBytes int
	IdleTimeout    time.Duration
	ExitRetention  time.Duration
	Now            func() time.Time
	ReadBufferSize int
}

// Service 管理单个进程内的全部终端会话。
type Service struct {
	starter pty.Starter
	options Options

	mu       sync.Mutex
	sessions map[string]*session
	closed   bool
}

type session struct {
	id         string
	key        string
	terminal   pty.Session
	path       string
	dir        string
	cols       uint16
	rows       uint16
	durable    bool
	persistent bool
	status     Status
	exitCode   int

	createdAt    time.Time
	lastActivity time.Time
	finishedAt   time.Time

	chunks      [][]byte
	bufferBytes int
	subs        map[*Subscription]struct{}
	writeMu     sync.Mutex
}

// NewService 创建会话服务；starter 通常为 pty.NewStarter()。
func NewService(starter pty.Starter, options Options) *Service {
	return &Service{
		starter:  starter,
		options:  options.withDefaults(),
		sessions: make(map[string]*session),
	}
}

func (options Options) withDefaults() Options {
	if options.MaxSessions <= 0 {
		options.MaxSessions = DefaultMaxSessions
	}
	if options.MaxBufferBytes <= 0 {
		options.MaxBufferBytes = DefaultMaxBufferBytes
	}
	if options.IdleTimeout == 0 {
		options.IdleTimeout = DefaultIdleTimeout
	}
	if options.ExitRetention == 0 {
		options.ExitRetention = DefaultExitRetention
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.ReadBufferSize <= 0 {
		options.ReadBufferSize = defaultReadBufferSize
	}
	return options
}

// Create 启动一个会话；同 Key 的存活会话直接复用。
func (service *Service) Create(ctx context.Context, spec Spec) (Snapshot, error) {
	if service == nil || service.starter == nil || strings.TrimSpace(spec.Path) == "" {
		return Snapshot{}, ErrInvalidSpec
	}
	service.Reap()

	service.mu.Lock()
	defer service.mu.Unlock()
	if service.closed {
		return Snapshot{}, ErrServiceClosed
	}

	key := normalizeSessionKey(spec.Key)
	if key != "" {
		if existing := service.byKeyLocked(key); existing != nil {
			if existing.status == StatusRunning {
				existing.lastActivity = service.options.Now()
				return snapshotOf(existing, true), nil
			}
			// 已退出的同 key 会话不再参与复用，直接让位给新会话。
			delete(service.sessions, existing.id)
		}
	}
	if len(service.sessions) >= service.options.MaxSessions {
		return Snapshot{}, ErrTooManySessions
	}

	size := normalizeCreateSize(spec.Size)
	dir := resolveDirectory(spec.Dir)
	startContext := context.Background()
	if ctx != nil {
		// 会话生命周期由服务管理；请求 ctx 取消不能连带杀掉长期终端。
		startContext = context.WithoutCancel(ctx)
	}
	terminal, err := service.starter.Start(startContext, pty.Spec{
		Path: strings.TrimSpace(spec.Path),
		Args: append([]string(nil), spec.Args...),
		Env:  terminalEnvironment(spec.Env),
		Dir:  dir,
		Size: size,
	})
	if err != nil {
		return Snapshot{}, err
	}
	id, err := newSessionID()
	if err != nil {
		_ = terminal.Close()
		return Snapshot{}, err
	}

	now := service.options.Now()
	created := &session{
		id:           id,
		key:          key,
		terminal:     terminal,
		path:         strings.TrimSpace(spec.Path),
		dir:          dir,
		cols:         size.Cols,
		rows:         size.Rows,
		durable:      spec.Durable,
		persistent:   spec.Persistent,
		status:       StatusRunning,
		createdAt:    now,
		lastActivity: now,
		subs:         make(map[*Subscription]struct{}),
	}
	service.sessions[id] = created
	go service.pump(created)
	return snapshotOf(created, false), nil
}

// Attach 按 termId 或 sessionKey 取回存活会话的元数据；已退出会话按 Node 语义返回未找到。
func (service *Service) Attach(ref string) (Snapshot, error) {
	if service == nil {
		return Snapshot{}, ErrSessionNotFound
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	found := service.resolveLocked(ref)
	if found == nil || found.status != StatusRunning {
		return Snapshot{}, ErrSessionNotFound
	}
	found.lastActivity = service.options.Now()
	return snapshotOf(found, false), nil
}

// Write 串行写入 PTY；并发调用按整次 Write 原子排序，避免输入交错。
func (service *Service) Write(ref string, payload []byte) error {
	if service == nil {
		return ErrSessionNotFound
	}
	if len(payload) == 0 {
		return nil
	}
	service.mu.Lock()
	found := service.resolveLocked(ref)
	if found == nil {
		service.mu.Unlock()
		return ErrSessionNotFound
	}
	if found.status != StatusRunning {
		service.mu.Unlock()
		return ErrSessionExited
	}
	found.lastActivity = service.options.Now()
	found.writeMu.Lock()
	terminal := found.terminal
	service.mu.Unlock()
	defer found.writeMu.Unlock()
	_, err := terminal.Write(payload)
	return err
}

// Resize 调整 PTY 尺寸；越界值按 Node 路由层规则夹取，失败时保留旧尺寸。
func (service *Service) Resize(ref string, size pty.Size) (Snapshot, error) {
	if service == nil || size.Cols == 0 || size.Rows == 0 {
		return Snapshot{}, ErrInvalidSpec
	}
	size = clampSize(size)

	service.mu.Lock()
	defer service.mu.Unlock()
	found := service.resolveLocked(ref)
	if found == nil {
		return Snapshot{}, ErrSessionNotFound
	}
	if found.status != StatusRunning {
		return Snapshot{}, ErrSessionExited
	}
	if found.cols == size.Cols && found.rows == size.Rows {
		found.lastActivity = service.options.Now()
		return snapshotOf(found, false), nil
	}
	if err := found.terminal.Resize(size); err != nil {
		return Snapshot{}, err
	}
	found.cols = size.Cols
	found.rows = size.Rows
	found.lastActivity = service.options.Now()
	return snapshotOf(found, false), nil
}

// Kill 终止会话并摘除全部订阅；对应 Node 的 close。
func (service *Service) Kill(ref string) error {
	return service.terminate(ref, "client_close")
}

// Subscribe 先回放当前缓冲，再持续接收实时输出与退出帧。
// queue 是每个订阅者的帧缓冲；慢消费者会被摘除，不能反压 PTY 读取。
func (service *Service) Subscribe(ref string, queue int) (*Subscription, error) {
	if service == nil {
		return nil, ErrSessionNotFound
	}
	if queue <= 0 {
		queue = DefaultQueueSize
	}
	if queue < 2 {
		// 至少容纳「回放 + 退出」两帧，避免持有服务锁时阻塞。
		queue = 2
	}

	service.mu.Lock()
	defer service.mu.Unlock()
	found := service.resolveLocked(ref)
	if found == nil {
		return nil, ErrSessionNotFound
	}

	frames := make(chan Frame, queue)
	subscription := &Subscription{
		C:         frames,
		frames:    frames,
		service:   service,
		sessionID: found.id,
	}
	if found.bufferBytes > 0 {
		frames <- Frame{Type: FrameOutput, Data: service.replayLocked(found)}
	}
	if found.status == StatusExited {
		frames <- Frame{Type: FrameExit, ExitCode: found.exitCode, Reason: "exit"}
		subscription.closed = true
		close(frames)
		return subscription, nil
	}
	found.subs[subscription] = struct{}{}
	found.lastActivity = service.options.Now()
	return subscription, nil
}

// List 返回当前全部会话（含等待回收的已退出会话），按创建时间升序。
func (service *Service) List() []Snapshot {
	if service == nil {
		return nil
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	result := make([]Snapshot, 0, len(service.sessions))
	for _, found := range service.sessions {
		result = append(result, snapshotOf(found, false))
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].CreatedAt.Before(result[right].CreatedAt)
	})
	return result
}

// Reap 回收空闲会话与超过保留期的已退出会话，返回被移除的 termId。
func (service *Service) Reap() []string {
	if service == nil {
		return nil
	}
	now := service.options.Now()
	removed := make([]string, 0)

	service.mu.Lock()
	for id, found := range service.sessions {
		if found.status == StatusExited {
			if service.options.ExitRetention >= 0 && now.Sub(found.finishedAt) >= service.options.ExitRetention {
				delete(service.sessions, id)
				removed = append(removed, id)
			}
			continue
		}
		if found.persistent || len(found.subs) > 0 {
			continue
		}
		if service.options.IdleTimeout <= 0 {
			continue
		}
		if now.Sub(found.lastActivity) >= service.options.IdleTimeout {
			removed = append(removed, id)
		}
	}
	service.mu.Unlock()

	for _, id := range removed {
		_ = service.terminate(id, "idle_timeout")
	}
	return removed
}

// Close 让 Service 满足 io.Closer：宿主停机时统一走 Shutdown。
func (service *Service) Close() error {
	service.Shutdown()
	return nil
}

// Shutdown 关闭服务并终止所有会话；之后 Create 返回 ErrServiceClosed。
func (service *Service) Shutdown() {
	if service == nil {
		return
	}
	service.mu.Lock()
	service.closed = true
	ids := make([]string, 0, len(service.sessions))
	for id := range service.sessions {
		ids = append(ids, id)
	}
	service.mu.Unlock()
	for _, id := range ids {
		_ = service.terminate(id, "server_close")
	}
}

func (service *Service) pump(found *session) {
	buffer := make([]byte, service.options.ReadBufferSize)
	for {
		read, err := found.terminal.Read(buffer)
		if read > 0 {
			chunk := append([]byte(nil), buffer[:read]...)
			service.mu.Lock()
			if found.status == StatusRunning {
				found.lastActivity = service.options.Now()
				service.appendOutputLocked(found, chunk)
				service.broadcastLocked(found, Frame{Type: FrameOutput, Data: chunk})
			}
			service.mu.Unlock()
		}
		if err != nil {
			break
		}
	}
	waitErr := found.terminal.Wait()
	service.finish(found, exitCodeOf(waitErr))
}

func (service *Service) finish(found *session, code int) {
	service.mu.Lock()
	if found.status == StatusRunning {
		found.status = StatusExited
		found.exitCode = code
		found.finishedAt = service.options.Now()
		found.lastActivity = found.finishedAt
		service.broadcastExitLocked(found, Frame{Type: FrameExit, ExitCode: code, Reason: "exit"})
	}
	service.mu.Unlock()
	_ = found.terminal.Close()
}

func (service *Service) terminate(ref string, reason string) error {
	if service == nil {
		return ErrSessionNotFound
	}
	service.mu.Lock()
	found := service.resolveLocked(ref)
	if found == nil {
		service.mu.Unlock()
		return ErrSessionNotFound
	}
	delete(service.sessions, found.id)
	exitCode := found.exitCode
	if found.status == StatusRunning {
		found.status = StatusExited
		found.exitCode = -1
		exitCode = -1
		found.finishedAt = service.options.Now()
		found.lastActivity = found.finishedAt
	}
	service.broadcastExitLocked(found, Frame{Type: FrameExit, ExitCode: exitCode, Reason: reason})
	service.mu.Unlock()

	if killer, ok := found.terminal.(interface{ Kill() error }); ok {
		_ = killer.Kill()
	}
	_ = found.terminal.Close()
	return nil
}

func (service *Service) appendOutputLocked(found *session, chunk []byte) {
	found.chunks = append(found.chunks, chunk)
	found.bufferBytes += len(chunk)
	for found.bufferBytes > service.options.MaxBufferBytes && len(found.chunks) > 1 {
		dropped := found.chunks[0]
		found.chunks = found.chunks[1:]
		found.bufferBytes -= len(dropped)
	}
}

func (service *Service) replayLocked(found *session) []byte {
	joined := make([]byte, 0, found.bufferBytes)
	for _, chunk := range found.chunks {
		joined = append(joined, chunk...)
	}
	return ReplayOutput(found.durable, joined)
}

func (service *Service) broadcastLocked(found *session, frame Frame) {
	for subscription := range found.subs {
		if subscription.closed {
			delete(found.subs, subscription)
			continue
		}
		select {
		case subscription.frames <- frame:
		default:
			// 与 Node 的写失败即摘除 watcher 一致：慢订阅者不能反压 PTY。
			subscription.closed = true
			close(subscription.frames)
			delete(found.subs, subscription)
		}
	}
}

func (service *Service) broadcastExitLocked(found *session, frame Frame) {
	for subscription := range found.subs {
		if !subscription.closed {
			select {
			case subscription.frames <- frame:
			default:
			}
			subscription.closed = true
			close(subscription.frames)
		}
		delete(found.subs, subscription)
	}
}

func (service *Service) removeSubscription(subscription *Subscription) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if found := service.sessions[subscription.sessionID]; found != nil {
		delete(found.subs, subscription)
	}
	if !subscription.closed {
		subscription.closed = true
		close(subscription.frames)
	}
}

func (service *Service) resolveLocked(ref string) *session {
	value := strings.TrimSpace(ref)
	if value == "" {
		return nil
	}
	if found, ok := service.sessions[value]; ok {
		return found
	}
	for _, found := range service.sessions {
		if found.key != "" && found.key == value {
			return found
		}
	}
	return nil
}

func (service *Service) byKeyLocked(key string) *session {
	if key == "" {
		return nil
	}
	for _, found := range service.sessions {
		if found.key == key {
			return found
		}
	}
	return nil
}

func snapshotOf(found *session, reused bool) Snapshot {
	return Snapshot{
		ID:         found.id,
		Key:        found.key,
		Path:       found.path,
		Dir:        found.dir,
		Cols:       found.cols,
		Rows:       found.rows,
		Durable:    found.durable,
		Persistent: found.persistent,
		Status:     found.status,
		ExitCode:   found.exitCode,
		CreatedAt:  found.createdAt,
		UpdatedAt:  found.lastActivity,
		FinishedAt: found.finishedAt,
		Reused:     reused,
	}
}

func normalizeSessionKey(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > sessionKeyMaxLength || strings.ContainsAny(value, "\x00\r\n") {
		return ""
	}
	return value
}

func normalizeCreateSize(size pty.Size) pty.Size {
	cols := int(size.Cols)
	rows := int(size.Rows)
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	return clampSize(pty.Size{Rows: uint16(clamp(rows, minRows, maxRows)), Cols: uint16(clamp(cols, minCols, maxCols))})
}

func clampSize(size pty.Size) pty.Size {
	return pty.Size{
		Rows: uint16(clamp(int(size.Rows), minRows, maxRows)),
		Cols: uint16(clamp(int(size.Cols), minCols, maxCols)),
	}
}

func clamp(value int, minimum int, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func resolveDirectory(requested string) string {
	if candidate := strings.TrimSpace(requested); candidate != "" {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return ""
}

// terminalEnvironment 与 Node 的 buildTerminalEnv 对齐：继承宿主环境，
// TERM 默认强制 xterm-256color（WebUI 终端不继承宿主 tmux/ssh 的 TERM），
// 但 Spec.Env 显式给了 TERM 时以调用方为准。
func terminalEnvironment(provided []string) []string {
	environment := append([]string(nil), os.Environ()...)
	indexes := make(map[string]int, len(environment))
	for index, entry := range environment {
		if separator := strings.IndexByte(entry, '='); separator > 0 {
			indexes[entry[:separator]] = index
		}
	}
	if index, ok := indexes["TERM"]; ok {
		environment[index] = "TERM=xterm-256color"
	} else {
		indexes["TERM"] = len(environment)
		environment = append(environment, "TERM=xterm-256color")
	}
	for _, entry := range provided {
		separator := strings.IndexByte(entry, '=')
		if separator <= 0 {
			environment = append(environment, entry)
			continue
		}
		name := entry[:separator]
		if index, ok := indexes[name]; ok {
			environment[index] = entry
			continue
		}
		indexes[name] = len(environment)
		environment = append(environment, entry)
	}
	return environment
}

func newSessionID() (string, error) {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	var withExitCode interface{ ExitCode() int }
	if errors.As(err, &withExitCode) {
		return withExitCode.ExitCode()
	}
	return -1
}
