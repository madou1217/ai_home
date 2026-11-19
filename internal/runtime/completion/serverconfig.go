package completion

import "strings"

// serverConfigField 是 `aih server config set` 的 Go 侧旗标描述符。
//
// 事实来源是 cmd/aih/server_config.go 的解析器（configFlagKey / 显式开关分支），
// 这里只为补全补上说明与枚举取值，不新增任何 Go 侧尚不接受的旗标。
type serverConfigField struct {
	Flag    string
	Summary string
	// Boolean 表示该旗标是开关（没有取值位）；其余旗标都有待填的取值。
	Boolean bool
	// Values 是唯一允许的枚举取值；空表示自由取值。
	Values []string
}

var serverConfigFields = []serverConfigField{
	{Flag: "--host", Summary: "监听地址"},
	{Flag: "--port", Summary: "监听端口"},
	{Flag: "--open-network", Summary: "是否对外监听（等价于把 host 设为 0.0.0.0）", Boolean: true},
	{Flag: "--local-only", Summary: "是否对外监听（等价于把 host 设为 0.0.0.0）", Boolean: true},
	{Flag: "--proxy-url", Summary: "上游请求走的 HTTP(S) 代理"},
	{Flag: "--no-proxy", Summary: "不走代理的主机列表（逗号分隔，支持 * 通配与域名后缀）"},
	{Flag: "--client-key", Summary: "客户端调用 /v1 与 /v1beta 所需的 key（Authorization: Bearer）"},
	{Flag: "--management-key", Summary: "管理面（/v0/webui、/v0/management、远程重启、中转服务）所需的 key"},
	{Flag: "--models-probe-accounts", Summary: "每次模型目录刷新时并发探测的账号数"},
	{Flag: "--model-cache-sync", Summary: "WebUI 模型缓存的刷新方式：go-batch = 批量读 Go 的 account-models（默认；启动后一次、每 6 小时一次、别名保存/候选读取前超过 30 秒补一次）；scheduler = legacy，枚举值仅用于配置回退，旧逐账号调度器已退役（不做定时轮询，只按需标记 stale）", Values: []string{"scheduler", "go-batch"}},
	{Flag: "--window-activation", Summary: "窗口激活的全局闸门（还要在账号页逐账号打开）", Boolean: true},
	{Flag: "--no-window-activation", Summary: "窗口激活的全局闸门（还要在账号页逐账号打开）", Boolean: true},
	{Flag: "--window-activation-default-interval-ms", Summary: "观察不到窗口时的兜底探测间隔（≥ 1 分钟）"},
	{Flag: "--window-activation-min-interval-ms", Summary: "探测间隔下限"},
	{Flag: "--go-core", Summary: "是否由 Go Core 承接数据面", Boolean: true},
	{Flag: "--no-go-core", Summary: "是否由 Go Core 承接数据面", Boolean: true},
	{Flag: "--go-core-routes", Summary: "由 Go 承接的 route-ownership 条目 ID（逗号分隔）"},
	{Flag: "--upstream-error-rules", Summary: "哪些 Provider 的账号自定义上游错误规则交给 Go 执行（小写、逗号分隔）"},
	{Flag: "--relay-udp", Summary: "中转 UDP：on = 在同一个端口号的 UDP 侧承接 SOCKS5 UDP ASSOCIATE（QUIC/HTTP3 可用），off = 只放行 TCP，default = 跟随环境变量/默认开", Values: []string{"default", "on", "off"}},
	{Flag: "--relay-udp-advertise-host", Summary: "播报给客户端的 UDP 入口主机（NAT / frp / 公网映射时填外部地址）"},
	{Flag: "--relay-udp-advertise-port", Summary: "播报给客户端的 UDP 端口（外部端口与本地不同时用）"},
	{Flag: "--relay-port-mode", Summary: "中转端口布局：server = 跟随 AIH 端口做首字节分流（默认，不开新端口，反代需四层透传），dedicated = 每节点一个端口（23100+，需在防火墙/安全组放行）", Values: []string{"default", "server", "dedicated"}},
	{Flag: "--relay-listen-host", Summary: "中转入口绑定的网卡"},
	{Flag: "--egress-evidence-ttl-ms", Summary: "出口节点对上游的实测结论（例如某节点访问 api.anthropic.com 被拒）的有效期，到期后后台自动重测"},
	{Flag: "--max-attempts", Summary: "单次请求最多尝试几个账号（同名别名回落也计入）"},
	{Flag: "--large-paste-chars", Summary: "WebUI 会话框粘贴多少字以上自动转成文本附件（显示预览与路径引用，不塞进输入框）"},
	{Flag: "--upstream-429-retry", Summary: "上游真实 HTTP 429 有界退避重试配置（默认启用，队列 [30] 秒）"},
	{Flag: "--no-upstream-429-retry", Summary: "上游真实 HTTP 429 有界退避重试配置（默认启用，队列 [30] 秒）"},
	{Flag: "--upstream-429-retry-backoff", Summary: "上游真实 HTTP 429 有界退避重试配置（默认启用，队列 [30] 秒）"},
}

func findServerConfigField(flag string) (serverConfigField, bool) {
	name := strings.TrimSpace(flag)
	for _, field := range serverConfigFields {
		if field.Flag == name {
			return field, true
		}
	}
	return serverConfigField{}, false
}

func listServerConfigFlags() []Candidate {
	result := make([]Candidate, 0, len(serverConfigFields))
	for _, field := range serverConfigFields {
		result = append(result, Candidate{Value: field.Flag, Description: field.Summary, Group: groupFlag})
	}
	return result
}

// serverConfigValues 返回某个旗标的取值候选。
// present=false 表示该旗标是开关或未知旗标（回到旗标列表）；
// present=true 且列表为空表示「有取值位但不是枚举」（不要再列旗标）。
func serverConfigValues(flag string) ([]Candidate, bool) {
	field, found := findServerConfigField(flag)
	if !found || field.Boolean {
		return nil, false
	}
	result := make([]Candidate, 0, len(field.Values))
	for _, value := range field.Values {
		result = append(result, Candidate{Value: value, Description: "允许的取值", Group: groupFlag})
	}
	return result, true
}
