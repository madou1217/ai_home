package egress

import (
	"context"
	"runtime"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// 本文件对应 Node lib/server/zcode-egress-service.js 的
// resolveAccountEgressRequestOptionsRaw() 与 lib/server/zcode-egress-resolver.js
// 的 resolveEgressTarget()：读绑定 → 规范化 → 按模式解析成具体出站目标。
// 失败一律返回 *Error（fail-closed），绝不回落到全局代理或直连。

// BindingReader 读 account:egress:<ref> 的原始 JSON；found=false 表示未绑定。
type BindingReader func(ctx context.Context, accountRef string) (raw string, found bool, err error)

// Options 是 Resolver 的依赖集合。
//
// 除 AIHomeDir 外都可注入：测试不需要真的读 app-state / 跑系统探测命令，
// 宿主也可以在接线时替换探测实现。
type Options struct {
	// AIHomeDir 是 AIH 数据根（含 app-state.db 与 run/egress-pool/state.json）。
	AIHomeDir string
	// ReadBinding 覆盖 app-state 读取；为空时用 appstate.ReadKV 读
	// account:egress:<ref>（与 Node readAccountEgressBinding 同键）。
	ReadBinding BindingReader
	// DetectSystemProxy 覆盖系统代理探测；为空时用 macOS 实现。
	DetectSystemProxy SystemProxyDetector
	// DetectTUN 覆盖外部 TUN 探测；为空时用 macOS 实现。
	DetectTUN TUNDetector
	// PidAlive 判断池运行文件里的 owner/core 进程是否存活；为空时用 signal 0。
	PidAlive func(pid int) bool
	// Platform 覆盖平台判定（默认 runtime.GOOS），测试非 macOS 分支用。
	Platform string
}

// Resolver 是账号级出口解析器。
//
// 无共享可变状态，可并发调用。每次解析都现读 app-state 与池运行文件——出口变更
// 不需要重启进程，也不会读到缓存里的旧绑定。
type Resolver struct {
	aiHomeDir         string
	readBinding       BindingReader
	detectSystemProxy SystemProxyDetector
	detectTUN         TUNDetector
	pidAlive          func(pid int) bool
	platform          string
}

// NewResolver 创建解析器；AIHomeDir 为空时 Resolve 一律返回未绑定（对应 Node
// 「没有存储上下文就保持既有 Gateway 网络策略」）。
func NewResolver(options Options) *Resolver {
	resolver := &Resolver{
		aiHomeDir:         strings.TrimSpace(options.AIHomeDir),
		readBinding:       options.ReadBinding,
		detectSystemProxy: options.DetectSystemProxy,
		detectTUN:         options.DetectTUN,
		pidAlive:          options.PidAlive,
		platform:          options.Platform,
	}
	if resolver.readBinding == nil {
		resolver.readBinding = newAppStateBindingReader(resolver.aiHomeDir)
	}
	return resolver
}

// newAppStateBindingReader 构造默认的 app-state 读取口。
//
// 没有数据根或路径不可解析时返回 nil：Resolve 按未绑定处理，与 Node 在没有
// 存储上下文时直接返回 bound:false 一致（不能去读默认数据目录，那可能是别的实例）。
func newAppStateBindingReader(aiHomeDir string) BindingReader {
	if aiHomeDir == "" {
		return nil
	}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil
	}
	return func(ctx context.Context, accountRef string) (string, bool, error) {
		return appstate.ReadKV(ctx, databasePath, bindingKey(accountRef))
	}
}

// Resolve 解析账号出口。
//
// 返回值语义与 Node resolveAccountEgressRequestOptionsRaw 对齐：
//   - Bound=false：账号没有绑定（或账号引用/存储上下文无效），调用方保持原网络策略；
//   - Bound=true 且 err=nil：Target 是解析后的出站目标；
//   - err 是 *Error：必须 fail-closed。
func (resolver *Resolver) Resolve(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (Decision, error) {
	if resolver == nil || !accountRef.IsValid() || resolver.readBinding == nil {
		return Decision{}, nil
	}
	raw, found, err := resolver.readBinding(ctx, accountRef.String())
	if err != nil {
		return Decision{}, newErrorWithReason(ErrorBindingReadFailed, err.Error())
	}
	if !found || strings.TrimSpace(raw) == "" {
		return Decision{}, nil
	}
	binding, parseErr := parseBinding(raw)
	if parseErr != nil {
		return Decision{}, newErrorWithReason(ErrorBindingReadFailed, parseErr.Error())
	}
	return resolver.resolveBinding(ctx, accountRef.String(), binding)
}

// resolveBinding 按模式解析，执行顺序与 Node resolveEgressTarget 一致：
// retired → 平台 → 模式。
func (resolver *Resolver) resolveBinding(
	ctx context.Context,
	accountRef string,
	binding Binding,
) (Decision, error) {
	if binding.Retired {
		return Decision{}, newErrorWithReason(ErrorModeRetired, binding.Mode)
	}
	platform := normalizePlatform(resolver.platformValue())
	if platform != "macos" {
		return Decision{}, &Error{Code: ErrorNotSupported, Platform: platform}
	}
	switch binding.Mode {
	case ModeDirect:
		// 显式直连：不探测任何外部设施，目标就是「不用代理」。
		return boundDecision(Target{Source: ModeDirect, Direct: true}), nil
	case ModeURL:
		if issue := proxyURLIssue(binding.ProxyURL); issue != "" {
			return Decision{}, newError(issue)
		}
		return boundDecision(Target{
			Source:   ModeURL,
			ProxyURL: normalizeProxyURL(binding.ProxyURL),
		}), nil
	case ModeSystem:
		return resolver.resolveSystemProxy(ctx)
	case ModeTUN:
		return resolver.resolveTUN(ctx)
	case ModePool:
		return resolver.resolvePool(accountRef)
	default:
		return Decision{}, newError(ErrorUnknownMode)
	}
}

// resolveSystemProxy 对应 Node resolveSystemProxyTarget()：优先 HTTPS > HTTP >
// SOCKS5，只按消费方能力过滤；agy 三种 scheme 都能承载。
func (resolver *Resolver) resolveSystemProxy(ctx context.Context) (Decision, error) {
	detector := resolver.detectSystemProxy
	if detector == nil {
		detector = detectMacOSSystemProxy
	}
	status, err := detector(ctx)
	if err != nil {
		return Decision{}, newErrorWithReason(ErrorSystemProxyUnavailable, err.Error())
	}
	if !status.Enabled {
		return Decision{}, newErrorWithReason(ErrorSystemProxyUnavailable, status.ProbeStatus)
	}
	for _, candidate := range []string{status.HTTPSProxy, status.HTTPProxy, status.SOCKSProxy} {
		if proxyURL := normalizeProxyURL(candidate); proxyURL != "" {
			return boundDecision(Target{Source: ModeSystem, ProxyURL: proxyURL}), nil
		}
	}
	// Node: 存在 SOCKS 地址却无法使用时归为 scheme 不可用，其余归为没有系统代理。
	if status.SOCKSProxy != "" {
		return Decision{}, newError(ErrorSystemProxySchemeUnavailable)
	}
	return Decision{}, newErrorWithReason(ErrorSystemProxyUnavailable, status.ProbeStatus)
}

// resolveTUN 对应 Node resolveTunTarget()：只有确认 active 才允许直连。
func (resolver *Resolver) resolveTUN(ctx context.Context) (Decision, error) {
	detector := resolver.detectTUN
	if detector == nil {
		detector = detectMacOSTUN
	}
	status, err := detector(ctx)
	if err != nil {
		return Decision{}, newErrorWithReason(ErrorTUNStateUnknown, err.Error())
	}
	state := strings.ToLower(strings.TrimSpace(status.State))
	if state == "" {
		// Node: String(tun?.state || 'unknown')。
		state = "unknown"
	}
	if state != "active" {
		if state == "inactive" {
			return Decision{}, newError(ErrorTUNInactive)
		}
		return Decision{}, newErrorWithReason(ErrorTUNStateUnknown, state)
	}
	return boundDecision(Target{Source: ModeTUN, Direct: true}), nil
}

// resolvePool 对应 Node resolveEgressPoolTarget() 的读取分支：地址来自运行文件，
// 账号有车道用车道，否则用默认出口。运行文件不可用（server 未运行 / 内核已退出）
// 时 fail-closed，绝不回落到全局代理。
func (resolver *Resolver) resolvePool(accountRef string) (Decision, error) {
	proxyURL, reason := resolver.readLivePoolState(accountRef)
	if proxyURL == "" {
		return Decision{}, newErrorWithReason(ErrorPoolNotReady, reason)
	}
	normalized := normalizeProxyURL(proxyURL)
	if normalized == "" {
		// Node 在同样情形下只报 egress_pool_not_ready（无 reason）；这里补一个明确
		// 原因，方便区分「文件里的地址坏了」与「池没起来」。
		return Decision{}, newErrorWithReason(ErrorPoolNotReady, "egress_pool_proxy_url_invalid")
	}
	return boundDecision(Target{Source: ModePool, ProxyURL: normalized}), nil
}

// platformValue 返回平台标识：显式注入优先，否则 runtime.GOOS。
func (resolver *Resolver) platformValue() string {
	if strings.TrimSpace(resolver.platform) != "" {
		return resolver.platform
	}
	return runtime.GOOS
}

// pidAliveFunc 返回 PID 存活判断；默认实现见 pool.go 的 defaultPidAlive。
func (resolver *Resolver) pidAliveFunc() func(pid int) bool {
	if resolver.pidAlive != nil {
		return resolver.pidAlive
	}
	return defaultPidAlive
}

// normalizePlatform 对应 Node normalizeClientPlatform() 的别名表。
func normalizePlatform(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "mac", "macos", "darwin":
		return "macos"
	case "win", "windows", "win32":
		return "windows"
	case "linux", "linux2":
		return "linux"
	default:
		return ""
	}
}

func boundDecision(target Target) Decision {
	return Decision{Bound: true, Target: target}
}
