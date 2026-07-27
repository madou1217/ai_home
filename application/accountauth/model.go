// Package accountauth 编排 Codex、Claude OAuth 登录作业。
//
// 该应用层只保存短期、进程内的 OAuth Flow，不持久化授权码、PKCE verifier、state
// 或 Token。成功后统一复用原生 artifact 解码与账号注册端口。
package accountauth

import (
	"context"
	"errors"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// DefaultJobTTL 是等待用户完成官方授权的默认时间窗口。
	DefaultJobTTL = 10 * time.Minute
	// DefaultTerminalRetention 是终态结果供客户端读取的短期保留时间。
	DefaultTerminalRetention = 5 * time.Minute
	// DefaultMaxJobs 是单进程允许保留的 OAuth Job 上限。
	DefaultMaxJobs = 32
)

var (
	// ErrInvalidDependencies 表示 OAuth Job 服务缺少必要端口或配置。
	ErrInvalidDependencies = errors.New("OAuth Job 服务依赖无效")
	// ErrUnsupportedProvider 表示当前只允许 Codex、Claude OAuth。
	ErrUnsupportedProvider = errors.New("OAuth Provider 不受支持")
	// ErrActiveJobExists 表示同一 Provider 已有活动 OAuth Job。
	ErrActiveJobExists = errors.New("provider 已有活动 OAuth Job")
	// ErrJobCapacity 表示有界 Job 容器暂时没有可用容量。
	ErrJobCapacity = errors.New("OAuth Job 容量已满")
	// ErrJobNotFound 表示 Job ID 不存在或终态保留期已经结束。
	ErrJobNotFound = errors.New("OAuth Job 不存在")
	// ErrJobNotPending 表示 Job 已经进入处理态或终态。
	ErrJobNotPending = errors.New("OAuth Job 不再等待回调")
	// ErrJobExpired 表示授权回调超过 Job 有效期。
	ErrJobExpired = errors.New("OAuth Job 已过期")
	// ErrInvalidCallback 表示回调不是当前 Provider 接受的官方格式。
	ErrInvalidCallback = errors.New("OAuth 回调格式无效")
	// ErrStateMismatch 表示回调 state 与当前 Job 不匹配。
	ErrStateMismatch = errors.New("OAuth 回调 state 不匹配")
	// ErrProviderRejected 表示上游 OAuth 服务明确拒绝授权或换取 Token。
	ErrProviderRejected = errors.New("OAuth Provider 拒绝授权")
	// ErrProviderUnavailable 表示 OAuth 上游网络或响应暂时不可用。
	ErrProviderUnavailable = errors.New("OAuth Provider 暂时不可用")
	// ErrInvalidArtifacts 表示 OAuth 适配器没有生成可注册的官方 artifact。
	ErrInvalidArtifacts = errors.New("OAuth 官方 artifact 无效")
)

// Status 是 OAuth Job 的稳定公开状态。
type Status string

const (
	// StatusPending 表示 Job 正在等待用户回调。
	StatusPending Status = "pending"
	// StatusProcessing 表示回调已被唯一消费者领取并正在完成注册。
	StatusProcessing Status = "processing"
	// StatusCompleted 表示 OAuth 账号已原子注册成功。
	StatusCompleted Status = "completed"
	// StatusFailed 表示换取凭据、资料确认或账号注册失败。
	StatusFailed Status = "failed"
	// StatusCancelled 表示用户主动取消了等待中的 Job。
	StatusCancelled Status = "cancelled"
	// StatusExpired 表示用户未在有效期内提交回调。
	StatusExpired Status = "expired"
)

// Job 是不包含授权 URL、state、PKCE、授权码或 Token 的只读公开快照。
type Job struct {
	id           string
	providerID   string
	status       Status
	createdAt    time.Time
	expiresAt    time.Time
	finishedAt   time.Time
	accountRef   accountcore.AccountRef
	cliAccountID accountcore.CLIAccountID
	failureCode  string
}

// ID 返回随机生成的 OAuth Job ID。
func (job Job) ID() string {
	return job.id
}

// ProviderID 返回 Job 绑定的规范 Provider ID。
func (job Job) ProviderID() string {
	return job.providerID
}

// Status 返回 Job 当前公开状态。
func (job Job) Status() Status {
	return job.status
}

// CreatedAt 返回 Job 创建时间。
func (job Job) CreatedAt() time.Time {
	return job.createdAt
}

// ExpiresAt 返回授权回调的最后有效时间。
func (job Job) ExpiresAt() time.Time {
	return job.expiresAt
}

// FinishedAt 返回 Job 进入终态的时间；活动 Job 返回零值。
func (job Job) FinishedAt() time.Time {
	return job.finishedAt
}

// AccountRef 返回成功注册后的稳定账号引用。
func (job Job) AccountRef() accountcore.AccountRef {
	return job.accountRef
}

// CLIAccountID 返回成功注册后分配的 Provider 内数字别名。
func (job Job) CLIAccountID() accountcore.CLIAccountID {
	return job.cliAccountID
}

// FailureCode 返回失败或过期的稳定安全错误码。
func (job Job) FailureCode() string {
	return job.failureCode
}

// IsTerminal 判断 Job 是否已经不再接受任何状态变化。
func (job Job) IsTerminal() bool {
	switch job.status {
	case StatusCompleted, StatusFailed, StatusCancelled, StatusExpired:
		return true
	default:
		return false
	}
}

// StartResult 把一次性授权 URL 与不含敏感参数拆开的 Job 快照一起返回。
type StartResult struct {
	job              Job
	authorizationURL string
}

// Job 返回新建 Job 的公开快照。
func (result StartResult) Job() Job {
	return result.job
}

// AuthorizationURL 返回只在创建响应中交付的官方授权地址。
func (result StartResult) AuthorizationURL() string {
	return result.authorizationURL
}

// OAuthProvider 是 Provider OAuth 开始阶段的策略端口。
type OAuthProvider interface {
	ProviderID() string
	Begin(ctx context.Context) (OAuthFlow, error)
}

// OAuthFlow 是仅由 Job 私有持有的一次性 OAuth 会话。
type OAuthFlow interface {
	AuthorizationURL() string
	Exchange(ctx context.Context, callback string) ([]byte, error)
}

// NativeAccountDecoder 是 OAuth artifact 进入账号应用层前的反腐端口。
type NativeAccountDecoder interface {
	Decode(
		providerID string,
		artifactsJSON []byte,
	) (accountapp.Credential, accountapp.PublicProfile, error)
}

// Registrar 是 OAuth 成功后唯一允许调用的账号注册端口。
type Registrar interface {
	Register(
		ctx context.Context,
		credential accountapp.Credential,
		profile accountapp.PublicProfile,
	) (accountcore.Account, error)
}

// Clock 返回当前时间，测试可注入确定性时钟。
type Clock func() time.Time

// IDGenerator 创建不携带业务信息的随机 Job ID。
type IDGenerator func() (string, error)

// Dependencies 集中声明 OAuth Job 应用服务依赖。
type Dependencies struct {
	Providers  []OAuthProvider
	Decoder    NativeAccountDecoder
	Registrar  Registrar
	Clock      Clock
	GenerateID IDGenerator
}
