package inmemory

import runtimecore "github.com/madou1217/ai_home/core/accountruntime"

// blockSet 用一个字节保存账号或账号模型当前等待的外部恢复事件。
//
// 同一作用域可以同时等待多个真相源，清除一个位不会影响其他阻塞。
type blockSet uint8

// recoveryScopeSet 表示一个恢复事件允许清理的运行态作用域集合。
type recoveryScopeSet uint8

const (
	// blockCredentialsUpdated 表示必须先成功更新账号凭据。
	blockCredentialsUpdated blockSet = 1 << iota
	// blockUsageSnapshot 表示必须先确认新的额度快照。
	blockUsageSnapshot
	// blockBillingSnapshot 表示必须先确认新的账单快照。
	blockBillingSnapshot
	// blockAccountStatus 表示必须先确认新的账号状态。
	blockAccountStatus
	// blockModelCatalog 表示必须先刷新账号模型目录。
	blockModelCatalog
	// blockPolicySnapshot 表示必须先确认新的 Provider 策略。
	blockPolicySnapshot
)

const (
	// recoveryScopeAccount 表示恢复事件可以清理账号级阻塞。
	recoveryScopeAccount recoveryScopeSet = 1 << iota
	// recoveryScopeModel 表示恢复事件可以清理账号模型级阻塞。
	recoveryScopeModel
)

// recoveryDefinition 集中保存恢复事件对应的阻塞位和合法作用域。
type recoveryDefinition struct {
	block  blockSet
	scopes recoveryScopeSet
}

// add 返回包含指定恢复事件的新集合。
func (set blockSet) add(block blockSet) blockSet {
	return set | block
}

// clear 返回只移除指定恢复事件的新集合。
func (set blockSet) clear(block blockSet) blockSet {
	return set &^ block
}

// eligibility 按稳定优先级把多个阻塞压缩为单个征召结果。
func (set blockSet) eligibility() (runtimecore.Eligibility, bool) {
	switch {
	case set&blockCredentialsUpdated != 0:
		return runtimecore.CredentialBlockedEligibility(), true
	case set&(blockUsageSnapshot|blockBillingSnapshot) != 0:
		return runtimecore.QuotaBlockedEligibility(), true
	case set&(blockAccountStatus|
		blockModelCatalog|
		blockPolicySnapshot) != 0:
		return runtimecore.PolicyBlockedEligibility(), true
	default:
		return runtimecore.Eligibility{}, false
	}
}

// definitionForRecovery 返回恢复事件唯一的紧凑位与合法作用域。
func definitionForRecovery(
	trigger runtimecore.RecoveryTrigger,
) (recoveryDefinition, bool) {
	switch trigger {
	case runtimecore.RecoveryCredentialsUpdated:
		return accountRecovery(blockCredentialsUpdated), true
	case runtimecore.RecoveryUsageSnapshot:
		return sharedRecovery(blockUsageSnapshot), true
	case runtimecore.RecoveryBillingSnapshot:
		return accountRecovery(blockBillingSnapshot), true
	case runtimecore.RecoveryAccountStatus:
		return accountRecovery(blockAccountStatus), true
	case runtimecore.RecoveryModelCatalog:
		return modelRecovery(blockModelCatalog), true
	case runtimecore.RecoveryPolicySnapshot:
		return sharedRecovery(blockPolicySnapshot), true
	default:
		return recoveryDefinition{}, false
	}
}

// supports 判断恢复事件能否用于目标作用域。
func (definition recoveryDefinition) supports(
	scope recoveryScopeSet,
) bool {
	return definition.block != 0 &&
		scope != 0 &&
		definition.scopes&scope != 0
}

// accountRecovery 创建只允许账号级清理的恢复定义。
func accountRecovery(block blockSet) recoveryDefinition {
	return recoveryDefinition{
		block:  block,
		scopes: recoveryScopeAccount,
	}
}

// modelRecovery 创建只允许账号模型级清理的恢复定义。
func modelRecovery(block blockSet) recoveryDefinition {
	return recoveryDefinition{
		block:  block,
		scopes: recoveryScopeModel,
	}
}

// sharedRecovery 创建账号级和账号模型级都允许使用的恢复定义。
func sharedRecovery(block blockSet) recoveryDefinition {
	return recoveryDefinition{
		block:  block,
		scopes: recoveryScopeAccount | recoveryScopeModel,
	}
}
