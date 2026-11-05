package accountauth

import (
	"context"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// JobRecord 是 OAuth Job 公开快照的持久化形态。
//
// 该结构刻意只保留可对外展示的字段：授权码、state、PKCE verifier 和 Token
// 只存在于进程内的 OAuthFlow 中，永不落库。持久化的目的不是让 Job 在重启后
// 继续完成（重启后 state/PKCE 已经丢失），而是让客户端还能查到 Job 的结果。
type JobRecord struct {
	// ID 是 Job 的稳定标识，也是 Upsert 的主键。
	ID string
	// ProviderID 是 Job 绑定的规范 Provider ID。
	ProviderID string
	// Purpose 区分新账号注册与已有账号原地重新认证。
	Purpose Purpose
	// TargetRef 是 reauth 目标账号引用；register Job 为空字符串。
	TargetRef string
	// Status 是 Job 的公开状态。
	Status Status
	// CreatedAt 是 Job 创建时间。
	CreatedAt time.Time
	// ExpiresAt 是授权回调的最后有效时间。
	ExpiresAt time.Time
	// UpdatedAt 是最后一次状态写入时间，对终态而言即完成时间。
	UpdatedAt time.Time
	// ErrorCode 是失败或过期的稳定安全错误码。
	ErrorCode string
	// ErrorMessage 保留给存储层记录可读原因，Job 对外只暴露 ErrorCode。
	ErrorMessage string
}

// JobStore 是 Job 公开快照的持久化端口，由基础设施层实现。
type JobStore interface {
	// UpsertJob 以 ID 为键写入或覆盖一条快照。
	UpsertJob(ctx context.Context, record JobRecord) error
	// GetJob 读取单条快照，第二个返回值表示记录是否存在。
	GetJob(ctx context.Context, jobID string) (JobRecord, bool, error)
	// ListJobs 返回快照列表；activeOnly 为 true 时只返回 pending/processing。
	ListJobs(ctx context.Context, activeOnly bool) ([]JobRecord, error)
	// ExpirePendingJobs 把所有 pending/processing 快照改成 expired，返回改动条数。
	ExpirePendingJobs(ctx context.Context, now time.Time) (int64, error)
}

// snapshot 把私有 Job 投影成可持久化的公开快照。
//
// 这里逐字段白名单构造而不是序列化 Job 本身：Job 将来新增私有字段时，
// 不会因为顺手复用结构体而把凭据类数据写进 aih.db。
func (job Job) snapshot(updatedAt time.Time) JobRecord {
	return JobRecord{
		ID:         job.id,
		ProviderID: job.providerID,
		Purpose:    job.purpose,
		TargetRef:  string(job.targetRef),
		Status:     job.status,
		CreatedAt:  job.createdAt,
		ExpiresAt:  job.expiresAt,
		UpdatedAt:  updatedAt,
		// ErrorMessage 留空：Job 只保留稳定错误码，上游错误文本可能带敏感信息。
		ErrorCode: job.failureCode,
	}
}

// jobFromRecord 把持久化快照还原为只读 Job。
//
// 还原结果只用于查询：OAuthFlow 等私有状态无法从快照恢复，
// 因此这个 Job 永远不会参与 Complete。
func jobFromRecord(record JobRecord) Job {
	job := Job{
		id:          record.ID,
		providerID:  record.ProviderID,
		purpose:     record.Purpose,
		targetRef:   accountcore.AccountRef(record.TargetRef),
		status:      record.Status,
		createdAt:   record.CreatedAt,
		expiresAt:   record.ExpiresAt,
		failureCode: record.ErrorCode,
	}
	if job.IsTerminal() && !record.UpdatedAt.IsZero() {
		// 快照没有单独的 finishedAt 列：UpdatedAt 是最后一次状态写入时间，
		// 对终态来说就是进入终态的时间。
		job.finishedAt = record.UpdatedAt
	}
	return job
}
