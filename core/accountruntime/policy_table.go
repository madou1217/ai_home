package accountruntime

// 本文件把 contracts/upstream-failure 的策略表组装成运行态可用的只读快照。
//
// 优先级：内置契约 < 全局覆盖（可热更新） < 旧进程环境变量。
// 环境变量保留 AIH_SERVER_COOLDOWN_MS / AIH_SERVER_FAILURE_THRESHOLD 的原有语义：
// 冷却覆盖所有有限时间冷却策略，阈值覆盖所有策略的默认阈值。

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	failurecontract "github.com/madou1217/ai_home/contracts/upstream-failure"
)

// PolicyOverride 是运行时可编辑的策略参数覆盖。
//
// 只允许改阈值、窗口与默认冷却；动作边界（block/cooldown/no_state_change）属于
// 语义本身，由契约的 policies 行决定，不能被运行时配置改写成另一个边界。
type PolicyOverride struct {
	Kind            FailureKind
	Threshold       *uint8
	FailureWindow   *time.Duration
	DefaultCooldown *time.Duration
}

type policySnapshot struct {
	byKind map[FailureKind]FailurePolicy
}

var (
	policySnapshotPtr atomic.Pointer[policySnapshot]

	policyStateMu      sync.Mutex
	policyEnvCooldown  time.Duration
	policyEnvThreshold uint8
	policyOverrides    []PolicyOverride
)

func init() {
	snapshot, err := buildPolicySnapshot(0, 0, nil)
	if err != nil {
		panic(fmt.Sprintf("失败策略表无效: %v", err))
	}
	policySnapshotPtr.Store(snapshot)
}

func currentPolicySnapshot() *policySnapshot {
	return policySnapshotPtr.Load()
}

// ConfigurePolicyDefaults 配置本进程的猜测冷却与失败阈值覆盖。
//
// 0 表示保留领域默认值；非 0 冷却必须落在 [1s, 24h]，阈值必须在 [0,10]。
// 该覆盖作用于所有有限时间冷却策略，优先级高于全局覆盖。
func ConfigurePolicyDefaults(cooldown time.Duration, threshold uint8) error {
	if cooldown != 0 && (cooldown < time.Second || cooldown > MaxCooldownHint) {
		return errors.New("猜测冷却时长必须在 1s 到 24h 之间")
	}
	if threshold > 10 {
		return errors.New("失败阈值必须在 0 到 10 之间")
	}
	policyStateMu.Lock()
	defer policyStateMu.Unlock()
	previousCooldown := policyEnvCooldown
	previousThreshold := policyEnvThreshold
	policyEnvCooldown = cooldown
	policyEnvThreshold = threshold
	snapshot, err := buildPolicySnapshot(cooldown, threshold, policyOverrides)
	if err != nil {
		policyEnvCooldown = previousCooldown
		policyEnvThreshold = previousThreshold
		return err
	}
	policySnapshotPtr.Store(snapshot)
	return nil
}

// ApplyPolicyOverrides 替换运行时可编辑的策略参数覆盖。
//
// 空集合表示回到契约默认值（仍受进程环境变量影响）。校验失败时保持旧快照，
// 调用方必须把错误反馈给配置写入方，不能静默降级。
func ApplyPolicyOverrides(overrides []PolicyOverride) error {
	policyStateMu.Lock()
	defer policyStateMu.Unlock()
	snapshot, err := buildPolicySnapshot(policyEnvCooldown, policyEnvThreshold, overrides)
	if err != nil {
		return err
	}
	cloned := make([]PolicyOverride, len(overrides))
	copy(cloned, overrides)
	policyOverrides = cloned
	policySnapshotPtr.Store(snapshot)
	return nil
}

// ConfiguredGuessedCooldown 返回当前进程生效的猜测冷却。
//
// 没有进程覆盖时返回领域默认值；适配器用它补全上游未给出恢复提示的瞬态失败。
func ConfiguredGuessedCooldown() time.Duration {
	policyStateMu.Lock()
	cooldown := policyEnvCooldown
	policyStateMu.Unlock()
	if cooldown > 0 {
		return cooldown
	}
	return GuessedCooldown
}

func buildPolicySnapshot(
	envCooldown time.Duration,
	envThreshold uint8,
	overrides []PolicyOverride,
) (*policySnapshot, error) {
	document := failurecontract.Default()
	if document == nil {
		return nil, errors.New("失败策略契约缺失")
	}
	snapshot := &policySnapshot{byKind: make(map[FailureKind]FailurePolicy, len(document.Policies))}
	for _, row := range document.Policies {
		kind := FailureKind(strings.TrimSpace(row.Kind))
		policy, err := policyFromRow(row)
		if err != nil {
			return nil, err
		}
		snapshot.byKind[kind] = policy
	}
	for kind, policy := range snapshot.byKind {
		if !policy.EntersCooldown() {
			continue
		}
		if envCooldown > 0 {
			policy.defaultCooldown = envCooldown
		}
		if envThreshold > 0 {
			policy.threshold = envThreshold
		}
		snapshot.byKind[kind] = policy
	}
	for _, override := range overrides {
		kind := FailureKind(strings.TrimSpace(string(override.Kind)))
		policy, found := snapshot.byKind[kind]
		if !found {
			return nil, fmt.Errorf("未知失败类型: %s", override.Kind)
		}
		if !policy.EntersCooldown() {
			return nil, fmt.Errorf("失败类型 %s 不是有限时间冷却策略，不能覆盖冷却参数", kind)
		}
		if override.Threshold != nil {
			policy.threshold = *override.Threshold
		}
		if override.FailureWindow != nil {
			policy.failureWindow = *override.FailureWindow
		}
		if override.DefaultCooldown != nil {
			policy.defaultCooldown = *override.DefaultCooldown
		}
		snapshot.byKind[kind] = policy
	}
	for kind, policy := range snapshot.byKind {
		if err := validatePolicy(kind, policy); err != nil {
			return nil, err
		}
	}
	return snapshot, nil
}

func policyFromRow(row failurecontract.Policy) (FailurePolicy, error) {
	action := FailureAction(strings.TrimSpace(row.Action))
	policy := FailurePolicy{action: action}
	switch action {
	case ActionModelCooldown:
		if row.Threshold < 1 || row.Threshold > 10 {
			return FailurePolicy{}, fmt.Errorf("策略 %s 的阈值必须在 1..10", row.Kind)
		}
		policy.threshold = uint8(row.Threshold)
		policy.failureWindow = time.Duration(row.FailureWindowMS) * time.Millisecond
		policy.defaultCooldown = time.Duration(row.DefaultCooldownMS) * time.Millisecond
	case ActionCredentialBlock, ActionQuotaBlock, ActionPolicyBlock:
		for _, scope := range row.BlockScopes {
			parsed, ok := parseBlockScope(scope)
			if !ok {
				return FailurePolicy{}, fmt.Errorf("策略 %s 的作用域 %q 无效", row.Kind, scope)
			}
			policy.scopes = append(policy.scopes, parsed)
		}
		if len(policy.scopes) == 0 {
			return FailurePolicy{}, fmt.Errorf("策略 %s 缺少作用域", row.Kind)
		}
		if row.DefaultBlockScope != "" {
			parsed, ok := parseBlockScope(row.DefaultBlockScope)
			if !ok || !policy.allowsScope(parsed) {
				return FailurePolicy{}, fmt.Errorf("策略 %s 的默认作用域 %q 无效", row.Kind, row.DefaultBlockScope)
			}
			policy.defaultScope = parsed
		}
		recovery, ok := parseRecoveryTrigger(row.Recovery)
		if !ok {
			return FailurePolicy{}, fmt.Errorf("策略 %s 的解除信号 %q 无效", row.Kind, row.Recovery)
		}
		policy.recovery = recovery
	case ActionNoStateChange:
	default:
		return FailurePolicy{}, fmt.Errorf("策略 %s 的动作 %q 无效", row.Kind, row.Action)
	}
	return policy, nil
}

func validatePolicy(kind FailureKind, policy FailurePolicy) error {
	switch policy.action {
	case ActionModelCooldown:
		if policy.threshold < 1 || policy.threshold > 10 {
			return fmt.Errorf("策略 %s 的阈值必须在 1..10", kind)
		}
		if policy.threshold > 1 && policy.failureWindow <= 0 {
			return fmt.Errorf("策略 %s 的阈值大于 1 时失败窗口必须大于 0", kind)
		}
		if policy.failureWindow < 0 {
			return fmt.Errorf("策略 %s 的失败窗口不能为负", kind)
		}
		if policy.defaultCooldown < time.Second || policy.defaultCooldown > MaxCooldownHint {
			return fmt.Errorf("策略 %s 的默认冷却必须在 1s 到 24h 之间", kind)
		}
	case ActionCredentialBlock, ActionQuotaBlock, ActionPolicyBlock:
		if len(policy.scopes) == 0 || policy.recovery == "" {
			return fmt.Errorf("策略 %s 的阻塞定义不完整", kind)
		}
	case ActionNoStateChange:
	default:
		return fmt.Errorf("策略 %s 的动作无效", kind)
	}
	return nil
}

func parseBlockScope(raw string) (BlockScope, bool) {
	switch BlockScope(strings.TrimSpace(raw)) {
	case BlockScopeAccount:
		return BlockScopeAccount, true
	case BlockScopeAccountModel:
		return BlockScopeAccountModel, true
	default:
		return "", false
	}
}

func parseRecoveryTrigger(raw string) (RecoveryTrigger, bool) {
	switch RecoveryTrigger(strings.TrimSpace(raw)) {
	case RecoveryCredentialsUpdated, RecoveryUsageSnapshot, RecoveryBillingSnapshot,
		RecoveryAccountStatus, RecoveryModelCatalog, RecoveryPolicySnapshot:
		return RecoveryTrigger(strings.TrimSpace(raw)), true
	default:
		return "", false
	}
}
