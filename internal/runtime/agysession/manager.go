// Package agysession 管理「一条需求一个常驻 AGY 会话」的注册表、持久化与 peer 桥接。
//
// 分层：sessionhost 只管进程与协议；本包管会话身份、状态机、持久化与 peer 收发；
// HTTP/CLI 只是它的传输层。peer 通道名固定为 agy-session，因此
// `aih peer send <会话> "..."` 与 `aih agy session say` 走的是同一套语义。
package agysession

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/agy/sessionhost"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/sshhost"
	"github.com/madou1217/ai_home/internal/runtime/peer"
)

const (
	// StorageKey 是 app_kv 里会话注册表的键。
	StorageKey = "runtime:agy-sessions"
	// PeerChannel 是 agy 会话在 peer 里的通道名。
	PeerChannel = "agy-session"
)

// 会话状态。
const (
	StatusIdle     = "idle"
	StatusRunning  = "running"
	StatusClosed   = "closed"
	StatusError    = "error"
	StatusDetached = "detached"
)

var (
	ErrNotFound     = errors.New("agy_session_not_found")
	ErrInvalidInput = errors.New("agy_session_invalid_input")
)

// Record 是持久化的会话元数据（不含进程句柄）。
type Record struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Goal           string `json:"goal"`
	Model          string `json:"model"`
	Effort         string `json:"effort"`
	ConnectionID   string `json:"connectionId,omitempty"`
	RemoteRoot     string `json:"remoteRoot,omitempty"`
	AccountHome    string `json:"accountHome,omitempty"`
	Binary         string `json:"binary,omitempty"`
	Local          bool   `json:"local,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
	Status         string `json:"status"`
	LastError      string `json:"lastError,omitempty"`
	LastReply      string `json:"lastReply,omitempty"`
	TurnCount      int    `json:"turnCount"`
	// RemoteOffset 是远端 out.ndjson 已消费的字节位置；重启后从这里续接，不丢在途结果。
	RemoteOffset int64 `json:"remoteOffset,omitempty"`
	// Pending* 是已写进远端、尚未拿到结果的一轮；Server 重启后据此接管。
	PendingTurnID int64  `json:"pendingTurnId,omitempty"`
	PendingPrompt string `json:"pendingPrompt,omitempty"`
	PendingPeerID string `json:"pendingPeerId,omitempty"`
	CreatedAt     int64  `json:"createdAt"`
	UpdatedAt     int64  `json:"updatedAt"`
}

// TurnView 是给调用方看的一轮。
type TurnView struct {
	sessionhost.Turn
}

// View 是 List/Get 的返回体。
type View struct {
	Record
	Alive        bool              `json:"alive"`
	Current      *sessionhost.Turn `json:"current,omitempty"`
	PeerTarget   string            `json:"peerTarget"`
	Conversation string            `json:"conversationId,omitempty"`
}

// CreateInput 是开启会话所需的输入。
type CreateInput struct {
	Title        string `json:"title"`
	Goal         string `json:"goal"`
	Model        string `json:"model"`
	Effort       string `json:"effort"`
	ConnectionID string `json:"connectionId"`
	RemoteRoot   string `json:"remoteRoot"`
	AccountHome  string `json:"accountHome"`
	Binary       string `json:"binary"`
	Local        bool   `json:"local"`
}

// Dependencies 是 manager 的外部端口。
type Dependencies struct {
	AIHomeDir     string
	HostHomeDir   string
	DatabasePath  string
	SelfBaseURL   func() string
	ManagementKey func() string
	HTTPClient    *http.Client
}

type session struct {
	record   Record
	proc     *sessionhost.Process
	cancel   context.CancelFunc
	turnPeer map[int64]string
}

// Manager 是一组常驻会话。
type Manager struct {
	deps Dependencies

	mu       sync.Mutex
	sessions map[string]*session
	loaded   bool
}

// New 创建管理器；会话在首次访问时从 app_kv 恢复。
func New(deps Dependencies) *Manager {
	return &Manager{deps: deps, sessions: map[string]*session{}}
}

// Create 开启一个会话，并把 Goal 作为第一轮发给 agy。
func (manager *Manager) Create(ctx context.Context, input CreateInput) (View, error) {
	if err := manager.load(); err != nil {
		return View{}, err
	}
	record, err := manager.buildRecord(input)
	if err != nil {
		return View{}, err
	}
	proc, err := manager.startProcess(ctx, record)
	if err != nil {
		return View{}, err
	}
	sess := &session{record: record, proc: proc, turnPeer: map[int64]string{}}
	sess.cancel = manager.attach(ctx, sess)

	manager.mu.Lock()
	manager.sessions[record.ID] = sess
	manager.mu.Unlock()
	manager.persist()

	if strings.TrimSpace(record.Goal) != "" {
		if _, err := manager.Submit(ctx, record.ID, record.Goal, ""); err != nil {
			return manager.viewOf(sess), err
		}
	}
	return manager.viewOf(sess), nil
}

func (manager *Manager) buildRecord(input CreateInput) (Record, error) {
	title := strings.TrimSpace(input.Title)
	goal := strings.TrimSpace(input.Goal)
	model := strings.TrimSpace(input.Model)
	if title == "" {
		title = firstLine(goal)
	}
	if title == "" {
		return Record{}, fmt.Errorf("%w: title 或 goal 至少给一个", ErrInvalidInput)
	}
	if model == "" {
		return Record{}, fmt.Errorf("%w: 必须指定 model", ErrInvalidInput)
	}
	if !input.Local && strings.TrimSpace(input.ConnectionID) == "" {
		return Record{}, fmt.Errorf("%w: 远程会话必须指定 connectionId", ErrInvalidInput)
	}
	if !input.Local && strings.TrimSpace(input.RemoteRoot) == "" {
		return Record{}, fmt.Errorf("%w: 远程会话必须指定 remoteRoot", ErrInvalidInput)
	}
	now := time.Now().UnixMilli()
	record := Record{
		ID:           newSessionID(model, now),
		Title:        title,
		Goal:         goal,
		Model:        model,
		Effort:       strings.TrimSpace(input.Effort),
		ConnectionID: strings.TrimSpace(input.ConnectionID),
		RemoteRoot:   strings.TrimSpace(input.RemoteRoot),
		AccountHome:  strings.TrimSpace(input.AccountHome),
		Binary:       strings.TrimSpace(input.Binary),
		Local:        input.Local,
		Status:       StatusIdle,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	return record, nil
}

func (manager *Manager) startProcess(ctx context.Context, record Record) (*sessionhost.Process, error) {
	spec := sessionhost.Spec{
		SessionID:      record.ID,
		Binary:         record.Binary,
		WorkDir:        record.RemoteRoot,
		HomeDir:        record.AccountHome,
		Model:          record.Model,
		Effort:         record.Effort,
		ConversationID: record.ConversationID,
		ResumeOffset:   record.RemoteOffset,
	}
	if record.Local {
		spec.WorkDir = record.RemoteRoot
		if spec.WorkDir == "" {
			spec.WorkDir = manager.deps.HostHomeDir
		}
	} else {
		transport, err := manager.resolveSSH(record.ConnectionID)
		if err != nil {
			return nil, err
		}
		spec.SSH = transport
	}
	proc := sessionhost.New(spec)
	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := proc.EnsureStarted(startCtx); err != nil {
		return nil, fmt.Errorf("agy_session_start: %w", err)
	}
	return proc, nil
}

func (manager *Manager) resolveSSH(connectionID string) (*sessionhost.SSHTransport, error) {
	raw, found, err := appstate.ReadKV(context.Background(), manager.deps.DatabasePath, "ssh_connections")
	if err != nil {
		return nil, err
	}
	if !found || strings.TrimSpace(raw) == "" {
		return nil, fmt.Errorf("ssh_connections_missing")
	}
	var connections []struct {
		ID           string `json:"id"`
		Label        string `json:"label"`
		Host         string `json:"host"`
		User         string `json:"user"`
		Port         int    `json:"port"`
		IdentityFile string `json:"identityFile"`
		AuthType     string `json:"authType"`
	}
	if err := json.Unmarshal([]byte(raw), &connections); err != nil {
		return nil, err
	}
	for _, connection := range connections {
		// 既接受连接 id，也接受用户在「SSH 开发机」里起的标签（例如 AWS）。
		if connection.ID != connectionID && !strings.EqualFold(strings.TrimSpace(connection.Label), connectionID) {
			continue
		}
		identity := strings.TrimSpace(connection.IdentityFile)
		if identity != "" {
			resolved, err := sshhost.ResolveIdentityFilePath(identity, sshhost.IdentityOptions{
				HomeDir: manager.deps.HostHomeDir, Platform: runtime.GOOS,
			})
			if err != nil {
				return nil, err
			}
			identity = resolved
		}
		return &sessionhost.SSHTransport{
			Host: connection.Host, User: connection.User, Port: connection.Port, IdentityFile: identity,
		}, nil
	}
	return nil, fmt.Errorf("ssh_connection_not_found")
}

// attach 安装事件回调并启动主循环。
func (manager *Manager) attach(ctx context.Context, sess *session) context.CancelFunc {
	_ = ctx
	loopCtx, cancel := context.WithCancel(context.Background())
	sess.proc.SetSink(func(event sessionhost.Event) {
		manager.handleEvent(sess, event)
	})
	go sess.proc.Run(loopCtx)
	return cancel
}

func (manager *Manager) handleEvent(sess *session, event sessionhost.Event) {
	switch event.Kind {
	case "result", "error":
		manager.mu.Lock()
		conversation := sess.proc.ConversationID()
		if conversation != "" {
			sess.record.ConversationID = conversation
		}
		sess.record.TurnCount++
		sess.record.PendingTurnID = 0
		sess.record.PendingPrompt = ""
		sess.record.PendingPeerID = ""
		if offset := sess.proc.RemoteOffset(); offset > 0 {
			sess.record.RemoteOffset = offset
		}
		if event.Kind == "result" {
			sess.record.Status = StatusIdle
			sess.record.LastReply = event.Text
			sess.record.LastError = ""
		} else {
			sess.record.Status = StatusError
			sess.record.LastError = event.Text
		}
		sess.record.UpdatedAt = time.Now().UnixMilli()
		peerID := sess.turnPeer[event.TurnID]
		delete(sess.turnPeer, event.TurnID)
		record := sess.record
		manager.mu.Unlock()

		manager.persist()
		if peerID != "" {
			go manager.replyToPeer(context.Background(), record, peerID, event.Text, event.Kind == "result")
		}
	case "process":
		if event.Status == "exited" {
			manager.mu.Lock()
			if sess.record.Status != StatusClosed {
				sess.record.Status = StatusError
				sess.record.LastError = event.Text
			}
			sess.record.UpdatedAt = time.Now().UnixMilli()
			manager.mu.Unlock()
			manager.persist()
		}
	}
}

// Submit 向会话投递一轮；返回轮次 ID。
func (manager *Manager) Submit(ctx context.Context, id, content, peerMessageID string) (int64, error) {
	if err := manager.load(); err != nil {
		return 0, err
	}
	manager.mu.Lock()
	sess, ok := manager.sessions[id]
	manager.mu.Unlock()
	if !ok {
		return 0, ErrNotFound
	}
	if sess.record.Status == StatusClosed {
		return 0, fmt.Errorf("agy_session_closed")
	}
	ensureCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	err := sess.proc.EnsureStarted(ensureCtx)
	cancel()
	if err != nil {
		return 0, fmt.Errorf("agy_session_restart: %w", err)
	}
	turnID, err := sess.proc.Submit(ctx, content, peerMessageID)
	if err == nil && sess.proc.IsRemote() {
		manager.mu.Lock()
		sess.record.PendingTurnID = turnID
		sess.record.PendingPrompt = content
		sess.record.PendingPeerID = peerMessageID
		manager.mu.Unlock()
	}
	if err != nil {
		// 进程在长轮之间掉线（例如 SSH 255）时重新拉起一次再投递同一轮，
		// 不把用户的追问静默丢掉。
		retryCtx, retryCancel := context.WithTimeout(ctx, 30*time.Second)
		restartErr := sess.proc.EnsureStarted(retryCtx)
		retryCancel()
		if restartErr == nil {
			turnID, err = sess.proc.Submit(ctx, content, peerMessageID)
		}
		if err != nil {
			return 0, err
		}
	}
	manager.mu.Lock()
	if peerMessageID != "" {
		sess.turnPeer[turnID] = peerMessageID
	}
	sess.record.Status = StatusRunning
	sess.record.UpdatedAt = time.Now().UnixMilli()
	manager.mu.Unlock()
	manager.persist()
	return turnID, nil
}

// List 返回全部会话视图。
func (manager *Manager) List() ([]View, error) {
	if err := manager.load(); err != nil {
		return nil, err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	views := make([]View, 0, len(manager.sessions))
	for _, sess := range manager.sessions {
		views = append(views, manager.viewOfLocked(sess))
	}
	sortViews(views)
	return views, nil
}

// Get 返回单个会话视图。
func (manager *Manager) Get(id string) (View, error) {
	if err := manager.load(); err != nil {
		return View{}, err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	sess, ok := manager.sessions[id]
	if !ok {
		return View{}, ErrNotFound
	}
	return manager.viewOfLocked(sess), nil
}

// Events 返回游标之后的增量事件。
func (manager *Manager) Events(id string, after int64) ([]sessionhost.Event, int64, error) {
	if err := manager.load(); err != nil {
		return nil, 0, err
	}
	manager.mu.Lock()
	sess, ok := manager.sessions[id]
	manager.mu.Unlock()
	if !ok {
		return nil, 0, ErrNotFound
	}
	return sess.proc.EventsAfter(after), sess.proc.Cursor(), nil
}

// Close 结束会话进程并保留记录（可随时 Resume）。
func (manager *Manager) Close(id string) (View, error) {
	if err := manager.load(); err != nil {
		return View{}, err
	}
	manager.mu.Lock()
	sess, ok := manager.sessions[id]
	if !ok {
		manager.mu.Unlock()
		return View{}, ErrNotFound
	}
	sess.cancel()
	sess.proc.Close()
	sess.record.Status = StatusClosed
	sess.record.UpdatedAt = time.Now().UnixMilli()
	view := manager.viewOfLocked(sess)
	manager.mu.Unlock()
	manager.persist()
	return view, nil
}

// Resume 用持久化的 conversation 重新拉起进程。
func (manager *Manager) Resume(ctx context.Context, id string) (View, error) {
	if err := manager.load(); err != nil {
		return View{}, err
	}
	manager.mu.Lock()
	sess, ok := manager.sessions[id]
	manager.mu.Unlock()
	if !ok {
		return View{}, ErrNotFound
	}
	if sess.proc.Alive() {
		return manager.Get(id)
	}
	ensureCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	err := sess.proc.EnsureStarted(ensureCtx)
	cancel()
	if err != nil {
		return View{}, err
	}
	manager.mu.Lock()
	sess.record.Status = StatusIdle
	sess.record.LastError = ""
	sess.record.UpdatedAt = time.Now().UnixMilli()
	sess.cancel()
	sess.cancel = manager.attach(ctx, sess)
	view := manager.viewOfLocked(sess)
	manager.mu.Unlock()
	manager.persist()
	return view, nil
}

// PeerTarget 把会话映射为 peer 目标。
func PeerTarget(view View) peer.Target {
	return peer.Target{
		ID: PeerChannel + ":" + view.ID,
		RecordParty: peer.RecordParty{
			Channel: PeerChannel, Provider: "agy", Name: view.Title, Address: view.ID, SessionID: view.ID,
		},
		CWD:    view.RemoteRoot,
		Status: view.Status,
	}
}

// ReplyPeerMessage 把一轮结果回写成 peer 回复并尝试立即投递。
// 投递失败时消息仍留在收件箱，可用 `aih peer flush` 补投。
func (manager *Manager) replyToPeer(ctx context.Context, record Record, peerMessageID, text string, ok bool) {
	if strings.TrimSpace(manager.deps.AIHomeDir) == "" {
		return
	}
	store := peer.NewDispatchStore(manager.deps.AIHomeDir, peer.StoreOptions{})
	original, err := store.Find(peerMessageID)
	if err != nil || original == nil {
		return
	}
	body := strings.TrimSpace(text)
	if !ok {
		body = "AGY 会话执行失败：" + firstNonEmpty(body, record.LastError, "unknown_error")
	}
	if body == "" {
		body = "AGY 会话已完成，但没有可见回复。"
	}
	until := time.Now().Add(time.Hour).UnixMilli()
	reply, err := store.CreateMessageDeduplicated(peer.CreateMessageInput{
		From: peer.RecordParty{
			Channel: PeerChannel, Provider: "agy", Name: record.Title, Address: record.ID, SessionID: record.ID,
		},
		To:               original.From,
		Body:             body,
		Subject:          "[AGY] " + record.Title,
		Summary:          "常驻 agy 会话回复",
		Purpose:          "agy.session.reply",
		Action:           "reply",
		ReplyPolicy:      "optional",
		ReplyTo:          original.ID,
		AutoDeliverUntil: &until,
		FromMode:         "server",
		Priority:         peer.PriorityNormal,
	}, 30*time.Second)
	if err != nil || reply == nil {
		return
	}
	if reply.State != "pending" || reply.NotificationState != "ready" {
		return
	}
	claimed, claimedOK, err := store.Claim(reply.ID)
	if err != nil || !claimedOK {
		return
	}
	options := peer.DeliveryOptions{
		AIHomeDir:     manager.deps.AIHomeDir,
		HostHomeDir:   manager.deps.HostHomeDir,
		Getenv:        os.Getenv,
		HTTPClient:    manager.deps.HTTPClient,
		ServerBaseURL: manager.deps.SelfBaseURL,
		ManagementKey: manager.deps.ManagementKey,
	}
	result := peer.DeliverRecord(ctx, *claimed, options)
	switch {
	case result.OK:
		_, _ = store.SettleDeliveryResult(claimed, result)
	case peer.IsTerminalDeliveryError(result.Error):
		_, _ = store.SettleFailed(claimed, result.Error)
	default:
		_, _ = store.SettlePending(claimed, result.Error, peer.BackoffFor(peer.DeliveryFailureCount(*claimed)+1))
	}
}

func (manager *Manager) viewOf(sess *session) View {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.viewOfLocked(sess)
}

func (manager *Manager) viewOfLocked(sess *session) View {
	view := View{
		Record:       sess.record,
		Alive:        sess.proc.Alive(),
		Current:      sess.proc.CurrentTurn(),
		PeerTarget:   PeerChannel + ":" + sess.record.ID,
		Conversation: sess.record.ConversationID,
	}
	return view
}

// load 从 app_kv 恢复注册表；进程不恢复，标记为 detached 以便显式 resume。
func (manager *Manager) load() error {
	manager.mu.Lock()
	if manager.loaded {
		manager.mu.Unlock()
		return nil
	}
	manager.loaded = true
	manager.mu.Unlock()

	raw, found, err := appstate.ReadKV(context.Background(), manager.deps.DatabasePath, StorageKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return nil
	}
	var records []Record
	if err := json.Unmarshal([]byte(raw), &records); err != nil {
		return nil
	}
	for _, record := range records {
		if record.Status == StatusRunning {
			record.Status = StatusDetached
		}
		sess := &session{record: record, turnPeer: map[int64]string{}}
		spec := sessionhost.Spec{
			SessionID: record.ID, Binary: record.Binary, WorkDir: record.RemoteRoot,
			HomeDir: record.AccountHome, Model: record.Model, Effort: record.Effort,
			ConversationID: record.ConversationID, ResumeOffset: record.RemoteOffset,
		}
		if !record.Local {
			if transport, err := manager.resolveSSH(record.ConnectionID); err == nil {
				spec.SSH = transport
			}
		}
		sess.proc = sessionhost.New(spec)
		// 重启后恢复的会话同样必须装回事件回调与主循环，否则结果回来了也没人更新状态/回执。
		sess.cancel = manager.attach(context.Background(), sess)
		if record.PendingTurnID > 0 && sess.proc.IsRemote() {
			sess.proc.AdoptPendingTurn(record.PendingTurnID, record.PendingPrompt, record.PendingPeerID)
			record.Status = StatusRunning
			// 远端在途回合的结果还在 out.ndjson：重启后立刻接上跟随，不依赖下一次 say。
			proc := sess.proc
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
				defer cancel()
				_ = proc.EnsureStarted(ctx)
			}()
		}
		sess.record = record
		manager.mu.Lock()
		manager.sessions[record.ID] = sess
		manager.mu.Unlock()
	}
	return nil
}

func (manager *Manager) persist() {
	manager.mu.Lock()
	records := make([]Record, 0, len(manager.sessions))
	for _, sess := range manager.sessions {
		records = append(records, sess.record)
	}
	manager.mu.Unlock()
	sortRecords(records)
	body, err := json.Marshal(records)
	if err != nil {
		return
	}
	_ = appstate.WriteKV(context.Background(), manager.deps.DatabasePath, StorageKey, string(body), time.Now().UnixMilli())
}

func newSessionID(model string, now int64) string {
	sum := sha1.Sum([]byte(fmt.Sprintf("%s|%d|%d", model, now, os.Getpid())))
	return "agys-" + hex.EncodeToString(sum[:5])
}

func firstLine(value string) string {
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(value), "\n", 2)[0])
	if len([]rune(line)) > 40 {
		return string([]rune(line)[:40]) + "…"
	}
	return line
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func sortViews(views []View) {
	for i := 1; i < len(views); i++ {
		for j := i; j > 0 && views[j].UpdatedAt > views[j-1].UpdatedAt; j-- {
			views[j], views[j-1] = views[j-1], views[j]
		}
	}
}

func sortRecords(records []Record) {
	for i := 1; i < len(records); i++ {
		for j := i; j > 0 && records[j].CreatedAt > records[j-1].CreatedAt; j-- {
			records[j], records[j-1] = records[j-1], records[j]
		}
	}
}
