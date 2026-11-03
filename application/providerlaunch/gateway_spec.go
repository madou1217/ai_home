package providerlaunch

import (
	"errors"
	"fmt"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidGatewayLaunchSpec 表示 Gateway 账号约束与 Provider 进程描述不一致。
	ErrInvalidGatewayLaunchSpec = errors.New("Gateway 启动描述无效")
)

// GatewayStrategyResultInput 是 Provider Adapter 构建 Gateway 进程差异的输入。
type GatewayStrategyResultInput struct {
	ProviderID                string
	Binary                    string
	Arguments                 []string
	ArgumentsAfterSubcommands []string
	Environment               EnvironmentPatch
}

// GatewayStrategyResult 是不含账号选择和用户参数的 Provider 进程描述。
type GatewayStrategyResult struct {
	providerID                string
	binary                    string
	arguments                 []string
	argumentsAfterSubcommands []string
	environment               EnvironmentPatch
}

// NewGatewayStrategyResult 校验并复制 Provider Gateway 进程描述。
func NewGatewayStrategyResult(input GatewayStrategyResultInput) (GatewayStrategyResult, error) {
	if !isDescriptorToken(input.ProviderID) ||
		!isBinaryName(input.Binary) ||
		!input.Environment.IsValid() ||
		!preservesSharedNativeState(input.Environment) {
		return GatewayStrategyResult{}, ErrInvalidGatewayStrategyResult
	}
	arguments, err := validateArguments(input.Arguments)
	if err != nil {
		return GatewayStrategyResult{}, ErrInvalidGatewayStrategyResult
	}
	subcommands, err := validateSubcommands(input.ArgumentsAfterSubcommands)
	if err != nil || (len(arguments) == 0 && len(subcommands) > 0) {
		return GatewayStrategyResult{}, ErrInvalidGatewayStrategyResult
	}
	return GatewayStrategyResult{
		providerID:                input.ProviderID,
		binary:                    input.Binary,
		arguments:                 arguments,
		argumentsAfterSubcommands: subcommands,
		environment:               cloneEnvironmentPatch(input.Environment),
	}, nil
}

// ProviderID 返回结果唯一支持的 Provider。
func (result GatewayStrategyResult) ProviderID() string {
	return result.providerID
}

// Binary 返回官方 CLI 可执行文件名。
func (result GatewayStrategyResult) Binary() string {
	return result.binary
}

// Arguments 返回 Provider Gateway 临时参数副本。
func (result GatewayStrategyResult) Arguments() []string {
	return append([]string(nil), result.arguments...)
}

// ArgumentsAfterSubcommands 返回需要在其后插入参数的官方子命令集合。
func (result GatewayStrategyResult) ArgumentsAfterSubcommands() []string {
	return append([]string(nil), result.argumentsAfterSubcommands...)
}

// Environment 返回当前进程环境补丁副本。
func (result GatewayStrategyResult) Environment() EnvironmentPatch {
	return cloneEnvironmentPatch(result.environment)
}

// String 返回不含固定参数正文和环境值的安全摘要。
func (result GatewayStrategyResult) String() string {
	return fmt.Sprintf(
		"providerlaunch.GatewayStrategyResult{provider=%s,binary=%s,args=%d,args_after=%v,env_set=%v,env_unset=%v}",
		result.providerID,
		result.binary,
		len(result.arguments),
		result.argumentsAfterSubcommands,
		result.environment.SetNames(),
		result.environment.UnsetNames(),
	)
}

// GoString 确保 %#v 不会反射 EnvironmentPatch 中的客户端密钥。
func (result GatewayStrategyResult) GoString() string {
	return result.String()
}

// Format 覆盖所有 fmt verb，避免格式化绕过脱敏摘要。
func (result GatewayStrategyResult) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(result.String()))
}

// IsValid 判断结果是否仍可安全进入规划器。
func (result GatewayStrategyResult) IsValid() bool {
	_, err := NewGatewayStrategyResult(GatewayStrategyResultInput{
		ProviderID:                result.providerID,
		Binary:                    result.binary,
		Arguments:                 result.arguments,
		ArgumentsAfterSubcommands: result.argumentsAfterSubcommands,
		Environment:               result.environment,
	})
	return err == nil
}

// GatewayLaunchSpec 是账号池或固定账号最终不可变启动描述。
type GatewayLaunchSpec struct {
	clientProviderID          string
	relayProviderID           string
	accountRef                accountcore.AccountRef
	cliAccountID              accountcore.CLIAccountID
	binary                    string
	arguments                 []string
	argumentsAfterSubcommands []string
	environment               EnvironmentPatch
}

// newGatewayLaunchSpec 合并 Gateway 意图、公开账号身份和 Provider 结果。
func newGatewayLaunchSpec(
	intent LaunchIntent,
	accountRef accountcore.AccountRef,
	result GatewayStrategyResult,
) (GatewayLaunchSpec, error) {
	if !intent.IsValid() || intent.Mode() != LaunchModeGatewayRelay ||
		!result.IsValid() || intent.ClientProviderID() != result.providerID ||
		(intent.HasPinnedAccount() != accountRef.IsValid()) {
		return GatewayLaunchSpec{}, ErrInvalidGatewayLaunchSpec
	}
	spec := GatewayLaunchSpec{
		clientProviderID:          intent.ClientProviderID(),
		relayProviderID:           intent.RelayProviderID(),
		accountRef:                accountRef,
		cliAccountID:              intent.CLIAccountID(),
		binary:                    result.binary,
		arguments:                 append([]string(nil), result.arguments...),
		argumentsAfterSubcommands: append([]string(nil), result.argumentsAfterSubcommands...),
		environment:               cloneEnvironmentPatch(result.environment),
	}
	if !spec.IsValid() {
		return GatewayLaunchSpec{}, ErrInvalidGatewayLaunchSpec
	}
	return spec, nil
}

// Mode 返回固定的 Gateway Relay 模式。
func (spec GatewayLaunchSpec) Mode() LaunchMode {
	return LaunchModeGatewayRelay
}

// ClientProviderID 返回决定官方 CLI 和下游协议的 Provider。
func (spec GatewayLaunchSpec) ClientProviderID() string {
	return spec.clientProviderID
}

// RelayProviderID 返回固定账号所属的上游 Provider。
func (spec GatewayLaunchSpec) RelayProviderID() string {
	return spec.relayProviderID
}

// PinnedAccount 返回固定账号身份；账号池模式返回 false。
func (spec GatewayLaunchSpec) PinnedAccount() (accountcore.AccountRef, bool) {
	return spec.accountRef, spec.accountRef.IsValid()
}

// CLIAccountID 返回用户输入的 Provider 内数字别名。
func (spec GatewayLaunchSpec) CLIAccountID() accountcore.CLIAccountID {
	return spec.cliAccountID
}

// Binary 返回官方 CLI 可执行文件名。
func (spec GatewayLaunchSpec) Binary() string {
	return spec.binary
}

// ResolveArguments 把临时 Gateway 参数插入官方子命令要求的位置。
func (spec GatewayLaunchSpec) ResolveArguments(arguments []string) ([]string, error) {
	return mergeArguments(spec.arguments, spec.argumentsAfterSubcommands, arguments)
}

// Environment 返回只作用于当前官方 CLI 进程的环境补丁。
func (spec GatewayLaunchSpec) Environment() EnvironmentPatch {
	return cloneEnvironmentPatch(spec.environment)
}

// IsValid 判断账号池和固定账号字段是否成对，并复核共享状态不变量。
func (spec GatewayLaunchSpec) IsValid() bool {
	pinned := spec.accountRef.IsValid()
	return isDescriptorToken(spec.clientProviderID) &&
		isDescriptorToken(spec.relayProviderID) &&
		pinned == spec.cliAccountID.IsValid() &&
		(pinned || spec.clientProviderID == spec.relayProviderID) &&
		(spec.accountRef == "" || pinned) &&
		isBinaryName(spec.binary) &&
		validSubcommands(spec.argumentsAfterSubcommands) &&
		(len(spec.arguments) > 0 || len(spec.argumentsAfterSubcommands) == 0) &&
		spec.environment.IsValid() &&
		preservesSharedNativeState(spec.environment)
}

// String 返回不含客户端密钥和参数正文的安全摘要。
func (spec GatewayLaunchSpec) String() string {
	return fmt.Sprintf(
		"providerlaunch.GatewayLaunchSpec{mode=%s,client_provider=%s,relay_provider=%s,account=%s,cli_id=%d,pinned=%t,binary=%s,args=%d,args_after=%v,env_set=%v,env_unset=%v}",
		LaunchModeGatewayRelay,
		spec.clientProviderID,
		spec.relayProviderID,
		spec.accountRef,
		spec.cliAccountID,
		spec.accountRef.IsValid(),
		spec.binary,
		len(spec.arguments),
		spec.argumentsAfterSubcommands,
		spec.environment.SetNames(),
		spec.environment.UnsetNames(),
	)
}

// GoString 确保 %#v 不会反射 EnvironmentPatch 中的密钥。
func (spec GatewayLaunchSpec) GoString() string {
	return spec.String()
}

// Format 覆盖所有 fmt verb，避免格式化绕过脱敏摘要。
func (spec GatewayLaunchSpec) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(spec.String()))
}
