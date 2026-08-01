package accounts

import (
	"context"
	"errors"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidLaunchSelectionDependencies 表示启动账号解析缺少 Provider 或读取端口。
	ErrInvalidLaunchSelectionDependencies = errors.New("启动账号解析依赖无效")
	// ErrInvalidLaunchSelection 表示 Provider 或显式账号选择字段组合无效。
	ErrInvalidLaunchSelection = errors.New("启动账号选择无效")
	// ErrLaunchSelectionProviderMismatch 表示显式 AccountRef 不属于目标 Provider。
	ErrLaunchSelectionProviderMismatch = errors.New("启动账号 Provider 归属不匹配")
	// ErrLaunchSelectionDisabled 表示用户停用的账号不能用于启动 Provider CLI。
	ErrLaunchSelectionDisabled = errors.New("启动账号已停用")
	// ErrLaunchSelectionUnconfigured 表示账号没有完整凭据，不能用于启动 Provider CLI。
	ErrLaunchSelectionUnconfigured = errors.New("启动账号未配置凭据")
)

// LaunchSelectionSource 描述启动账号由哪一种明确规则选中。
type LaunchSelectionSource string

const (
	// LaunchSelectionSourceAccountRef 表示调用方明确指定稳定账号引用。
	LaunchSelectionSourceAccountRef LaunchSelectionSource = "account_ref"
	// LaunchSelectionSourceCLIAccountID 表示调用方明确指定 Provider 内数字别名。
	LaunchSelectionSourceCLIAccountID LaunchSelectionSource = "cli_account_id"
	// LaunchSelectionSourceProviderDefault 表示调用方未指定账号，使用 Provider 默认关系。
	LaunchSelectionSourceProviderDefault LaunchSelectionSource = "provider_default"
)

// LaunchSelectionRequest 是 Provider CLI 启动前的账号选择输入。
//
// AccountRef 和 CLIAccountID 最多只能指定一个；两者均为空表示读取 Provider 默认账号。
type LaunchSelectionRequest struct {
	ProviderID   string
	AccountRef   accountcore.AccountRef
	CLIAccountID accountcore.CLIAccountID
}

// LaunchCandidate 是持久化适配器返回的最小启动资格投影。
//
// 它只表达基础账号和持久化适配器是否已完整恢复凭据，不包含 usage、模型或运行态。
type LaunchCandidate struct {
	account       accountcore.Account
	hasCredential bool
}

// NewLaunchCandidate 创建供启动选择用例校验的紧凑账号投影。
func NewLaunchCandidate(
	account accountcore.Account,
	hasCredential bool,
) (LaunchCandidate, error) {
	if !account.IsValid() {
		return LaunchCandidate{}, ErrInvalidLaunchSelection
	}
	return LaunchCandidate{
		account:       account,
		hasCredential: hasCredential,
	}, nil
}

// Account 返回候选账号的不可变基础快照。
func (candidate LaunchCandidate) Account() accountcore.Account {
	return candidate.account
}

// HasCredential 返回账号凭据是否已通过持久化格式和 Provider 领域校验。
func (candidate LaunchCandidate) HasCredential() bool {
	return candidate.hasCredential
}

// IsValid 判断适配器返回的候选投影是否包含有效账号。
func (candidate LaunchCandidate) IsValid() bool {
	return candidate.account.IsValid()
}

// LaunchSelection 是通过 Provider、启用状态和凭据资格校验的启动账号结果。
type LaunchSelection struct {
	account accountcore.Account
	source  LaunchSelectionSource
}

// NewLaunchSelection 创建经过账号和来源不变量校验的启动选择结果。
func NewLaunchSelection(
	account accountcore.Account,
	source LaunchSelectionSource,
) (LaunchSelection, error) {
	if !account.IsValid() || !source.isValid() {
		return LaunchSelection{}, ErrInvalidLaunchSelection
	}
	return LaunchSelection{account: account, source: source}, nil
}

// Account 返回最终选中的稳定账号快照。
func (selection LaunchSelection) Account() accountcore.Account {
	return selection.account
}

// Source 返回本次选择使用的明确规则。
func (selection LaunchSelection) Source() LaunchSelectionSource {
	return selection.source
}

// IsValid 判断选择结果是否可作为后续 Provider 启动上下文的账号部分。
func (selection LaunchSelection) IsValid() bool {
	return selection.account.IsValid() && selection.source.isValid()
}

// LaunchSelectionStore 是启动账号解析使用的单查询持久化端口。
type LaunchSelectionStore interface {
	// LoadLaunchCandidateByRef 按稳定账号引用读取一次完整启动资格快照。
	LoadLaunchCandidateByRef(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (LaunchCandidate, error)
	// LoadLaunchCandidateByCLIAccountID 按 Provider 内数字别名读取一次完整启动资格快照。
	LoadLaunchCandidateByCLIAccountID(
		ctx context.Context,
		providerID string,
		cliAccountID accountcore.CLIAccountID,
	) (LaunchCandidate, error)
	// LoadDefaultLaunchCandidate 按 Provider 默认关系读取一次完整启动资格快照。
	LoadDefaultLaunchCandidate(
		ctx context.Context,
		providerID string,
	) (LaunchCandidate, error)
}

// LaunchAccountSelector 只解析 Provider CLI 的单账号启动偏好。
//
// 它不参与推理网关征召、公平轮转、fallback、cooldown 或运行态判断。
type LaunchAccountSelector struct {
	catalog *providers.Catalog
	store   LaunchSelectionStore
}

// NewLaunchAccountSelector 创建只依赖 Provider Catalog 和紧凑读取端口的选择用例。
func NewLaunchAccountSelector(
	catalog *providers.Catalog,
	store LaunchSelectionStore,
) (*LaunchAccountSelector, error) {
	if catalog == nil || store == nil {
		return nil, ErrInvalidLaunchSelectionDependencies
	}
	return &LaunchAccountSelector{catalog: catalog, store: store}, nil
}

// Resolve 按显式 AccountRef、显式数字别名、Provider 默认账号的顺序解析一次启动选择。
func (selector *LaunchAccountSelector) Resolve(
	ctx context.Context,
	request LaunchSelectionRequest,
) (LaunchSelection, error) {
	providerID, err := selector.validateRequest(ctx, request)
	if err != nil {
		return LaunchSelection{}, err
	}

	var candidate LaunchCandidate
	var source LaunchSelectionSource
	switch {
	case request.AccountRef.IsValid():
		candidate, err = selector.store.LoadLaunchCandidateByRef(
			ctx,
			request.AccountRef,
		)
		source = LaunchSelectionSourceAccountRef
	case request.CLIAccountID.IsValid():
		candidate, err = selector.store.LoadLaunchCandidateByCLIAccountID(
			ctx,
			providerID,
			request.CLIAccountID,
		)
		source = LaunchSelectionSourceCLIAccountID
	default:
		candidate, err = selector.store.LoadDefaultLaunchCandidate(
			ctx,
			providerID,
		)
		source = LaunchSelectionSourceProviderDefault
	}
	if err != nil {
		return LaunchSelection{}, err
	}
	if !candidate.IsValid() {
		return LaunchSelection{}, ErrInvalidLaunchSelection
	}
	account := candidate.Account()
	if account.ProviderID() != providerID {
		return LaunchSelection{}, ErrLaunchSelectionProviderMismatch
	}
	if !account.Enabled() {
		return LaunchSelection{}, ErrLaunchSelectionDisabled
	}
	if !candidate.HasCredential() {
		return LaunchSelection{}, ErrLaunchSelectionUnconfigured
	}
	return NewLaunchSelection(account, source)
}

// validateRequest 规范化 Provider，并拒绝模糊或非规范的显式选择。
func (selector *LaunchAccountSelector) validateRequest(
	ctx context.Context,
	request LaunchSelectionRequest,
) (string, error) {
	if selector == nil || selector.catalog == nil || selector.store == nil || ctx == nil {
		return "", ErrInvalidLaunchSelectionDependencies
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	providerID, found := selector.catalog.CanonicalID(request.ProviderID)
	if !found ||
		providerID != request.ProviderID ||
		!supportsProviderDefault(providerID) ||
		(request.AccountRef != "" && !request.AccountRef.IsValid()) ||
		(request.CLIAccountID != 0 && !request.CLIAccountID.IsValid()) ||
		(request.AccountRef != "" && request.CLIAccountID != 0) {
		return "", ErrInvalidLaunchSelection
	}
	return providerID, nil
}

// isValid 避免未知选择来源越过应用边界。
func (source LaunchSelectionSource) isValid() bool {
	return source == LaunchSelectionSourceAccountRef ||
		source == LaunchSelectionSourceCLIAccountID ||
		source == LaunchSelectionSourceProviderDefault
}
