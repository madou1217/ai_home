package webuiaccountreauthapi

import (
	"context"

	accountauth "github.com/madou1217/ai_home/application/accountauth"
)

// AccountAuthJobs 是 application/accountauth 作业服务的最小形状。
//
// *accountauth.Service 原样满足；Complete 只用于本机回调监听消费浏览器回调。
type AccountAuthJobs interface {
	Start(
		ctx context.Context,
		request accountauth.StartRequest,
	) (accountauth.StartResult, error)
	Get(jobID string) (accountauth.Job, error)
	Complete(
		ctx context.Context,
		jobID string,
		callback string,
	) (accountauth.Job, error)
}

// 编译期确认生产实现仍然满足适配器端口。
var _ AccountAuthJobs = (*accountauth.Service)(nil)

// accountAuthStarter 把应用层作业服务适配成本包的作业端口。
type accountAuthStarter struct {
	jobs AccountAuthJobs
}

// NewAccountAuthStarter 创建作业适配器。
//
// 返回的 JobStarter 同时实现 JobReader，Handler 会用它确认作业是否仍在进行。
func NewAccountAuthStarter(jobs AccountAuthJobs) (JobStarter, error) {
	if jobs == nil {
		return nil, ErrInvalidDependencies
	}
	return accountAuthStarter{jobs: jobs}, nil
}

// Start 发起一次原地重新认证作业。
func (starter accountAuthStarter) Start(
	ctx context.Context,
	request Request,
) (Job, error) {
	result, err := starter.jobs.Start(ctx, accountauth.StartRequest{
		ProviderID:       request.ProviderID,
		TargetAccountRef: request.AccountRef,
		AuthStrategy:     request.AuthStrategy,
		LoginProvider:    request.LoginProvider,
	})
	if err != nil {
		return Job{}, err
	}
	job := result.Job()
	authorizationURL := result.AuthorizationURL()
	return Job{
		ID:               job.ID(),
		ProviderID:       job.ProviderID(),
		Purpose:          string(job.Purpose()),
		AuthMode:         job.AuthMode(),
		AuthStrategy:     job.AuthStrategy(),
		PollIntervalMS:   pollIntervalForMode(job.AuthMode()),
		Status:           string(job.Status()),
		AuthorizationURL: authorizationURL,
		RedirectURI:      accountauth.RedirectURIFromAuthorizationURL(authorizationURL),
		UserCode:         result.UserCode(),
		ExpiresAt:        job.ExpiresAt(),
	}, nil
}

// Complete 用本机监听收到的完整回调 URL 收尾作业。
func (starter accountAuthStarter) Complete(
	ctx context.Context,
	jobID string,
	callbackURL string,
) (Job, error) {
	job, err := starter.jobs.Complete(ctx, jobID, callbackURL)
	if err != nil {
		return Job{}, err
	}
	return Job{
		ID:             job.ID(),
		ProviderID:     job.ProviderID(),
		Purpose:        string(job.Purpose()),
		AuthMode:       job.AuthMode(),
		AuthStrategy:   job.AuthStrategy(),
		PollIntervalMS: pollIntervalForMode(job.AuthMode()),
		Status:         string(job.Status()),
		UserCode:       job.UserCode(),
		ExpiresAt:      job.ExpiresAt(),
	}, nil
}

// Active 判断作业是否仍在等待回调或正在写入账号。
func (starter accountAuthStarter) Active(jobID string) (bool, error) {
	job, err := starter.jobs.Get(jobID)
	if err != nil {
		return false, err
	}
	return !job.IsTerminal(), nil
}

var (
	_ JobStarter   = accountAuthStarter{}
	_ JobReader    = accountAuthStarter{}
	_ JobCompleter = accountAuthStarter{}
)
