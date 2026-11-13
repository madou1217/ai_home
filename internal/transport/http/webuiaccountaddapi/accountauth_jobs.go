package webuiaccountaddapi

import (
	"context"

	"github.com/madou1217/ai_home/application/accountauth"
)

// AccountAuthJobs 是 application/accountauth 作业服务的最小形状。
//
// *accountauth.Service 原样满足；这里不引入更大的服务接口，避免把无关能力
// 带进 WebUI 入口。GetJob 在内存终态被清理后会回落持久化快照。
type AccountAuthJobs interface {
	Start(
		ctx context.Context,
		request accountauth.StartRequest,
	) (accountauth.StartResult, error)
	GetJob(ctx context.Context, jobID string) (accountauth.Job, error)
	Complete(
		ctx context.Context,
		jobID string,
		callback string,
	) (accountauth.Job, error)
	Cancel(jobID string) (accountauth.Job, error)
}

// 编译期确认生产实现仍然满足适配器端口。
var _ AccountAuthJobs = (*accountauth.Service)(nil)

// accountAuthAdapter 把应用层作业服务适配成本包的作业端口。
type accountAuthAdapter struct {
	jobs AccountAuthJobs
}

// NewAccountAuthJobs 创建作业适配器。
//
// 返回的端口只暴露开始、查询、完成与取消：授权 URL、设备码与状态迁移都由
// 应用层决定，传输层不再拼接 OAuth 参数。
func NewAccountAuthJobs(jobs AccountAuthJobs) (Jobs, error) {
	if jobs == nil {
		return nil, ErrInvalidDependencies
	}
	return accountAuthAdapter{jobs: jobs}, nil
}

// Start 发起一次注册型作业（没有目标账号 = PurposeRegister）。
func (adapter accountAuthAdapter) Start(
	ctx context.Context,
	request StartRequest,
) (Started, error) {
	result, err := adapter.jobs.Start(ctx, accountauth.StartRequest{
		ProviderID:    request.ProviderID,
		AuthStrategy:  request.AuthStrategy,
		LoginProvider: request.LoginProvider,
	})
	if err != nil {
		return Started{}, err
	}
	return Started{
		Job:              NewJobView(result.Job()),
		AuthorizationURL: result.AuthorizationURL(),
		UserCode:         result.UserCode(),
	}, nil
}

// GetJob 返回作业快照。
func (adapter accountAuthAdapter) GetJob(
	ctx context.Context,
	jobID string,
) (JobSnapshot, error) {
	job, err := adapter.jobs.GetJob(ctx, jobID)
	if err != nil {
		return JobSnapshot{}, err
	}
	return NewJobView(job), nil
}

// Complete 把一次性回调交给应用层完成换码与账号写入。
func (adapter accountAuthAdapter) Complete(
	ctx context.Context,
	jobID string,
	callback string,
) (JobSnapshot, error) {
	job, err := adapter.jobs.Complete(ctx, jobID, callback)
	if err != nil {
		return JobSnapshot{}, err
	}
	return NewJobView(job), nil
}

// Cancel 取消等待中的作业。
func (adapter accountAuthAdapter) Cancel(jobID string) (JobSnapshot, error) {
	job, err := adapter.jobs.Cancel(jobID)
	if err != nil {
		return JobSnapshot{}, err
	}
	return NewJobView(job), nil
}

var _ Jobs = accountAuthAdapter{}
