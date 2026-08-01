// Package accountrouting 负责从紧凑账号候选中征召一个当前可用的账号。
//
// 该应用层只组合候选读取、运行态资格和凭据可用化，不认识 SQLite、HTTP、
// Provider SDK、usage 存储或具体运行态实现。
package accountrouting

import (
	"context"
	"errors"
	"fmt"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidDependencies 表示征召器缺少模型候选、运行态或凭据端口。
	ErrInvalidDependencies = errors.New("账号征召器依赖无效")
	// ErrInvalidRequest 表示 Provider、真实模型或上下文无效。
	ErrInvalidRequest = errors.New("账号征召请求无效")
	// ErrInvalidCandidateSnapshot 表示候选源违反了快照、Provider 或身份合同。
	ErrInvalidCandidateSnapshot = errors.New("账号征召候选快照无效")
	// ErrInvalidResolvedCredential 表示凭据解析结果不属于候选账号。
	ErrInvalidResolvedCredential = errors.New("账号征召凭据无效")
	// ErrInvalidRuntimeEligibility 表示运行态端口返回了不完整的资格值。
	ErrInvalidRuntimeEligibility = errors.New("账号征召运行态资格无效")
	// ErrInvalidCredentialTransport 表示调用方没有提供当前上游协议的凭据传输策略。
	ErrInvalidCredentialTransport = errors.New("账号征召凭据传输策略无效")
	// ErrNoRoutableAccount 表示当前候选快照没有可直接交给上游的账号。
	ErrNoRoutableAccount = errors.New("没有可征召账号")
)

// CandidateSource 提供已经按 Provider、模型和启用状态筛选的不可变候选快照。
type CandidateSource interface {
	// LoadRoutingCandidates 返回当前原子发布的完整本地候选快照。
	LoadRoutingCandidates(
		ctx context.Context,
		providerID string,
		modelID runtimecore.ModelID,
	) (*accountapp.RoutingCandidates, error)
}

// CredentialResolver 把候选账号凭据解析为当前可直接使用的版本。
type CredentialResolver interface {
	// ResolveCredentialBinding 延迟读取凭据，并返回稳定账号绑定。
	ResolveCredentialBinding(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.CredentialBinding, error)
}

// CredentialTransportPolicy 判断领域凭据能否由当前上游协议安全承载。
//
// 该策略只表达本地协议兼容性，不执行网络请求，也不改变账号运行态。
type CredentialTransportPolicy interface {
	// SupportsCredential 返回当前 Adapter 是否可以直接使用该凭据。
	SupportsCredential(credential accountapp.Credential) bool
}

// RuntimeEligibilitySource 提供账号与真实模型元组的当前运行态资格。
type RuntimeEligibilitySource interface {
	// CheckEligibility 在读取凭据前判断硬阻塞或模型 cooldown。
	CheckEligibility(
		ctx context.Context,
		route runtimecore.ModelRoute,
	) (runtimecore.Eligibility, error)
}

// Dependencies 声明征召器所需的三个最小应用端口。
type Dependencies struct {
	// Candidates 负责从本地模型倒排读取启用账号的不可变紧凑快照。
	Candidates CandidateSource
	// Runtime 负责在敏感凭据读取前排除运行态不可用元组。
	Runtime RuntimeEligibilitySource
	// Credentials 负责单账号凭据读取和必要刷新。
	Credentials CredentialResolver
}

// Request 是经过 Provider 注册表校验的征召请求。
type Request struct {
	providerID    string
	modelID       runtimecore.ModelID
	pinnedAccount accountcore.AccountRef
}

// NewRequest 规范化 Provider，并校验别名解析后的真实模型。
//
// modelID 必须是别名解析后的真实上游模型，不能使用客户端模型别名。
func NewRequest(
	catalog *providers.Catalog,
	providerID string,
	modelID string,
) (Request, error) {
	return newRequest(catalog, providerID, modelID, "")
}

// NewPinnedRequest 创建只允许征召指定稳定账号的请求。
//
// 固定账号仍必须存在于目标 Provider、模型的启用候选快照中，并继续经过运行态、
// 凭据和传输能力校验；任何失败都不得回退到同池其他账号。
func NewPinnedRequest(
	catalog *providers.Catalog,
	providerID string,
	modelID string,
	accountRef accountcore.AccountRef,
) (Request, error) {
	if !accountRef.IsValid() {
		return Request{}, ErrInvalidRequest
	}
	return newRequest(catalog, providerID, modelID, accountRef)
}

// newRequest 统一普通征召和固定账号征召的 Provider、模型校验。
func newRequest(
	catalog *providers.Catalog,
	providerID string,
	modelID string,
	pinnedAccount accountcore.AccountRef,
) (Request, error) {
	if catalog == nil {
		return Request{}, ErrInvalidRequest
	}
	canonicalProviderID, found := catalog.CanonicalID(providerID)
	if !found {
		return Request{}, ErrInvalidRequest
	}
	runtimeModelID, err := runtimecore.NewModelID(modelID)
	if err != nil {
		return Request{}, errors.Join(ErrInvalidRequest, err)
	}
	return Request{
		providerID:    canonicalProviderID,
		modelID:       runtimeModelID,
		pinnedAccount: pinnedAccount,
	}, nil
}

// ProviderID 返回规范 Provider ID。
func (request Request) ProviderID() string {
	return request.providerID
}

// ModelID 返回别名解析后的真实上游模型 ID。
func (request Request) ModelID() runtimecore.ModelID {
	return request.modelID
}

// PinnedAccount 返回请求唯一允许的账号；普通公平征召返回 false。
func (request Request) PinnedAccount() (accountcore.AccountRef, bool) {
	return request.pinnedAccount, request.pinnedAccount.IsValid()
}

// isValid 防止零值或跨层篡改请求进入候选端口。
func (request Request) isValid() bool {
	return request.ProviderID() != "" &&
		request.ModelID().IsValid() &&
		(request.pinnedAccount == "" || request.pinnedAccount.IsValid())
}

// Result 保存一次征召的账号、凭据和本次扫描进度。
type Result struct {
	account         accountapp.RoutingAccount
	credential      accountapp.Credential
	examined        int
	sourceExhausted bool
}

// Account 返回本次选中的紧凑账号投影。
func (result Result) Account() accountapp.RoutingAccount {
	return result.account
}

// Credential 返回已经刷新且身份经过复核的 Provider 凭据。
func (result Result) Credential() accountapp.Credential {
	return result.credential
}

// Examined 返回本次实际尝试解析凭据的候选数量。
func (result Result) Examined() int {
	return result.examined
}

// SourceExhausted 表示当前请求固定的候选快照已经扫描完毕。
func (result Result) SourceExhausted() bool {
	return result.sourceExhausted
}

// Recruiter 编排本地模型候选、运行态和凭据可用化。
type Recruiter struct {
	candidates  CandidateSource
	runtime     RuntimeEligibilitySource
	credentials CredentialResolver
	scheduler   *FairRoundRobinScheduler
}

// RecruitmentSession 固定一次请求的候选快照、轮转起点和扫描位置。
//
// 一个 Session 最多访问快照中的每个位置一次，因此无需请求级 Map 或 Set
// 也能保证同一请求不会重复调用同一账号。
type RecruitmentSession struct {
	recruiter       *Recruiter
	request         Request
	transport       CredentialTransportPolicy
	candidates      *accountapp.RoutingCandidates
	pinned          bool
	pinnedCandidate accountapp.RoutingAccount
	pinnedFound     bool
	start           int
	offset          int
}

// NewRecruiter 创建不缓存凭据、共享公平票号的账号征召器。
func NewRecruiter(dependencies Dependencies) (*Recruiter, error) {
	if dependencies.Candidates == nil ||
		dependencies.Runtime == nil ||
		dependencies.Credentials == nil {
		return nil, ErrInvalidDependencies
	}
	return &Recruiter{
		candidates:  dependencies.Candidates,
		runtime:     dependencies.Runtime,
		credentials: dependencies.Credentials,
		scheduler:   &FairRoundRobinScheduler{},
	}, nil
}

// Begin 固定当前路由快照并为本请求分配公平的环形扫描起点。
func (recruiter *Recruiter) Begin(
	ctx context.Context,
	request Request,
	transport CredentialTransportPolicy,
) (*RecruitmentSession, error) {
	if recruiter == nil ||
		recruiter.candidates == nil ||
		recruiter.runtime == nil ||
		recruiter.credentials == nil ||
		recruiter.scheduler == nil {
		return nil, ErrInvalidDependencies
	}
	if ctx == nil || !request.isValid() {
		return nil, ErrInvalidRequest
	}
	if transport == nil {
		return nil, ErrInvalidCredentialTransport
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	candidates, err := recruiter.candidates.LoadRoutingCandidates(
		ctx,
		request.ProviderID(),
		request.ModelID(),
	)
	if err != nil {
		return nil, fmt.Errorf("读取账号征召候选失败: %w", err)
	}
	if candidates == nil {
		return nil, ErrInvalidCandidateSnapshot
	}
	session := &RecruitmentSession{
		recruiter:  recruiter,
		request:    request,
		transport:  transport,
		candidates: candidates,
	}
	if accountRef, pinned := request.PinnedAccount(); pinned {
		session.pinned = true
		session.pinnedCandidate, session.pinnedFound = candidates.FindByRef(accountRef)
		return session, nil
	}
	session.start = recruiter.scheduler.NextStart(
		request.ProviderID(),
		request.ModelID(),
		candidates.Len(),
	)
	return session, nil
}

// Recruit 从新建会话中返回首个当前可用账号。
//
// 单账号缺失凭据、需要重新认证、刷新被拒绝或刷新暂时失败时继续检查下一候选；
// 凭据不能由当前 Adapter 承载时也只跳过该账号，不写入 cooldown 或硬阻塞；
// 未分类的存储、解码和合同错误立即失败，避免静默掩盖系统问题。
func (recruiter *Recruiter) Recruit(
	ctx context.Context,
	request Request,
	transport CredentialTransportPolicy,
) (Result, error) {
	session, err := recruiter.Begin(ctx, request, transport)
	if err != nil {
		return Result{}, err
	}
	return session.Next(ctx)
}

// Next 从固定快照的上次位置继续，返回下一个可直接调用的不同账号。
func (session *RecruitmentSession) Next(ctx context.Context) (Result, error) {
	if session == nil ||
		session.recruiter == nil ||
		session.transport == nil ||
		session.candidates == nil ||
		!session.request.isValid() ||
		ctx == nil {
		return Result{}, ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	progress := Result{}
	for session.offset < session.candidateCount() {
		candidate, found := session.candidateAt(session.offset)
		if !found {
			return progress, ErrInvalidCandidateSnapshot
		}
		session.offset++
		progress.examined++
		progress.sourceExhausted = session.offset == session.candidateCount()
		if !validCandidate(candidate, session.request.ProviderID()) {
			return progress, ErrInvalidCandidateSnapshot
		}
		route, routeErr := candidateModelRoute(candidate, session.request.ModelID())
		if routeErr != nil {
			return progress, routeErr
		}
		eligible, eligibilityErr := session.recruiter.isRuntimeEligible(ctx, route)
		if eligibilityErr != nil {
			return progress, eligibilityErr
		}
		if !eligible {
			continue
		}
		binding, resolveErr := session.recruiter.credentials.ResolveCredentialBinding(
			ctx,
			candidate.Ref(),
		)
		if resolveErr != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return progress, ctxErr
			}
			if isAccountUnavailable(resolveErr) {
				continue
			}
			return progress, fmt.Errorf(
				"解析账号征召凭据失败: %w",
				resolveErr,
			)
		}
		if !credentialMatchesCandidate(candidate, binding) {
			return progress, ErrInvalidResolvedCredential
		}
		credential := binding.Credential()
		if !session.transport.SupportsCredential(credential) {
			continue
		}
		progress.account = candidate
		progress.credential = credential
		return progress, nil
	}
	progress.sourceExhausted = true
	return progress, ErrNoRoutableAccount
}

// candidateCount 返回当前会话可检查的候选数量；固定账号最多为一。
func (session *RecruitmentSession) candidateCount() int {
	if session.pinned {
		if session.pinnedFound {
			return 1
		}
		return 0
	}
	return session.candidates.Len()
}

// candidateAt 统一普通环形快照和固定账号单元素视图，不复制候选切片。
func (session *RecruitmentSession) candidateAt(offset int) (accountapp.RoutingAccount, bool) {
	if session.pinned {
		return session.pinnedCandidate, session.pinnedFound && offset == 0
	}
	index := (session.start + offset) % session.candidates.Len()
	return session.candidates.At(index)
}

// isRuntimeEligible 在读取敏感凭据前检查账号与真实模型元组。
func (recruiter *Recruiter) isRuntimeEligible(
	ctx context.Context,
	route runtimecore.ModelRoute,
) (bool, error) {
	eligibility, err := recruiter.runtime.CheckEligibility(ctx, route)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return false, ctxErr
		}
		return false, fmt.Errorf("读取账号征召运行态失败: %w", err)
	}
	if !eligibility.IsValid() {
		return false, ErrInvalidRuntimeEligibility
	}
	return eligibility.Eligible(), nil
}

// candidateModelRoute 创建运行态和模型权限端口共享的精确元组键。
func candidateModelRoute(
	candidate accountapp.RoutingAccount,
	modelID runtimecore.ModelID,
) (runtimecore.ModelRoute, error) {
	route, err := runtimecore.NewModelRoute(
		candidate.Ref(),
		modelID.String(),
	)
	if err != nil {
		return runtimecore.ModelRoute{}, ErrInvalidCandidateSnapshot
	}
	return route, nil
}

// validCandidate 复核候选源返回的 Provider、身份和 CLI 别名。
func validCandidate(
	candidate accountapp.RoutingAccount,
	providerID string,
) bool {
	return candidate.Ref().IsValid() &&
		candidate.ProviderID() == providerID &&
		candidate.CLIAccountID().IsValid()
}

// credentialMatchesCandidate 防止错误缓存或适配器把其他账号凭据交给当前请求。
func credentialMatchesCandidate(
	candidate accountapp.RoutingAccount,
	binding accountapp.CredentialBinding,
) bool {
	return binding.IsValid() &&
		binding.AccountRef() == candidate.Ref() &&
		binding.ProviderID() == candidate.ProviderID()
}

// isAccountUnavailable 只允许明确的单账号凭据故障进入候选降级。
func isAccountUnavailable(err error) bool {
	return errors.Is(err, accountapp.ErrCredentialNotFound) ||
		errors.Is(err, accountapp.ErrCredentialConflict) ||
		errors.Is(err, accountcredentials.ErrRefreshUnavailable) ||
		errors.Is(err, accountcredentials.ErrRefreshRejected) ||
		errors.Is(err, accountcredentials.ErrReauthenticationRequired)
}
