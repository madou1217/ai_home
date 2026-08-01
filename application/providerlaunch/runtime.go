package providerlaunch

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

var (
	// ErrInvalidRuntimeDirective 表示 Provider Strategy 请求了未知或不完整的运行形态。
	ErrInvalidRuntimeDirective = errors.New("Provider CLI Runtime 指令无效")
)

// RuntimeKind 描述官方 CLI 所需的最小进程拓扑，而不是认证类型。
type RuntimeKind string

const (
	// RuntimeKindDirectProcess 表示凭据可安全地只注入官方 CLI 子进程。
	RuntimeKindDirectProcess RuntimeKind = "direct_process"
	// RuntimeKindCodexExternalAuth 表示 Codex OAuth 需要 app-server 外部 Token 桥。
	RuntimeKindCodexExternalAuth RuntimeKind = "codex_external_auth"
	// RuntimeKindClaudeOAuthProxy 表示 Claude 可刷新 OAuth 使用官方 Unix Socket 认证代理。
	RuntimeKindClaudeOAuthProxy RuntimeKind = "claude_oauth_proxy"
)

const (
	externalAccessTokenKey = "access_token"
	externalAccountIDKey   = "chatgpt_account_id"
	externalPlanTypeKey    = "chatgpt_plan_type"
)

// RuntimeDirective 是 Strategy 交给 Runtime Adapter 的不可变运行形态与敏感输入。
type RuntimeDirective struct {
	kind       RuntimeKind
	parameters map[string]string
}

// NewDirectProcessRuntime 创建无需辅助进程的官方 CLI 运行指令。
func NewDirectProcessRuntime() RuntimeDirective {
	return RuntimeDirective{kind: RuntimeKindDirectProcess, parameters: map[string]string{}}
}

// NewClaudeOAuthProxyRuntime 创建不把真实 OAuth Token 暴露给 Claude 子进程的运行指令。
//
// Runtime Adapter 必须通过 Claude Code 原生 ANTHROPIC_UNIX_SOCKET 通道转发请求，
// 在本机代理中注入和刷新 Token；共享 history、trust、plugins 和配置目录均保持不变。
func NewClaudeOAuthProxyRuntime(accessToken string) (RuntimeDirective, error) {
	directive := RuntimeDirective{
		kind: RuntimeKindClaudeOAuthProxy,
		parameters: map[string]string{
			externalAccessTokenKey: accessToken,
		},
	}
	if !directive.IsValid() {
		return RuntimeDirective{}, ErrInvalidRuntimeDirective
	}
	return directive, nil
}

// NewCodexExternalAuthRuntime 创建不写 auth.json 的 Codex OAuth 外部认证指令。
//
// Runtime Adapter 必须启动共享 CODEX_HOME 的 app-server，通过实验性
// chatgptAuthTokens 注入本值，并用 unix socket 连接官方 Codex TUI。
func NewCodexExternalAuthRuntime(
	accessToken string,
	chatGPTAccountID string,
	chatGPTPlanType string,
) (RuntimeDirective, error) {
	parameters := map[string]string{
		externalAccessTokenKey: accessToken,
		externalAccountIDKey:   chatGPTAccountID,
	}
	if chatGPTPlanType != "" {
		parameters[externalPlanTypeKey] = chatGPTPlanType
	}
	directive := RuntimeDirective{
		kind:       RuntimeKindCodexExternalAuth,
		parameters: parameters,
	}
	if !directive.IsValid() {
		return RuntimeDirective{}, ErrInvalidRuntimeDirective
	}
	return directive, nil
}

// Kind 返回 Runtime Adapter 的稳定分派键。
func (directive RuntimeDirective) Kind() RuntimeKind {
	return directive.kind
}

// ParameterNames 返回敏感参数名的稳定排序，不返回任何值。
func (directive RuntimeDirective) ParameterNames() []string {
	names := make([]string, 0, len(directive.parameters))
	for name := range directive.parameters {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// RevealParameters 显式返回敏感参数副本，仅供最终 Runtime Adapter 使用。
func (directive RuntimeDirective) RevealParameters() map[string]string {
	parameters := make(map[string]string, len(directive.parameters))
	for name, value := range directive.parameters {
		parameters[name] = value
	}
	return parameters
}

// IsValid 判断运行形态和参数集合是否满足当前已实现的精确合同。
func (directive RuntimeDirective) IsValid() bool {
	switch directive.kind {
	case RuntimeKindDirectProcess:
		return len(directive.parameters) == 0
	case RuntimeKindClaudeOAuthProxy:
		return len(directive.parameters) == 1 &&
			validRuntimeParameter(directive.parameters[externalAccessTokenKey])
	case RuntimeKindCodexExternalAuth:
		if len(directive.parameters) < 2 || len(directive.parameters) > 3 {
			return false
		}
		for name, value := range directive.parameters {
			if (name != externalAccessTokenKey &&
				name != externalAccountIDKey &&
				name != externalPlanTypeKey) ||
				!validRuntimeParameter(value) {
				return false
			}
		}
		return directive.parameters[externalAccessTokenKey] != "" &&
			directive.parameters[externalAccountIDKey] != ""
	default:
		return false
	}
}

// validRuntimeParameter 拒绝空值、首尾空白和进程参数不能承载的 NUL。
func validRuntimeParameter(value string) bool {
	return value != "" &&
		value == strings.TrimSpace(value) &&
		!strings.ContainsRune(value, '\x00')
}

// String 返回不含任何 Token、账号 ID 或套餐值的安全摘要。
func (directive RuntimeDirective) String() string {
	return fmt.Sprintf(
		"providerlaunch.RuntimeDirective{kind=%s,parameters=%v,values=<redacted>}",
		directive.kind,
		directive.ParameterNames(),
	)
}

// GoString 确保 %#v 不会反射敏感参数。
func (directive RuntimeDirective) GoString() string {
	return directive.String()
}

// Format 覆盖所有 fmt verb，避免格式化绕过 Runtime 指令脱敏。
func (directive RuntimeDirective) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(directive.String()))
}

// cloneRuntimeDirective 深复制 Runtime 敏感参数。
func cloneRuntimeDirective(source RuntimeDirective) RuntimeDirective {
	return RuntimeDirective{
		kind:       source.kind,
		parameters: source.RevealParameters(),
	}
}
