// Package egress 解析账号级出口绑定（Node 的 account:egress:<ref>）到具体出站目标。
//
// 背景：agy 的 Token 刷新已迁到 Go，但账号可能绑定自定义出口。Node 的解析链是
// lib/server/zcode-egress-service.js（resolveAccountEgressRequestOptionsRaw）+
// lib/server/zcode-egress-resolver.js（resolveEgressTarget）：url / system / tun /
// pool / direct 五种模式，任何失败都 fail-closed，不回落到全局代理或直连。Go 侧
// 此前只认 direct/proxy，pool/tun 直接报「需要宿主代理」；本包补齐同一套解析：
//
//   - url：校验并归一化绑定里的代理地址（scheme 白名单 http/https/socks5/socks5h，
//     agy 的 provider 描述符没有收窄 egress.proxySchemes，见 lib/providers/defs/agy.js）；
//   - system：读 macOS 系统代理（scutil --proxy，未启用时回退 networksetup 按网络服务读，
//     与 lib/cli/services/toolkit/system-proxy-plugins/macos.js 同判据）；
//   - tun：探测外部 TUN（ifconfig / netstat / ps，与 detectTun 同判据），生效时客户端直连；
//   - pool：读 <aiHomeDir>/run/egress-pool/state.json 的账号车道（Node 的
//     lib/runtime/egress-pool-state-file.js），得到本机回环出站地址；
//   - direct：显式不用代理（一条绑定记录，不是「没有绑定」）。
//
// 与 Node 的故意差异（均有理由）：
//   - 不复用 15s 的探测结果缓存：Go 只在 OAuth 刷新时解析（小时级），不是每请求热路径；
//   - pool 保存时的连通性探测与节点轮换（probePoolEgressWithRotation）仍由持有内核的
//     Node 池运行时负责；Go 进程里没有池内核，读取路径只能按运行文件 fail-closed；
//   - 系统代理的 bypassList 不参与出口解析，因此这里不解析（Node 也只用于诊断展示）。
package egress

import "strings"

// 绑定模式与解析后的出口来源同名，取值与 Node
// lib/account/zcode-egress-binding-store.js 的 EGRESS_MODE_* 一致。
const (
	ModeDirect = "direct"
	ModeSystem = "system"
	ModeTUN    = "tun"
	ModeURL    = "url"
	ModePool   = "pool"
)

// 失败码对齐 Node 的 egress.error / egressError 字段，便于宿主按同一张文案表映射。
const (
	// ErrorBindingReadFailed 表示绑定记录读不出来或形状非法（Node 的
	// egress_binding_read_failed，reason 带原始错误）。
	ErrorBindingReadFailed = "egress_binding_read_failed"
	// ErrorModeRetired 表示绑定还停在已下线的 node/group 模式。
	ErrorModeRetired = "account_egress_mode_retired"
	// ErrorNotSupported 表示当前平台不是 macOS（Node 的 not_supported）。
	ErrorNotSupported = "not_supported"
	// ErrorUnknownMode 表示绑定模式不在五种之内（规范化后理论上不可达）。
	ErrorUnknownMode = "unknown_egress_mode"
	// ErrorSystemProxyUnavailable 表示系统里没有可用的系统代理。
	ErrorSystemProxyUnavailable = "system_proxy_unavailable"
	// ErrorSystemProxySchemeUnavailable 表示系统代理只有消费方承载不了的 scheme。
	ErrorSystemProxySchemeUnavailable = "system_proxy_scheme_unavailable"
	// ErrorTUNInactive 表示没有探测到已激活的外部 TUN。
	ErrorTUNInactive = "tun_inactive"
	// ErrorTUNStateUnknown 表示无法确认外部 TUN 状态。
	ErrorTUNStateUnknown = "tun_state_unknown"
	// ErrorPoolNotReady 表示出口池没有可用的本地出站地址。
	ErrorPoolNotReady = "egress_pool_not_ready"
)

// Error 是一次 fail-closed 的出口解析失败。
//
// Code 对应 Node 的 egress.error（调用方的 egressError），Reason 对应更细的
// reason / probeStatus，只用于排查；Platform 仅在 not_supported 时给出。
type Error struct {
	Code     string
	Reason   string
	Platform string
}

// Error 输出 "code: reason" 形式，保留 Node 错误码原文供日志检索。
func (err *Error) Error() string {
	if err == nil {
		return ""
	}
	parts := []string{err.Code}
	if err.Platform != "" {
		parts = append(parts, "platform="+err.Platform)
	}
	if err.Reason != "" {
		parts = append(parts, err.Reason)
	}
	return strings.Join(parts, ": ")
}

// Target 是解析成功后的出站目标。
//
// Direct 为 true 时 ProxyURL 为空：调用方必须完全不走代理（tun 由外部 TUN 接管，
// direct 是显式直连）；否则用 ProxyURL。Source 是五种模式之一。
type Target struct {
	Source   string
	ProxyURL string
	Direct   bool
}

// Decision 是 Resolve 的结果。
//
// Bound 为 false 表示账号没有绑定记录（或调用方没有存储上下文），调用方应保持
// 既有网络策略；Bound 为 true 时 Target 一定有效，失败则返回 *Error（fail-closed）。
type Decision struct {
	Bound  bool
	Target Target
}

func newError(code string) *Error {
	return &Error{Code: code}
}

func newErrorWithReason(code string, reason string) *Error {
	return &Error{Code: code, Reason: reason}
}
