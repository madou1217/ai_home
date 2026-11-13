// Package managementops 提供管理面运行态聚合、状态索引同步、SSE 监听与用量分析/扫描的 Go 核心实现。
package managementops

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"math"
	"strings"
	"time"
)

const (
	// DefaultServerHost 与 Node lib/server/server-defaults.js 保持一致。
	DefaultServerHost = "127.0.0.1"
	// DefaultServerPort 与 Node lib/server/server-defaults.js 保持一致。
	DefaultServerPort = 9527
	// DefaultUsageThresholdPct 是未配置 config:usage 时的默认额度阈值。
	DefaultUsageThresholdPct = 95
	// DefaultModelsCacheTTL 是 /models 的默认缓存窗口。
	DefaultModelsCacheTTL = 5 * time.Minute
	// DefaultModelAccountLimit 是单次模型探索默认账号上限。
	DefaultModelAccountLimit = 3
	// MaxUsageQueryLimit 限制单次明细请求上限，对齐 Node normalizeQuery。
	MaxUsageQueryLimit = 500
	// DefaultUsageQueryLimit 是明细请求的默认条数。
	DefaultUsageQueryLimit = 50
	// ModelUsageCostDecimals 对齐 Node model-usage-precision.js，消除 IEEE-754 并行归约噪声。
	ModelUsageCostDecimals = 9
)

var (
	// ErrInvalidUsageQuery 表示时间窗或查询参数无效（对应 HTTP 400 invalid_usage_query）。
	ErrInvalidUsageQuery = errors.New("invalid_usage_query")
	// ErrBreakdownScopeRequired 表示 breakdown 查询缺少 sessionId 与 model（400 usage_breakdown_scope_required）。
	ErrBreakdownScopeRequired = errors.New("usage_breakdown_scope_required")
	// ErrSessionIDRequired 表示 session-detail 查询缺少 sessionId（400 session_id_required）。
	ErrSessionIDRequired = errors.New("session_id_required")
	// ErrUsageUnavailable 表示用量存储不可用（503 model_usage_unavailable）。
	ErrUsageUnavailable = errors.New("model_usage_unavailable")
	// ErrQueryJobNotFound 表示渐进看板查询作业不存在（404 model_usage_query_job_not_found）。
	ErrQueryJobNotFound = errors.New("model_usage_query_job_not_found")
	// ErrQueryCancelled 表示渐进看板查询被用户取消。
	ErrQueryCancelled = errors.New("model_usage_query_cancelled")
	// ErrScanUnsupportedProvider 表示扫描请求包含不支持用量扫描的 Provider。
	ErrScanUnsupportedProvider = errors.New("model_usage_scan_unsupported_provider")
	// ErrRestartUnavailable 表示宿主未提供 server 重启端口（503 management_restart_unavailable）。
	ErrRestartUnavailable = errors.New("management_restart_unavailable")
	// ErrInvalidStateIndexPayload 表示状态索引写请求参数非法（400 invalid_state_index_payload）。
	ErrInvalidStateIndexPayload = errors.New("invalid_state_index_payload")
	// ErrStateIndexUnavailable 表示 app-state.db 状态索引不可用（503 state_index_unavailable）。
	ErrStateIndexUnavailable = errors.New("state_index_unavailable")
	// ErrManagementUnavailable 表示管理核心服务尚未初始化。
	ErrManagementUnavailable = errors.New("management_unavailable")
)

// StatusTotals 汇总全池账号运行态分布，键集合与 Node management.js 完全对齐。
type StatusTotals struct {
	Healthy            int `json:"healthy"`
	RateLimited        int `json:"rate_limited"`
	AuthInvalid        int `json:"auth_invalid"`
	Overloaded         int `json:"overloaded"`
	TransientNetwork   int `json:"transient_network"`
	ServiceUnavailable int `json:"service_unavailable"`
	UpstreamError      int `json:"upstream_error"`
	CoolingDown        int `json:"cooling_down"`
	Unknown            int `json:"unknown"`
}

// ProviderStatus 描述单个 Provider 下的账号数与运行态统计。
type ProviderStatus struct {
	Total    int            `json:"total"`
	Active   int            `json:"active"`
	Statuses map[string]int `json:"statuses"`
}

// QueueSnapshot 描述单 Provider 执行队列快照。
type QueueSnapshot struct {
	Name           string `json:"name"`
	Running        int    `json:"running"`
	Queued         int    `json:"queued"`
	MaxConcurrency int    `json:"maxConcurrency"`
	QueueLimit     int    `json:"queueLimit"`
	TotalScheduled int64  `json:"totalScheduled"`
	TotalRejected  int64  `json:"totalRejected"`
}

// StatusResponse 是 /v0/management/status 的完整响应契约。
type StatusResponse struct {
	OK                     bool                      `json:"ok"`
	Backend                string                    `json:"backend"`
	Host                   string                    `json:"host"`
	Port                   int                       `json:"port"`
	APIKeyConfigured       bool                      `json:"apiKeyConfigured"`
	ProviderMode           string                    `json:"providerMode"`
	Strategy               string                    `json:"strategy"`
	TotalAccounts          int                       `json:"totalAccounts"`
	ActiveAccounts         int                       `json:"activeAccounts"`
	CooldownAccounts       int                       `json:"cooldownAccounts"`
	StatusTotals           StatusTotals              `json:"statusTotals"`
	Providers              map[string]ProviderStatus `json:"providers"`
	SessionAffinity        map[string]int            `json:"sessionAffinity"`
	Queue                  map[string]QueueSnapshot  `json:"queue"`
	ModelsCached           int                       `json:"modelsCached"`
	ModelsUpdatedAt        int64                     `json:"modelsUpdatedAt"`
	ModelRegistryUpdatedAt int64                     `json:"modelRegistryUpdatedAt"`
	SuccessRate            float64                   `json:"successRate"`
	TimeoutRate            float64                   `json:"timeoutRate"`
	TotalRequests          uint64                    `json:"totalRequests"`
	UptimeSec              int64                     `json:"uptimeSec"`
}

// MetricsResponse 是 /v0/management/metrics 的完整响应契约。
type MetricsResponse struct {
	OK                bool                     `json:"ok"`
	TotalRequests     uint64                   `json:"totalRequests"`
	TotalSuccess      uint64                   `json:"totalSuccess"`
	TotalFailures     uint64                   `json:"totalFailures"`
	TotalTimeouts     uint64                   `json:"totalTimeouts"`
	SuccessRate       float64                  `json:"successRate"`
	TimeoutRate       float64                  `json:"timeoutRate"`
	RouteCounts       map[string]uint64        `json:"routeCounts"`
	ProviderCounts    map[string]uint64        `json:"providerCounts"`
	ProviderSuccess   map[string]uint64        `json:"providerSuccess"`
	ProviderFailures  map[string]uint64        `json:"providerFailures"`
	Queue             map[string]QueueSnapshot `json:"queue"`
	LastErrors        []map[string]any         `json:"lastErrors"`
	Memory            map[string]any           `json:"memory,omitempty"`
	RequestBodyBudget map[string]any           `json:"requestBodyBudget,omitempty"`
	AccountActivity   map[string]any           `json:"accountActivity"`
}

// ModelsResponse 是 /v0/management/models 的响应契约。
type ModelsResponse struct {
	OK              bool     `json:"ok"`
	Cached          bool     `json:"cached"`
	UpdatedAt       int64    `json:"updatedAt"`
	ScannedAccounts int      `json:"scannedAccounts"`
	Sources         int      `json:"sources"`
	Source          string   `json:"source"`
	Models          []string `json:"models"`
	FirstError      string   `json:"firstError"`
}

// ManagementAccount 是 /v0/management/accounts 中的单条账号运行态视图。
type ManagementAccount struct {
	RuntimeStatus       string           `json:"runtimeStatus"`
	RuntimeUntil        int64            `json:"runtimeUntil"`
	RuntimeReason       string           `json:"runtimeReason"`
	AccountRef          string           `json:"accountRef"`
	Provider            string           `json:"provider"`
	Status              string           `json:"status"`
	Email               string           `json:"email"`
	BaseURL             string           `json:"baseUrl"`
	PlanType            string           `json:"planType"`
	Configured          bool             `json:"configured"`
	APIKeyMode          bool             `json:"apiKeyMode"`
	RemainingPct        *float64         `json:"remainingPct"`
	UsageSnapshot       any              `json:"usageSnapshot"`
	QuotaStatus         string           `json:"quotaStatus"`
	QuotaReason         string           `json:"quotaReason"`
	SchedulableStatus   string           `json:"schedulableStatus"`
	SchedulableReason   string           `json:"schedulableReason"`
	HasAccessToken      bool             `json:"hasAccessToken"`
	HasRefreshToken     bool             `json:"hasRefreshToken"`
	CooldownUntil       int64            `json:"cooldownUntil"`
	ModelCooldowns      map[string]int64 `json:"modelCooldowns"`
	ModelCooldownCount  int              `json:"modelCooldownCount"`
	LastRefresh         int64            `json:"lastRefresh"`
	ConsecutiveFailures int              `json:"consecutiveFailures"`
	SuccessCount        int              `json:"successCount"`
	FailCount           int              `json:"failCount"`
	LastError           string           `json:"lastError"`
}

// AccountsResponse 是 /v0/management/accounts 的响应契约。
type AccountsResponse struct {
	OK       bool                `json:"ok"`
	Accounts []ManagementAccount `json:"accounts"`
}

// ReloadResponse 是 POST /v0/management/reload 的响应契约。
type ReloadResponse struct {
	OK        bool           `json:"ok"`
	Reloaded  int            `json:"reloaded"`
	Providers map[string]int `json:"providers"`
}

// RestartResponse 是 POST /v0/management/restart 的响应契约。
type RestartResponse struct {
	OK            bool                 `json:"ok"`
	Action        string               `json:"action"`
	Running       bool                 `json:"running"`
	PID           int                  `json:"pid"`
	Started       bool                 `json:"started"`
	Stopped       RestartStoppedStatus `json:"stopped"`
	AppliedConfig map[string]any       `json:"appliedConfig"`
}

// RestartStoppedStatus 描述重启过程中旧进程的停止信息。
type RestartStoppedStatus struct {
	Stopped bool   `json:"stopped"`
	Reason  string `json:"reason"`
	Forced  bool   `json:"forced"`
}

// WatchSnapshotPayload 是 management/watch 推送的实时快照帧。
type WatchSnapshotPayload struct {
	Type     string              `json:"type"`
	Revision int64               `json:"revision"`
	Status   StatusResponse      `json:"status"`
	Metrics  MetricsResponse     `json:"metrics"`
	Accounts []ManagementAccount `json:"accounts"`
}

// StateIndexBaseState 描述状态索引的账号展示基础字段。
type StateIndexBaseState struct {
	Status       *string  `json:"status,omitempty"`
	Configured   bool     `json:"configured,omitempty"`
	APIKeyMode   bool     `json:"apiKeyMode,omitempty"`
	AuthMode     *string  `json:"authMode,omitempty"`
	RemainingPct *float64 `json:"remainingPct,omitempty"`
	DisplayName  *string  `json:"displayName,omitempty"`
}

// StateIndexOperationalStatusInput 对应 POST /state-index/operational-status。
type StateIndexOperationalStatusInput struct {
	Provider   string              `json:"provider"`
	AccountRef string              `json:"accountRef"`
	Status     string              `json:"status"`
	BaseState  StateIndexBaseState `json:"baseState"`
}

// StateIndexRuntimeStateInput 对应 POST /state-index/runtime-state。
type StateIndexRuntimeStateInput struct {
	Provider     string              `json:"provider"`
	AccountRef   string              `json:"accountRef"`
	RuntimeState map[string]any      `json:"runtimeState"`
	BaseState    StateIndexBaseState `json:"baseState"`
}

// StateIndexUpsertInput 对应 POST /state-index/upsert。
type StateIndexUpsertInput struct {
	Provider   string              `json:"provider"`
	AccountRef string              `json:"accountRef"`
	State      StateIndexBaseState `json:"state"`
}

// StateIndexPruneMissingInput 对应 POST /state-index/prune-missing。
type StateIndexPruneMissingInput struct {
	Provider     string   `json:"provider"`
	ExistingRefs []string `json:"existingRefs"`
}

// UsageRange 描述查询生效的起止日期（YYYY-MM-DD 或 ISO 字符串）。
type UsageRange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// UsageQuery 表示归一后的用量查询条件。
type UsageQuery struct {
	From      string `json:"from"`
	To        string `json:"to"`
	FromMS    int64  `json:"fromMs"`
	ToMS      int64  `json:"toMs"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	SessionID string `json:"sessionId"`
	Limit     int    `json:"limit"`
	Scan      bool   `json:"scan"`
}

// UsageStatsSummary 表示统计卡片聚合指标。
type UsageStatsSummary struct {
	TotalCalls               int     `json:"totalCalls"`
	TotalSessions            int     `json:"totalSessions"`
	TotalPrompts             int     `json:"totalPrompts"`
	InputTokens              int64   `json:"inputTokens"`
	OutputTokens             int64   `json:"outputTokens"`
	CacheReadInputTokens     int64   `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64   `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int64   `json:"reasoningOutputTokens"`
	TotalTokens              int64   `json:"totalTokens"`
	TotalCostUSD             float64 `json:"totalCostUsd"`
}

// UsageModelItem 表示按模型分组的聚合行。
type UsageModelItem struct {
	Provider                 string   `json:"provider"`
	Model                    string   `json:"model"`
	Calls                    int      `json:"calls"`
	InputTokens              int64    `json:"inputTokens"`
	OutputTokens             int64    `json:"outputTokens"`
	CacheReadInputTokens     int64    `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64    `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int64    `json:"reasoningOutputTokens"`
	TotalTokens              int64    `json:"totalTokens"`
	CostUSD                  float64  `json:"costUsd"`
	AccountCount             int      `json:"accountCount"`
	UnattributedCalls        int      `json:"unattributedCalls"`
	CacheHitRate             *float64 `json:"cacheHitRate"`
	AccountRefs              []string `json:"accountRefs,omitempty"`
}

// UsageSessionItem 表示按会话分组的聚合行。
type UsageSessionItem struct {
	Provider                 string   `json:"provider"`
	SessionID                string   `json:"sessionId"`
	Project                  string   `json:"project"`
	CWD                      string   `json:"cwd"`
	GitBranch                string   `json:"gitBranch"`
	StartedAtMS              int64    `json:"startedAtMs"`
	UpdatedAtMS              int64    `json:"updatedAtMs"`
	PromptCount              int      `json:"promptCount"`
	Calls                    int      `json:"calls"`
	InputTokens              int64    `json:"inputTokens"`
	OutputTokens             int64    `json:"outputTokens"`
	CacheReadInputTokens     int64    `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64    `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int64    `json:"reasoningOutputTokens"`
	TotalTokens              int64    `json:"totalTokens"`
	CostUSD                  float64  `json:"costUsd"`
	AccountCount             int      `json:"accountCount"`
	UnattributedCalls        int      `json:"unattributedCalls"`
	CacheHitRate             *float64 `json:"cacheHitRate"`
}

// UsageSessionPart 是渐进分片合并使用的中间会话聚合分片。
type UsageSessionPart struct {
	Provider                 string
	SessionID                string
	UsageProject             string
	SessionProject           string
	UsageCWD                 string
	SessionCWD               string
	UsageGitBranch           string
	SessionGitBranch         string
	SessionStartedAtMS       int64
	UsageStartedAtMS         int64
	SessionUpdatedAtMS       int64
	UsageUpdatedAtMS         int64
	PromptCount              int
	Calls                    int
	InputTokens              int64
	OutputTokens             int64
	CacheReadInputTokens     int64
	CacheCreationInputTokens int64
	ReasoningOutputTokens    int64
	TotalTokens              int64
	CostUSD                  float64
	AccountRefs              []string
	UnattributedCalls        int
}

// UsageTrendPoint 表示时间序列的单个桶指标。
type UsageTrendPoint struct {
	BucketStartMS            int64    `json:"bucketStartMs"`
	Calls                    int      `json:"calls"`
	InputTokens              int64    `json:"inputTokens"`
	OutputTokens             int64    `json:"outputTokens"`
	CacheReadInputTokens     int64    `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64    `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int64    `json:"reasoningOutputTokens"`
	TotalTokens              int64    `json:"totalTokens"`
	CostUSD                  float64  `json:"costUsd"`
	CacheHitRate             *float64 `json:"cacheHitRate"`
}

// UsageTrend 描述趋势分桶序列。
type UsageTrend struct {
	FromMS   int64             `json:"fromMs"`
	ToMS     int64             `json:"toMs"`
	BucketMS int64             `json:"bucketMs"`
	Points   []UsageTrendPoint `json:"points"`
}

// UsageDashboardPayload 是用量看板主视图数据。
type UsageDashboardPayload struct {
	Stats        UsageStatsSummary  `json:"stats"`
	Models       []UsageModelItem   `json:"models"`
	Sessions     []UsageSessionItem `json:"sessions"`
	ModelOptions []UsageModelItem   `json:"modelOptions"`
	Trend        UsageTrend         `json:"trend"`
}

// UsageDashboardShard 是单一时间分片查询结果，供渐进查询归并。
type UsageDashboardShard struct {
	Stats        UsageStatsSummary
	Models       []UsageModelItem
	SessionParts []UsageSessionPart
	ModelOptions []UsageModelItem
	Trend        UsageTrend
}

// UsageBreakdownSummary 汇总按账号/模型拆解的总览指标。
type UsageBreakdownSummary struct {
	Calls                    int      `json:"calls"`
	InputTokens              int64    `json:"inputTokens"`
	OutputTokens             int64    `json:"outputTokens"`
	CacheReadInputTokens     int64    `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64    `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int64    `json:"reasoningOutputTokens"`
	TotalTokens              int64    `json:"totalTokens"`
	CostUSD                  float64  `json:"costUsd"`
	AccountCount             int      `json:"accountCount"`
	UnattributedCalls        int      `json:"unattributedCalls"`
	CacheHitRate             *float64 `json:"cacheHitRate"`
}

// UsageBreakdownAccount 描述单个账号在特定会话/模型下的消耗与模型明细。
type UsageBreakdownAccount struct {
	AccountRef               string           `json:"accountRef"`
	AccountProvider          string           `json:"accountProvider"`
	Calls                    int              `json:"calls"`
	InputTokens              int64            `json:"inputTokens"`
	OutputTokens             int64            `json:"outputTokens"`
	CacheReadInputTokens     int64            `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64            `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int64            `json:"reasoningOutputTokens"`
	TotalTokens              int64            `json:"totalTokens"`
	CostUSD                  float64          `json:"costUsd"`
	ModelCount               int              `json:"modelCount"`
	CacheHitRate             *float64         `json:"cacheHitRate"`
	Models                   []UsageModelItem `json:"models"`
}

// UsageBreakdownResult 是 /usage/breakdown 的主体响应。
type UsageBreakdownResult struct {
	Summary  UsageBreakdownSummary   `json:"summary"`
	Accounts []UsageBreakdownAccount `json:"accounts"`
	Models   []UsageModelItem        `json:"models"`
}

// UsageSessionModelDetail 表示会话内单模型的统计行。
type UsageSessionModelDetail struct {
	Provider                 string   `json:"provider"`
	SessionID                string   `json:"sessionId"`
	Model                    string   `json:"model"`
	Calls                    int      `json:"calls"`
	InputTokens              int64    `json:"inputTokens"`
	OutputTokens             int64    `json:"outputTokens"`
	CacheReadInputTokens     int64    `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64    `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int64    `json:"reasoningOutputTokens"`
	TotalTokens              int64    `json:"totalTokens"`
	CostUSD                  float64  `json:"costUsd"`
	AccountCount             int      `json:"accountCount"`
	UnattributedCalls        int      `json:"unattributedCalls"`
	CacheHitRate             *float64 `json:"cacheHitRate"`
}

// UsageRequestRow 表示请求明细列表中的单条请求（成功用量或日志错误）。
type UsageRequestRow struct {
	RequestID                string  `json:"requestId"`
	Provider                 string  `json:"provider"`
	Model                    string  `json:"model"`
	ReasoningEffort          string  `json:"reasoningEffort"`
	Endpoint                 string  `json:"endpoint"`
	ClientIP                 string  `json:"clientIp"`
	RequestType              string  `json:"requestType"`
	BillingMode              string  `json:"billingMode"`
	InputTokens              int64   `json:"inputTokens"`
	OutputTokens             int64   `json:"outputTokens"`
	CacheReadInputTokens     int64   `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64   `json:"cacheCreationInputTokens"`
	ReasoningOutputTokens    int64   `json:"reasoningOutputTokens"`
	TotalTokens              int64   `json:"totalTokens"`
	CostUSD                  float64 `json:"costUsd"`
	DurationMS               int64   `json:"durationMs"`
	TimestampMS              int64   `json:"timestampMs"`
	StatusCode               int     `json:"statusCode"`
	ErrorCode                string  `json:"errorCode"`
	ErrorMessage             string  `json:"errorMessage"`
}

// UsageRequestDetailsPayload 是 /usage/requests 的主体响应。
type UsageRequestDetailsPayload struct {
	Usage  []UsageRequestRow `json:"usage"`
	Errors []UsageRequestRow `json:"errors"`
}

// UsageScanSource 描述扫描结果的来源元数据，对齐 usage-scan-contract.js。
type UsageScanSource struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Authority *string `json:"authority"`
	Conf      *string `json:"confidence"`
	FetchedAt string  `json:"fetchedAt"`
	Stale     bool    `json:"stale"`
}

// UsageScanCounts 汇总一次本地会话扫描的总计数。
type UsageScanCounts struct {
	Files           int `json:"files"`
	Records         int `json:"records"`
	Prompts         int `json:"prompts"`
	Skipped         int `json:"skipped"`
	FilesDeferred   int `json:"filesDeferred"`
	ReindexRequired int `json:"reindexRequired"`
}

// UsageScanProviderResult 描述单个 Provider 的扫描结果（三态 ok/empty/unavailable）。
type UsageScanProviderResult struct {
	Files           int    `json:"files"`
	Records         int    `json:"records"`
	Prompts         int    `json:"prompts"`
	Skipped         int    `json:"skipped"`
	FilesDeferred   int    `json:"filesDeferred"`
	ReindexRequired int    `json:"reindexRequired"`
	Errors          int    `json:"errors"`
	Reason          string `json:"reason"`
	Status          string `json:"status"`
}

// UsageScanAttempt 描述各目标 Provider 的扫描状态尝试记录。
type UsageScanAttempt struct {
	Provider string `json:"provider"`
	Status   string `json:"status"`
	Reason   string `json:"reason"`
}

// UsageScanWarning 描述扫描警告项。
type UsageScanWarning struct {
	Code     string `json:"code"`
	Provider string `json:"provider,omitempty"`
	Detail   string `json:"detail,omitempty"`
	Count    int    `json:"count,omitempty"`
}

// UsageScanResult 是本地会话扫描的标准契约返回。
type UsageScanResult struct {
	SchemaVersion      int                                `json:"schemaVersion"`
	Kind               string                             `json:"kind"`
	Status             string                             `json:"status"`
	Source             UsageScanSource                    `json:"source"`
	ScannedAt          int64                              `json:"scannedAt"`
	ScannedAtIso       string                             `json:"scannedAtIso"`
	Stale              bool                               `json:"stale"`
	RequestedProviders []string                           `json:"requestedProviders"`
	Providers          map[string]UsageScanProviderResult `json:"providers"`
	Counts             UsageScanCounts                    `json:"counts"`
	Files              int                                `json:"files"`
	Records            int                                `json:"records"`
	Prompts            int                                `json:"prompts"`
	Skipped            int                                `json:"skipped"`
	FilesDeferred      int                                `json:"filesDeferred"`
	ReindexRequired    int                                `json:"reindexRequired"`
	Attempts           []UsageScanAttempt                 `json:"attempts"`
	Warnings           []UsageScanWarning                 `json:"warnings"`
}

// UsageScanJob 表示异步本地用量扫描作业快照。
type UsageScanJob struct {
	ID         string           `json:"id"`
	Status     string           `json:"status"`
	Provider   string           `json:"provider"`
	StartedAt  int64            `json:"startedAt"`
	FinishedAt int64            `json:"finishedAt"`
	Result     *UsageScanResult `json:"result"`
	Error      string           `json:"error"`
}

// UsageScanStartResult 是 POST/GET /usage/scan 返回的作业启动摘要。
type UsageScanStartResult struct {
	Accepted       bool         `json:"accepted"`
	AlreadyRunning bool         `json:"alreadyRunning"`
	Job            UsageScanJob `json:"job"`
}

// UsageDashboardQueryJob 表示异步渐进看板查询作业快照。
type UsageDashboardQueryJob struct {
	ID              string                 `json:"id"`
	Status          string                 `json:"status"`
	Query           UsageQuery             `json:"query"`
	StartedAt       int64                  `json:"startedAt"`
	FinishedAt      int64                  `json:"finishedAt"`
	CompletedShards int                    `json:"completedShards"`
	TotalShards     int                    `json:"totalShards"`
	Dashboard       *UsageDashboardPayload `json:"dashboard"`
	Error           string                 `json:"error"`
}

// UsageDashboardCancelResult 是 DELETE /usage/dashboard/query/:jobId 返回结果。
type UsageDashboardCancelResult struct {
	Cancelled bool                   `json:"cancelled"`
	Job       UsageDashboardQueryJob `json:"job"`
}

// StableHash 与 Node lib/usage/model-usage-stable-hash.js 一致（SHA1 十六进制前 16 位）。
func StableHash(value string) string {
	sum := sha1.Sum([]byte(value))
	return hex.EncodeToString(sum[:])[:16]
}

// NormalizeUsageCostUSD 将美元金额四舍五入至 9 位小数，对齐 Node normalizeModelUsageCostUsd。
func NormalizeUsageCostUSD(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	scale := math.Pow10(ModelUsageCostDecimals)
	return math.Round(value*scale) / scale
}

// CalculateCacheHitRate 计算缓存命中率，无输入 token 时返回 nil（JSON null）。
func CalculateCacheHitRate(input, cacheRead, cacheCreation int64) *float64 {
	in := maxInt64(0, input)
	cr := maxInt64(0, cacheRead)
	cc := maxInt64(0, cacheCreation)
	total := in + cr + cc
	if total <= 0 {
		return nil
	}
	rate := float64(cr) / float64(total)
	return &rate
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// ParseUsageQuery 校验并归一用量查询参数（from/to/provider/model/sessionId/limit/scan）。
func ParseUsageQuery(fromRaw, toRaw, providerRaw, modelRaw, sessionIDRaw string, limitRaw int, scan bool, now time.Time) (UsageQuery, error) {
	if now.IsZero() {
		now = time.Now()
	}
	today := now.In(time.Local).Format("2006-01-02")
	from := strings.TrimSpace(fromRaw)
	if from == "" {
		from = today
	}
	to := strings.TrimSpace(toRaw)
	if to == "" {
		to = from
	}
	fromMS := parseUsageTimeBound(from, false)
	toMS := parseUsageTimeBound(to, true)
	if fromMS <= 0 || toMS <= 0 {
		return UsageQuery{}, ErrInvalidUsageQuery
	}
	limit := limitRaw
	if limit <= 0 {
		limit = DefaultUsageQueryLimit
	}
	if limit > MaxUsageQueryLimit {
		limit = MaxUsageQueryLimit
	}
	return UsageQuery{
		From:      from,
		To:        to,
		FromMS:    fromMS,
		ToMS:      toMS,
		Provider:  strings.ToLower(strings.TrimSpace(providerRaw)),
		Model:     strings.TrimSpace(modelRaw),
		SessionID: strings.TrimSpace(sessionIDRaw),
		Limit:     limit,
		Scan:      scan,
	}, nil
}

func parseUsageTimeBound(raw string, endOfDay bool) int64 {
	text := strings.TrimSpace(raw)
	if text == "" {
		return 0
	}
	if parsedDate, err := time.ParseInLocation("2006-01-02", text, time.Local); err == nil {
		if endOfDay {
			return parsedDate.UnixMilli() + 24*60*60*1000 - 1
		}
		return parsedDate.UnixMilli()
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, text); err == nil {
			ms := t.UnixMilli()
			if ms > 0 {
				return ms
			}
		}
	}
	return 0
}
