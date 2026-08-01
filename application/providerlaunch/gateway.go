package providerlaunch

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// MinGatewayClientKeyLength 与 Go Server 的客户端密钥下限保持一致。
	MinGatewayClientKeyLength = 32
	// MaxGatewayClientKeyLength 防止异常配置进入子进程环境。
	MaxGatewayClientKeyLength = 8192
)

var (
	// ErrInvalidGatewayEndpoint 表示 AIH Server 根地址或客户端密钥无效。
	ErrInvalidGatewayEndpoint = errors.New("Gateway Endpoint 无效")
	// ErrInvalidGatewayDependencies 表示规划器缺少基础账号读取或 Provider Strategy。
	ErrInvalidGatewayDependencies = errors.New("Gateway 启动规划依赖无效")
	// ErrInvalidGatewayBuildRequest 表示上下文、意图或 Endpoint 不满足 Gateway 合同。
	ErrInvalidGatewayBuildRequest = errors.New("Gateway 启动规划请求无效")
	// ErrGatewayAccountMismatch 表示数字别名解析出的账号不属于目标 Provider。
	ErrGatewayAccountMismatch = errors.New("Gateway 固定账号不匹配")
	// ErrGatewayAccountDisabled 表示固定账号已被用户关闭。
	ErrGatewayAccountDisabled = errors.New("Gateway 固定账号已停用")
	// ErrInvalidGatewayStrategyResult 表示 Provider Strategy 返回了不安全的进程描述。
	ErrInvalidGatewayStrategyResult = errors.New("Gateway Strategy 结果无效")
)

// GatewayEndpoint 是官方 CLI 连接 AIH Server 所需的最小敏感配置。
type GatewayEndpoint struct {
	baseURL   string
	clientKey string
}

// NewGatewayEndpoint 校验并规范化 AIH Server 根地址与客户端密钥。
func NewGatewayEndpoint(baseURL string, clientKey string) (GatewayEndpoint, error) {
	normalizedURL, err := normalizeGatewayBaseURL(baseURL)
	if err != nil || !validGatewayClientKey(clientKey) {
		return GatewayEndpoint{}, ErrInvalidGatewayEndpoint
	}
	return GatewayEndpoint{baseURL: normalizedURL, clientKey: clientKey}, nil
}

// BaseURL 返回不含 /v1 的 AIH Server 根地址。
func (endpoint GatewayEndpoint) BaseURL() string {
	return endpoint.baseURL
}

// RevealClientKey 显式返回客户端密钥，仅供 Gateway Provider Strategy 写入子进程环境。
func (endpoint GatewayEndpoint) RevealClientKey() string {
	return endpoint.clientKey
}

// IsValid 判断跨层传递后的 Endpoint 是否仍满足原始约束。
func (endpoint GatewayEndpoint) IsValid() bool {
	normalized, err := normalizeGatewayBaseURL(endpoint.baseURL)
	return err == nil && normalized == endpoint.baseURL && validGatewayClientKey(endpoint.clientKey)
}

// String 返回不包含客户端密钥的安全摘要。
func (endpoint GatewayEndpoint) String() string {
	return fmt.Sprintf("providerlaunch.GatewayEndpoint{base_url=%s,client_key=<redacted>}", endpoint.baseURL)
}

// GoString 确保 %#v 不会反射客户端密钥。
func (endpoint GatewayEndpoint) GoString() string {
	return endpoint.String()
}

// Format 覆盖所有 fmt verb，避免格式化绕过密钥脱敏。
func (endpoint GatewayEndpoint) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(endpoint.String()))
}

// GatewayTarget 是 Provider Strategy 可见的 Server 连接目标。
type GatewayTarget struct {
	endpoint   GatewayEndpoint
	accountRef accountcore.AccountRef
}

// NewGatewayTarget 创建账号池或固定账号 Gateway 目标。
func NewGatewayTarget(
	endpoint GatewayEndpoint,
	accountRef accountcore.AccountRef,
) (GatewayTarget, error) {
	if !endpoint.IsValid() || (accountRef != "" && !accountRef.IsValid()) {
		return GatewayTarget{}, ErrInvalidGatewayBuildRequest
	}
	return GatewayTarget{endpoint: endpoint, accountRef: accountRef}, nil
}

// Endpoint 返回经过深复制语义保护的不可变 Server 配置。
func (target GatewayTarget) Endpoint() GatewayEndpoint {
	return target.endpoint
}

// PinnedAccount 返回固定账号；账号池模式返回 false。
func (target GatewayTarget) PinnedAccount() (accountcore.AccountRef, bool) {
	return target.accountRef, target.accountRef.IsValid()
}

// IsValid 判断目标地址和可选稳定账号是否完整。
func (target GatewayTarget) IsValid() bool {
	return target.endpoint.IsValid() &&
		(target.accountRef == "" || target.accountRef.IsValid())
}

// String 返回不含 Server Client Key 的安全目标摘要。
func (target GatewayTarget) String() string {
	return fmt.Sprintf(
		"providerlaunch.GatewayTarget{base_url=%s,account=%s,pinned=%t,client_key=<redacted>}",
		target.endpoint.BaseURL(),
		target.accountRef,
		target.accountRef.IsValid(),
	)
}

// GoString 确保 %#v 不会反射 Endpoint 中的客户端密钥。
func (target GatewayTarget) GoString() string {
	return target.String()
}

// Format 覆盖所有 fmt verb，避免格式化绕过客户端密钥脱敏。
func (target GatewayTarget) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(target.String()))
}

// GatewayAccountResolver 只读取固定账号的公开基础字段，禁止读取凭据表。
type GatewayAccountResolver interface {
	GetByCLIAccountID(
		ctx context.Context,
		providerID string,
		cliAccountID accountcore.CLIAccountID,
	) (accountcore.Account, error)
}

// GatewayStrategy 把 Server 目标转换为官方 Provider CLI 的临时参数与进程环境。
type GatewayStrategy interface {
	ProviderID() string
	Build(target GatewayTarget) (GatewayStrategyResult, error)
}

// GatewayDependencies 集中声明 Gateway 规划器的公开账号端口和策略注册表。
type GatewayDependencies struct {
	Accounts   GatewayAccountResolver
	Strategies []GatewayStrategy
}

// GatewayPlanner 生成不读取上游凭据的官方 CLI Gateway 启动描述。
type GatewayPlanner struct {
	accounts   GatewayAccountResolver
	strategies map[string]GatewayStrategy
}

// NewGatewayPlanner 创建只读 Strategy 注册表。
func NewGatewayPlanner(dependencies GatewayDependencies) (*GatewayPlanner, error) {
	if dependencies.Accounts == nil || len(dependencies.Strategies) == 0 {
		return nil, ErrInvalidGatewayDependencies
	}
	strategies := make(map[string]GatewayStrategy, len(dependencies.Strategies))
	for _, strategy := range dependencies.Strategies {
		if strategy == nil || !isDescriptorToken(strategy.ProviderID()) {
			return nil, ErrInvalidGatewayDependencies
		}
		if _, duplicated := strategies[strategy.ProviderID()]; duplicated {
			return nil, ErrInvalidGatewayDependencies
		}
		strategies[strategy.ProviderID()] = strategy
	}
	return &GatewayPlanner{accounts: dependencies.Accounts, strategies: strategies}, nil
}

// Build 解析可选数字别名并生成 Gateway 启动描述，全程不触碰账号凭据。
func (planner *GatewayPlanner) Build(
	ctx context.Context,
	intent LaunchIntent,
	endpoint GatewayEndpoint,
) (GatewayLaunchSpec, error) {
	if planner == nil || planner.accounts == nil || len(planner.strategies) == 0 ||
		ctx == nil || !intent.IsValid() || intent.Mode() != LaunchModeGatewayRelay ||
		!endpoint.IsValid() {
		return GatewayLaunchSpec{}, ErrInvalidGatewayBuildRequest
	}
	if err := ctx.Err(); err != nil {
		return GatewayLaunchSpec{}, err
	}
	strategy, found := planner.strategies[intent.ProviderID()]
	if !found {
		return GatewayLaunchSpec{}, ErrStrategyNotFound
	}

	var accountRef accountcore.AccountRef
	if intent.HasPinnedAccount() {
		account, err := planner.accounts.GetByCLIAccountID(
			ctx,
			intent.ProviderID(),
			intent.CLIAccountID(),
		)
		if err != nil {
			return GatewayLaunchSpec{}, err
		}
		if !account.IsValid() ||
			account.ProviderID() != intent.ProviderID() ||
			account.CLIAccountID() != intent.CLIAccountID() {
			return GatewayLaunchSpec{}, ErrGatewayAccountMismatch
		}
		if !account.Enabled() {
			return GatewayLaunchSpec{}, ErrGatewayAccountDisabled
		}
		accountRef = account.Ref()
	}
	target, err := NewGatewayTarget(endpoint, accountRef)
	if err != nil {
		return GatewayLaunchSpec{}, err
	}
	result, err := strategy.Build(target)
	if err != nil {
		return GatewayLaunchSpec{}, err
	}
	if result.ProviderID() != intent.ProviderID() {
		return GatewayLaunchSpec{}, ErrInvalidGatewayStrategyResult
	}
	return newGatewayLaunchSpec(intent, accountRef, result)
}

// normalizeGatewayBaseURL 只接受无凭据、查询和 fragment 的 HTTP(S) Server 根地址。
func normalizeGatewayBaseURL(value string) (string, error) {
	if value == "" || value != strings.TrimSpace(value) || strings.ContainsRune(value, '\x00') {
		return "", ErrInvalidGatewayEndpoint
	}
	parsed, err := url.Parse(value)
	if err != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" ||
		parsed.User != nil ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") {
		return "", ErrInvalidGatewayEndpoint
	}
	parsed.Path = ""
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

// validGatewayClientKey 复核密钥长度以及 HTTP Header 不能承载的空白和控制字符。
func validGatewayClientKey(value string) bool {
	if len(value) < MinGatewayClientKeyLength || len(value) > MaxGatewayClientKeyLength {
		return false
	}
	for _, character := range value {
		if character <= ' ' || character == 0x7f {
			return false
		}
	}
	return true
}
