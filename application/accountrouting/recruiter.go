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
	// ErrInvalidDependencies 表示征召器缺少候选源或凭据解析端口。
	ErrInvalidDependencies = errors.New("账号征召器依赖无效")
	// ErrInvalidRequest 表示 Provider、游标、扫描上限或上下文无效。
	ErrInvalidRequest = errors.New("账号征召请求无效")
	// ErrInvalidCandidatePage 表示候选源违反了有界、Provider 或身份合同。
	ErrInvalidCandidatePage = errors.New("账号征召候选页无效")
	// ErrInvalidResolvedCredential 表示凭据解析结果不属于候选账号。
	ErrInvalidResolvedCredential = errors.New("账号征召凭据无效")
	// ErrInvalidRuntimeEligibility 表示运行态端口返回了不完整的资格值。
	ErrInvalidRuntimeEligibility = errors.New("账号征召运行态资格无效")
	// ErrNoRoutableAccount 表示当前候选页没有可直接交给上游的账号。
	ErrNoRoutableAccount = errors.New("没有可征召账号")
)

// CandidateSource 提供已经按 Provider 和启用状态筛选的紧凑账号页。
type CandidateSource interface {
	// ListRoutingCandidates 使用稳定游标返回不超过查询上限的候选。
	ListRoutingCandidates(
		ctx context.Context,
		query accountapp.RoutingQuery,
	) ([]accountapp.RoutingAccount, error)
}

// CredentialResolver 把候选账号凭据解析为当前可直接使用的版本。
type CredentialResolver interface {
	// ResolveCredential 延迟读取凭据，并在需要时完成 OAuth 刷新。
	ResolveCredential(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.Credential, error)
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
	// Candidates 负责有界读取启用账号的紧凑投影。
	Candidates CandidateSource
	// Runtime 负责在敏感凭据读取前排除运行态不可用元组。
	Runtime RuntimeEligibilitySource
	// Credentials 负责单账号凭据读取和必要刷新。
	Credentials CredentialResolver
}

// Request 是经过 Provider 注册表校验的有界征召请求。
type Request struct {
	query   accountapp.RoutingQuery
	modelID runtimecore.ModelID
}

// NewRequest 规范化 Provider，并校验真实模型、稳定游标和扫描上限。
//
// modelID 必须是别名解析后的真实上游模型，不能使用客户端模型别名。
func NewRequest(
	catalog *providers.Catalog,
	providerID string,
	modelID string,
	afterRef accountcore.AccountRef,
	limit int,
) (Request, error) {
	query, err := accountapp.NewRoutingQuery(
		catalog,
		providerID,
		afterRef,
		limit,
	)
	if err != nil {
		return Request{}, errors.Join(ErrInvalidRequest, err)
	}
	runtimeModelID, err := runtimecore.NewModelID(modelID)
	if err != nil {
		return Request{}, errors.Join(ErrInvalidRequest, err)
	}
	return Request{
		query:   query,
		modelID: runtimeModelID,
	}, nil
}

// ProviderID 返回规范 Provider ID。
func (request Request) ProviderID() string {
	return request.query.ProviderID()
}

// ModelID 返回别名解析后的真实上游模型 ID。
func (request Request) ModelID() runtimecore.ModelID {
	return request.modelID
}

// AfterRef 返回本页不包含的稳定账号游标。
func (request Request) AfterRef() accountcore.AccountRef {
	return request.query.AfterRef()
}

// Limit 返回本次最多检查的候选数量。
func (request Request) Limit() int {
	return request.query.Limit()
}

// isValid 防止零值或跨层篡改请求进入持久化端口。
func (request Request) isValid() bool {
	return request.ProviderID() != "" &&
		request.ModelID().IsValid() &&
		(request.AfterRef() == "" || request.AfterRef().IsValid()) &&
		request.Limit() >= 1 &&
		request.Limit() <= accountapp.MaxRoutingLimit
}

// Result 保存一次有界征召的账号、凭据和续查进度。
//
// ErrNoRoutableAccount 时账号和凭据为空，但 Examined、NextAfterRef 和
// SourceExhausted 仍可用于继续下一页或结束本轮扫描。
type Result struct {
	account         accountapp.RoutingAccount
	credential      accountapp.Credential
	examined        int
	nextAfterRef    accountcore.AccountRef
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

// NextAfterRef 返回最后检查的账号，可直接作为下一页稳定游标。
func (result Result) NextAfterRef() accountcore.AccountRef {
	return result.nextAfterRef
}

// SourceExhausted 表示当前结果之后已确认没有更多候选。
func (result Result) SourceExhausted() bool {
	return result.sourceExhausted
}

// Recruiter 编排有界候选读取和单账号凭据可用化。
type Recruiter struct {
	candidates  CandidateSource
	runtime     RuntimeEligibilitySource
	credentials CredentialResolver
}

// NewRecruiter 创建不持有账号池、不缓存凭据的无状态征召器。
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
	}, nil
}

// Recruit 返回当前页首个凭据可用的账号。
//
// 单账号缺失凭据、需要重新认证、刷新被拒绝或刷新暂时失败时继续检查下一候选；
// 未分类的存储、解码和合同错误立即失败，避免静默掩盖系统问题。
func (recruiter *Recruiter) Recruit(
	ctx context.Context,
	request Request,
) (Result, error) {
	if recruiter == nil ||
		recruiter.candidates == nil ||
		recruiter.runtime == nil ||
		recruiter.credentials == nil {
		return Result{}, ErrInvalidDependencies
	}
	if ctx == nil || !request.isValid() {
		return Result{}, ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	candidates, err := recruiter.candidates.ListRoutingCandidates(
		ctx,
		request.query,
	)
	if err != nil {
		return Result{}, fmt.Errorf("读取账号征召候选失败: %w", err)
	}
	if len(candidates) > request.Limit() {
		return Result{}, ErrInvalidCandidatePage
	}
	progress := Result{
		nextAfterRef:    request.AfterRef(),
		sourceExhausted: len(candidates) < request.Limit(),
	}
	for index, candidate := range candidates {
		progress.examined++
		progress.nextAfterRef = candidate.Ref()
		if !validCandidate(candidate, request.ProviderID()) {
			return progress, ErrInvalidCandidatePage
		}
		eligible, eligibilityErr := recruiter.isRuntimeEligible(
			ctx,
			candidate,
			request.ModelID(),
		)
		if eligibilityErr != nil {
			return progress, eligibilityErr
		}
		if !eligible {
			continue
		}
		credential, resolveErr := recruiter.credentials.ResolveCredential(
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
		if !credentialMatchesCandidate(candidate, credential) {
			return progress, ErrInvalidResolvedCredential
		}
		progress.account = candidate
		progress.credential = credential
		progress.sourceExhausted = progress.sourceExhausted &&
			index == len(candidates)-1
		return progress, nil
	}
	return progress, ErrNoRoutableAccount
}

// isRuntimeEligible 在读取敏感凭据前检查账号与真实模型元组。
func (recruiter *Recruiter) isRuntimeEligible(
	ctx context.Context,
	candidate accountapp.RoutingAccount,
	modelID runtimecore.ModelID,
) (bool, error) {
	route, err := runtimecore.NewModelRoute(
		candidate.Ref(),
		modelID.String(),
	)
	if err != nil {
		return false, ErrInvalidCandidatePage
	}
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
	credential accountapp.Credential,
) bool {
	if credential == nil || credential.ProviderID() != candidate.ProviderID() {
		return false
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	return err == nil && accountRef == candidate.Ref()
}

// isAccountUnavailable 只允许明确的单账号凭据故障进入候选降级。
func isAccountUnavailable(err error) bool {
	return errors.Is(err, accountapp.ErrCredentialNotFound) ||
		errors.Is(err, accountapp.ErrCredentialConflict) ||
		errors.Is(err, accountcredentials.ErrRefreshUnavailable) ||
		errors.Is(err, accountcredentials.ErrRefreshRejected) ||
		errors.Is(err, accountcredentials.ErrReauthenticationRequired)
}
