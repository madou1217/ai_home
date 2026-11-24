package codexenvironments

import (
	"strconv"
	"strings"
)

// URL 模式：AIH 自己建立 SSH 通道并把远端的 exec-server 暴露到本机回环，
// Codex 只连 `ws://127.0.0.1:<port>`。它比 program 模式多做两件事：
//
//   - 能带上 program 模式表达不了的东西（反向隧道、askpass 密码认证、出口绑定）；
//   - 通道生命周期由 AIH 管理，断线重连、探活都复用现有守护逻辑。
//
// 代价是 AIH 必须常驻：远端 exec-server 与本地监听都由它维持，因此这个模式
// 永远由调用方显式选择，不会作为默认。

// URLEnvironment 是一条 url 模式环境的渲染输入。
type URLEnvironment struct {
	ConnectionID string
	// LocalPort 是 AIH 在本机回环上监听的端口；必须 >0。
	LocalPort int
	// BearerToken 为空时写 null（Codex 允许省略）。
	BearerToken string
	// Cwd 是远端默认工作目录，可空。
	Cwd string
	// ConnectTimeoutSec / InitializeTimeoutSec 为 0 时用默认值。
	ConnectTimeoutSec    int
	InitializeTimeoutSec int
}

const (
	defaultConnectTimeoutSec = 15
	minLocalPort             = 1
	maxLocalPort             = 65535
)

// BuildURLEntry 渲染一条 url 模式环境。
//
// 注意：connect_timeout_sec 只能与 url 同用——与 program 同用 Codex 会直接拒载，
// 所以这个字段只在本文件出现。
func BuildURLEntry(environment URLEnvironment) (Entry, *Rejection) {
	id := strings.TrimSpace(environment.ConnectionID)
	if id == "" {
		return Entry{}, &Rejection{Code: CodeInvalid, Message: "SSH 连接缺少 ID"}
	}
	reject := func(message string) (Entry, *Rejection) {
		return Entry{}, &Rejection{ConnectionID: id, Code: CodeInvalid, Message: message}
	}
	if environment.LocalPort < minLocalPort || environment.LocalPort > maxLocalPort {
		return reject("url 模式需要有效的本机回环端口")
	}
	connect := environment.ConnectTimeoutSec
	if connect <= 0 {
		connect = defaultConnectTimeoutSec
	}
	initialize := environment.InitializeTimeoutSec
	if initialize <= 0 {
		initialize = defaultInitializeTimeoutSec
	}
	return Entry{
		ID:                   EnvironmentID(id),
		URL:                  "ws://127.0.0.1:" + strconv.Itoa(environment.LocalPort),
		AuthBearerToken:      strings.TrimSpace(environment.BearerToken),
		Cwd:                  strings.TrimSpace(environment.Cwd),
		ConnectTimeoutSec:    connect,
		InitializeTimeoutSec: initialize,
	}, nil
}
