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
	// RecoveryCredentialsUpdated 表示账号凭据已经由重登或显式更新替换。
	RecoveryCredentialsUpdated RecoveryTrigger = "credentials_updated"
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
	if err != nil || !policy.BlocksRouting() || !policy.allowsScope(scope) {
		return BlockDirective{}, ErrInvalidBlockDirective
	}
	return BlockDirective{
		kind:     kind,
		scope:    scope,
		recovery: policy.Recovery(),
	}, nil
}

// DefaultBlockDirective 返回不依赖 Provider 额外证据的固定阻塞合同。
//
// 哪些类型有默认作用域由契约数据决定：quota、region 和 permission 允许账号或
// 账号模型两种作用域，契约不设默认值，必须使用 NewBlockDirective 显式声明。
func DefaultBlockDirective(kind FailureKind) (BlockDirective, error) {
	policy, err := PolicyFor(kind)
	if err != nil || !policy.BlocksRouting() {
		return BlockDirective{}, ErrInvalidBlockDirective
	}
	scope, ok := policy.DefaultBlockScope()
	if !ok {
		return BlockDirective{}, ErrBlockScopeRequired
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
