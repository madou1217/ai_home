// Package providerlaunch 生成 Provider CLI 启动前的安全、不可变描述。
//
// 该包不创建临时目录、不写凭据文件、不启动进程，也不依赖 tmux；真正的资源分配、
// 进程生命周期和清理属于后续 Runtime Adapter。
package providerlaunch

import (
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidLaunchSpec 表示账号选择与 Provider Strategy 结果不一致。
	ErrInvalidLaunchSpec = errors.New("Provider 启动描述无效")
)

// LaunchSpec 是完成账号选择、凭据刷新和 Provider 适配后的最终启动描述。
type LaunchSpec struct {
	mode                      LaunchMode
	providerID                string
	accountRef                accountcore.AccountRef
	cliAccountID              accountcore.CLIAccountID
	selectionSource           accountapp.LaunchSelectionSource
	binary                    string
	arguments                 []string
	argumentsAfterSubcommands []string
	environment               EnvironmentPatch
	runtime                   RuntimeDirective
	credential                CredentialDescriptor
}

// newLaunchSpec 合并经过验证的账号选择和 Provider Strategy 结果。
func newLaunchSpec(
	selection accountapp.LaunchSelection,
	result StrategyResult,
) (LaunchSpec, error) {
	if !selection.IsValid() || !result.IsValid() {
		return LaunchSpec{}, ErrInvalidLaunchSpec
	}
	account := selection.Account()
	if account.ProviderID() != result.providerID ||
		!isExplicitSelectionSource(selection.Source()) {
		return LaunchSpec{}, ErrInvalidLaunchSpec
	}
	return LaunchSpec{
		mode:                      LaunchModeNativeDirect,
		providerID:                account.ProviderID(),
		accountRef:                account.Ref(),
		cliAccountID:              account.CLIAccountID(),
		selectionSource:           selection.Source(),
		binary:                    result.binary,
		arguments:                 append([]string(nil), result.arguments...),
		argumentsAfterSubcommands: append([]string(nil), result.argumentsAfterSubcommands...),
		environment:               cloneEnvironmentPatch(result.environment),
		runtime:                   cloneRuntimeDirective(result.runtime),
		credential:                result.credential,
	}, nil
}

// Mode 返回本描述唯一允许的 Native Direct 模式。
func (spec LaunchSpec) Mode() LaunchMode {
	return spec.mode
}

// ProviderID 返回目标 Provider 的规范标识。
func (spec LaunchSpec) ProviderID() string {
	return spec.providerID
}

// AccountRef 返回启动凭据绑定的稳定账号引用。
func (spec LaunchSpec) AccountRef() accountcore.AccountRef {
	return spec.accountRef
}

// CLIAccountID 返回本机用户可见的 Provider 内数字别名。
func (spec LaunchSpec) CLIAccountID() accountcore.CLIAccountID {
	return spec.cliAccountID
}

// SelectionSource 返回本次账号选择使用的明确规则。
func (spec LaunchSpec) SelectionSource() accountapp.LaunchSelectionSource {
	return spec.selectionSource
}

// Binary 返回不包含 shell 的原生 CLI 可执行文件名。
func (spec LaunchSpec) Binary() string {
	return spec.binary
}

// Arguments 返回 Provider 必需的非敏感全局参数副本。
func (spec LaunchSpec) Arguments() []string {
	return append([]string(nil), spec.arguments...)
}

// ArgumentsAfterSubcommands 返回账号参数需要跟随其后的 Provider 子命令集合。
func (spec LaunchSpec) ArgumentsAfterSubcommands() []string {
	return append([]string(nil), spec.argumentsAfterSubcommands...)
}

// ResolveArguments 合并用户命令参数并保持 Provider 所需的精确插入位置。
func (spec LaunchSpec) ResolveArguments(arguments []string) ([]string, error) {
	return mergeArguments(
		spec.arguments,
		spec.argumentsAfterSubcommands,
		arguments,
	)
}

// Environment 返回环境补丁的深副本。
func (spec LaunchSpec) Environment() EnvironmentPatch {
	return cloneEnvironmentPatch(spec.environment)
}

// Runtime 返回官方 CLI 的进程拓扑和敏感输入副本。
func (spec LaunchSpec) Runtime() RuntimeDirective {
	return cloneRuntimeDirective(spec.runtime)
}

// Credential 返回不包含任何凭据内容的认证类型摘要。
func (spec LaunchSpec) Credential() CredentialDescriptor {
	return spec.credential
}

// IsValid 判断跨层传递后的启动描述是否仍满足账号和 Provider 不变量。
func (spec LaunchSpec) IsValid() bool {
	if spec.mode != LaunchModeNativeDirect ||
		!isDescriptorToken(spec.providerID) ||
		!spec.accountRef.IsValid() ||
		!spec.cliAccountID.IsValid() ||
		!isExplicitSelectionSource(spec.selectionSource) ||
		!isBinaryName(spec.binary) ||
		!validSubcommands(spec.argumentsAfterSubcommands) ||
		(len(spec.arguments) == 0 && len(spec.argumentsAfterSubcommands) > 0) ||
		!spec.environment.IsValid() ||
		!preservesSharedNativeState(spec.environment) ||
		!spec.runtime.IsValid() ||
		!spec.credential.IsValid() {
		return false
	}
	return true
}

// String 返回不含参数正文、环境值和 Runtime 敏感输入的安全启动摘要。
func (spec LaunchSpec) String() string {
	return fmt.Sprintf(
		"providerlaunch.LaunchSpec{mode=%s,provider=%s,account=%s,cli_id=%d,source=%s,binary=%s,args=%d,args_after=%v,env_set=%v,env_unset=%v,runtime=%s,credential=%s}",
		spec.mode,
		spec.providerID,
		spec.accountRef,
		spec.cliAccountID,
		spec.selectionSource,
		spec.binary,
		len(spec.arguments),
		spec.argumentsAfterSubcommands,
		spec.environment.SetNames(),
		spec.environment.UnsetNames(),
		spec.runtime.Kind(),
		spec.credential,
	)
}

// GoString 确保 %#v 不会反射启动描述中的明文凭据。
func (spec LaunchSpec) GoString() string {
	return spec.String()
}

// Format 覆盖所有 fmt verb，避免值格式化绕过启动描述脱敏。
func (spec LaunchSpec) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(spec.String()))
}

// isExplicitSelectionSource 限定 Native Direct 只能使用显式稳定引用或数字别名。
func isExplicitSelectionSource(source accountapp.LaunchSelectionSource) bool {
	return source == accountapp.LaunchSelectionSourceAccountRef ||
		source == accountapp.LaunchSelectionSourceCLIAccountID
}
