package chatruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

var chatSessionIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// LegacyChatSession 描述旧版 ~/.ai_home/chat-sessions/<id>.json 会话文件结构。
type LegacyChatSession struct {
	ID         string              `json:"id"`
	Title      string              `json:"title"`
	Provider   string              `json:"provider"`
	Model      string              `json:"model"`
	AccountRef string              `json:"accountRef"`
	CreatedAt  int64               `json:"createdAt"`
	UpdatedAt  int64               `json:"updatedAt"`
	Messages   []LegacyChatMessage `json:"messages"`
}

// LegacyChatMessage 描述旧版聊天文件内的单条消息。
type LegacyChatMessage struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	Timestamp int64  `json:"timestamp"`
}

// OpenChatSessionInput 描述打开或新建纯聊天会话的请求。
type OpenChatSessionInput struct {
	ChatSessionID       string
	Provider            string
	ExecutionAccountRef string
	ReadOnly            bool
}

type legacyImportCall struct {
	done    chan struct{}
	session *Session
	err     error
}

// ChatSessionCoordinatorOptions 配置纯聊天会话打开、导入与重绑定协调器。
type ChatSessionCoordinatorOptions struct {
	Store         *PublishingStore
	Actors        *ActorRegistry
	HostHomeDir   string
	CreateSession func(ctx context.Context, input CreateSessionInput) (*Session, error)
}

// ChatSessionCoordinator 管理 chat 模式会话的打开、账号重绑定及 legacy 导入清理。
type ChatSessionCoordinator struct {
	store         *PublishingStore
	actors        *ActorRegistry
	hostHomeDir   string
	createSession func(ctx context.Context, input CreateSessionInput) (*Session, error)

	mu      sync.Mutex
	pending map[string]*legacyImportCall
}

// NewChatSessionCoordinator 构造纯聊天会话协调器。
func NewChatSessionCoordinator(opts ChatSessionCoordinatorOptions) *ChatSessionCoordinator {
	return &ChatSessionCoordinator{
		store:         opts.Store,
		actors:        opts.Actors,
		hostHomeDir:   opts.HostHomeDir,
		createSession: opts.CreateSession,
		pending:       make(map[string]*legacyImportCall),
	}
}

// ResolveExecutionScope 将请求中的 executionAccountRef 收敛到单账号或 gateway 作用域。
func (c *ChatSessionCoordinator) ResolveExecutionScope(accountRef string) string {
	requested := strings.TrimSpace(accountRef)
	if requested != "" && !IsGatewayRuntimeScope(requested) {
		return requested
	}
	return GatewayRuntimeScope
}

// Open 按 chatSessionId 打开（或导入 legacy）既有聊天会话，为空时新建会话。
func (c *ChatSessionCoordinator) Open(ctx context.Context, in OpenChatSessionInput) (*Session, error) {
	id := strings.TrimSpace(in.ChatSessionID)
	if id == "" {
		return c.Create(ctx, in, "", nil)
	}
	if !chatSessionIDPattern.MatchString(id) {
		return nil, NewError("chat_session_id_invalid", 400, nil)
	}
	existing, err := c.store.GetSession(ctx, id)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if in.ReadOnly && IsChatSession(existing) && existing.Provider == in.Provider {
			return existing, nil
		}
		if IsChatSession(existing) && existing.Provider == in.Provider {
			return c.retarget(ctx, existing, in)
		}
		return c.requireOwner(existing, in)
	}

	legacy := ReadLegacyChatSession(id, c.hostHomeDir)
	if legacy == nil {
		return nil, NewError("chat_session_not_found", 404, nil)
	}
	gatewayScope := IsGatewayRuntimeScope(in.ExecutionAccountRef)
	var accountMismatch bool
	if gatewayScope {
		accountMismatch = legacy.AccountRef != "" && !IsGatewayRuntimeScope(legacy.AccountRef)
	} else {
		accountMismatch = legacy.AccountRef != "" && legacy.AccountRef != in.ExecutionAccountRef
	}
	if legacy.Provider != in.Provider || accountMismatch {
		return nil, NewError("chat_session_account_mismatch", 409, nil)
	}

	sum := sha256.Sum256([]byte(id))
	importedID := "chat-import-" + hex.EncodeToString(sum[:])
	imported, err := c.store.GetSession(ctx, importedID)
	if err != nil {
		return nil, err
	}
	if imported != nil {
		return c.requireOwner(imported, in)
	}

	c.mu.Lock()
	if call := c.pending[importedID]; call != nil {
		c.mu.Unlock()
		<-call.done
		if call.err != nil {
			return nil, call.err
		}
		return c.requireOwner(call.session, in)
	}
	call := &legacyImportCall{done: make(chan struct{})}
	c.pending[importedID] = call
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		delete(c.pending, importedID)
		c.mu.Unlock()
		close(call.done)
	}()

	sess, err := c.Create(ctx, in, importedID, legacy)
	call.session = sess
	call.err = err
	return sess, err
}

func (c *ChatSessionCoordinator) requireOwner(sess *Session, in OpenChatSessionInput) (*Session, error) {
	if !IsChatSession(sess) || sess.Provider != in.Provider {
		return nil, NewError("chat_session_account_mismatch", 409, nil)
	}
	if IsGatewayRuntimeScope(sess.ExecutionAccountRef) {
		return sess, nil
	}
	if IsGatewayRuntimeScope(in.ExecutionAccountRef) || sess.ExecutionAccountRef != in.ExecutionAccountRef {
		return nil, NewError("chat_session_account_mismatch", 409, nil)
	}
	return sess, nil
}

func (c *ChatSessionCoordinator) retarget(ctx context.Context, sess *Session, in OpenChatSessionInput) (*Session, error) {
	next := c.ResolveExecutionScope(in.ExecutionAccountRef)
	if next == sess.ExecutionAccountRef {
		return sess, nil
	}
	candidate := *sess
	candidate.ExecutionAccountRef = next
	if err := c.actors.AssertReplaceable(sess.SessionID); err != nil {
		return nil, err
	}
	prepared, err := c.actors.Prepare(ctx, &candidate)
	if err != nil {
		return nil, err
	}
	defer prepared.Dispose()

	if err := c.actors.AssertReplaceable(sess.SessionID); err != nil {
		return nil, err
	}
	caps := EntryCapabilities(prepared.Entry, &candidate)
	if caps == nil {
		caps = sess.CapabilitySnapshot
	}
	updated, err := c.store.UpdateExecutionContext(
		ctx,
		sess.SessionID,
		next,
		RuntimeBindingPatch(&candidate, prepared.Runtime),
		caps,
	)
	if err != nil {
		return nil, err
	}
	if _, err := c.actors.ReplacePrepared(updated, prepared); err != nil {
		return nil, err
	}
	return updated, nil
}

// Create 新建纯聊天会话并（若提供了 legacy 记录）导入其历史对话。
func (c *ChatSessionCoordinator) Create(ctx context.Context, in OpenChatSessionInput, sessionID string, legacy *LegacyChatSession) (*Session, error) {
	if c.createSession == nil {
		return nil, NewError("chat_session_creator_unavailable", 503, nil)
	}
	title := "新对话"
	policy := map[string]any{
		"approvalMode": "confirm",
		"title":        title,
	}
	if legacy != nil {
		if strings.TrimSpace(legacy.Title) != "" {
			policy["title"] = legacy.Title
		}
		policy["legacySessionId"] = legacy.ID
	}
	sess, err := c.createSession(ctx, CreateSessionInput{
		SessionID:           sessionID,
		Provider:            in.Provider,
		ExecutionAccountRef: c.ResolveExecutionScope(in.ExecutionAccountRef),
		ProjectPath:         "",
		Policy:              policy,
	})
	if err != nil {
		return nil, err
	}
	if legacy != nil {
		drafts := LegacyTimelineDrafts(sess, legacy)
		if len(drafts) > 0 {
			if _, err := c.store.ImportTimeline(ctx, sess.SessionID, drafts); err != nil {
				return nil, err
			}
		}
	}
	return sess, nil
}

// CleanupLegacySource 删除 canonical 会话后同步移除其来源 legacy 聊天 JSON 文件（尽力清理）。
func (c *ChatSessionCoordinator) CleanupLegacySource(sess *Session) bool {
	if sess == nil || sess.Policy == nil {
		return false
	}
	legacyID, _ := sess.Policy["legacySessionId"].(string)
	legacyID = strings.TrimSpace(legacyID)
	if legacyID == "" {
		return false
	}
	return DeleteLegacyChatSession(legacyID, c.hostHomeDir)
}

func legacyChatStoreDir(hostHome string) string {
	home := strings.TrimSpace(hostHome)
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".ai_home", "chat-sessions")
}

// ListLegacyChatSessions 列出旧版纯聊天会话文件（按更新时间倒序）。
func ListLegacyChatSessions(hostHome string) []LegacyChatSession {
	dir := legacyChatStoreDir(hostHome)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]LegacyChatSession, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var sess LegacyChatSession
		if err := json.Unmarshal(raw, &sess); err != nil || strings.TrimSpace(sess.ID) == "" {
			continue
		}
		out = append(out, sess)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
	return out
}

// ReadLegacyChatSession 读取单个旧版纯聊天 JSON 文件。
func ReadLegacyChatSession(sessionID, hostHome string) *LegacyChatSession {
	if strings.TrimSpace(sessionID) == "" || !chatSessionIDPattern.MatchString(sessionID) {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(legacyChatStoreDir(hostHome), sessionID+".json"))
	if err != nil {
		return nil
	}
	var sess LegacyChatSession
	if err := json.Unmarshal(raw, &sess); err != nil {
		return nil
	}
	return &sess
}

// DeleteLegacyChatSession 删除单个旧版纯聊天 JSON 文件。
func DeleteLegacyChatSession(sessionID, hostHome string) bool {
	if strings.TrimSpace(sessionID) == "" || !chatSessionIDPattern.MatchString(sessionID) {
		return false
	}
	err := os.Remove(filepath.Join(legacyChatStoreDir(hostHome), sessionID+".json"))
	return err == nil
}

func filterLegacyMessages(legacy *LegacyChatSession) []LegacyChatMessage {
	if legacy == nil {
		return nil
	}
	var out []LegacyChatMessage
	for _, msg := range legacy.Messages {
		if (msg.Role == "user" || msg.Role == "assistant") && msg.Content != "" {
			out = append(out, msg)
		}
	}
	return out
}

// LegacyResponseItems 将旧版聊天消息转换为 Responses API 初始历史条目。
func LegacyResponseItems(legacy *LegacyChatSession) []map[string]any {
	msgs := filterLegacyMessages(legacy)
	out := make([]map[string]any, 0, len(msgs))
	for _, msg := range msgs {
		partType := "input_text"
		if msg.Role == "assistant" {
			partType = "output_text"
		}
		out = append(out, map[string]any{
			"type": "message",
			"role": msg.Role,
			"content": []any{
				map[string]any{"type": partType, "text": msg.Content},
			},
		})
	}
	return out
}

// LegacyTimelineDrafts 生成导入旧版聊天记录的时间线草稿事件列表。
func LegacyTimelineDrafts(sess *Session, legacy *LegacyChatSession) []EventDraft {
	msgs := filterLegacyMessages(legacy)
	out := make([]EventDraft, 0, len(msgs))
	for i, msg := range msgs {
		id := sess.SessionID + "-legacy-" + itoa64(int64(i))
		at := msg.Timestamp
		if at == 0 {
			at = legacy.CreatedAt
		}
		if at == 0 {
			at = sess.CreatedAt
		}
		atCopy := at
		out = append(out, EventDraft{
			EventID: id,
			Type:    "timeline.item.completed",
			At:      &atCopy,
			ItemID:  id,
			Source: EventSource{
				Provider:  sess.Provider,
				RuntimeID: "legacy-chat-import",
			},
			Payload: map[string]any{
				"item": map[string]any{
					"id":        id,
					"kind":      "message",
					"detail":    map[string]any{"role": msg.Role},
					"status":    "completed",
					"content":   msg.Content,
					"createdAt": at,
					"updatedAt": at,
				},
			},
		})
	}
	return out
}

// ChatSessionSummary 将 Canonical Session 投影为 WebUI 聊天列表摘要格式。
func ChatSessionSummary(sess *Session) map[string]any {
	if sess == nil {
		return nil
	}
	title := "新对话"
	if t, _ := sess.Policy["title"].(string); strings.TrimSpace(t) != "" {
		title = t
	}
	model, _ := sess.Policy["model"].(string)
	return map[string]any{
		"id":               sess.SessionID,
		"runtimeSessionId": sess.SessionID,
		"projectPath":      sess.ProjectPath,
		"provider":         sess.Provider,
		"accountRef":       sess.ExecutionAccountRef,
		"title":            title,
		"updatedAt":        sess.UpdatedAt,
		"model":            model,
		"status":           sess.State,
	}
}

// SessionResolutionCoordinatorOptions 配置工作区会话幂等解析/领养协调器。
type SessionResolutionCoordinatorOptions struct {
	Actors      *ActorRegistry
	Publisher   *PublishingStore
	Store       *Store
	CreateDraft func(input CreateSessionInput) CreateSessionInput
}

// SessionResolutionCoordinator 协调 work 会话的按 ID 领养、按原生线程领养与账号重绑定。
type SessionResolutionCoordinator struct {
	actors      *ActorRegistry
	publisher   *PublishingStore
	store       *Store
	createDraft func(input CreateSessionInput) CreateSessionInput
}

// NewSessionResolutionCoordinator 构造会话解析/领养协调器。
func NewSessionResolutionCoordinator(opts SessionResolutionCoordinatorOptions) *SessionResolutionCoordinator {
	createDraft := opts.CreateDraft
	if createDraft == nil {
		createDraft = func(in CreateSessionInput) CreateSessionInput { return in }
	}
	return &SessionResolutionCoordinator{
		actors:      opts.Actors,
		publisher:   opts.Publisher,
		store:       opts.Store,
		createDraft: createDraft,
	}
}

// Resolve 根据 sessionId 或 (provider, nativeSessionId) 解析或新建工作区会话。
func (c *SessionResolutionCoordinator) Resolve(ctx context.Context, in CreateSessionInput) (*ResolveSessionResult, error) {
	sessionInput := CreateSessionInput{
		Provider:            in.Provider,
		ExecutionAccountRef: in.ExecutionAccountRef,
		ProjectPath:         strings.TrimSpace(in.ProjectPath),
		Policy:              CloneMap(in.Policy),
		ReadOnly:            in.ReadOnly,
	}
	if nid := strings.TrimSpace(in.NativeSessionID); nid != "" {
		sessionInput.NativeSessionID = nid
		sessionInput.RuntimeBinding = map[string]any{"nativeSessionId": nid}
	}

	explicitID := strings.TrimSpace(in.SessionID)
	if explicitID != "" {
		sess, err := c.store.GetSession(ctx, explicitID)
		if err != nil {
			return nil, err
		}
		if sess == nil {
			return nil, NewError("chat_session_not_found", 404, nil)
		}
		sessNativeID, _ := sess.RuntimeBinding["nativeSessionId"].(string)
		if in.ReadOnly && sess.Provider == sessionInput.Provider && sess.ProjectPath == sessionInput.ProjectPath &&
			(sessionInput.NativeSessionID == "" || sessionInput.NativeSessionID == sessNativeID) {
			return &ResolveSessionResult{Status: "adopted", Session: sess}, nil
		}
		if IsChatSession(sess) || sess.Provider != sessionInput.Provider ||
			(!in.ReadOnly && sess.ExecutionAccountRef != sessionInput.ExecutionAccountRef) ||
			sess.ProjectPath != sessionInput.ProjectPath ||
			(sessionInput.NativeSessionID != "" && sessionInput.NativeSessionID != sessNativeID) {
			return nil, NewError("chat_session_identity_mismatch", 409, nil)
		}
		return &ResolveSessionResult{Status: "adopted", Session: sess}, nil
	}

	if sessionInput.NativeSessionID != "" {
		existing, err := c.store.FindSessionByNativeIdentity(ctx, sessionInput.Provider, sessionInput.NativeSessionID)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			if IsChatSession(existing) {
				return nil, NewError("chat_session_requires_chat_identity", 409, nil)
			}
			if in.ReadOnly && existing.Provider == sessionInput.Provider && existing.ProjectPath == sessionInput.ProjectPath {
				return &ResolveSessionResult{Status: "adopted", Session: existing}, nil
			}
			if existing.ExecutionAccountRef == sessionInput.ExecutionAccountRef {
				return &ResolveSessionResult{Status: "adopted", Session: existing}, nil
			}
			return c.rebind(ctx, existing, sessionInput)
		}
	}

	draft := c.createDraft(sessionInput)
	if strings.TrimSpace(draft.SessionID) == "" {
		draft.SessionID = c.store.NewID("session")
	}
	draftSess := &Session{
		SessionID:           draft.SessionID,
		Provider:            draft.Provider,
		ExecutionAccountRef: draft.ExecutionAccountRef,
		ProjectPath:         draft.ProjectPath,
		RuntimeBinding:      CloneMap(draft.RuntimeBinding),
		Policy:              CloneMap(draft.Policy),
	}
	prepared, err := c.actors.Prepare(ctx, draftSess)
	if err != nil {
		return nil, err
	}
	defer prepared.Dispose()

	draft.RuntimeBinding = RuntimeBindingPatch(draftSess, prepared.Runtime)
	if caps := EntryCapabilities(prepared.Entry, draftSess); caps != nil {
		draft.CapabilitySnapshot = caps
	} else {
		draft.CapabilitySnapshot = map[string]any{}
	}

	result, err := c.store.ResolveSession(ctx, draft)
	if err != nil {
		return nil, err
	}
	if result.Status == "created" {
		if _, err := c.publisher.PublishSince(ctx, result.Session.SessionID, 0); err != nil {
			return nil, err
		}
		if _, err := c.actors.Register(result.Session, prepared); err != nil {
			return nil, err
		}
	} else if result.Session.ExecutionAccountRef != draft.ExecutionAccountRef {
		return c.rebind(ctx, result.Session, sessionInput)
	}
	return result, nil
}

func (c *SessionResolutionCoordinator) rebind(ctx context.Context, existing *Session, in CreateSessionInput) (*ResolveSessionResult, error) {
	if IsChatSession(existing) {
		return nil, NewError("chat_session_requires_chat_identity", 409, nil)
	}
	if existing.Policy != nil && existing.Policy["lineage"] != nil {
		return nil, NewError("chat_branch_account_mismatch", 409, nil)
	}
	if err := c.actors.AssertReplaceable(existing.SessionID); err != nil {
		return nil, err
	}
	candidate := *existing
	candidate.ExecutionAccountRef = in.ExecutionAccountRef
	prepared, err := c.actors.Prepare(ctx, &candidate)
	if err != nil {
		return nil, err
	}
	defer prepared.Dispose()

	if err := c.actors.AssertReplaceable(existing.SessionID); err != nil {
		return nil, err
	}
	caps := EntryCapabilities(prepared.Entry, &candidate)
	if caps == nil {
		caps = existing.CapabilitySnapshot
	}
	sess, err := c.store.UpdateExecutionContext(
		ctx,
		existing.SessionID,
		in.ExecutionAccountRef,
		RuntimeBindingPatch(&candidate, prepared.Runtime),
		caps,
	)
	if err != nil {
		return nil, err
	}
	if _, err := c.actors.ReplacePrepared(sess, prepared); err != nil {
		return nil, err
	}
	if _, err := c.publisher.PublishSince(ctx, sess.SessionID, existing.LastEventSeq); err != nil {
		return nil, err
	}
	return &ResolveSessionResult{Status: "adopted", Session: sess}, nil
}
