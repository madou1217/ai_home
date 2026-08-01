package providerlaunch

import (
	"context"
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidDependencies 表示启动规划器缺少账号选择、凭据解析或 Provider Strategy。
	ErrInvalidDependencies = errors.New("Provider 启动规划依赖无效")
	// ErrInvalidBuildRequest 表示启动规划请求或上下文无效。
	ErrInvalidBuildRequest = errors.New("Provider 启动规划请求无效")
	// ErrStrategyNotFound 表示选中账号所属 Provider 没有启动策略。
	ErrStrategyNotFound = errors.New("Provider 启动策略不存在")
	// ErrCredentialBindingMismatch 表示刷新后的凭据不属于选中的账号或 Provider。
	ErrCredentialBindingMismatch = errors.New("Provider 启动凭据绑定不匹配")
)

// AccountSelector 是 Provider CLI 启动账号选择的最小应用端口。
type AccountSelector interface {
	// Resolve 按显式账号或 Provider 默认关系返回唯一启动账号。
	Resolve(
		ctx context.Context,
		request accountapp.LaunchSelectionRequest,
	) (accountapp.LaunchSelection, error)
}

// CredentialResolver 是启动前取得当前可用凭据的最小应用端口。
type CredentialResolver interface {
	// ResolveCredentialBinding 刷新即将过期的 OAuth 后返回稳定账号绑定。
	ResolveCredentialBinding(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.CredentialBinding, error)
}

// Strategy 把一个 Provider 领域凭据转换为原生 CLI 启动差异。
type Strategy interface {
	// ProviderID 返回 Strategy 唯一支持的规范 Provider。
	ProviderID() string
	// Build 生成不执行 I/O 的安全启动描述。
	Build(binding accountapp.CredentialBinding) (StrategyResult, error)
}

// Dependencies 集中声明启动规划器的三个窄接口依赖。
type Dependencies struct {
	// Accounts 负责解析显式账号或 Provider 默认账号。
	Accounts AccountSelector
	// Credentials 负责读取并按需刷新当前凭据。
	Credentials CredentialResolver
	// Strategies 是当前已经研究完成的 Provider CLI 策略。
	Strategies []Strategy
}

// Planner 按固定主链生成 Provider CLI 启动描述。
//
// 主链为账号选择 -> 凭据解析 -> Provider Strategy；Planner 不包含 Provider 分支。
type Planner struct {
	accounts    AccountSelector
	credentials CredentialResolver
	strategies  map[string]Strategy
}

// NewPlanner 校验依赖并创建只读 Provider Strategy 注册表。
func NewPlanner(dependencies Dependencies) (*Planner, error) {
	if dependencies.Accounts == nil ||
		dependencies.Credentials == nil ||
		len(dependencies.Strategies) == 0 {
		return nil, ErrInvalidDependencies
	}
	strategies := make(map[string]Strategy, len(dependencies.Strategies))
	for _, strategy := range dependencies.Strategies {
		if strategy == nil || !isDescriptorToken(strategy.ProviderID()) {
			return nil, ErrInvalidDependencies
		}
		providerID := strategy.ProviderID()
		if _, duplicated := strategies[providerID]; duplicated {
			return nil, ErrInvalidDependencies
		}
		strategies[providerID] = strategy
	}
	return &Planner{
		accounts:    dependencies.Accounts,
		credentials: dependencies.Credentials,
		strategies:  strategies,
	}, nil
}

// Build 解析账号、取得当前凭据并生成一次不可变启动描述。
func (planner *Planner) Build(
	ctx context.Context,
	request accountapp.LaunchSelectionRequest,
) (LaunchSpec, error) {
	if planner == nil ||
		planner.accounts == nil ||
		planner.credentials == nil ||
		len(planner.strategies) == 0 ||
		ctx == nil {
		return LaunchSpec{}, ErrInvalidBuildRequest
	}
	if err := ctx.Err(); err != nil {
		return LaunchSpec{}, err
	}

	selection, err := planner.accounts.Resolve(ctx, request)
	if err != nil {
		return LaunchSpec{}, err
	}
	if !selection.IsValid() {
		return LaunchSpec{}, ErrInvalidLaunchSpec
	}
	account := selection.Account()
	if !account.Enabled() || account.ProviderID() != request.ProviderID {
		return LaunchSpec{}, ErrInvalidLaunchSpec
	}
	strategy, found := planner.strategies[account.ProviderID()]
	if !found {
		return LaunchSpec{}, ErrStrategyNotFound
	}

	binding, err := planner.credentials.ResolveCredentialBinding(ctx, account.Ref())
	if err != nil {
		return LaunchSpec{}, err
	}
	if !binding.IsValid() ||
		binding.AccountRef() != account.Ref() ||
		binding.ProviderID() != account.ProviderID() {
		return LaunchSpec{}, ErrCredentialBindingMismatch
	}

	result, err := strategy.Build(binding)
	if err != nil {
		return LaunchSpec{}, err
	}
	if result.ProviderID() != strategy.ProviderID() ||
		result.ProviderID() != account.ProviderID() {
		return LaunchSpec{}, ErrInvalidStrategyResult
	}
	return newLaunchSpec(selection, result)
}
