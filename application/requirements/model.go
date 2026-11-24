// Package requirements 是「需求管理」的领域层：工作区绑定、需求状态机、
// AI 拆解与调度编排都集中在这里，HTTP/存储/模型/执行只是端口。
package requirements

import (
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 需求状态。
//
//	idea     临时想法，未确认，不可调度
//	ready    已确认，等待调度器排期
//	queued   调度器已领取，正在创建执行会话
//	running  AI 正在执行
//	waiting  执行中等待用户输入或审批
//	review   执行完成，等待人工验收
//	done     已验收完成
//	blocked  执行失败或缺少必要条件
//	archived 归档，不参与调度
const (
	StatusIdea     = "idea"
	StatusReady    = "ready"
	StatusQueued   = "queued"
	StatusRunning  = "running"
	StatusWaiting  = "waiting"
	StatusReview   = "review"
	StatusDone     = "done"
	StatusBlocked  = "blocked"
	StatusArchived = "archived"
)

// 执行模式：plan 先计划再执行；goal 以目标为标准推进；loop 每轮检查目标并续跑。
const (
	ModePlan = "plan"
	ModeGoal = "goal"
	ModeLoop = "loop"
)

// 优先级按数值升序执行。
const (
	PriorityHigh   = 0
	PriorityNormal = 1
	PriorityLow    = 2
)

var (
	// ErrNotFound 表示需求或工作区不存在。
	ErrNotFound = errors.New("requirements_not_found")
	// ErrInvalid 表示输入不满足领域约束。
	ErrInvalid = errors.New("requirements_invalid")
	// ErrConflict 表示状态迁移或并发写入不被允许。
	ErrConflict = errors.New("requirements_conflict")
	// ErrUnavailable 表示执行依赖（账号、会话运行时）暂时不可用。
	ErrUnavailable = errors.New("requirements_unavailable")
)

// Step 是需求拆解后的一个可执行步骤。
type Step struct {
	Text   string `json:"text"`
	Status string `json:"status"`
}

// Workspace 绑定一个确定的需求执行范围，可包含一个或多个项目路径。
// 需求在调度时必须恰好关联一个 Workspace。
type Workspace struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	ProjectPaths []string `json:"projectPaths"`
	Provider     string   `json:"provider"`
	Model        string   `json:"model"`
	AccountRef   string   `json:"accountRef"`
	MaxParallel  int      `json:"maxParallel"`
	CreatedAt    int64    `json:"createdAt"`
	UpdatedAt    int64    `json:"updatedAt"`
}

// PrimaryPath 返回执行会话的工作目录（第一个路径）。
func (workspace Workspace) PrimaryPath() string {
	if len(workspace.ProjectPaths) == 0 {
		return ""
	}
	return workspace.ProjectPaths[0]
}

// Normalize 清理并校验工作区输入。
func (workspace *Workspace) Normalize() error {
	if workspace == nil {
		return ErrInvalid
	}
	workspace.Name = strings.TrimSpace(workspace.Name)
	if workspace.Name == "" {
		return fmt.Errorf("%w: 工作区名称不能为空", ErrInvalid)
	}
	seen := make(map[string]struct{}, len(workspace.ProjectPaths))
	paths := make([]string, 0, len(workspace.ProjectPaths))
	for _, raw := range workspace.ProjectPaths {
		path := strings.TrimSpace(raw)
		if path == "" {
			continue
		}
		if !filepath.IsAbs(path) {
			return fmt.Errorf("%w: 项目路径必须是绝对路径：%s", ErrInvalid, path)
		}
		path = filepath.Clean(path)
		if _, found := seen[path]; found {
			continue
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	if len(paths) == 0 {
		return fmt.Errorf("%w: 工作区至少需要一个项目路径", ErrInvalid)
	}
	workspace.ProjectPaths = paths
	workspace.Provider = strings.TrimSpace(workspace.Provider)
	workspace.Model = strings.TrimSpace(workspace.Model)
	workspace.AccountRef = strings.TrimSpace(workspace.AccountRef)
	if workspace.MaxParallel <= 0 {
		workspace.MaxParallel = 1
	}
	if workspace.MaxParallel > 4 {
		workspace.MaxParallel = 4
	}
	return nil
}

// Requirement 是需求卡片。
type Requirement struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Description   string `json:"description"`
	Status        string `json:"status"`
	Priority      int    `json:"priority"`
	Position      int    `json:"position"`
	WorkspaceID   string `json:"workspaceId"`
	Mode          string `json:"mode"`
	Parallel      bool   `json:"parallel"`
	Steps         []Step `json:"steps"`
	RefinedAt     int64  `json:"refinedAt"`
	Progress      int    `json:"progress"`
	ProgressNote  string `json:"progressNote"`
	SessionID     string `json:"sessionId"`
	PeerMessageID string `json:"peerMessageId"`
	TurnID        string `json:"turnId"`
	LoopCount     int    `json:"loopCount"`
	LastError     string `json:"lastError"`
	Source        string `json:"source"`
	CreatedAt     int64  `json:"createdAt"`
	UpdatedAt     int64  `json:"updatedAt"`
	StartedAt     int64  `json:"startedAt"`
	CompletedAt   int64  `json:"completedAt"`
}

// SchedulerSettings 是调度器的 AI 执行目标配置。
type SchedulerSettings struct {
	Enabled    bool   `json:"enabled"`
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	AccountRef string `json:"accountRef"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// DefaultSchedulerSettings 使用 AWS Server + AGY + Gemini Neon xhigh。
func DefaultSchedulerSettings() SchedulerSettings {
	return SchedulerSettings{Enabled: true, Provider: "agy", Model: "gemini-4-neon-xhigh"}
}

// Normalized 清理调度器配置。
func (settings SchedulerSettings) Normalized() SchedulerSettings {
	settings.Provider = strings.TrimSpace(settings.Provider)
	settings.Model = strings.TrimSpace(settings.Model)
	settings.AccountRef = strings.TrimSpace(settings.AccountRef)
	if settings.Provider == "" {
		settings.Provider = "agy"
	}
	if settings.Model == "" {
		settings.Model = "gemini-4-neon-xhigh"
	}
	return settings
}

// Event 是需求时间线事件。
type Event struct {
	ID            string `json:"id"`
	RequirementID string `json:"requirementId"`
	Kind          string `json:"kind"`
	Message       string `json:"message"`
	At            int64  `json:"at"`
}

// RequirementPatch 是局部更新；nil 表示不修改。
type RequirementPatch struct {
	Title       *string `json:"title,omitempty"`
	Description *string `json:"description,omitempty"`
	Status      *string `json:"status,omitempty"`
	Priority    *int    `json:"priority,omitempty"`
	Position    *int    `json:"position,omitempty"`
	WorkspaceID *string `json:"workspaceId,omitempty"`
	Mode        *string `json:"mode,omitempty"`
	Parallel    *bool   `json:"parallel,omitempty"`
	Steps       *[]Step `json:"steps,omitempty"`
}

// ProgressUpdate 是执行器回写的进度。
type ProgressUpdate struct {
	Status        string
	Progress      int
	Note          string
	TurnID        string
	SessionID     string
	PeerMessageID string
	LastError     string
	StepIndex     int
	StepStatus    string
}

// NormalizeStatus 校验并返回规范状态。
func NormalizeStatus(raw string) (string, error) {
	status := strings.ToLower(strings.TrimSpace(raw))
	switch status {
	case StatusIdea, StatusReady, StatusQueued, StatusRunning, StatusWaiting, StatusReview, StatusDone, StatusBlocked, StatusArchived:
		return status, nil
	default:
		return "", fmt.Errorf("%w: 未知需求状态 %q", ErrInvalid, raw)
	}
}

// NormalizeMode 校验执行模式。
func NormalizeMode(raw string) (string, error) {
	mode := strings.ToLower(strings.TrimSpace(raw))
	if mode == "" {
		return ModePlan, nil
	}
	switch mode {
	case ModePlan, ModeGoal, ModeLoop:
		return mode, nil
	default:
		return "", fmt.Errorf("%w: 未知执行模式 %q", ErrInvalid, raw)
	}
}

// NormalizePriority 把输入限制在已知优先级。
func NormalizePriority(value int) int {
	if value < PriorityHigh {
		return PriorityHigh
	}
	if value > PriorityLow {
		return PriorityLow
	}
	return value
}

// CanDispatch 只有已确认且已绑定工作区的需求可以进入调度。
func (requirement Requirement) CanDispatch() bool {
	if requirement.WorkspaceID == "" {
		return false
	}
	switch requirement.Status {
	case StatusReady:
		return true
	default:
		return false
	}
}

// IsActive 表示该需求正在占用执行槽位。
func (requirement Requirement) IsActive() bool {
	switch requirement.Status {
	case StatusQueued, StatusRunning, StatusWaiting:
		return true
	default:
		return false
	}
}

// StepsDone 返回已完成步骤数。
func StepsDone(steps []Step) int {
	done := 0
	for _, step := range steps {
		if step.Status == "done" {
			done++
		}
	}
	return done
}

// SortRequirements 按优先级、人工顺序与创建时间排序。
func SortRequirements(items []Requirement) {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Priority != items[j].Priority {
			return items[i].Priority < items[j].Priority
		}
		if items[i].Position != items[j].Position {
			return items[i].Position < items[j].Position
		}
		return items[i].CreatedAt < items[j].CreatedAt
	})
}

// Transition 校验需求状态迁移；调度器只能驱动与执行相关的状态。
func Transition(current, next string) error {
	if current == next {
		return nil
	}
	allowed := map[string]map[string]struct{}{
		StatusIdea:     {StatusReady: {}, StatusBlocked: {}, StatusArchived: {}},
		StatusReady:    {StatusIdea: {}, StatusQueued: {}, StatusBlocked: {}, StatusArchived: {}},
		StatusQueued:   {StatusRunning: {}, StatusReady: {}, StatusBlocked: {}, StatusArchived: {}},
		StatusRunning:  {StatusWaiting: {}, StatusReview: {}, StatusBlocked: {}, StatusDone: {}, StatusArchived: {}},
		StatusWaiting:  {StatusRunning: {}, StatusReview: {}, StatusBlocked: {}, StatusDone: {}, StatusArchived: {}},
		StatusReview:   {StatusDone: {}, StatusRunning: {}, StatusReady: {}, StatusBlocked: {}, StatusArchived: {}},
		StatusBlocked:  {StatusReady: {}, StatusArchived: {}},
		StatusDone:     {StatusReady: {}, StatusArchived: {}},
		StatusArchived: {StatusReady: {}},
	}
	if _, ok := allowed[current][next]; !ok {
		return fmt.Errorf("%w: 不允许从 %s 迁移到 %s", ErrConflict, current, next)
	}
	return nil
}

// NowMillis 返回毫秒时间戳；测试与回放共用。
func NowMillis(clock func() time.Time) int64 {
	if clock == nil {
		return time.Now().UnixMilli()
	}
	return clock().UnixMilli()
}
