package requirements

import "context"

// Store 是需求的持久化端口。
type Store interface {
	ListWorkspaces(ctx context.Context) ([]Workspace, error)
	GetWorkspace(ctx context.Context, id string) (Workspace, error)
	SaveWorkspace(ctx context.Context, workspace Workspace) error
	DeleteWorkspace(ctx context.Context, id string) error

	ListRequirements(ctx context.Context) ([]Requirement, error)
	GetRequirement(ctx context.Context, id string) (Requirement, error)
	SaveRequirement(ctx context.Context, requirement Requirement) error
	DeleteRequirement(ctx context.Context, id string) error

	AppendEvent(ctx context.Context, event Event) error
	ListEvents(ctx context.Context, requirementID string, limit int) ([]Event, error)

	GetSchedulerSettings(ctx context.Context) (SchedulerSettings, error)
	SaveSchedulerSettings(ctx context.Context, settings SchedulerSettings) error
}

// ModelRequest 是需求优化的一次模型调用。
type ModelRequest struct {
	Provider   string
	Model      string
	AccountRef string
	System     string
	Prompt     string
}

// ModelClient 返回模型原始文本输出。
type ModelClient interface {
	Complete(ctx context.Context, request ModelRequest) (string, error)
}

// WorkRequest 描述一次执行会话的创建参数。
type WorkRequest struct {
	RequirementID string
	Title         string
	Prompt        string
	Mode          string
	Workspace     Workspace
	Provider      string
	Model         string
	AccountRef    string
	GoalObjective string
}

// WorkHandle 是执行器创建会话后的身份。
type WorkHandle struct {
	SessionID     string
	PeerMessageID string
}

// Dispatcher 负责把需求变成真实的 AI 工作会话，并通过 peer 投递任务。
type Dispatcher interface {
	Start(ctx context.Context, request WorkRequest) (WorkHandle, error)
	Interrupt(ctx context.Context, sessionID string) error
}

// Scheduler 是调度循环的最小生命周期。
type Scheduler interface {
	Start(ctx context.Context)
	Stop()
	RunOnce(ctx context.Context) (DispatchSummary, error)
	Status() SchedulerStatus
}

// DispatchSummary 是一次调度扫描的结果。
type DispatchSummary struct {
	Scanned   int    `json:"scanned"`
	Started   int    `json:"started"`
	Skipped   int    `json:"skipped"`
	Failed    int    `json:"failed"`
	LastRun   int64  `json:"lastRun"`
	LastError string `json:"lastError"`
}

// SchedulerStatus 是调度器对外状态。
type SchedulerStatus struct {
	Enabled    bool   `json:"enabled"`
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	AccountRef string `json:"accountRef"`
	Running    int    `json:"running"`
	Queued     int    `json:"queued"`
	Ready      int    `json:"ready"`
	LastRun    int64  `json:"lastRun"`
	LastError  string `json:"lastError"`
}
