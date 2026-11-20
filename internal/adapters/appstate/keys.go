package appstate

// app_kv 的键名是「这份库里的哪一槽数据」这一事实，必须只有一处定义。
//
// 此前 `config:server` 在七个包里各有 const、又在十余处直接写字面量；改键名时
// 只要漏掉一处，那个读点就会静默读到空值（服务地址回落默认端口、管理密钥变空），
// 属于最难排查的一类故障。这里给出唯一定义，其它包一律引用。
const (
	// KeyServerConfig 是服务端配置（监听主机/端口、apiKey、managementKey、
	// goCoreEnabled 等）在 app_kv 里的键，与 Node 同键。
	KeyServerConfig = "config:server"
	// KeyUsageConfig 是用量阈值与统计配置的键，与 Node 同键。
	KeyUsageConfig = "config:usage"

	// KeyCodexProviderDefault / KeyCodexAccountDefault 是 codex 兼容默认态在
	// app_kv 里的旧键（profile 与 legacy account 两槽），与 Node 同键。
	// 账号适配器与 app-server 环境构建都读这两槽，键名必须同源。
	KeyCodexProviderDefault = "provider:default:codex"
	KeyCodexAccountDefault  = "account:default:codex"
)
