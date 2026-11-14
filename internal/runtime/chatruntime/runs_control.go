package chatruntime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
)

const (
	// DefaultCLIInstallConfirmationTimeout 与 Node cli-install-confirmation-registry 的默认 10s 一致。
	DefaultCLIInstallConfirmationTimeout = 10 * time.Second
	// DefaultNativeApprovalTimeout 与 Node claude-permission-mcp-tool / native-approval-bridge 的 600s 长挂一致。
	DefaultNativeApprovalTimeout = 10 * time.Minute

	minRunTerminalCols = 20
	maxRunTerminalCols = 400
	minRunTerminalRows = 4
	maxRunTerminalRows = 200
)

// ActiveRunRegistration 描述向 Chat Runtime 控制面登记的活动运行句柄。
type ActiveRunRegistration struct {
	RunID              string
	Provider           string
	AccountRef         string
	SessionID          string
	ProjectDirName     string
	ProjectPath        string
	StartedAt          int64
	InteractionMode    string
	Mode               string
	WriteInput         func(input string, appendNewline bool) error
	WriteSteer         func(content string) error
	Resize             func(cols, rows int) error
	Abort              func() error
	GetActivePrompt    func() map[string]any
	GetContentSnapshot func() string
}

// ActiveRunSummary 是 GET /v1/management/webui/chat/runs 返回的活动运行摘要。
type ActiveRunSummary struct {
	RunID           string         `json:"runId"`
	Provider        string         `json:"provider"`
	AccountRef      string         `json:"accountRef"`
	SessionID       string         `json:"sessionId"`
	ProjectDirName  string         `json:"projectDirName"`
	ProjectPath     string         `json:"projectPath"`
	StartedAt       int64          `json:"startedAt"`
	InteractionMode string         `json:"interactionMode"`
	Mode            string         `json:"mode"`
	ContentSnapshot string         `json:"contentSnapshot"`
	ActivePrompt    map[string]any `json:"activePrompt"`
}

// ListActiveRunsFilter 配置活动运行列表过滤条件。
type ListActiveRunsFilter struct {
	SessionID      string
	Provider       string
	ProjectDirName string
}

// NativeApprovalInboundRequest 描述内部审批工具发起的权限请求载荷。
type NativeApprovalInboundRequest struct {
	RunID     string         `json:"runId"`
	SessionID string         `json:"sessionId"`
	ToolName  string         `json:"toolName"`
	Input     map[string]any `json:"input"`
	ToolUseID string         `json:"toolUseId"`
}

// NativeApprovalDecisionOutcome 描述一次审批决策的响应结果。
type NativeApprovalDecisionOutcome struct {
	ApprovalID      string `json:"approvalId"`
	Decision        string `json:"decision,omitempty"`
	AlreadyResolved bool   `json:"alreadyResolved,omitempty"`
}

// CLIInstallConfirmationOutcome 描述一次性 CLI 安装确认的最终裁决。
type CLIInstallConfirmationOutcome struct {
	ConfirmationID string `json:"confirmationId"`
	Provider       string `json:"provider"`
	Decision       string `json:"decision"`
	Source         string `json:"source"`
	ResolvedAt     int64  `json:"resolvedAt"`
}

// CLIInstallConfirmationTicket 表示单条待决的 CLI 安装确认票据。
type CLIInstallConfirmationTicket struct {
	ConfirmationID string
	Provider       string
	CreatedAt      int64
	ExpiresAt      int64
	CountdownMs    int64
	done           chan CLIInstallConfirmationOutcome
	once           sync.Once
	outcome        CLIInstallConfirmationOutcome
}

// Wait 阻塞等待该安装确认被用户裁决或超时自动放行。
func (t *CLIInstallConfirmationTicket) Wait(ctx context.Context) (CLIInstallConfirmationOutcome, error) {
	if t == nil {
		return CLIInstallConfirmationOutcome{}, NewError("invalid_cli_install_confirmation", http.StatusBadRequest, nil)
	}
	if ctx == nil {
		<-t.done
		return t.outcome, nil
	}
	select {
	case <-t.done:
		return t.outcome, nil
	case <-ctx.Done():
		return CLIInstallConfirmationOutcome{}, ctx.Err()
	}
}

type cliInstallPendingEntry struct {
	ticket *CLIInstallConfirmationTicket
	timer  *time.Timer
}

// CLIInstallConfirmationRegistry 管理安装缺失 CLI 前的一次性短时确认票据。
type CLIInstallConfirmationRegistry struct {
	mu             sync.Mutex
	pending        map[string]*cliInstallPendingEntry
	defaultTimeout time.Duration
	clock          func() int64
	idFactory      func(string) string
}

// NewCLIInstallConfirmationRegistry 构造 CLI 安装确认注册表。
func NewCLIInstallConfirmationRegistry(
	defaultTimeout time.Duration,
	clock func() int64,
	idFactory func(string) string,
) *CLIInstallConfirmationRegistry {
	if defaultTimeout <= 0 {
		defaultTimeout = DefaultCLIInstallConfirmationTimeout
	}
	if clock == nil {
		clock = func() int64 { return time.Now().UnixMilli() }
	}
	if idFactory == nil {
		idFactory = func(prefix string) string { return randomControlID(prefix) }
	}
	return &CLIInstallConfirmationRegistry{
		pending:        make(map[string]*cliInstallPendingEntry),
		defaultTimeout: defaultTimeout,
		clock:          clock,
		idFactory:      idFactory,
	}
}

// Create 创建一条待决的 CLI 安装确认票据并在超时后自动按 confirm 结算。
func (r *CLIInstallConfirmationRegistry) Create(provider string, timeout time.Duration) *CLIInstallConfirmationTicket {
	if timeout <= 0 {
		timeout = r.defaultTimeout
	}
	confirmationID := r.idFactory("confirm")
	createdAt := r.clock()
	countdownMs := timeout.Milliseconds()
	ticket := &CLIInstallConfirmationTicket{
		ConfirmationID: confirmationID,
		Provider:       strings.ToLower(strings.TrimSpace(provider)),
		CreatedAt:      createdAt,
		ExpiresAt:      createdAt + countdownMs,
		CountdownMs:    countdownMs,
		done:           make(chan CLIInstallConfirmationOutcome, 1),
	}
	entry := &cliInstallPendingEntry{ticket: ticket}
	entry.timer = time.AfterFunc(timeout, func() {
		r.settle(confirmationID, "confirm", "timeout")
	})
	r.mu.Lock()
	r.pending[confirmationID] = entry
	r.mu.Unlock()
	return ticket
}

// Decide 由用户或调用方裁决指定的确认票据（仅接受 confirm / cancel）。
func (r *CLIInstallConfirmationRegistry) Decide(confirmationID, decision, source string) *CLIInstallConfirmationOutcome {
	id := strings.TrimSpace(confirmationID)
	dec := strings.ToLower(strings.TrimSpace(decision))
	if id == "" || (dec != "confirm" && dec != "cancel") {
		return nil
	}
	if strings.TrimSpace(source) == "" {
		source = "user"
	}
	return r.settle(id, dec, source)
}

// Has 判断指定 confirmationId 当前是否仍在等待裁决。
func (r *CLIInstallConfirmationRegistry) Has(confirmationID string) bool {
	id := strings.TrimSpace(confirmationID)
	if id == "" {
		return false
	}
	r.mu.Lock()
	_, ok := r.pending[id]
	r.mu.Unlock()
	return ok
}

// Close 取消全部未结算的确认定时器并按 cancel 释放等待方。
func (r *CLIInstallConfirmationRegistry) Close() {
	r.mu.Lock()
	ids := make([]string, 0, len(r.pending))
	for id := range r.pending {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.settle(id, "cancel", "closed")
	}
}

func (r *CLIInstallConfirmationRegistry) settle(confirmationID, decision, source string) *CLIInstallConfirmationOutcome {
	r.mu.Lock()
	entry := r.pending[confirmationID]
	if entry == nil {
		r.mu.Unlock()
		return nil
	}
	delete(r.pending, confirmationID)
	r.mu.Unlock()

	if entry.timer != nil {
		entry.timer.Stop()
	}
	outcome := CLIInstallConfirmationOutcome{
		ConfirmationID: confirmationID,
		Provider:       entry.ticket.Provider,
		Decision:       decision,
		Source:         source,
		ResolvedAt:     r.clock(),
	}
	entry.ticket.once.Do(func() {
		entry.ticket.outcome = outcome
		close(entry.ticket.done)
	})
	return &outcome
}

type standalonePendingApproval struct {
	approvalID string
	runID      string
	sessionID  string
	toolName   string
	input      map[string]any
	toolUseID  string
	createdAt  int64
	done       chan map[string]any
	once       sync.Once
	timer      *time.Timer
}

type standaloneApprovalRegistry struct {
	mu        sync.Mutex
	pending   map[string]*standalonePendingApproval
	timeout   time.Duration
	clock     func() int64
	idFactory func(string) string
}

func newStandaloneApprovalRegistry(
	timeout time.Duration,
	clock func() int64,
	idFactory func(string) string,
) *standaloneApprovalRegistry {
	if timeout <= 0 {
		timeout = DefaultNativeApprovalTimeout
	}
	if clock == nil {
		clock = func() int64 { return time.Now().UnixMilli() }
	}
	if idFactory == nil {
		idFactory = func(prefix string) string { return randomControlID(prefix) }
	}
	return &standaloneApprovalRegistry{
		pending:   make(map[string]*standalonePendingApproval),
		timeout:   timeout,
		clock:     clock,
		idFactory: idFactory,
	}
}

func (r *standaloneApprovalRegistry) WaitForDecision(
	ctx context.Context,
	req NativeApprovalInboundRequest,
) (map[string]any, error) {
	approvalID := r.idFactory("ap")
	entry := &standalonePendingApproval{
		approvalID: approvalID,
		runID:      strings.TrimSpace(req.RunID),
		sessionID:  strings.TrimSpace(req.SessionID),
		toolName:   firstNonEmptyStr(strings.TrimSpace(req.ToolName), "unknown"),
		input:      CloneMap(req.Input),
		toolUseID:  strings.TrimSpace(req.ToolUseID),
		createdAt:  r.clock(),
		done:       make(chan map[string]any, 1),
	}
	entry.timer = time.AfterFunc(r.timeout, func() {
		r.Decide(approvalID, "deny", "审批等待超时,已默认拒绝")
	})

	r.mu.Lock()
	r.pending[approvalID] = entry
	r.mu.Unlock()

	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case dec := <-entry.done:
		return dec, nil
	case <-ctx.Done():
		r.Decide(approvalID, "deny", "approval_channel_closed")
		select {
		case dec := <-entry.done:
			return dec, nil
		default:
			return map[string]any{"behavior": "deny", "message": "approval_channel_closed"}, nil
		}
	}
}

func (r *standaloneApprovalRegistry) Decide(approvalID, decision, message string) *standalonePendingApproval {
	id := strings.TrimSpace(approvalID)
	if id == "" {
		return nil
	}
	r.mu.Lock()
	entry := r.pending[id]
	if entry == nil {
		r.mu.Unlock()
		return nil
	}
	delete(r.pending, id)
	r.mu.Unlock()

	if entry.timer != nil {
		entry.timer.Stop()
	}
	var payload map[string]any
	if strings.EqualFold(strings.TrimSpace(decision), "allow") {
		updated := entry.input
		if updated == nil {
			updated = map[string]any{}
		}
		payload = map[string]any{
			"behavior":     "allow",
			"updatedInput": updated,
		}
	} else {
		payload = map[string]any{
			"behavior": "deny",
			"message":  firstNonEmptyStr(strings.TrimSpace(message), "用户在 webUI 拒绝了此操作"),
		}
	}
	entry.once.Do(func() {
		entry.done <- payload
		close(entry.done)
	})
	return entry
}

func (r *standaloneApprovalRegistry) CancelForRun(runID, reason string) int {
	target := strings.TrimSpace(runID)
	if target == "" {
		return 0
	}
	r.mu.Lock()
	ids := make([]string, 0)
	for id, entry := range r.pending {
		if entry.runID == target {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	count := 0
	for _, id := range ids {
		if r.Decide(id, "deny", reason) != nil {
			count++
		}
	}
	return count
}

func (r *standaloneApprovalRegistry) PendingPromptForRun(runID string) map[string]any {
	target := strings.TrimSpace(runID)
	if target == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var earliest *standalonePendingApproval
	for _, entry := range r.pending {
		if entry.runID != target {
			continue
		}
		if earliest == nil || entry.createdAt < earliest.createdAt || (entry.createdAt == earliest.createdAt && entry.approvalID < earliest.approvalID) {
			earliest = entry
		}
	}
	if earliest == nil {
		return nil
	}
	return map[string]any{
		"type":      "approval",
		"promptId":  earliest.approvalID,
		"toolName":  earliest.toolName,
		"input":     CloneMap(earliest.input),
		"toolUseId": earliest.toolUseID,
		"label":     fmt.Sprintf("需要确认工具: %s", earliest.toolName),
		"detail":    formatApprovalDetail(earliest.toolName, earliest.input),
	}
}

func (r *standaloneApprovalRegistry) Close() {
	r.mu.Lock()
	ids := make([]string, 0, len(r.pending))
	for id := range r.pending {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.Decide(id, "deny", "service_closed")
	}
}

func (s *Service) ensureRunsControl() {
	s.runsMu.Lock()
	defer s.runsMu.Unlock()
	if s.activeRuns == nil {
		s.activeRuns = make(map[string]*ActiveRunRegistration)
	}
	if s.surfacesByRun == nil {
		s.surfacesByRun = make(map[string]*NativeApprovalSurface)
	}
	if s.surfacesBySession == nil {
		s.surfacesBySession = make(map[string]*NativeApprovalSurface)
	}
	if s.standaloneApprovals == nil {
		s.standaloneApprovals = newStandaloneApprovalRegistry(DefaultNativeApprovalTimeout, s.opts.Clock, s.opts.IDFactory)
	}
	if s.cliConfirmations == nil {
		s.cliConfirmations = NewCLIInstallConfirmationRegistry(DefaultCLIInstallConfirmationTimeout, s.opts.Clock, s.opts.IDFactory)
	}
}

func (s *Service) closeRunsControl() {
	s.runsMu.Lock()
	approvals := s.standaloneApprovals
	confirmations := s.cliConfirmations
	s.activeRuns = make(map[string]*ActiveRunRegistration)
	s.surfacesByRun = make(map[string]*NativeApprovalSurface)
	s.surfacesBySession = make(map[string]*NativeApprovalSurface)
	s.runsMu.Unlock()
	if approvals != nil {
		approvals.Close()
	}
	if confirmations != nil {
		confirmations.Close()
	}
}

// RegisterActiveRun 在控制面注册表登记一个活动运行。
func (s *Service) RegisterActiveRun(reg ActiveRunRegistration) {
	runID := strings.TrimSpace(reg.RunID)
	if s == nil || runID == "" {
		return
	}
	s.ensureRunsControl()
	copyReg := reg
	copyReg.RunID = runID
	copyReg.Provider = sessionchat.NormalizeProvider(reg.Provider)
	if copyReg.Provider == "" {
		copyReg.Provider = strings.ToLower(strings.TrimSpace(reg.Provider))
	}
	copyReg.AccountRef = strings.TrimSpace(reg.AccountRef)
	copyReg.SessionID = strings.TrimSpace(reg.SessionID)
	copyReg.ProjectDirName = strings.TrimSpace(reg.ProjectDirName)
	copyReg.ProjectPath = strings.TrimSpace(reg.ProjectPath)
	copyReg.InteractionMode = firstNonEmptyStr(strings.TrimSpace(reg.InteractionMode), "default")
	copyReg.Mode = firstNonEmptyStr(strings.TrimSpace(reg.Mode), "native-session")
	if copyReg.StartedAt <= 0 {
		copyReg.StartedAt = time.Now().UnixMilli()
	}

	s.runsMu.Lock()
	s.activeRuns[runID] = &copyReg
	s.runsMu.Unlock()
}

// UnregisterActiveRun 从控制面注册表移除指定 runId（不强杀已分离进程）。
func (s *Service) UnregisterActiveRun(runID string) {
	id := strings.TrimSpace(runID)
	if s == nil || id == "" {
		return
	}
	s.runsMu.Lock()
	delete(s.activeRuns, id)
	delete(s.surfacesByRun, id)
	s.runsMu.Unlock()
}

func (s *Service) getActiveRun(runID string) *ActiveRunRegistration {
	id := strings.TrimSpace(runID)
	if s == nil || id == "" {
		return nil
	}
	s.runsMu.RLock()
	reg := s.activeRuns[id]
	s.runsMu.RUnlock()
	return reg
}

// ListActiveRuns 返回满足过滤条件的活动运行列表（合并注册表句柄与持久化 ActiveTurn 会话）。
func (s *Service) ListActiveRuns(ctx context.Context, filter ListActiveRunsFilter) ([]ActiveRunSummary, error) {
	if s == nil {
		return []ActiveRunSummary{}, nil
	}
	s.ensureRunsControl()

	filterSessionID := strings.TrimSpace(filter.SessionID)
	filterProvider := strings.ToLower(strings.TrimSpace(filter.Provider))
	filterProjectDirName := strings.TrimSpace(filter.ProjectDirName)

	byRun := make(map[string]ActiveRunSummary)
	s.runsMu.RLock()
	regs := make([]*ActiveRunRegistration, 0, len(s.activeRuns))
	for _, reg := range s.activeRuns {
		if reg != nil && strings.TrimSpace(reg.RunID) != "" {
			regs = append(regs, reg)
		}
	}
	approvals := s.standaloneApprovals
	s.runsMu.RUnlock()

	for _, reg := range regs {
		snapshot := ""
		if reg.GetContentSnapshot != nil {
			snapshot = reg.GetContentSnapshot()
		}
		var activePrompt map[string]any
		if reg.GetActivePrompt != nil {
			activePrompt = reg.GetActivePrompt()
		}
		if activePrompt == nil && approvals != nil {
			activePrompt = approvals.PendingPromptForRun(reg.RunID)
		}
		byRun[reg.RunID] = ActiveRunSummary{
			RunID:           reg.RunID,
			Provider:        strings.ToLower(strings.TrimSpace(reg.Provider)),
			AccountRef:      reg.AccountRef,
			SessionID:       reg.SessionID,
			ProjectDirName:  reg.ProjectDirName,
			ProjectPath:     reg.ProjectPath,
			StartedAt:       reg.StartedAt,
			InteractionMode: firstNonEmptyStr(reg.InteractionMode, "default"),
			Mode:            firstNonEmptyStr(reg.Mode, "native-session"),
			ContentSnapshot: snapshot,
			ActivePrompt:    activePrompt,
		}
	}

	if s.publisher != nil {
		sessions, err := s.ListSessions(ctx, ListSessionsFilter{Provider: filterProvider})
		if err != nil {
			return nil, err
		}
		for _, sess := range sessions {
			if sess.ActiveTurn == nil || strings.TrimSpace(sess.ActiveTurn.RunID) == "" {
				continue
			}
			if sess.State != "running" && sess.State != "waiting_input" {
				continue
			}
			runID := strings.TrimSpace(sess.ActiveTurn.RunID)
			dirName := strings.TrimSpace(asString(sess.Policy["projectDirName"]))
			if existing, ok := byRun[runID]; ok {
				if existing.Provider == "" {
					existing.Provider = strings.ToLower(strings.TrimSpace(sess.Provider))
				}
				if existing.AccountRef == "" {
					existing.AccountRef = strings.TrimSpace(sess.ExecutionAccountRef)
				}
				if existing.SessionID == "" {
					existing.SessionID = sess.SessionID
				}
				if existing.ProjectDirName == "" {
					existing.ProjectDirName = dirName
				}
				if existing.ProjectPath == "" {
					existing.ProjectPath = strings.TrimSpace(sess.ProjectPath)
				}
				if existing.StartedAt <= 0 {
					existing.StartedAt = sess.ActiveTurn.StartedAt
				}
				byRun[runID] = existing
				continue
			}
			var activePrompt map[string]any
			if approvals != nil {
				activePrompt = approvals.PendingPromptForRun(runID)
			}
			interactionMode := firstNonEmptyStr(strings.TrimSpace(asString(sess.Policy["approvalMode"])), "default")
			mode := "native-session"
			if IsChatSession(&sess) {
				mode = "chat-session"
			}
			byRun[runID] = ActiveRunSummary{
				RunID:           runID,
				Provider:        strings.ToLower(strings.TrimSpace(sess.Provider)),
				AccountRef:      strings.TrimSpace(sess.ExecutionAccountRef),
				SessionID:       sess.SessionID,
				ProjectDirName:  dirName,
				ProjectPath:     strings.TrimSpace(sess.ProjectPath),
				StartedAt:       sess.ActiveTurn.StartedAt,
				InteractionMode: interactionMode,
				Mode:            mode,
				ContentSnapshot: "",
				ActivePrompt:    activePrompt,
			}
		}
	}

	out := make([]ActiveRunSummary, 0, len(byRun))
	for _, item := range byRun {
		if filterSessionID != "" && item.SessionID != filterSessionID {
			continue
		}
		if filterProvider != "" && !strings.EqualFold(item.Provider, filterProvider) {
			continue
		}
		// projectDirName 仅在两边都有值时参与过滤，兼容 codex/agy 无该字段的场景。
		if filterProjectDirName != "" && item.ProjectDirName != "" && item.ProjectDirName != filterProjectDirName {
			continue
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt != out[j].StartedAt {
			return out[i].StartedAt < out[j].StartedAt
		}
		return out[i].RunID < out[j].RunID
	})
	return out, nil
}

// WriteRunInput 向活动运行写入 PTY 输入（mode=="input"）或 mid-run steer（mode=="steer"）。
func (s *Service) WriteRunInput(_ context.Context, runID, input string, appendNewline bool, mode string) error {
	reg := s.getActiveRun(runID)
	if reg == nil {
		return NewError("native_chat_run_not_found", http.StatusNotFound, nil)
	}
	if input == "" {
		return NewError("native_chat_input_empty", http.StatusBadRequest, nil)
	}

	var err error
	if strings.EqualFold(strings.TrimSpace(mode), "steer") {
		if reg.WriteSteer == nil {
			return NewError("native_steer_unsupported", http.StatusBadRequest, nil)
		}
		err = reg.WriteSteer(input)
	} else {
		if reg.WriteInput == nil {
			return NewError("native_chat_input_failed", http.StatusBadRequest, map[string]any{
				"message": "该运行未启用交互式标准输入通道",
			})
		}
		err = reg.WriteInput(input, appendNewline)
	}
	if err != nil {
		if errorCode(err) == "native_session_run_not_active" {
			s.UnregisterActiveRun(reg.RunID)
		}
		return ensureRunControlHTTPStatus(err, http.StatusBadRequest, "native_chat_input_failed")
	}
	return nil
}

// ResizeRun 调整活动 PTY 运行的终端尺寸并按 [20..400] x [4..200] 钳位。
func (s *Service) ResizeRun(_ context.Context, runID string, cols, rows int) (int, int, error) {
	reg := s.getActiveRun(runID)
	if reg == nil {
		return 0, 0, NewError("native_chat_run_not_found", http.StatusNotFound, nil)
	}
	if cols <= 0 || rows <= 0 {
		return 0, 0, NewError("native_chat_resize_invalid", http.StatusBadRequest, nil)
	}
	clampedCols := clampInt(cols, minRunTerminalCols, maxRunTerminalCols)
	clampedRows := clampInt(rows, minRunTerminalRows, maxRunTerminalRows)
	if reg.Resize != nil {
		if err := reg.Resize(clampedCols, clampedRows); err != nil {
			if errorCode(err) == "native_session_run_not_active" {
				s.UnregisterActiveRun(reg.RunID)
			}
			return 0, 0, ensureRunControlHTTPStatus(err, http.StatusBadRequest, "native_chat_resize_failed")
		}
	}
	return clampedCols, clampedRows, nil
}

// AbortRun 显式中止指定活动运行并清理关联挂起审批；不存在时按幂等成功处理（alreadyGone=true）。
func (s *Service) AbortRun(ctx context.Context, runID string) (bool, error) {
	id := strings.TrimSpace(runID)
	if s == nil || id == "" {
		return true, nil
	}
	s.ensureRunsControl()

	if s.standaloneApprovals != nil {
		s.standaloneApprovals.CancelForRun(id, "aborted")
	}

	reg := s.getActiveRun(id)
	sessionID := ""
	if reg != nil {
		sessionID = reg.SessionID
	} else {
		sessionID = s.sessionIDForActiveRun(ctx, id)
	}

	if reg == nil && sessionID == "" {
		return true, nil
	}

	if sessionID != "" && s.actors != nil && s.actors.Has(sessionID) {
		if surface := s.LookupApprovalSurface(id, sessionID); surface != nil {
			surface.Dispose()
		}
		_, intErr := s.DispatchCommand(ctx, sessionID, map[string]any{
			"commandId": s.nextControlID("abort"),
			"type":      "turn.interrupt",
			"payload":   map[string]any{"reason": "user_aborted"},
		})
		if intErr != nil && reg != nil && reg.Abort != nil {
			if err := reg.Abort(); err != nil {
				return false, ensureRunControlHTTPStatus(err, http.StatusBadRequest, "native_chat_abort_failed")
			}
		}
		s.UnregisterActiveRun(id)
		return false, nil
	}

	if reg != nil && reg.Abort != nil {
		if err := reg.Abort(); err != nil {
			return false, ensureRunControlHTTPStatus(err, http.StatusBadRequest, "native_chat_abort_failed")
		}
	}
	s.UnregisterActiveRun(id)
	return false, nil
}

// RegisterApprovalSurface 为会话登记对应的 NativeApprovalSurface。
func (s *Service) RegisterApprovalSurface(sessionID string, surface *NativeApprovalSurface) {
	sid := strings.TrimSpace(sessionID)
	if s == nil || sid == "" || surface == nil {
		return
	}
	s.ensureRunsControl()
	s.runsMu.Lock()
	s.surfacesBySession[sid] = surface
	s.runsMu.Unlock()
}

// UnregisterApprovalSurface 在驱动销毁时移除指针匹配的审批面，避免误删新实例。
func (s *Service) UnregisterApprovalSurface(sessionID string, surface *NativeApprovalSurface) {
	sid := strings.TrimSpace(sessionID)
	if s == nil || sid == "" || surface == nil {
		return
	}
	s.runsMu.Lock()
	if s.surfacesBySession[sid] == surface {
		delete(s.surfacesBySession, sid)
	}
	for runID, bound := range s.surfacesByRun {
		if bound == surface {
			delete(s.surfacesByRun, runID)
		}
	}
	s.runsMu.Unlock()
}

// BindApprovalSurfaceRun 绑定 runId 与 NativeApprovalSurface。
func (s *Service) BindApprovalSurfaceRun(runID string, surface *NativeApprovalSurface) {
	id := strings.TrimSpace(runID)
	if s == nil || id == "" || surface == nil {
		return
	}
	s.ensureRunsControl()
	s.runsMu.Lock()
	s.surfacesByRun[id] = surface
	s.runsMu.Unlock()
}

// UnbindApprovalSurfaceRun 解绑指定 runId 上的 NativeApprovalSurface。
func (s *Service) UnbindApprovalSurfaceRun(runID string, surface *NativeApprovalSurface) {
	id := strings.TrimSpace(runID)
	if s == nil || id == "" {
		return
	}
	s.runsMu.Lock()
	if surface == nil || s.surfacesByRun[id] == surface {
		delete(s.surfacesByRun, id)
	}
	s.runsMu.Unlock()
}

// LookupApprovalSurface 按 runId 或 sessionId 查找绑定的 Canonical NativeApprovalSurface。
func (s *Service) LookupApprovalSurface(runID, sessionID string) *NativeApprovalSurface {
	if s == nil {
		return nil
	}
	rid := strings.TrimSpace(runID)
	sid := strings.TrimSpace(sessionID)

	s.runsMu.RLock()
	if rid != "" {
		if surf := s.surfacesByRun[rid]; surf != nil {
			s.runsMu.RUnlock()
			return surf
		}
		if reg := s.activeRuns[rid]; reg != nil && reg.SessionID != "" {
			if surf := s.surfacesBySession[reg.SessionID]; surf != nil {
				s.runsMu.RUnlock()
				return surf
			}
		}
	}
	if sid != "" {
		if surf := s.surfacesBySession[sid]; surf != nil {
			s.runsMu.RUnlock()
			return surf
		}
	}
	s.runsMu.RUnlock()

	if rid != "" && s.publisher != nil {
		if resolvedSID := s.sessionIDForActiveRun(context.Background(), rid); resolvedSID != "" {
			s.runsMu.RLock()
			surf := s.surfacesBySession[resolvedSID]
			s.runsMu.RUnlock()
			return surf
		}
	}
	return nil
}

// RequestNativeApproval 处理权限工具长挂审批请求（优先走 Canonical 交互面，否则走独立审批等待表）。
func (s *Service) RequestNativeApproval(ctx context.Context, req NativeApprovalInboundRequest) (map[string]any, error) {
	if s == nil {
		return nil, NewError("chat_runtime_unavailable", http.StatusServiceUnavailable, nil)
	}
	s.ensureRunsControl()

	if surface := s.LookupApprovalSurface(req.RunID, req.SessionID); surface != nil {
		decision, err := surface.Request(ctx, NativeApprovalRequest{
			RunID:     strings.TrimSpace(req.RunID),
			ToolName:  firstNonEmptyStr(strings.TrimSpace(req.ToolName), "tool"),
			Detail:    formatApprovalDetail(req.ToolName, req.Input),
			Input:     CloneMap(req.Input),
			ToolUseID: strings.TrimSpace(req.ToolUseID),
		})
		if err != nil {
			return nil, err
		}
		return decision, nil
	}
	return s.standaloneApprovals.WaitForDecision(ctx, req)
}

// DecideNativeApproval 处理来自 REST 审批端点（/runs/{runId}/approvals/{approvalId}）的用户决策。
func (s *Service) DecideNativeApproval(
	ctx context.Context,
	runID, approvalID, decision, message string,
) (NativeApprovalDecisionOutcome, error) {
	if s == nil {
		return NativeApprovalDecisionOutcome{}, NewError("chat_runtime_unavailable", http.StatusServiceUnavailable, nil)
	}
	s.ensureRunsControl()

	id := strings.TrimSpace(approvalID)
	normalizedDecision := "deny"
	if strings.EqualFold(strings.TrimSpace(decision), "allow") {
		normalizedDecision = "allow"
	}

	if id == "" {
		return NativeApprovalDecisionOutcome{
			ApprovalID:      id,
			AlreadyResolved: true,
		}, nil
	}

	if surface := s.LookupApprovalSurface(runID, ""); surface != nil {
		resolved, err := surface.ResolveDecision(ctx, id, normalizedDecision, message)
		if err != nil {
			return NativeApprovalDecisionOutcome{}, err
		}
		if resolved {
			return NativeApprovalDecisionOutcome{
				ApprovalID: id,
				Decision:   normalizedDecision,
			}, nil
		}
	}

	for _, surface := range s.snapshotSurfaces() {
		if !surface.HasPending(id) {
			continue
		}
		resolved, err := surface.ResolveDecision(ctx, id, normalizedDecision, message)
		if err != nil {
			return NativeApprovalDecisionOutcome{}, err
		}
		if resolved {
			return NativeApprovalDecisionOutcome{
				ApprovalID: id,
				Decision:   normalizedDecision,
			}, nil
		}
	}

	if entry := s.standaloneApprovals.Decide(id, normalizedDecision, message); entry != nil {
		return NativeApprovalDecisionOutcome{
			ApprovalID: id,
			Decision:   normalizedDecision,
		}, nil
	}

	return NativeApprovalDecisionOutcome{
		ApprovalID:      id,
		AlreadyResolved: true,
	}, nil
}

// CLIInstallConfirmations 返回安装缺失 CLI 前的确认注册表。
func (s *Service) CLIInstallConfirmations() *CLIInstallConfirmationRegistry {
	if s == nil {
		return nil
	}
	s.ensureRunsControl()
	return s.cliConfirmations
}

// DecideCLIInstallConfirmation 裁决一次待决的 CLI 安装确认。
func (s *Service) DecideCLIInstallConfirmation(confirmationID, decision, source string) *CLIInstallConfirmationOutcome {
	if s == nil {
		return nil
	}
	s.ensureRunsControl()
	return s.cliConfirmations.Decide(confirmationID, decision, source)
}

func (s *Service) snapshotSurfaces() []*NativeApprovalSurface {
	s.runsMu.RLock()
	defer s.runsMu.RUnlock()
	seen := make(map[*NativeApprovalSurface]struct{}, len(s.surfacesBySession)+len(s.surfacesByRun))
	out := make([]*NativeApprovalSurface, 0, len(seen))
	for _, surf := range s.surfacesBySession {
		if surf != nil {
			if _, ok := seen[surf]; !ok {
				seen[surf] = struct{}{}
				out = append(out, surf)
			}
		}
	}
	for _, surf := range s.surfacesByRun {
		if surf != nil {
			if _, ok := seen[surf]; !ok {
				seen[surf] = struct{}{}
				out = append(out, surf)
			}
		}
	}
	return out
}

func (s *Service) sessionIDForActiveRun(ctx context.Context, runID string) string {
	if s == nil || s.publisher == nil || strings.TrimSpace(runID) == "" {
		return ""
	}
	sessions, err := s.ListSessions(ctx, ListSessionsFilter{})
	if err != nil {
		return ""
	}
	for _, sess := range sessions {
		if sess.ActiveTurn != nil && strings.TrimSpace(sess.ActiveTurn.RunID) == runID &&
			(sess.State == "running" || sess.State == "waiting_input") {
			return sess.SessionID
		}
	}
	return ""
}

func formatApprovalDetail(toolName string, input map[string]any) string {
	name := strings.TrimSpace(toolName)
	if len(input) > 0 {
		if raw, err := json.MarshalIndent(input, "", "  "); err == nil {
			if name != "" {
				return name + "\n" + string(raw)
			}
			return string(raw)
		}
	}
	return name
}

func clampInt(val, minVal, maxVal int) int {
	if val < minVal {
		return minVal
	}
	if val > maxVal {
		return maxVal
	}
	return val
}

func errorCode(err error) string {
	if rtErr, ok := err.(*Error); ok && rtErr != nil {
		return rtErr.Code
	}
	return ""
}

func ensureRunControlHTTPStatus(err error, defaultStatus int, fallbackCode string) error {
	if err == nil {
		return nil
	}
	if rtErr, ok := err.(*Error); ok && rtErr != nil {
		if rtErr.StatusCode == http.StatusNotFound || rtErr.StatusCode == http.StatusBadRequest {
			return rtErr
		}
		return NewErrorWithMessage(firstNonEmptyStr(rtErr.Code, fallbackCode), defaultStatus, rtErr.Error(), rtErr.Details)
	}
	return NewErrorWithMessage(fallbackCode, defaultStatus, err.Error(), nil)
}

func (s *Service) nextControlID(prefix string) string {
	if s != nil && s.opts.IDFactory != nil {
		return s.opts.IDFactory(prefix)
	}
	if s != nil && s.store != nil {
		return s.store.NewID(prefix)
	}
	return randomControlID(prefix)
}

func randomControlID(prefix string) string {
	var raw [8]byte
	_, _ = rand.Read(raw[:])
	return fmt.Sprintf("%s-%d-%s", firstNonEmptyStr(strings.TrimSpace(prefix), "id"), time.Now().UnixNano(), hex.EncodeToString(raw[:]))
}
