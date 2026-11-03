package providerlaunch

import (
	"errors"
	"fmt"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidLaunchIntent 表示 CLI Provider、账号别名或透传参数不满足双模式合同。
	ErrInvalidLaunchIntent = errors.New("Provider CLI 启动意图无效")
	// ErrLaunchModeMismatch 表示调用方把 Gateway 意图交给 Native 规划器，或反向混用。
	ErrLaunchModeMismatch = errors.New("Provider CLI 启动模式不匹配")
)

// LaunchMode 是 CLI 启动时不可混用的执行边界。
type LaunchMode string

const (
	// LaunchModeGatewayRelay 表示官方 CLI 只连接本机 AIH Server，由服务端执行纯 Relay。
	LaunchModeGatewayRelay LaunchMode = "gateway_relay"
	// LaunchModeNativeDirect 表示官方 CLI 使用指定账号的原生凭据直连上游。
	LaunchModeNativeDirect LaunchMode = "native_direct"
)

// LaunchIntent 是 CLI 路由层解析后的不可变命令意图。
//
// 命令合同：
//   - aih <client_provider>                                  -> Gateway 账号池
//   - aih <client_provider> relay <account_id>               -> Gateway 同 Provider 固定账号
//   - aih <client_provider> relay <relay_provider> <account_id> -> Gateway 跨 Provider 固定账号
//   - aih <client_provider> <account_id>                     -> Native Direct
type LaunchIntent struct {
	mode             LaunchMode
	clientProviderID string
	relayProviderID  string
	cliAccountID     accountcore.CLIAccountID
	arguments        []string
}

// ParseLaunchIntent 使用首个业务 token 一次性区分 Gateway 与 Native，避免下层重新猜测。
func ParseLaunchIntent(
	catalog *providers.Catalog,
	providerID string,
	arguments []string,
) (LaunchIntent, error) {
	if catalog == nil {
		return LaunchIntent{}, ErrInvalidLaunchIntent
	}
	canonicalProviderID, found := catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID {
		return LaunchIntent{}, ErrInvalidLaunchIntent
	}
	for _, argument := range arguments {
		if strings.ContainsRune(argument, '\x00') {
			return LaunchIntent{}, ErrInvalidLaunchIntent
		}
	}

	mode := LaunchModeGatewayRelay
	relayProviderID := providerID
	var cliAccountID accountcore.CLIAccountID
	forwardArguments := arguments
	if len(arguments) > 0 && arguments[0] == "relay" {
		forwardArguments = arguments[1:]
		if len(forwardArguments) > 0 && isCanonicalProviderToken(catalog, forwardArguments[0]) {
			relayProviderID = forwardArguments[0]
			forwardArguments = forwardArguments[1:]
			if len(forwardArguments) == 0 || !isDecimalAccountID(forwardArguments[0]) {
				return LaunchIntent{}, ErrInvalidLaunchIntent
			}
		} else if len(forwardArguments) > 1 && isDecimalAccountID(forwardArguments[1]) {
			// “Provider + 数字别名”形态只能使用目录中的规范 Provider，禁止把拼写错误降级为 CLI 参数。
			return LaunchIntent{}, ErrInvalidLaunchIntent
		}
		if len(forwardArguments) > 0 && isDecimalAccountID(forwardArguments[0]) {
			parsed, err := accountcore.ParseCLIAccountID(forwardArguments[0])
			if err != nil {
				return LaunchIntent{}, ErrInvalidLaunchIntent
			}
			cliAccountID = parsed
			forwardArguments = forwardArguments[1:]
		}
	} else if len(arguments) > 0 && isDecimalAccountID(arguments[0]) {
		parsed, err := accountcore.ParseCLIAccountID(arguments[0])
		if err != nil {
			return LaunchIntent{}, ErrInvalidLaunchIntent
		}
		mode = LaunchModeNativeDirect
		cliAccountID = parsed
		forwardArguments = arguments[1:]
	}

	intent := LaunchIntent{
		mode:             mode,
		clientProviderID: providerID,
		relayProviderID:  relayProviderID,
		cliAccountID:     cliAccountID,
		arguments:        append([]string(nil), forwardArguments...),
	}
	if !intent.IsValid() {
		return LaunchIntent{}, ErrInvalidLaunchIntent
	}
	return intent, nil
}

// Mode 返回已经明确的 Gateway Relay 或 Native Direct 模式。
func (intent LaunchIntent) Mode() LaunchMode {
	return intent.mode
}

// ClientProviderID 返回决定官方 CLI 和下游协议的 Provider。
func (intent LaunchIntent) ClientProviderID() string {
	return intent.clientProviderID
}

// RelayProviderID 返回决定账号归属和上游 Adapter 的 Provider。
func (intent LaunchIntent) RelayProviderID() string {
	return intent.relayProviderID
}

// CLIAccountID 返回显式账号别名；Gateway 账号池模式返回零值。
func (intent LaunchIntent) CLIAccountID() accountcore.CLIAccountID {
	return intent.cliAccountID
}

// HasPinnedAccount 表示 Gateway 固定账号或 Native 指定账号已经存在。
func (intent LaunchIntent) HasPinnedAccount() bool {
	return intent.cliAccountID.IsValid()
}

// Arguments 返回需要原样交给官方 Provider CLI 的参数副本。
func (intent LaunchIntent) Arguments() []string {
	return append([]string(nil), intent.arguments...)
}

// NativeSelectionRequest 把 Native 意图转换为显式账号选择；Gateway 永远不能读取凭据。
func (intent LaunchIntent) NativeSelectionRequest() (accountapp.LaunchSelectionRequest, error) {
	if !intent.IsValid() || intent.mode != LaunchModeNativeDirect || !intent.cliAccountID.IsValid() {
		return accountapp.LaunchSelectionRequest{}, ErrLaunchModeMismatch
	}
	return accountapp.LaunchSelectionRequest{
		ProviderID:   intent.clientProviderID,
		CLIAccountID: intent.cliAccountID,
	}, nil
}

// IsValid 验证两种模式各自的账号约束和参数安全性。
func (intent LaunchIntent) IsValid() bool {
	if !isDescriptorToken(intent.clientProviderID) ||
		!isDescriptorToken(intent.relayProviderID) ||
		(intent.mode != LaunchModeGatewayRelay && intent.mode != LaunchModeNativeDirect) {
		return false
	}
	if intent.mode == LaunchModeNativeDirect {
		if !intent.cliAccountID.IsValid() || intent.relayProviderID != intent.clientProviderID {
			return false
		}
	} else if !intent.cliAccountID.IsValid() && intent.relayProviderID != intent.clientProviderID {
		return false
	}
	for _, argument := range intent.arguments {
		if strings.ContainsRune(argument, '\x00') {
			return false
		}
	}
	return true
}

// String 返回不含用户 prompt 和 Provider 参数正文的安全意图摘要。
func (intent LaunchIntent) String() string {
	return fmt.Sprintf(
		"providerlaunch.LaunchIntent{mode=%s,client_provider=%s,relay_provider=%s,cli_id=%d,pinned=%t,args=%d}",
		intent.mode,
		intent.clientProviderID,
		intent.relayProviderID,
		intent.cliAccountID,
		intent.HasPinnedAccount(),
		len(intent.arguments),
	)
}

// isCanonicalProviderToken 只把目录中的规范 ID 解释为 Relay Provider。
func isCanonicalProviderToken(catalog *providers.Catalog, value string) bool {
	canonical, found := catalog.CanonicalID(value)
	return found && canonical == value
}

// GoString 确保 %#v 不会反射用户参数。
func (intent LaunchIntent) GoString() string {
	return intent.String()
}

// Format 覆盖所有 fmt verb，避免格式化绕过参数脱敏。
func (intent LaunchIntent) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(intent.String()))
}

// isDecimalAccountID 只识别纯十进制 token；负数和普通 Provider 参数继续透传。
func isDecimalAccountID(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}
