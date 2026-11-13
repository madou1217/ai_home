package sessionevents

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	StateVersion           = 1
	DefaultMaxRecentEvents = 32
	DefaultMaxPendingEvent = 16
	stateDirName           = "provider-session-state"
	correlationDirName     = "provider-session-correlations"
	pendingDirName         = "provider-session-pending"
)

// StateSession 定义与 Node provider-session-state-store.js 逐字节同口径的会话键结构体。
// 字段声明顺序故意保持 (provider, sessionId, projectPath, projectDirName)，使 sha256(json) 与 Node 一致。
type StateSession struct {
	Provider       string `json:"provider"`
	SessionID      string `json:"sessionId"`
	ProjectPath    string `json:"projectPath"`
	ProjectDirName string `json:"projectDirName"`
}

// LastEventInfo 记录最近一次落库事件摘要。
type LastEventInfo struct {
	EventID string `json:"eventId"`
	Type    string `json:"type"`
	Source  string `json:"source"`
	At      int64  `json:"at"`
}

// StateQuestion 描述等待用户回答的交互问题。
type StateQuestion struct {
	Question string   `json:"question"`
	Options  []string `json:"options,omitempty"`
}

// StateError 描述最近一次失败信息。
type StateError struct {
	Message string `json:"message"`
	Code    string `json:"code"`
}

// SessionState 是持久化在 run/provider-session-state/<sha256>.json 的运行态快照。
type SessionState struct {
	Version        int            `json:"version"`
	Session        StateSession   `json:"session"`
	Revision       int64          `json:"revision"`
	LastEventAt    int64          `json:"lastEventAt"`
	TurnState      string         `json:"turnState"`
	Question       *StateQuestion `json:"question"`
	Error          *StateError    `json:"error"`
	Retry          map[string]any `json:"retry"`
	Statusline     map[string]any `json:"statusline"`
	Route          map[string]any `json:"route"`
	LastEvent      *LastEventInfo `json:"lastEvent"`
	RecentEventIds []string       `json:"recentEventIds"`
}

// StateEvent 是状态机接收的标准化输入事件。
type StateEvent struct {
	EventID        string         `json:"eventId"`
	Session        StateSession   `json:"session"`
	CorrelationID  string         `json:"correlationId"`
	Source         string         `json:"source"`
	Type           string         `json:"type"`
	Revision       int64          `json:"revision"`
	At             int64          `json:"at"`
	Payload        map[string]any `json:"payload"`
}

// ApplyResult 描述状态更新的结果。
type ApplyResult struct {
	Accepted bool
	Reason   string
	State    *SessionState
}

// StateStoreOptions 配置 StateStore。
type StateStoreOptions struct {
	AIHomeDir        string
	Now              func() time.Time
	MaxRecentEvents  int
	MaxPendingEvents int
}

// StateStore 持久化会话运行态快照并维护 correlationId 映射与 pending 队列。
type StateStore struct {
	mu               sync.Mutex
	aiHomeDir        string
	now              func() time.Time
	maxRecentEvents  int
	maxPendingEvents int
	states           map[string]*SessionState
	correlations     map[string]string
	pending          map[string][]StateEvent
}

// NewStateStore 创建一个与 Node provider-session-state-store.js 兼容的持久化存储。
func NewStateStore(options StateStoreOptions) *StateStore {
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	maxRecent := options.MaxRecentEvents
	if maxRecent <= 0 {
		maxRecent = DefaultMaxRecentEvents
	}
	maxPending := options.MaxPendingEvents
	if maxPending <= 0 {
		maxPending = DefaultMaxPendingEvent
	}
	return &StateStore{
		aiHomeDir:        strings.TrimSpace(options.AIHomeDir),
		now:              nowFn,
		maxRecentEvents:  maxRecent,
		maxPendingEvents: maxPending,
		states:           make(map[string]*SessionState),
		correlations:     make(map[string]string),
		pending:          make(map[string][]StateEvent),
	}
}

// StateSessionKey 生成与 Node JSON.stringify(normalizeSession(s)) 完全一致的键串。
func StateSessionKey(session StateSession) string {
	normalized := normalizeStateSession(session)
	if normalized.Provider == "" || normalized.SessionID == "" {
		return ""
	}
	raw, err := json.Marshal(normalized)
	if err != nil {
		return ""
	}
	return string(raw)
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func normalizeStateSession(session StateSession) StateSession {
	return StateSession{
		Provider:       strings.ToLower(strings.TrimSpace(session.Provider)),
		SessionID:      strings.TrimSpace(session.SessionID),
		ProjectPath:    strings.TrimSpace(session.ProjectPath),
		ProjectDirName: strings.TrimSpace(session.ProjectDirName),
	}
}

var eventTypeAlias = map[string]string{
	"session:opened":            "session-opened",
	"session:closed":            "session-closed",
	"session:turn-started":      "turn-started",
	"session:turn-updated":      "turn-updated",
	"session:turn-completed":    "turn-completed",
	"session:turn-failed":       "turn-failed",
	"session:turn-interrupted":  "turn-interrupted",
	"session:question-opened":   "question-opened",
	"session:question-cleared":  "question-cleared",
	"session:retry-status":      "retry-updated",
	"session:statusline-updated": "statusline-updated",
	"session:route-updated":     "route-updated",
}

func normalizeStateEventType(rawType string) string {
	trimmed := strings.ToLower(strings.TrimSpace(rawType))
	if mapped, ok := eventTypeAlias[trimmed]; ok {
		return mapped
	}
	return trimmed
}

// Apply 应用一次事件并原子写入磁盘快照。
func (store *StateStore) Apply(input StateEvent) ApplyResult {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.applyLocked(input)
}

// ApplyByCorrelation 通过 correlationId 解析会话后应用事件；未就绪时排入 pending 队列。
func (store *StateStore) ApplyByCorrelation(correlationID string, input StateEvent) ApplyResult {
	store.mu.Lock()
	defer store.mu.Unlock()

	correlation := bounded(correlationID, 128)
	if correlation == "" {
		return ApplyResult{Accepted: false, Reason: "correlation_not_ready"}
	}
	session, found := store.resolveCorrelationLocked(correlation)
	if !found {
		return store.queuePendingLocked(correlation, input)
	}
	input.Session = session
	input.CorrelationID = correlation
	return store.applyLocked(input)
}

// BindCorrelation 绑定 correlationId -> session 并排空对应 pending 事件。
func (store *StateStore) BindCorrelation(correlationID string, session StateSession) (conflict bool) {
	store.mu.Lock()
	defer store.mu.Unlock()

	correlation := bounded(correlationID, 128)
	key := StateSessionKey(session)
	if correlation == "" || key == "" {
		return false
	}
	existing := store.getCorrelationKeyLocked(correlation)
	if existing != "" && existing != key {
		return true
	}
	store.correlations[correlation] = key
	_ = store.persistCorrelationLocked(correlation, key)
	store.drainPendingLocked(correlation, normalizeStateSession(session))
	return false
}

// ResolveCorrelation 解析已绑定的会话标识。
func (store *StateStore) ResolveCorrelation(correlationID string) (StateSession, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.resolveCorrelationLocked(bounded(correlationID, 128))
}

// Get 读取给定会话的最新状态快照（优先同步磁盘更新）。
func (store *StateStore) Get(session StateSession) (*SessionState, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	key := StateSessionKey(session)
	if key == "" {
		return nil, false
	}
	state := store.getLocked(key, normalizeStateSession(session))
	return cloneSessionState(state), true
}

func (store *StateStore) resolveCorrelationLocked(correlation string) (StateSession, bool) {
	if correlation == "" {
		return StateSession{}, false
	}
	key := store.getCorrelationKeyLocked(correlation)
	if key == "" {
		return StateSession{}, false
	}
	var session StateSession
	if err := json.Unmarshal([]byte(key), &session); err != nil {
		return StateSession{}, false
	}
	if session.Provider == "" || session.SessionID == "" {
		return StateSession{}, false
	}
	return session, true
}

func (store *StateStore) normalizeEventLocked(input StateEvent) StateEvent {
	session := normalizeStateSession(input.Session)
	eventType := normalizeStateEventType(input.Type)
	revision := input.Revision
	if revision < 0 {
		revision = 0
	}
	at := input.At
	if at <= 0 {
		at = store.now().UnixMilli()
	}
	source := bounded(input.Source, 64)
	if source == "" {
		source = "unknown"
	}
	payload := deepCloneMap(input.Payload)
	if payload == nil {
		payload = map[string]any{}
	}
	eventID := bounded(input.EventID, 160)
	if eventID == "" {
		hashPayload := struct {
			Session  StateSession   `json:"session"`
			Type     string         `json:"type"`
			Revision int64          `json:"revision"`
			At       int64          `json:"at"`
			Payload  map[string]any `json:"payload"`
		}{
			Session:  session,
			Type:     eventType,
			Revision: revision,
			At:       at,
			Payload:  payload,
		}
		raw, _ := json.Marshal(hashPayload)
		eventID = sha256Hex(string(raw))
	}
	return StateEvent{
		EventID:       eventID,
		Session:       session,
		CorrelationID: bounded(input.CorrelationID, 128),
		Source:        source,
		Type:          eventType,
		Revision:      revision,
		At:            at,
		Payload:       payload,
	}
}

func (store *StateStore) applyLocked(input StateEvent) ApplyResult {
	event := store.normalizeEventLocked(input)
	key := StateSessionKey(event.Session)
	if key == "" || event.Type == "" {
		return ApplyResult{Accepted: false, Reason: "invalid_event"}
	}
	if event.CorrelationID != "" {
		existing := store.getCorrelationKeyLocked(event.CorrelationID)
		if existing != "" && existing != key {
			return ApplyResult{
				Accepted: false,
				Reason:   "correlation_conflict",
				State:    cloneSessionState(store.getLocked(key, event.Session)),
			}
		}
	}

	previous := store.getLocked(key, event.Session)
	for _, seenID := range previous.RecentEventIds {
		if seenID == event.EventID {
			return ApplyResult{Accepted: false, Reason: "duplicate_event", State: cloneSessionState(previous)}
		}
	}
	if (event.Revision > 0 && previous.Revision > 0 && event.Revision < previous.Revision) ||
		(event.Revision > 0 && event.Revision == previous.Revision && event.At < previous.LastEventAt) {
		return ApplyResult{Accepted: false, Reason: "stale_event", State: cloneSessionState(previous)}
	}

	next := applyStateTransition(previous, event, store.maxRecentEvents)
	if err := store.persistStateLocked(key, next); err != nil {
		return ApplyResult{Accepted: false, Reason: "persist_failed", State: cloneSessionState(previous)}
	}
	store.states[key] = next

	if event.CorrelationID != "" {
		store.correlations[event.CorrelationID] = key
		_ = store.persistCorrelationLocked(event.CorrelationID, key)
		store.drainPendingLocked(event.CorrelationID, event.Session)
	}
	return ApplyResult{Accepted: true, Reason: "accepted", State: cloneSessionState(next)}
}

func (store *StateStore) getLocked(key string, session StateSession) *SessionState {
	persisted := store.readPersistedStateLocked(key)
	cached, exists := store.states[key]
	if persisted != nil {
		if !exists ||
			persisted.Revision > cached.Revision ||
			persisted.LastEventAt > cached.LastEventAt ||
			(persisted.LastEvent != nil && (cached.LastEvent == nil || persisted.LastEvent.EventID != cached.LastEvent.EventID)) {
			store.states[key] = persisted
			return persisted
		}
	}
	if !exists {
		initial := initialSessionState(session)
		store.states[key] = initial
		return initial
	}
	return cached
}

func initialSessionState(session StateSession) *SessionState {
	return &SessionState{
		Version:        StateVersion,
		Session:        normalizeStateSession(session),
		TurnState:      "idle",
		RecentEventIds: []string{},
	}
}

func applyStateTransition(previous *SessionState, event StateEvent, maxRecentEvents int) *SessionState {
	next := cloneSessionState(previous)
	payload := event.Payload

	switch event.Type {
	case "session-opened":
		next.TurnState = "idle"
	case "session-closed":
		next.TurnState = "closed"
		next.Question = nil
	case "turn-started":
		next.TurnState = "working"
		next.Error = nil
		next.Question = nil
	case "turn-updated":
		next.TurnState = "working"
	case "turn-completed":
		next.TurnState = "completed"
		next.Question = nil
		next.Error = nil
	case "turn-failed":
		next.TurnState = "failed"
		next.Error = normalizeStateError(payload)
		next.Question = nil
	case "turn-interrupted":
		next.TurnState = "interrupted"
		next.Error = normalizeStateError(payload)
		if next.Error == nil {
			next.Error = &StateError{Message: "interrupted"}
		}
		next.Question = nil
	case "question-opened":
		next.TurnState = "waiting"
		incoming := normalizeStateQuestion(payload)
		isNotice, _ := payload["notice"].(bool)
		if previous.TurnState == "waiting" && previous.Question != nil && isNotice {
			next.Question = cloneQuestion(previous.Question)
		} else {
			next.Question = incoming
		}
	case "question-cleared":
		next.Question = nil
		if previous.TurnState == "waiting" {
			next.TurnState = "working"
		}
	case "retry-updated":
		next.Retry = deepCloneMap(payload)
	case "statusline-updated":
		next.Statusline = deepCloneMap(payload)
	case "route-updated":
		next.Route = deepCloneMap(payload)
	}

	if event.Revision > next.Revision {
		next.Revision = event.Revision
	}
	if event.At > next.LastEventAt {
		next.LastEventAt = event.At
	}
	next.LastEvent = &LastEventInfo{
		EventID: event.EventID,
		Type:    event.Type,
		Source:  event.Source,
		At:      event.At,
	}

	recent := make([]string, 0, len(previous.RecentEventIds)+1)
	for _, id := range previous.RecentEventIds {
		if id != event.EventID {
			recent = append(recent, id)
		}
	}
	recent = append(recent, event.EventID)
	if len(recent) > maxRecentEvents {
		recent = recent[len(recent)-maxRecentEvents:]
	}
	next.RecentEventIds = recent
	return next
}

func normalizeStateError(payload map[string]any) *StateError {
	if len(payload) == 0 {
		return nil
	}
	message := bounded(firstNonEmpty(
		anyToText(payload["message"]),
		anyToText(payload["error"]),
		anyToText(payload["reason"]),
	), 4096)
	if message == "" {
		return nil
	}
	return &StateError{
		Message: message,
		Code:    bounded(anyToText(payload["code"]), 128),
	}
}

func normalizeStateQuestion(payload map[string]any) *StateQuestion {
	if len(payload) == 0 {
		return nil
	}
	question := bounded(firstNonEmpty(
		anyToText(payload["question"]),
		anyToText(payload["text"]),
		anyToText(payload["prompt"]),
	), 4096)
	if question == "" {
		return nil
	}
	var options []string
	if rawOpts, ok := payload["options"].([]any); ok {
		for _, item := range rawOpts {
			if len(options) >= 32 {
				break
			}
			text := bounded(anyToText(item), 512)
			if text != "" {
				options = append(options, text)
			}
		}
	} else if rawStrOpts, ok := payload["options"].([]string); ok {
		for _, item := range rawStrOpts {
			if len(options) >= 32 {
				break
			}
			text := bounded(item, 512)
			if text != "" {
				options = append(options, text)
			}
		}
	}
	return &StateQuestion{Question: question, Options: options}
}

func (store *StateStore) queuePendingLocked(correlationID string, input StateEvent) ApplyResult {
	input.CorrelationID = correlationID
	event := store.normalizeEventLocked(input)
	if event.Type == "" {
		return ApplyResult{Accepted: false, Reason: "invalid_event"}
	}
	events := store.readPendingLocked(correlationID)
	for _, existing := range events {
		if existing.EventID == event.EventID {
			return ApplyResult{Accepted: false, Reason: "duplicate_event"}
		}
	}
	events = append(events, event)
	if len(events) > store.maxPendingEvents {
		events = events[len(events)-store.maxPendingEvents:]
	}
	if err := store.persistPendingLocked(correlationID, events); err != nil {
		return ApplyResult{Accepted: false, Reason: "pending_persist_failed"}
	}
	store.pending[correlationID] = events
	return ApplyResult{Accepted: false, Reason: "pending_correlation"}
}

func (store *StateStore) drainPendingLocked(correlationID string, session StateSession) {
	events := store.readPendingLocked(correlationID)
	if len(events) == 0 {
		return
	}
	delete(store.pending, correlationID)
	_ = store.persistPendingLocked(correlationID, []StateEvent{})
	for _, event := range events {
		event.Session = session
		event.CorrelationID = correlationID
		store.applyLocked(event)
	}
}

func (store *StateStore) stateFilePath(key string) string {
	if store.aiHomeDir == "" || key == "" {
		return ""
	}
	return filepath.Join(store.aiHomeDir, "run", stateDirName, sha256Hex(key)+".json")
}

func (store *StateStore) correlationFilePath(correlationID string) string {
	if store.aiHomeDir == "" || correlationID == "" {
		return ""
	}
	return filepath.Join(store.aiHomeDir, "run", correlationDirName, sha256Hex(correlationID)+".json")
}

func (store *StateStore) pendingFilePath(correlationID string) string {
	if store.aiHomeDir == "" || correlationID == "" {
		return ""
	}
	return filepath.Join(store.aiHomeDir, "run", pendingDirName, sha256Hex(correlationID)+".json")
}

func (store *StateStore) readPersistedStateLocked(key string) *SessionState {
	path := store.stateFilePath(key)
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var state SessionState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil
	}
	if state.Version != StateVersion || state.Session.Provider == "" || state.Session.SessionID == "" {
		return nil
	}
	if state.RecentEventIds == nil {
		state.RecentEventIds = []string{}
	}
	return &state
}

func (store *StateStore) persistStateLocked(key string, state *SessionState) error {
	path := store.stateFilePath(key)
	if path == "" {
		return nil
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(encoded, byte(10)))
}

func (store *StateStore) getCorrelationKeyLocked(correlationID string) string {
	if correlationID == "" {
		return ""
	}
	if cached, ok := store.correlations[correlationID]; ok && cached != "" {
		return cached
	}
	path := store.correlationFilePath(correlationID)
	if path == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var doc struct {
		Version int    `json:"version"`
		Key     string `json:"key"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Version != StateVersion {
		return ""
	}
	key := strings.TrimSpace(doc.Key)
	if key != "" {
		store.correlations[correlationID] = key
	}
	return key
}

func (store *StateStore) persistCorrelationLocked(correlationID, key string) error {
	path := store.correlationFilePath(correlationID)
	if path == "" {
		return nil
	}
	doc := struct {
		Version int    `json:"version"`
		Key     string `json:"key"`
	}{
		Version: StateVersion,
		Key:     key,
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(encoded, byte(10)))
}

func (store *StateStore) readPendingLocked(correlationID string) []StateEvent {
	if cached, ok := store.pending[correlationID]; ok {
		return append([]StateEvent(nil), cached...)
	}
	path := store.pendingFilePath(correlationID)
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var doc struct {
		Version int          `json:"version"`
		Events  []StateEvent `json:"events"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Version != StateVersion {
		return nil
	}
	events := doc.Events
	if len(events) > store.maxPendingEvents {
		events = events[len(events)-store.maxPendingEvents:]
	}
	store.pending[correlationID] = events
	return append([]StateEvent(nil), events...)
}

func (store *StateStore) persistPendingLocked(correlationID string, events []StateEvent) error {
	path := store.pendingFilePath(correlationID)
	if path == "" {
		return nil
	}
	if len(events) > store.maxPendingEvents {
		events = events[len(events)-store.maxPendingEvents:]
	}
	if events == nil {
		events = []StateEvent{}
	}
	doc := struct {
		Version int          `json:"version"`
		Events  []StateEvent `json:"events"`
	}{
		Version: StateVersion,
		Events:  events,
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(encoded, byte(10)))
}

func writeFileAtomic(targetPath string, content []byte) error {
	dir := filepath.Dir(targetPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".state-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func cloneSessionState(src *SessionState) *SessionState {
	if src == nil {
		return nil
	}
	copyState := *src
	copyState.Question = cloneQuestion(src.Question)
	if src.Error != nil {
		errCopy := *src.Error
		copyState.Error = &errCopy
	}
	if src.LastEvent != nil {
		lastCopy := *src.LastEvent
		copyState.LastEvent = &lastCopy
	}
	copyState.Retry = deepCloneMap(src.Retry)
	copyState.Statusline = deepCloneMap(src.Statusline)
	copyState.Route = deepCloneMap(src.Route)
	copyState.RecentEventIds = append([]string{}, src.RecentEventIds...)
	return &copyState
}

func cloneQuestion(q *StateQuestion) *StateQuestion {
	if q == nil {
		return nil
	}
	copyQ := StateQuestion{
		Question: q.Question,
	}
	if len(q.Options) > 0 {
		copyQ.Options = append([]string(nil), q.Options...)
	}
	return &copyQ
}

func deepCloneMap(src map[string]any) map[string]any {
	if src == nil {
		return nil
	}
	raw, err := json.Marshal(src)
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

func bounded(value string, max int) string {
	trimmed := strings.TrimSpace(value)
	if max <= 0 || len(trimmed) <= max {
		return trimmed
	}
	runes := []rune(trimmed)
	if len(runes) <= max {
		return trimmed
	}
	return string(runes[:max])
}

func anyToText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return ""
		}
		return strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(jsonNumber(typed), ".0"), "."))
	default:
		return ""
	}
}

func jsonNumber(value float64) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(raw)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

