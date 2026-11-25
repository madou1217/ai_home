package completion

// 本文件是补全命令面的唯一数据源。新增/调整命令只改这里：
//   n(名字, 说明)             一个命令节点
//   .withAliases(别名...)     别名
//   .withChildren(子命令...)  子命令
//   .withOptions(选项...)     该层选项
//   .withPositionals(位...)   自由参数位
// 选项用 f(无值) / vf(取值) / mf(可重复取值)，参数位用 p / pr。

func n(name, summary string) commandNode {
	return commandNode{Name: name, Summary: summary}
}

func (node commandNode) withAliases(aliases ...string) commandNode {
	node.Aliases = append([]string(nil), aliases...)
	return node
}

func (node commandNode) withChildren(children ...commandNode) commandNode {
	node.Children = append([]commandNode(nil), children...)
	return node
}

func (node commandNode) withOptions(options ...optionSpec) commandNode {
	node.Options = append([]optionSpec(nil), options...)
	return node
}

func (node commandNode) withPositionals(positionals ...positionalSpec) commandNode {
	node.Positionals = append([]positionalSpec(nil), positionals...)
	return node
}

func (node commandNode) withAlwaysOptions() commandNode {
	node.AlwaysOptions = true
	return node
}

// plusOptions 在子命令现有选项之后追加父级通用选项，保持顺序稳定。
func (node commandNode) plusOptions(options ...optionSpec) commandNode {
	node.Options = append(append([]optionSpec(nil), node.Options...), options...)
	return node
}

func f(name, summary string) optionSpec {
	return optionSpec{Name: name, Summary: summary}
}

func vf(name, summary string, kind valueKind, values ...string) optionSpec {
	return optionSpec{Name: name, Summary: summary, Kind: kind, Values: values}
}

func mf(name, summary string) optionSpec {
	return optionSpec{Name: name, Summary: summary, Kind: kindProvider, Multi: true}
}

func p(kind valueKind) positionalSpec {
	return positionalSpec{Kind: kind}
}

func positionEnum(values ...string) positionalSpec {
	return positionalSpec{Kind: kindEnum, Values: values}
}

func failureStatusPosition() positionalSpec {
	return positionEnum("*", "400", "401", "403", "404", "408", "409", "413", "422", "429", "500", "502", "503", "504")
}

func pr(kind valueKind) positionalSpec {
	return positionalSpec{Kind: kind, Repeat: true}
}

func buildCommandCatalog() []commandNode {
	jsonFlag := f("--json", "以 JSON 输出")
	usageOptions := []optionSpec{
		f("--from", "起始时间（含）"), f("--to", "结束时间（含）"),
		vf("--provider", "指定 Provider", kindProvider), vf("--model", "限定模型", kindModel),
		f("--session-id", "限定某个会话"), f("--no-scan", "不重新扫描历史记录"), jsonFlag,
		f("--reindex-codex-forks", "重建 codex fork 的索引"),
	}
	peerOptions := []optionSpec{
		vf("--provider", "指定 Provider", kindProvider),
		vf("--channel", "投递通道", kindEnum, "native", "inject", "webui-chat"),
		f("--mode", "投递模式"), f("--from", "发送方"),
		vf("--target", "收件人", kindPeerTarget), vf("--reply-to", "回复指定消息", kindPeerMessage),
		f("--self", "只看发给自己的"), f("--unread", "只看未读"),
		vf("--state", "按消息状态过滤", kindEnum, "pending", "delivered", "read", "failed", "unread", "all"),
		f("--limit", "最多返回多少条"), f("--wait", "等待可投递后再发"),
		f("--no-envelope", "发送时不带信封"), f("--dry-run", "只打印将要做的改动"), jsonFlag,
	}
	mcpOptions := []optionSpec{vf("--provider", "指定 Provider", kindProvider), jsonFlag}
	skillOptions := []optionSpec{vf("--provider", "指定 Provider", kindProvider), f("--all-supported", "对所有支持的 Provider 生效"), jsonFlag}
	claimOptions := []optionSpec{f("--dry-run", "只预览"), vf("--account", "指定账号", kindAccount), jsonFlag, f("--quiet", "安静模式")}
	pluginOptions := []optionSpec{jsonFlag}
	remoteTargetOptions := []optionSpec{
		vf("--server", "目标 Server profile", kindRemoteServer),
		f("--server-id", "Server id"),
		vf("--workspace", "工作区 Connector", kindRemoteWorkspace),
		f("--connection", "连接 id"),
		vf("--harness", "harness", kindHarness),
		vf("--provider", "指定 Provider", kindProvider),
		vf("--account", "账号编号或 accountRef", kindAccount),
		vf("--model", "模型", kindModel),
		jsonFlag,
	}
	return []commandNode{
		n("ls", "列出所有工具、账号与状态（provider 位支持通配，也可 --scope）").withAliases("list").
			withOptions(mf("--scope", "按 provider 过滤（支持 * 与 ? 通配）"), jsonFlag).
			withPositionals(p(kindProvider), p(kindFree)),
		n("resume", "跨 provider 选择一段会话并续聊（不记得 id 时用这个）").
			withOptions(vf("--provider", "只看某个 Provider", kindProvider), vf("--account", "指定账号", kindAccount), f("--limit", "最多返回多少条"), jsonFlag).
			withPositionals(p(kindResume)),
		n("ss", "选择并进入一个活跃的持久会话").withAliases("sessions").
			withOptions(f("--list", "按项目预览所有活跃会话"), f("--detail", "列出活跃会话的完整状态"), f("--refresh", "强制重新采集"), f("--all-projects", "查看全部项目"), f("--all", "查看全部项目"), f("--limit", "最多返回多少条")).
			withPositionals(p(kindPersistent)).withAlwaysOptions(),
		n("usage", "按 provider / 模型统计 token 与成本").withChildren(
			n("stats", "总览").plusOptions(usageOptions...),
			n("models", "按模型汇总").plusOptions(usageOptions...),
			n("sessions", "按会话汇总").plusOptions(usageOptions...),
			n("session-detail", "单个会话明细").withPositionals(p(kindFree)).plusOptions(usageOptions...),
			n("scan", "重新扫描历史记录").plusOptions(usageOptions...),
			n("recalculate-costs", "用当前定价重算历史成本").plusOptions(usageOptions...),
		).withOptions(usageOptions...),
		n("update", "检查更新或通过 npm 更新 ai-home").withOptions(f("--check", "只检查是否有更新"), f("--dry-run", "只打印将要做的改动"), f("--force", "跳过确认强制执行")),
		n("install", "安装 / 升级 aih 发行包与托管服务"),
		n("account", "Server 账号管理：增删启停、默认账号、模型与额度").withOptions(f("--from-env", "从官方环境变量读取凭据"), f("--yes", "跳过确认"), f("--limit", "最多返回多少条"), vf("--after", "从某个 account_ref 之后继续", kindAccountTarget), jsonFlag).withChildren(
			n("add", "从环境变量添加静态账号").withOptions(f("--from-env", "从官方环境变量读取凭据")).withPositionals(p(kindProvider)),
			n("list", "分页列出公开账号信息").withOptions(f("--limit", "最多返回多少条"), vf("--after", "从某个 account_ref 之后继续", kindAccountTarget), jsonFlag),
			n("show", "查看一个账号详情").withPositionals(p(kindAccountTarget)),
			n("enable", "启用账号并加入 Server 路由").withPositionals(p(kindAccountTarget)),
			n("disable", "停用账号并移出 Server 路由").withPositionals(p(kindAccountTarget)),
			n("delete", "删除账号及全部从属状态").withOptions(f("--yes", "跳过确认")).withPositionals(p(kindAccountTarget)),
			n("transfer", "单账号标准迁移（export / import）").withChildren(n("export", "导出单账号"), n("import", "导入单账号")),
			n("credential", "原地更新静态凭据").withChildren(n("update", "更新静态凭据").withOptions(f("--from-env", "从官方环境变量读取凭据")).withPositionals(p(kindAccountTarget))),
			n("default", "管理 Provider 默认启动账号").withChildren(
				n("show", "查看 Provider 默认账号").withPositionals(p(kindProvider)),
				n("set", "设置 Provider 默认账号").withPositionals(p(kindProvider), p(kindAccountTarget)),
				n("clear", "清除 Provider 默认账号").withPositionals(p(kindProvider)),
			),
			n("models", "查看 / 刷新账号模型目录与策略").withChildren(
				n("list", "查看已物化账号模型").withPositionals(p(kindAccountTarget)),
				n("refresh", "刷新账号模型目录").withPositionals(p(kindAccountTarget)),
				n("set-policy", "设置人工模型策略").withPositionals(p(kindAccountTarget), p(kindModel), positionEnum("inherit", "force_enable", "force_disable")),
			),
			n("usage", "查看 / 刷新账号额度快照").withChildren(
				n("show", "查看最近额度快照").withPositionals(p(kindAccountTarget)),
				n("refresh", "真实刷新账号额度").withPositionals(p(kindAccountTarget)),
			),
			n("import", "导入官方 CLI 当前登录态").withOptions(vf("--artifact-file", "显式原生 artifact envelope", kindFile)).withPositionals(p(kindProvider)),
		),
		n("limits", "并发与速率上限：全局配置 + Provider / 账号覆盖").withOptions(jsonFlag).withChildren(
			n("show", "查看生效上限").withOptions(jsonFlag),
			n("set-global", "设置全局并发与排队参数").withOptions(f("--system-max", ""), f("--queue-limit", ""), f("--queue-wait-ms", ""), f("--retry-after", ""), f("--account-default", ""), jsonFlag),
			n("set-provider", "设置某 Provider 的并发上限").withOptions(f("--max", ""), jsonFlag).withPositionals(p(kindProvider)),
			n("unset-provider", "清除某 Provider 的覆盖").withOptions(jsonFlag).withPositionals(p(kindProvider)),
			n("set-account", "设置账号级并发 / RPM / TPM").withOptions(vf("--model", "限定模型", kindModel), f("--max", ""), f("--rpm", ""), f("--tpm", ""), jsonFlag).withPositionals(p(kindAccountTarget)),
			n("unset-account", "清除账号级覆盖").withOptions(vf("--model", "限定模型", kindModel), jsonFlag).withPositionals(p(kindAccountTarget)),
			n("preview", "预览某次请求会命中的上限").withOptions(vf("--provider", "指定 Provider", kindProvider), vf("--account", "账号", kindAccountTarget), vf("--model", "限定模型", kindModel), f("--key", "客户端 key id"), jsonFlag),
		),
		n("failure-policy", "上游失败语义覆盖：账号规则 > 全局覆盖 > 内置合同").withOptions(jsonFlag).withChildren(
			n("list", "列出当前生效规则").withOptions(vf("--provider", "只看某个 Provider", kindProvider), jsonFlag),
			n("explain", "解释某个状态码会怎么处理").withOptions(f("--code", ""), f("--type", ""), f("--retry-after-ms", ""), jsonFlag).withPositionals(p(kindProvider), failureStatusPosition()),
			n("set", "覆盖某 Provider 的状态语义").withOptions(f("--semantic", ""), vf("--block-scope", "阻断范围", kindEnum, "account", "account_model")).withPositionals(p(kindProvider), failureStatusPosition()),
			n("set-policy", "设置全局阈值 / 窗口 / 冷却").withOptions(f("--threshold", ""), f("--window-ms", ""), f("--cooldown-ms", "")).withPositionals(p(kindFree)),
			n("unset", "删除一条覆盖").withPositionals(p(kindFree)),
			n("unset-policy", "删除一条全局策略").withPositionals(p(kindFree)),
			n("disable", "停用一条规则").withPositionals(p(kindFree)),
			n("enable", "启用一条规则").withPositionals(p(kindFree)),
		),
		n("client-keys", "网关客户端 key：创建 / 轮换 / 限额 / 统计").withAliases("apikeys").withOptions(jsonFlag).withChildren(
			n("list", "列出 key（只显示前缀）").withOptions(jsonFlag),
			n("create", "创建 key（secret 只输出一次）").withOptions(f("--name", "key 名称"), f("--max-concurrency", ""), f("--rpm", ""), f("--tpm", "")),
			n("show", "查看 key 详情").withOptions(jsonFlag).withPositionals(p(kindFree)),
			n("rename", "重命名 key").withOptions(f("--name", "新名称")).withPositionals(p(kindFree)),
			n("enable", "启用 key").withPositionals(p(kindFree)),
			n("disable", "停用 key").withPositionals(p(kindFree)),
			n("delete", "删除 key").withPositionals(p(kindFree)),
			n("rotate", "轮换 key secret").withPositionals(p(kindFree)),
			n("limits", "设置 key 的并发 / 速率 / 日额度").withOptions(f("--max-concurrency", ""), f("--rpm", ""), f("--tpm", ""), f("--daily-tokens", "")).withPositionals(p(kindFree)),
			n("stats", "查看 key 用量统计").withOptions(f("--key", "key id"), vf("--granularity", "统计粒度", kindEnum, "minute", "hour"), f("--from-ms", ""), f("--to-ms", ""), jsonFlag),
		),
		n("zcode-url", "处理 zcode:// 登录回调（交给登录任务）").withPositionals(p(kindFree)),
		n("remote", "远程执行目标、Server/Workspace/Harness/Model 选择与预检").withChildren(
			n("target", "解析远程执行目标").withChildren(
				n("ls", "列出远程目标候选").withAliases("list").withOptions(remoteTargetOptions...),
				n("resolve", "解析一个远程目标").withOptions(remoteTargetOptions...).withPositionals(p(kindFree)),
				n("doctor", "预检远程目标能力").withOptions(remoteTargetOptions...).withPositionals(p(kindFree)),
			),
		),
		n("workspace", "本地工作区 Connector：只暴露显式目录，不启动模型").withChildren(
			n("connect", "连接本地目录并从远程 Server 观测").withOptions(vf("--server", "目标 Server profile", kindRemoteServer), vf("--root", "本地目录", kindFile), f("--label", ""), f("--code", ""), f("--no-reconnect", ""), f("--no-command", ""), vf("--approval", "", kindEnum, "destructive", "never", "all"), jsonFlag),
			n("ls", "列出已登记的工作区").withAliases("list").withOptions(vf("--server", "目标 Server profile", kindRemoteServer), jsonFlag),
			n("enroll", "生成一次性 enrollment code").withOptions(vf("--server", "目标 Server profile", kindRemoteServer), f("--label", ""), jsonFlag),
			n("revoke", "撤销工作区登记").withOptions(vf("--server", "目标 Server profile", kindRemoteServer)).withPositionals(p(kindRemoteWorkspace)),
			n("approvals", "审批远程命令请求").withChildren(
				n("ls", "列出待审批请求").withOptions(vf("--server", "目标 Server profile", kindRemoteServer), jsonFlag),
				n("approve", "批准一个请求").withOptions(vf("--server", "目标 Server profile", kindRemoteServer), jsonFlag).withPositionals(p(kindRemoteWorkspace), p(kindFree)),
				n("deny", "拒绝一个请求").withOptions(vf("--server", "目标 Server profile", kindRemoteServer), jsonFlag).withPositionals(p(kindRemoteWorkspace), p(kindFree)),
			),
			n("sessions", "列出工作区会话").withOptions(vf("--server", "目标 Server profile", kindRemoteServer), jsonFlag),
		),
		n("server", "管理本机 OpenAI 兼容网关").withAliases("serve", "daemon").withOptions(jsonFlag).withChildren(
			n("start", "启动（daemon 模式）").withOptions(f("--graceful", "平滑停止/重启")),
			n("restart", "重启").withOptions(f("--graceful", "平滑停止/重启")),
			n("stop", "停止").withOptions(f("--graceful", "平滑停止/重启")),
			n("status", "查看状态").withOptions(jsonFlag),
			n("serve", "前台运行"),
			n("add", "保存并选中一个远程 Server").withOptions(f("--name", ""), f("--url", ""), f("--api-key", ""), f("--management-key", ""), jsonFlag),
			n("ls", "列出已保存的 Server").withAliases("list").withOptions(jsonFlag),
			n("use", "切换当前 Server").withPositionals(p(kindFree)),
			n("remove", "移除已保存的 Server").withAliases("rm").withPositionals(p(kindFree)),
			n("config", "查看/设置服务端配置").withOptions(serverConfigOptionSpecs()...).withAlwaysOptions().withChildren(
				n("show", "显示配置").withOptions(f("--show-secrets", ""), f("--one-line", ""), f("--qr", ""), f("--qr-url", ""), jsonFlag),
				n("get", "读取单个配置项").withOptions(f("--show-secrets", ""), jsonFlag),
				n("set", "设置配置项"),
				n("unset", "清除配置项").withPositionals(p(kindFree)),
				n("list", "列出配置项").withOptions(jsonFlag),
			),
			n("autostart", "开机自启").withChildren(n("install", "安装自启"), n("uninstall", "移除自启").withAliases("remove"), n("status", "查看自启状态")),
			n("env", "打印可用的网关环境变量"),
			n("sync-codex", "同步 Codex 账号到远端 Server").withAliases("sync_codex"),
		),
		n("desktop", "桌面端版本总览（canonical / 影子 / 运行中）").withOptions(jsonFlag).withChildren(n("status", "canonical 版本、影子副本、运行中实例与漂移").withOptions(jsonFlag)),
		n("edge", "本机入口转发（nginx / caddy / frpc）").withOptions(f("--dry-run", "只打印将要做的改动"), jsonFlag).withChildren(
			n("status", "当前入口与转发状态").withChildren(n("frpc", "frpc 入口").withOptions(jsonFlag), n("nginx", "nginx 入口").withOptions(jsonFlag), n("caddy", "caddy 入口").withOptions(jsonFlag)),
			n("plan", "只打印将要写入的配置").withChildren(n("frpc", "frpc 入口").withOptions(f("--dry-run", ""), jsonFlag), n("nginx", "nginx 入口").withOptions(f("--dry-run", ""), jsonFlag), n("caddy", "caddy 入口").withOptions(f("--dry-run", ""), jsonFlag)),
			n("apply", "写入配置并校验/重载").withChildren(n("frpc", "frpc 入口").withOptions(f("--dry-run", ""), f("--no-reload", ""), jsonFlag), n("nginx", "nginx 入口").withOptions(f("--dry-run", ""), f("--no-reload", ""), jsonFlag), n("caddy", "caddy 入口").withOptions(f("--dry-run", ""), f("--no-reload", ""), jsonFlag)),
			n("remove", "移除受管条目").withChildren(n("frpc", "frpc 入口").withOptions(f("--name", ""), f("--dry-run", ""), jsonFlag)),
		),
		n("claim", "领取账号福利 / 活动（签到）").withOptions(claimOptions...).withChildren(
			n("qoder", "Qoder 每日签到").plusOptions(claimOptions...),
			n("qodercn", "Qoder 国内站每日签到").plusOptions(claimOptions...),
			n("zcode", "ZCode 活动领取").plusOptions(claimOptions...),
			n("all", "全部可领取项（默认）").plusOptions(claimOptions...),
		),
		n("harness", "用某个 Provider 的某个账号跑外部 harness（经本地网关 relay）").withChildren(buildHarnessNodes()...).withOptions(vf("--provider", "指定 Provider", kindProvider), vf("--account", "账号编号或 accountRef", kindAccount), vf("--model", "模型", kindModel), vf("--model-alias", "临时转发", kindAlias), jsonFlag, f("--list", "只列出 harness")),
		n("shell", "终端集成：补全、拼写纠正、rc 片段管理").withOptions(vf("--shell", "目标 shell", kindShell), f("--rc-file", "写入哪个 shell rc 文件"), f("--all", "对所有已安装 shell 执行"), f("--completion", "开启 TAB 补全"), f("--typo", "开启纠错建议"), f("--wrapper", "开启 aih 包装函数"), f("--no-typo", "不安装拼写纠正"), f("--no-completion", "不安装 TAB 补全"), f("--no-wrapper", "不安装包装函数"), f("--dry-run", "只打印将要做的改动"), jsonFlag).withChildren(
			n("status", "当前 shell 集成状态").withOptions(jsonFlag),
			n("plan", "打印将要写入 rc 的片段（不写文件）").withOptions(vf("--shell", "目标 shell", kindShell), f("--rc-file", ""), jsonFlag),
			n("apply", "写入 shell 集成（带备份）").withOptions(vf("--shell", "目标 shell", kindShell), f("--rc-file", ""), f("--all", ""), f("--completion", ""), f("--typo", ""), f("--wrapper", ""), f("--no-typo", ""), f("--no-completion", ""), f("--no-wrapper", ""), f("--dry-run", ""), jsonFlag),
			n("remove", "移除 aih 写入的片段").withOptions(vf("--shell", "目标 shell", kindShell), f("--rc-file", ""), f("--all", ""), f("--dry-run", ""), jsonFlag),
			n("snippet", "只打印片段（可 eval）").withOptions(vf("--shell", "目标 shell", kindShell), f("--rc-file", ""), jsonFlag),
			n("doctor", "检查实际安装、语法与补全入口").withOptions(vf("--shell", "目标 shell", kindShell), jsonFlag),
			n("typo", "查看/遗忘已学习的拼写纠正").withChildren(n("list", "列出已学习纠正"), n("forget", "遗忘一条纠正").withPositionals(p(kindFree))),
		),
		n("agent", "TUI harness 的会话适配层：用哪个 adapter、三种交互从哪来").withOptions(jsonFlag).withChildren(
			n("adapters", "每个 harness 的 adapter 候选与实现状态").withOptions(jsonFlag),
			n("capabilities", "某 harness 的审批/提问/计划确认支持级别").withOptions(jsonFlag).withPositionals(p(kindProvider)),
			n("probe", "现在实际会选中哪个 adapter").withOptions(jsonFlag).withPositionals(p(kindProvider)),
		),
		n("peer", "给另一个正在跑的会话发消息 / 看收件箱（协议 / 注入 / chat 总线）").withOptions(peerOptions...).withChildren(
			n("list", "列出可发消息的会话").withAliases("ls").plusOptions(peerOptions...),
			n("send", "发一条消息：send <名字|id> \"<正文>\"").withPositionals(p(kindPeerTarget), p(kindFree)).plusOptions(peerOptions...),
			n("inbox", "看收件箱：inbox [--target <名字>] [--self]").plusOptions(peerOptions...),
			n("read", "看一条消息全文：read <msg-id>").withPositionals(p(kindPeerMessage)).plusOptions(peerOptions...),
			n("reply", "回给原发送方：reply <msg-id> \"<正文>\"").withPositionals(p(kindPeerMessage), p(kindFree)).plusOptions(peerOptions...),
			n("flush", "手动补投一轮待投递消息").plusOptions(peerOptions...),
			n("channels", "每条通道怎么投递").plusOptions(peerOptions...),
		),
		n("export", "导出账号（aih 原生 JSON，含明文凭据）").withPositionals(p(kindFile), pr(kindFile)),
		n("import", "导入 aih 账号文件").withOptions(f("--dry-run", "只打印将要做的改动")).withPositionals(pr(kindFile)),
		n("clip", "跨设备剪贴板历史、终端选择器、采集与 Vim 粘贴").withChildren(
			n("ls", "列出最近的剪贴板历史").withAliases("list").withOptions(
				f("--limit", "最多返回多少条"),
				vf("--kind", "按内容类型过滤", kindEnum, "text", "link", "image", "file"),
				jsonFlag,
			),
			n("show", "查看单条剪贴板详情").withOptions(jsonFlag, f("--raw", "输出原始字节")).withPositionals(p(kindClipboardItem)),
			n("paste", "输出剪贴板原始内容到标准输出（默认最新一条）").withOptions(f("--stdout", "输出到标准输出"), jsonFlag).withPositionals(p(kindClipboardItem)),
			n("copy", "将历史条目写回本机系统剪贴板").withPositionals(p(kindClipboardItem)),
			n("pin", "置顶或取消置顶条目").withOptions(f("--off", "取消置顶")).withPositionals(p(kindClipboardItem)),
			n("rm", "软删除一条或多条历史").withAliases("remove", "delete").withPositionals(pr(kindClipboardItem)),
			n("clear", "清空剪贴板历史（默认保留置顶）").withOptions(f("--yes", "确认清空"), f("--all", "连同置顶条目一并清空")),
			n("status", "查看本机剪贴板采集、同步与设备状态").withOptions(jsonFlag),
			n("pick", "打开终端交互选择器").withOptions(
				vf("--kind", "按内容类型过滤", kindEnum, "text", "link", "image", "file"),
				f("--query", "初始搜索词"),
				f("--limit", "最多加载条数"),
				f("--stdout", "选中后将内容输出到标准输出"),
			),
			n("ui", "pick 的别名：打开终端交互选择器").withOptions(
				vf("--kind", "按内容类型过滤", kindEnum, "text", "link", "image", "file"),
				f("--query", "初始搜索词"),
				f("--limit", "最多加载条数"),
				f("--stdout", "选中后将内容输出到标准输出"),
			),
			n("enable", "启用本机剪贴板采集"),
			n("disable", "停用本机剪贴板采集"),
			n("sync", "与远端 Server 加密同步剪贴板").withOptions(
				f("--once", "只同步一次（默认）"),
				f("--watch", "持续循环同步"),
				vf("--server", "目标 Server profile", kindRemoteServer),
			),
			n("vim", "安装或打印 Vim 粘贴插件").withChildren(
				n("install", "幂等写入 ~/.vim/plugin/aih_clipboard.vim"),
				n("print", "打印 Vim 插件脚本"),
			),
		),
		n("backup", "导出 / 导入 / 远程自动备份").withOptions(f("--name", "目标名称"), f("--port", "SSH 端口"), f("--key", "SSH 私钥"), f("--remote-dir", "远端目录"), f("--password-env", "密码环境变量"), f("--strategy", "备份策略"), f("--interval", "备份间隔"), f("--debounce", "防抖秒数"), vf("--enabled", "是否启用", kindEnum, "on", "off"), f("--full", "全量备份"), f("--dry-run", "只打印将要做的改动"), f("--remote", "读取远端清单"), jsonFlag).withChildren(
			n("add", "添加 SSH 备份目标").withOptions(f("--name", ""), f("--port", ""), f("--key", ""), f("--remote-dir", ""), f("--password-env", ""), f("--strategy", "")).withPositionals(p(kindFree)),
			n("list", "列出目标与最近结果").withAliases("ls"),
			n("remove", "删除目标").withAliases("rm").withPositionals(p(kindFree)),
			n("enable", "启用目标").withPositionals(p(kindFree)),
			n("disable", "暂停目标").withPositionals(p(kindFree)),
			n("run", "立即备份（默认增量）").withOptions(f("--full", ""), f("--dry-run", "")).withPositionals(pr(kindFree)),
			n("status", "查看本地状态 / 远端清单").withOptions(f("--remote", ""), jsonFlag),
			n("test", "测试 SSH 连接").withPositionals(p(kindFree)),
			n("restore", "从远端恢复账号").withOptions(f("--dry-run", "")).withPositionals(p(kindFree)),
			n("recover", "从本地快照恢复").withOptions(f("--dry-run", ""), f("--confirm-stopped", "")).withPositionals(p(kindFree)),
			n("config", "修改自动备份参数").withOptions(f("--interval", ""), f("--debounce", ""), vf("--enabled", "", kindEnum, "on", "off")),
			n("show", "打印配置与状态"),
		),
		n("provider", "Provider 目录、资源边界与诊断").withOptions(mf("--scope", "按 provider 过滤"), jsonFlag).withChildren(
			n("ls", "列出 provider 与各自的账号数（支持通配）").withOptions(mf("--scope", "按 provider 过滤"), jsonFlag),
			n("capabilities", "列出各 provider 的资源边界").withOptions(jsonFlag),
			n("doctor", "本机可用性与受管资源状态").withOptions(jsonFlag),
			n("models", "查看某个 Provider 的账号模型目录").withOptions(jsonFlag).withPositionals(p(kindProvider), p(kindAccountTarget)),
		),
		n("native", "原生宿主投影（plugin）").withChildren(n("plugin", "Codex/Claude/OpenCode 原生插件投影").withChildren(
			n("list", "列出原生插件"),
			n("install", "安装投影"),
			n("enable", "启用"),
			n("disable", "停用"),
			n("remove", "移除"),
			n("inspect", "查看详情"),
			n("project", "重新投影"),
			n("doctor", "检查一致性"),
		).withOptions(vf("--provider", "指定 Provider", kindProvider), jsonFlag)),
		n("mcp", "管理并测试原生 MCP 投影").withOptions(mcpOptions...).withChildren(
			n("list", "列出已登记 MCP").plusOptions(mcpOptions...),
			n("add", "登记一个 stdio MCP").withPositionals(p(kindFree), p(kindFree)).plusOptions(mcpOptions...),
			n("test", "运行并握手测试").withPositionals(p(kindFree)).plusOptions(mcpOptions...),
			n("tools", "列出工具").withPositionals(p(kindFree)).plusOptions(mcpOptions...),
			n("call", "调用一个工具").withPositionals(p(kindFree), p(kindFree), pr(kindFree)).plusOptions(mcpOptions...),
			n("enable", "写入原生配置").withPositionals(p(kindFree)).plusOptions(mcpOptions...),
			n("disable", "停用原生投影").withPositionals(p(kindFree)).plusOptions(mcpOptions...),
			n("remove", "移除登记").withPositionals(p(kindFree)).plusOptions(mcpOptions...),
			n("doctor", "检查投影一致性").plusOptions(mcpOptions...),
		),
		n("skill", "管理原生 skill 与指令投影").withOptions(skillOptions...).withChildren(
			n("list", "列出 skill").plusOptions(skillOptions...),
			n("install", "安装并启用").withPositionals(p(kindFree)).plusOptions(skillOptions...),
			n("enable", "启用").withPositionals(p(kindFree)).plusOptions(skillOptions...),
			n("disable", "停用").withPositionals(p(kindFree)).plusOptions(skillOptions...),
			n("remove", "移除").withPositionals(p(kindFree)).plusOptions(skillOptions...),
			n("doctor", "检查投影一致性").plusOptions(skillOptions...),
		),
		n("plugin", "AIH 插件包与实例").withOptions(pluginOptions...).withChildren(
			n("validate", "校验插件包").withPositionals(p(kindFile)).plusOptions(pluginOptions...),
			n("pack", "打包成离线插件包").withPositionals(p(kindFile)).plusOptions(pluginOptions...),
			n("keygen", "生成发布密钥对").plusOptions(pluginOptions...),
			n("trust", "把发布公钥加入本机信任根").withOptions(f("--trust-key", "")).plusOptions(pluginOptions...),
			n("untrust", "移除发布公钥").withPositionals(p(kindFree)).plusOptions(pluginOptions...),
			n("trusted", "列出信任的发布公钥").plusOptions(pluginOptions...),
			n("install", "安装插件包").withOptions(f("--trust-key", ""), f("--require-signed", "")).withPositionals(p(kindFile)).plusOptions(pluginOptions...),
			n("list", "已安装插件与实例").withAliases("status").plusOptions(pluginOptions...),
			n("enable", "启用实例").withPositionals(p(kindFree)).plusOptions(pluginOptions...),
			n("disable", "停用实例").withPositionals(p(kindFree)).plusOptions(pluginOptions...),
			n("uninstall", "卸载插件").withPositionals(p(kindFree)).plusOptions(pluginOptions...),
			n("call", "调试调用一个贡献项").withOptions(f("--args-json", "")).withPositionals(p(kindFree), p(kindFree)).plusOptions(pluginOptions...),
			n("doctor", "检查制品/签名/权限").plusOptions(pluginOptions...),
		),
		n("ssh", "非零客户端 SSH 图片粘贴包装").withPositionals(pr(kindFree)),
		n("ssh-clipboard", "严格零客户端终端图片剪贴板探针").withOptions(jsonFlag, f("--paste-event", "用真实粘贴事件测试"), f("--timeout-ms", "超时毫秒数")).withChildren(n("probe", "诊断真实粘贴路径").withOptions(jsonFlag, f("--paste-event", ""), f("--timeout-ms", ""))),
		n("clip-agent", "SSH RemoteForward 剪贴板图片提供方").withChildren(n("start", "启动本机剪贴板代理")),
		n("help", "打印用法").withAliases("--help", "-h").withPositionals(p(kindProvider)),
	}
}

func buildHarnessNodes() []commandNode {
	items := harnessSubcommands()
	nodes := make([]commandNode, 0, len(items))
	harnessOptions := []optionSpec{
		vf("--provider", "指定 Provider", kindProvider),
		vf("--account", "账号编号或 accountRef", kindAccount),
		vf("--model", "模型", kindModel),
		vf("--model-alias", "临时转发", kindAlias),
		jsonFlagOnly(),
		f("--list", "只列出 harness"),
	}
	for _, item := range items {
		nodes = append(nodes, n(item.Name, item.Summary).withOptions(harnessOptions...).withChildren(
			n("models", "只读 harness 可选模型").withOptions(
				vf("--provider", "指定 Provider", kindProvider),
				vf("--account", "账号", kindAccount),
				jsonFlagOnly(),
			),
		))
	}
	return nodes
}

func jsonFlagOnly() optionSpec {
	return f("--json", "以 JSON 输出")
}
