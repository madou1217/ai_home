package completion

import "strings"

// flagSummaries 是「每个候选都要能解释自己」的旗标说明。
var flagSummaries = map[string]string{
	"--proxy":               "本次安装/更新代理：裸旗标 auto，或指定节点/名称/HTTP(S) URL",
	"--account":             "账号编号或 accountRef",
	"--all-supported":       "对所有支持的 Provider 生效",
	"--channel":             "投递通道（native / inject / webui-chat）",
	"--check":               "只检查是否有更新",
	"--dry-run":             "只打印将要做的改动，不写文件",
	"--force":               "跳过确认，强制执行",
	"--force-quit-client":   "先强杀客户端再设置",
	"--from":                "起始时间（含）",
	"--help":                "打印用法",
	"--history":             "列该 CLI 自己的历史会话",
	"--json":                "以 JSON 输出",
	"--limit":               "最多返回多少条",
	"--list":                "只列出，不进入",
	"--mode":                "peer 的投递模式",
	"--model":               "本次启动请求的模型名",
	"--model-alias":         "本次启动的临时转发：请求 A 实际用 B",
	"--mcp":                 "只启用列出的 MCP（逗号分隔；Codex / Claude）",
	"--no-mcp":              "本次会话不启用任何 MCP",
	"--no-browser":          "不打开浏览器（设备码直接打印）",
	"--completion":          "开启 TAB 补全",
	"--typo":                "开启命令纠错建议",
	"--wrapper":             "开启 aih 包装函数",
	"--no-completion":       "不安装 TAB 补全",
	"--no-envelope":         "发送时不带信封",
	"--no-scan":             "不重新扫描历史记录",
	"--no-typo":             "不安装拼写纠正",
	"--no-wrapper":          "不安装 aih 包装函数",
	"--paste-event":         "用真实粘贴事件测试",
	"--preflight":           "先探测账号可用性",
	"--provider":            "指定 Provider",
	"--quiet":               "安静模式，只输出结果",
	"--rc-file":             "写入哪个 shell rc 文件",
	"--refresh":             "强制重新探测 / 刷新",
	"--reindex-codex-forks": "重建 codex fork 的索引",
	"--remaining":           "剩余额度阈值（0-100，0 = 只在真的用完时换）",
	"--reply-to":            "回复指定消息",
	"--restart-client":      "设置后重启客户端",
	"--scope":               "按 provider 过滤（支持 * 与 ? 通配）",
	"--self":                "只看发给自己的",
	"--session-id":          "限定某个会话",
	"--shell":               "目标 shell（zsh / bash / fish / powershell）",
	"--state":               "按消息状态过滤",
	"--target":              "收件人（会话名或 id）",
	"--timeout-ms":          "超时毫秒数",
	"--to":                  "结束时间（含）",
	"--unread":              "只看未读",
	"--wait":                "等待可投递后再发",
	"-j":                    "以 JSON 输出（简写）",
}

// nestedSubcommandSummaries 是 NESTED_SUBCOMMAND_TABLES 的配套说明表。
var nestedSubcommandSummaries = map[string]string{
	"accounts":         "列出 / 审计该 Provider 的账号",
	"agent":            "注册中心 agent 操作",
	"apply":            "应用配置",
	"attach":           "附着到运行中的会话",
	"audit":            "审计一致性",
	"auth-job":         "查看 / 重跑认证任务",
	"caddy":            "Caddy 入口",
	"cloud-edge":       "云边通道",
	"config":           "查看 / 修改配置",
	"connect":          "建立连接",
	"disable":          "停用",
	"doctor":           "诊断一致性",
	"echo":             "回声测试",
	"echo-server":      "启动回声服务端",
	"enable":           "启用",
	"events":           "读取会话事件",
	"forget":           "遗忘已学习的记录",
	"frpc":             "frpc 入口",
	"get":              "读取配置项",
	"heartbeat":        "发送心跳",
	"inspect":          "查看详情",
	"install":          "安装",
	"list":             "列出",
	"message":          "给会话发消息",
	"nginx":            "nginx 入口",
	"off":              "关闭",
	"on":               "开启",
	"prerequisites":    "检查前置条件",
	"probe":            "探测可用性",
	"project":          "投影原生配置",
	"promotion-gate":   "晋升门禁检查",
	"publish":          "发布",
	"readiness":        "就绪检查",
	"reauth":           "重新认证",
	"relay-durability": "中继持久性检查",
	"remove":           "移除",
	"resume-check":     "断点续传检查",
	"revalidate":       "重新校验",
	"service":          "服务管理",
	"set":              "写入配置项",
	"show":             "显示当前配置",
	"slash":            "发送斜杠命令",
	"start":            "启动",
	"status":           "查看状态",
	"stop":             "停止",
	"tcp-echo":         "TCP 回声测试",
	"tcp-echo-server":  "启动 TCP 回声服务端",
	"turn-relay":       "TURN 中继检查",
	"uninstall":        "卸载",
	"verify":           "验证",
	"webtransport":     "WebTransport 检查",
}

func describeFlag(flag string) string {
	name := strings.TrimSpace(flag)
	if summary, found := flagSummaries[name]; found {
		return summary
	}
	return "选项：" + strings.TrimLeft(name, "-")
}

func describeNestedSubcommand(name string) string {
	key := strings.TrimSpace(name)
	if summary, found := nestedSubcommandSummaries[key]; found {
		return summary
	}
	return "子命令：" + key
}

// nestedSubcommandTables 是第三层及更深的下钻表。
var nestedSubcommandTables = map[string][]string{
	"server config":       {"show", "get", "set", "list"},
	"server autostart":    {"install", "uninstall", "status"},
	"native plugin":       {"list", "install", "enable", "disable", "remove", "inspect", "project", "doctor"},
	"ssh-clipboard probe": {},
	"shell typo":          {"list", "forget"},
	"edge status":         {"frpc", "nginx", "caddy"},
	"edge plan":           {"frpc", "nginx", "caddy"},
	"edge apply":          {"frpc", "nginx", "caddy"},
	"edge remove":         {"frpc"},
	"account credential":  {"update"},
	"account default":     {"show", "set", "clear"},
	"account models":      {"list", "refresh", "set-policy"},
	"account usage":       {"show", "refresh"},
	"account transfer":    {"export", "import"},
}
