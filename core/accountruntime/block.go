package accountruntime

import "errors"

var (
	// ErrInvalidBlockDirective 表示失败类型、作用域或解除信号不匹配。
	ErrInvalidBlockDirective = errors.New("账号运行态硬阻塞指令无效")
	// ErrBlockScopeRequired 表示 Provider 必须根据结构化证据声明作用域。
	ErrBlockScopeRequired = errors.New("账号运行态硬阻塞缺少明确作用域")
)

// BlockScope 表示硬阻塞影响账号整体还是单个真实模型。
type BlockScope string

const (
	// BlockScopeAccount 表示账号的所有模型都不能继续征召。
	BlockScopeAccount BlockScope = "account"
	// BlockScopeAccountModel 表示只排除当前账号与真实模型元组。
	BlockScopeAccountModel BlockScope = "account_model"
)

// RecoveryTrigger 表示哪个外部真相源更新后允许重新判断阻塞。
type RecoveryTrigger string

const (
	// RecoveryCredentialVersion 表示新凭据版本可以解除凭据阻塞。
	RecoveryCredentialVersion RecoveryTrigger = "credential_version"
	// RecoveryUsageSnapshot 表示新额度快照可以解除 quota 阻塞。
	RecoveryUsageSnapshot RecoveryTrigger = "usage_snapshot"
	// RecoveryBillingSnapshot 表示新账单快照可以解除 billing 阻塞。
	RecoveryBillingSnapshot RecoveryTrigger = "billing_snapshot"
	// RecoveryAccountStatus 表示新账号状态可以解除工作区停用阻塞。
	RecoveryAccountStatus RecoveryTrigger = "account_status"
	// RecoveryModelCatalog 表示新模型目录可以解除模型能力阻塞。
	RecoveryModelCatalog RecoveryTrigger = "model_catalog"
	// RecoveryPolicySnapshot 表示新地区或 Provider 策略可以解除策略阻塞。
	RecoveryPolicySnapshot RecoveryTrigger = "policy_snapshot"
)

// BlockDirective 是不包含凭据、正文或请求内容的硬阻塞合同。
type BlockDirective struct {
	kind     FailureKind
	scope    BlockScope
	recovery RecoveryTrigger
}

// NewBlockDirective 按失败类型校验作用域并绑定唯一解除信号。
func NewBlockDirective(
	kind FailureKind,
	scope BlockScope,
) (BlockDirective, error) {
	policy, err := PolicyFor(kind)
	if err != nil || !policy.BlocksRouting() {
		return BlockDirective{}, ErrInvalidBlockDirective
	}
	recovery, valid := recoveryForBlock(kind, scope)
	if !valid {
		return BlockDirective{}, ErrInvalidBlockDirective
	}
	return BlockDirective{
		kind:     kind,
		scope:    scope,
		recovery: recovery,
	}, nil
}

// DefaultBlockDirective 返回不依赖 Provider 额外证据的固定阻塞合同。
//
// quota、region 和 permission 可能作用于账号或账号模型，必须使用 NewBlockDirective
// 显式声明，不能在共享领域层猜测。
func DefaultBlockDirective(kind FailureKind) (BlockDirective, error) {
	var scope BlockScope
	switch kind {
	case FailureCredentialRejected,
		FailureReauthenticationRequired,
		FailureBillingBlocked,
		FailureWorkspaceDeactivated:
		scope = BlockScopeAccount
	case FailureModelUnsupported:
		scope = BlockScopeAccountModel
	case FailureQuotaExhausted,
		FailureRegionUnsupported,
		FailurePermissionDenied:
		return BlockDirective{}, ErrBlockScopeRequired
	default:
		return BlockDirective{}, ErrInvalidBlockDirective
	}
	return NewBlockDirective(kind, scope)
}

// Scope 返回硬阻塞影响的最小账号范围。
func (directive BlockDirective) Scope() BlockScope {
	return directive.scope
}

// RecoveryTrigger 返回负责解除阻塞的外部真相源。
func (directive BlockDirective) RecoveryTrigger() RecoveryTrigger {
	return directive.recovery
}

// IsZero 判断当前值没有携带硬阻塞指令。
func (directive BlockDirective) IsZero() bool {
	return directive == BlockDirective{}
}

// IsValidFor 判断指令是否与指定失败类型完整一致。
func (directive BlockDirective) IsValidFor(kind FailureKind) bool {
	restored, err := NewBlockDirective(kind, directive.scope)
	return err == nil && restored == directive
}

// recoveryForBlock 返回指定失败和作用域唯一允许的解除信号。
func recoveryForBlock(
	kind FailureKind,
	scope BlockScope,
) (RecoveryTrigger, bool) {
	switch kind {
	case FailureCredentialRejected, FailureReauthenticationRequired:
		return RecoveryCredentialVersion, scope == BlockScopeAccount
	case FailureQuotaExhausted:
		return RecoveryUsageSnapshot, isAccountScope(scope)
	case FailureBillingBlocked:
		return RecoveryBillingSnapshot, scope == BlockScopeAccount
	case FailureWorkspaceDeactivated:
		return RecoveryAccountStatus, scope == BlockScopeAccount
	case FailureModelUnsupported:
		return RecoveryModelCatalog, scope == BlockScopeAccountModel
	case FailureRegionUnsupported:
		return RecoveryPolicySnapshot, isAccountScope(scope)
	case FailurePermissionDenied:
		return RecoveryPolicySnapshot, isAccountScope(scope)
	default:
		return "", false
	}
}

// isAccountScope 判断作用域是否能由当前账号征召键表达。
func isAccountScope(scope BlockScope) bool {
	return scope == BlockScopeAccount || scope == BlockScopeAccountModel
}
