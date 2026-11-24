// Package codexenvironments 把 AIH 的 SSH 连接渲染成 Codex 的远端执行环境
// （$CODEX_HOME/environments.toml 的 [[environments]] 条目）。
//
// 它只做「纯渲染与合并」：输入是已解析好的连接事实，输出是 TOML 文本。
// 不读数据库、不拨号、不注册 HTTP 路由，也不碰用户手写的条目——本包写入的
// 内容永远被受管标记包裹，合并时原样保留其余文本。
//
// 与 Codex 的契约（真机实证，见 docs/remote/2026-11-23-codex-ssh-environment-bridge.md）：
//   - 顶层：default、include_local、environments（**数组表** [[environments]]）
//   - 条目字段：id、skills、url、auth_bearer_token、program、args、env、cwd、
//     connect_timeout_sec、initialize_timeout_sec
//   - connect_timeout_sec 只允许与 url 同用，与 program 同用会直接拒载
package codexenvironments

// maxJumpDepth 与 webuiremoteworkspace 的跳板链上限保持一致。
const maxJumpDepth = 5

// Auth 是连接认证方式的稳定标识；取值与 app_kv:ssh_connections 的 authType 一致。
const (
	AuthAgent    = "agent"
	AuthKey      = "key"
	AuthKeyFile  = "key-file"
	AuthPassword = "password"
)

// Connection 是渲染一条环境所需的 SSH 连接事实子集。
//
// 它刻意只保留本包用得到的东西，让调用方从各自的连接模型适配进来，
// 而不是让渲染逻辑依赖 webui/adapters 的具体类型。
type Connection struct {
	ID           string
	Label        string
	Host         string
	User         string
	Port         int
	AuthType     string
	IdentityFile string
	// Password / PrivateKey 只在 url 模式拨号时使用。
	//
	// program 模式无法把密码或逐跳私钥交给 Codex 的 ProxyJump，所以那两条
	// 路径不会渲染这两个字段；url 模式由 AIH 自己拨号，需要凭据本体。
	Password   string
	PrivateKey string
	// EgressConnectionID 非空表示该连接的出口是另一条连接（跳板链）。
	EgressConnectionID string
	// HasReverseTunnel 为真表示该连接挂着反向隧道。
	//
	// 反向隧道是 AIH 侧的附加能力（把远端 127.0.0.1:remotePort 转发回本机），
	// 与 Codex 的 ssh 直连正交，不影响渲染：Codex 只是多一条普通的 SSH 连接。
	HasReverseTunnel bool
	// Jump 非空表示已经可以经跳板拨号（由 EgressConnectionID 展开而来）。
	Jump *Connection
}

// Entry 是一条待渲染的 Codex 执行环境。
//
// program 模式与 url 模式共用这个结构，但字段互斥：
//   - program 模式用 Program/Args；
//   - url 模式用 URL/AuthBearerToken/ConnectTimeoutSec。
//
// connect_timeout_sec 只对 url 合法，所以它只在 URL 非空时才会被渲染。
type Entry struct {
	ID                   string
	Program              string
	Args                 []string
	Env                  map[string]string
	Cwd                  string
	InitializeTimeoutSec int
	URL                  string
	AuthBearerToken      string
	ConnectTimeoutSec    int
}

// Rejection 描述一条无法安全渲染的连接及其原因。
//
// 原因必须是稳定的机器码：调用方要把它原样透出，而不是笼统说“同步失败”。
type Rejection struct {
	ConnectionID string
	Label        string
	Code         string
	Message      string
}
