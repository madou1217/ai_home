// Package accountauth 编排 Codex、Claude OAuth 登录作业。
//
// 该应用层只保存短期、进程内的 OAuth Flow，不持久化授权码、PKCE verifier、state
// 或 Token。成功后统一复用原生 artifact 解码，再按 Job 意图注册或原地 reauth。
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
	// ErrUnsupportedProvider 表示该 Provider 还没有 Go 侧登录流程实现。
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
	// ErrInvalidStartRequest 表示 Job 起始命令缺少 Provider 或目标身份无效。
	ErrInvalidStartRequest = errors.New("OAuth Job 起始命令无效")
	// ErrUnsupportedAuthStrategy 表示所选登录子策略当前不受 Go OAuth 引擎支持。
	ErrUnsupportedAuthStrategy = errors.New("OAuth 登录策略不受支持")
	// ErrUnsupportedLoginProvider 表示所选上游身份提供方当前不受支持。
	ErrUnsupportedLoginProvider = errors.New("OAuth 上游身份提供方不受支持")
)

// Purpose 区分新账号注册与已有账号原地重新认证。
type Purpose string

const (
	// PurposeRegister 表示 OAuth 成功后创建新账号。
	PurposeRegister Purpose = "register"
	// PurposeReauth 表示 OAuth 成功后原子替换目标账号凭据和资料。
	PurposeReauth Purpose = "reauth"
)

// Status 是 OAuth Job 的稳定公开状态。
type Status string

const (
	// StatusPending 表示 Job 正在等待用户回调。
	StatusPending Status = "pending"
	// StatusProcessing 表示回调已被唯一消费者领取并正在完成账号写入。
	StatusProcessing Status = "processing"
	// StatusCompleted 表示 OAuth 账号已原子注册或重新认证成功。
	StatusCompleted Status = "completed"
	// StatusFailed 表示换取凭据、资料确认或账号写入失败。
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
	purpose      Purpose
	targetRef    accountcore.AccountRef
	status       Status
	createdAt    time.Time
	expiresAt    time.Time
	finishedAt   time.Time
	accountRef   accountcore.AccountRef
	cliAccountID accountcore.CLIAccountID
	// authMode 是登录流程的公开形态：oauth-browser 等待浏览器回调，
	// oauth-device 靠设备码轮询推进。它只存在于进程内，持久化快照不记录，
	// 重启后从持久化记录还原的 Job 一律为空（无法继续流程，也不需要展示）。
	authMode string
	// authStrategy 记录启动流程采用的子策略标识（如 bigmodel:custom-scheme / social-oauth-device），
	// 同样只保留在进程内公开快照，不持久化。
	authStrategy string
	// account 是成功登录后可直接展示的账号字段；失败或未完成时为零值。
	account     Account
	failureCode string
	// authorizationURL / userCode 只对活跃作业有值：设备码与授权链接在启动响应里
	// 交付一次，浏览器随后通过作业快照重新读取（进程重启后为空）。
	authorizationURL string
	userCode         string
}

// Account 是 OAuth 登录成功后可直接展示的公开账号字段。
//
// JSON 字段名与 Node 登录 Job 快照保持一致（email / displayName / planType）；
// 全部字段允许为空，缺失 claim 不能阻断登录。
type Account struct {
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	PlanType    string `json:"planType"`
}

// ID 返回随机生成的 OAuth Job ID。
func (job Job) ID() string {
	return job.id
}

// ProviderID 返回 Job 绑定的规范 Provider ID。
func (job Job) ProviderID() string {
	return job.providerID
}

// Purpose 返回 Job 的注册或原地重新认证意图。
func (job Job) Purpose() Purpose {
	return job.purpose
}

// TargetAccountRef 返回 reauth 目标；register Job 返回零值。
func (job Job) TargetAccountRef() accountcore.AccountRef {
	return job.targetRef
}

// Status 返回 Job 当前公开状态。
func (job Job) Status() Status {
	return job.status
}

// AuthMode 返回登录流程形态（oauth-browser / oauth-device）。
//
// 它来自 Start 时对 Flow 的实际类型判断，不是按 Provider 猜的默认值；
// 从持久化快照还原的 Job 没有 Flow，返回空串。
func (job Job) AuthMode() string {
	return job.authMode
}

// AuthStrategy 返回启动流程时采用的子策略标识（如 zai:custom-scheme / bigmodel:custom-scheme）。
func (job Job) AuthStrategy() string {
	return job.authStrategy
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

// Account 返回登录成功时解析出的公开账号字段；其它状态返回零值。
// AuthorizationURL 返回创建响应里交付的官方授权地址（仅活跃作业）。
func (job Job) AuthorizationURL() string { return job.authorizationURL }

// UserCode 返回设备码流程的短码（仅活跃作业）。
func (job Job) UserCode() string { return job.userCode }

func (job Job) Account() Account {
	return job.account
}

// IsTerminal 判断状态是否已经不再接受任何变化。
//
// 终态判定同时被服务、持久化适配器和 Node 快照入站三处使用，集中在这里
// 才能保证「哪些状态允许携带账号结果」只有一个答案。
func (status Status) IsTerminal() bool {
	switch status {
	case StatusCompleted, StatusFailed, StatusCancelled, StatusExpired:
		return true
	default:
		return false
	}
}

// IsTerminal 判断 Job 是否已经不再接受任何状态变化。
func (job Job) IsTerminal() bool {
	return job.status.IsTerminal()
}

// StartResult 把一次性授权 URL 与不含敏感参数拆开的 Job 快照一起返回。
type StartResult struct {
	job              Job
	authorizationURL string
	userCode         string
}

// Job 返回新建 Job 的公开快照。
func (result StartResult) Job() Job {
	return result.job
}

// AuthorizationURL 返回只在创建响应中交付的官方授权地址。
func (result StartResult) AuthorizationURL() string {
	return result.authorizationURL
}

// UserCode 返回设备码流程需要用户在验证页核对的短码；回调型流程为空。
func (result StartResult) UserCode() string {
	return result.userCode
}

// BeginOptions 描述发起 OAuth 流程时的可选子策略与上游登录提供方。
type BeginOptions struct {
	AuthStrategy  string
	LoginProvider string
}

// OAuthProvider 是 Provider OAuth 开始阶段的策略端口。
type OAuthProvider interface {
	ProviderID() string
	Begin(ctx context.Context) (OAuthFlow, error)
}

// OAuthProviderWithOptions 是 OAuthProvider 的可选扩展：支持按子策略或上游提供方发起流程。
type OAuthProviderWithOptions interface {
	OAuthProvider
	BeginWithOptions(ctx context.Context, options BeginOptions) (OAuthFlow, error)
}

// OAuthFlow 是仅由 Job 私有持有的一次性 OAuth 会话。
type OAuthFlow interface {
	AuthorizationURL() string
	Exchange(ctx context.Context, callback string) ([]byte, error)
}

// StateProvider 是 OAuthFlow 的可选扩展：仅向应用服务内部暴露本次流程的随机 state，
// 用于按协议回调 state 认领在途 Job；公开快照永远不会暴露该值。
type StateProvider interface {
	OAuthState() string
}

// AuthStrategyProvider 是 OAuthFlow 的可选扩展：返回 Flow 实际采用的规范子策略名。
type AuthStrategyProvider interface {
	AuthStrategy() string
}

// AuthModeProvider 是 OAuthFlow 的可选扩展：显式声明流程形态（如 oauth-refresh-token）。
//
// 未实现该端口时按是否实现 DeviceFlow 自动判定为 oauth-browser / oauth-device。
type AuthModeProvider interface {
	AuthMode() string
}

// AccountClaimsProvider 是 OAuthFlow 的可选扩展：Flow 在 Exchange 之后可直接
// 提供从上游 ID Token 解析出的公开账号字段。未实现时登录照常完成，Job.Account
// 回落到账号解码器给出的公开资料。
type AccountClaimsProvider interface {
	AccountClaims() Account
}

// DeviceStatus 是设备码（RFC 8628）轮询的归一状态。
//
// 词汇与 Node 的设备流驱动一致：pending 继续、slow_down 拉长间隔、ready 交产物；
// failed / expired 是终态，不再轮询。
type DeviceStatus string

const (
	// DevicePending 表示用户还没有完成授权。
	DevicePending DeviceStatus = "pending"
	// DeviceSlowDown 表示轮询过快，应按 Interval 退避。
	DeviceSlowDown DeviceStatus = "slow_down"
	// DeviceReady 表示授权完成，Artifacts 可交给账号注册链。
	DeviceReady DeviceStatus = "ready"
	// DeviceFailed 表示上游明确拒绝（access_denied 等）。
	DeviceFailed DeviceStatus = "failed"
	// DeviceExpired 表示设备码已过期，需要重新发起。
	DeviceExpired DeviceStatus = "expired"
)

// DevicePoll 是一次设备码轮询的结果。
//
// Account 只在 ready 时非空，供 Job 快照直接展示；账号写入仍以 Artifacts 为准。
type DevicePoll struct {
	Status    DeviceStatus
	Artifacts []byte
	Account   Account
	// Interval 非零时覆盖下一次轮询间隔（slow_down 之后会变大）。
	Interval time.Duration
}

// DeviceFlow 是设备码流程：没有浏览器回调，只能按上游给出的间隔轮询。
//
// Service 在 Start 之后为这类 Flow 启动后台轮询；授权完成后走与回调型流程
// 完全相同的账号写入与终态路径。Exchange 仍满足 OAuthFlow 端口，只服务于
// 单次轮询语义，正常调用方应当使用 Poll。
type DeviceFlow interface {
	OAuthFlow
	// PollInterval 返回当前建议的轮询间隔。
	PollInterval() time.Duration
	// Poll 执行一次轮询。
	Poll(ctx context.Context) (DevicePoll, error)
}

// DeviceCodeProvider 是设备码流程的可选展示端口：把用户码交给界面核对。
type DeviceCodeProvider interface {
	UserCode() string
}

// StartRequest 是创建 OAuth Job 的应用命令。
type StartRequest struct {
	// ProviderID 是本次 OAuth Flow 使用的规范 Provider ID。
	ProviderID string
	// TargetAccountRef 非空时表示原地 reauth，空值表示注册新账号。
	TargetAccountRef accountcore.AccountRef
	// AuthStrategy 指定可选子策略（如 bigmodel:custom-scheme、aih-google-oauth）。
	AuthStrategy string
	// LoginProvider 指定同一策略下的上游身份提供方（如 Kiro 的 Google / Github）。
	LoginProvider string
}

// Purpose 根据目标账号是否存在返回明确 Job 意图。
func (request StartRequest) Purpose() Purpose {
	if request.TargetAccountRef.IsValid() {
		return PurposeReauth
	}
	return PurposeRegister
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

// Reauthenticator 是 OAuth Job 对已有账号执行目标预检和原子替换的端口。
type Reauthenticator interface {
	ValidateTarget(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		providerID string,
	) error
	Reauthenticate(
		ctx context.Context,
		accountRef accountcore.AccountRef,
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
	Reauth     Reauthenticator
	Clock      Clock
	GenerateID IDGenerator
	// JobStore 持久化 Job 公开快照；为 nil 时退化为只存在于内存的旧行为，
	// 这样尚未接入 aih.db 的宿主（如 aih CLI）不必立刻提供存储实现。
	JobStore JobStore
}
