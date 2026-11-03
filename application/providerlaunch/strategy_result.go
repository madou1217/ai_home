package providerlaunch

import (
	"errors"
	"fmt"
	"strings"
)

var (
	// ErrInvalidStrategyResult 表示 Provider Strategy 返回了不完整的启动描述。
	ErrInvalidStrategyResult = errors.New("Provider 启动策略结果无效")
	// ErrInvalidProcessArguments 表示调用方参数包含不能安全传给进程的 NUL。
	ErrInvalidProcessArguments = errors.New("Provider 启动进程参数无效")
)

// StrategyResultInput 是 Provider Strategy 构建启动差异所需的输出字段。
type StrategyResultInput struct {
	// ProviderID 是 Strategy 唯一支持的规范 Provider。
	ProviderID string
	// Binary 是不包含路径和 shell 语法的原生 CLI 可执行文件名。
	Binary string
	// Arguments 是 Provider 必需的非敏感全局参数，不包含用户命令参数。
	Arguments []string
	// ArgumentsAfterSubcommands 指定 Arguments 必须插入其首个子命令之后的命令集合。
	ArgumentsAfterSubcommands []string
	// Environment 是只对目标子进程生效的凭据环境补丁。
	Environment EnvironmentPatch
	// Runtime 描述直接进程或受控辅助进程拓扑。
	Runtime RuntimeDirective
	// Credential 是不含凭据内容的认证类型摘要。
	Credential CredentialDescriptor
}

// StrategyResult 是具体 Provider Adapter 返回的不可变启动差异。
type StrategyResult struct {
	providerID                string
	binary                    string
	arguments                 []string
	argumentsAfterSubcommands []string
	environment               EnvironmentPatch
	runtime                   RuntimeDirective
	credential                CredentialDescriptor
}

// NewStrategyResult 校验并复制 Strategy 输出，禁止凭据通过可变集合逸出。
func NewStrategyResult(input StrategyResultInput) (StrategyResult, error) {
	if !isDescriptorToken(input.ProviderID) ||
		!isBinaryName(input.Binary) ||
		!input.Environment.IsValid() ||
		!preservesSharedNativeState(input.Environment) ||
		!input.Runtime.IsValid() ||
		!input.Credential.IsValid() {
		return StrategyResult{}, ErrInvalidStrategyResult
	}
	arguments, err := validateArguments(input.Arguments)
	if err != nil {
		return StrategyResult{}, ErrInvalidStrategyResult
	}
	argumentsAfterSubcommands, err := validateSubcommands(input.ArgumentsAfterSubcommands)
	if err != nil || (len(arguments) == 0 && len(argumentsAfterSubcommands) > 0) {
		return StrategyResult{}, ErrInvalidStrategyResult
	}
	return StrategyResult{
		providerID:                input.ProviderID,
		binary:                    input.Binary,
		arguments:                 arguments,
		argumentsAfterSubcommands: argumentsAfterSubcommands,
		environment:               cloneEnvironmentPatch(input.Environment),
		runtime:                   cloneRuntimeDirective(input.Runtime),
		credential:                input.Credential,
	}, nil
}

// validateArguments 校验并复制 Strategy 固定参数，供 Native 与 Gateway 复用。
func validateArguments(values []string) ([]string, error) {
	arguments := append([]string(nil), values...)
	for _, argument := range arguments {
		if argument == "" || strings.ContainsRune(argument, '\x00') {
			return nil, ErrInvalidProcessArguments
		}
	}
	return arguments, nil
}

// ProviderID 返回 Strategy 结果所属的规范 Provider。
func (result StrategyResult) ProviderID() string {
	return result.providerID
}

// Binary 返回 Provider Strategy 选择的原生 CLI 可执行文件名。
func (result StrategyResult) Binary() string {
	return result.binary
}

// Arguments 返回 Provider 必需的非敏感全局参数副本。
func (result StrategyResult) Arguments() []string {
	return append([]string(nil), result.arguments...)
}

// ArgumentsAfterSubcommands 返回需要把 Strategy 参数插入首个子命令之后的命令集合。
func (result StrategyResult) ArgumentsAfterSubcommands() []string {
	return append([]string(nil), result.argumentsAfterSubcommands...)
}

// ResolveArguments 按 Provider Strategy 声明的位置合并调用方参数。
func (result StrategyResult) ResolveArguments(arguments []string) ([]string, error) {
	return mergeArguments(
		result.arguments,
		result.argumentsAfterSubcommands,
		arguments,
	)
}

// Environment 返回 Strategy 环境补丁的深副本。
func (result StrategyResult) Environment() EnvironmentPatch {
	return cloneEnvironmentPatch(result.environment)
}

// Runtime 返回进程拓扑和敏感输入的深副本。
func (result StrategyResult) Runtime() RuntimeDirective {
	return cloneRuntimeDirective(result.runtime)
}

// Credential 返回 Strategy 的脱敏认证类型摘要。
func (result StrategyResult) Credential() CredentialDescriptor {
	return result.credential
}

// String 返回不含参数正文、环境值和 Runtime 敏感输入的安全 Strategy 摘要。
func (result StrategyResult) String() string {
	return fmt.Sprintf(
		"providerlaunch.StrategyResult{provider=%s,binary=%s,args=%d,args_after=%v,env_set=%v,env_unset=%v,runtime=%s,credential=%s}",
		result.providerID,
		result.binary,
		len(result.arguments),
		result.argumentsAfterSubcommands,
		result.environment.SetNames(),
		result.environment.UnsetNames(),
		result.runtime.Kind(),
		result.credential,
	)
}

// GoString 确保 %#v 不会反射 StrategyResult 内的明文凭据。
func (result StrategyResult) GoString() string {
	return result.String()
}

// Format 覆盖所有 fmt verb，避免值格式化绕过 StrategyResult 脱敏。
func (result StrategyResult) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(result.String()))
}

// IsValid 判断 Strategy 结果是否仍满足不可变启动合同。
func (result StrategyResult) IsValid() bool {
	_, err := NewStrategyResult(StrategyResultInput{
		ProviderID:                result.providerID,
		Binary:                    result.binary,
		Arguments:                 result.arguments,
		ArgumentsAfterSubcommands: result.argumentsAfterSubcommands,
		Environment:               result.environment,
		Runtime:                   result.runtime,
		Credential:                result.credential,
	})
	return err == nil
}

// sharedNativeStateKeys 是账号启动绝不能设置或删除的 Provider 状态根。
//
// 凭据隔离只能发生在目标子进程或受控 Runtime 通道；修改这些变量会拆分会话、
// 历史、trust、插件或用户配置。
var sharedNativeStateKeys = map[string]struct{}{
	"HOME":              {},
	"USERPROFILE":       {},
	"XDG_CONFIG_HOME":   {},
	"CODEX_HOME":        {},
	"CODEX_SQLITE_HOME": {},
	"CLAUDE_CONFIG_DIR": {},
}

// preservesSharedNativeState 拒绝任何改变 Provider 共享状态根的 Strategy。
func preservesSharedNativeState(environment EnvironmentPatch) bool {
	for _, name := range environment.SetNames() {
		if _, forbidden := sharedNativeStateKeys[name]; forbidden {
			return false
		}
	}
	for _, name := range environment.UnsetNames() {
		if _, forbidden := sharedNativeStateKeys[name]; forbidden {
			return false
		}
	}
	return true
}

// validateSubcommands 校验、去重并复制 Strategy 声明的子命令集合。
func validateSubcommands(values []string) ([]string, error) {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !isDescriptorToken(value) {
			return nil, ErrInvalidStrategyResult
		}
		if _, duplicated := seen[value]; duplicated {
			return nil, ErrInvalidStrategyResult
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, nil
}

// validSubcommands 判断不可变描述中的子命令集合仍满足唯一性约束。
func validSubcommands(values []string) bool {
	_, err := validateSubcommands(values)
	return err == nil
}

// mergeArguments 只按首个 token 判断子命令，避免 prompt 或 option value 误触发插入规则。
func mergeArguments(
	strategyArguments []string,
	afterSubcommands []string,
	callerArguments []string,
) ([]string, error) {
	for _, argument := range callerArguments {
		if strings.ContainsRune(argument, '\x00') {
			return nil, ErrInvalidProcessArguments
		}
	}
	arguments := append([]string(nil), callerArguments...)
	insertAt := 0
	if len(arguments) > 0 {
		for _, subcommand := range afterSubcommands {
			if arguments[0] == subcommand {
				insertAt = 1
				break
			}
		}
	}
	merged := make([]string, 0, len(arguments)+len(strategyArguments))
	merged = append(merged, arguments[:insertAt]...)
	merged = append(merged, strategyArguments...)
	merged = append(merged, arguments[insertAt:]...)
	return merged, nil
}

// isBinaryName 拒绝路径、空白和 shell 元字符，只允许确定的可执行文件名。
func isBinaryName(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character < 'a' || character > 'z') &&
			(character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') &&
			character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}
