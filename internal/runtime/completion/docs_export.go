package completion

// 本文件把补全命令树导出成稳定的文档条目，供 `aih man` 页面渲染。
// 页面只消费这里的数据：命令面变化时页面自动跟随，不维护第二份清单。

// DocEntry 是手册页的一行：分组 + 命令路径 + 说明 + 可选旗标/别名。
type DocEntry struct {
	Group       string   `json:"group"`
	Path        string   `json:"path"`
	Description string   `json:"description"`
	Usage       string   `json:"usage,omitempty"`
	Example     string   `json:"example,omitempty"`
	Flags       []string `json:"flags,omitempty"`
	Alias       []string `json:"alias,omitempty"`
}

// DocumentationEntries 返回完整命令文档条目（命令树 + Provider 动作 + 启动语法）。
func DocumentationEntries() []DocEntry {
	entries := make([]DocEntry, 0, 256)
	for index := range topLevelCommands {
		command := &topLevelCommands[index]
		entries = append(entries, docEntryForNode("顶层命令", "", command))
		appendChildDocEntries(&entries, "aih "+command.Name, command)
	}
	for _, provider := range allProviderNames() {
		entries = append(entries, DocEntry{
			Group:       "Provider",
			Path:        "aih " + provider,
			Description: describeProvider(provider),
		})
		// 每个 Provider 单独成组：21 个 Provider 动作放同一节会变成 280 张卡的墙。
		actionGroup := "Provider · " + provider
		for _, action := range listProviderActions(provider) {
			entry := DocEntry{
				Group:       actionGroup,
				Path:        "aih " + provider + " " + action.Name,
				Description: action.Summary,
				Flags:       listProviderActionFlags(action.Name),
			}
			if sample, ok := docExamples[entry.Path]; ok {
				entry.Usage, entry.Example = sample.Usage, sample.Example
			}
			entries = append(entries, entry)
		}
	}
	entries = append(entries, launchGrammarDocEntries()...)
	return entries
}

func docEntryForNode(group, parentPath string, node *commandNode) DocEntry {
	path := "aih " + node.Name
	if parentPath != "" {
		path = parentPath + " " + node.Name
	}
	entry := DocEntry{Group: group, Path: path, Description: node.Summary}
	if sample, ok := docExamples[path]; ok {
		entry.Usage, entry.Example = sample.Usage, sample.Example
	}
	for _, option := range node.Options {
		entry.Flags = append(entry.Flags, option.Name)
	}
	for _, alias := range node.Aliases {
		if parentPath == "" {
			entry.Alias = append(entry.Alias, "aih "+alias)
			continue
		}
		entry.Alias = append(entry.Alias, parentPath+" "+alias)
	}
	return entry
}

func appendChildDocEntries(entries *[]DocEntry, parentPath string, node *commandNode) {
	for index := range node.Children {
		child := &node.Children[index]
		*entries = append(*entries, docEntryForNode(parentPath, parentPath, child))
		appendChildDocEntries(entries, parentPath+" "+child.Name, child)
	}
}

// launchGrammarDocEntries 描述不在命令树里的启动位语法（Provider 裸启动/relay/跨 Provider）。
func launchGrammarDocEntries() []DocEntry {
	return []DocEntry{
		{Group: "启动语法", Path: "aih <provider>", Description: "裸启动：按健康度自动选号（Native Direct）", Usage: "aih codex", Example: "aih codex"},
		{Group: "启动语法", Path: "aih <provider> <cliID> [原生参数...]", Description: "指定账号启动（伪 HOME 投影）"},
		{Group: "启动语法", Path: "aih <provider> relay [<cliID>] [原生参数...]", Description: "网关档：经 AIH Server，固定账号不换号"},
		{Group: "启动语法", Path: "aih <client> relay <provider> <cliID> [原生参数...]", Description: "跨 Provider：Codex/Claude 客户端跑别的 Provider 账号"},
		{Group: "启动语法", Path: "aih <cliID> [原生参数...]", Description: "裸数字：编号只在一个 Provider 内唯一时才解释"},
		{Group: "启动语法", Path: "aih <provider> -m|--model {ModelID}", Description: "指定本次会话模型（TAB 按账号模型目录补全）"},
		{Group: "启动语法", Path: "aih <provider> --model-alias {AliasID}", Description: "临时转发：请求 A 实际用 B（不落库）"},
		{Group: "启动语法", Path: "aih <provider> -- {原生参数...}", Description: "逃生门：之后的参数原样交给原生 CLI"},
	}
}

// docExample 是一条命令的手写用法与示例；页面只展示这里登记的内容。
type docExample struct {
	Usage   string
	Example string
}

// docExamples 覆盖高频命令；未登记的命令不编造示例。
var docExamples = map[string]docExample{
	"aih ls": {
		Usage:   "aih ls [provider] [account] [--scope <glob>] [--json]",
		Example: "aih ls codex",
	},
	"aih resume": {
		Usage:   "aih resume [sessionID] [--provider <p>] [--account <id>]",
		Example: "aih resume --provider claude",
	},
	"aih ss": {
		Usage:   "aih ss [name] [--list|--detail] [--all-projects]",
		Example: "aih ss --detail",
	},
	"aih usage stats": {
		Usage:   "aih usage stats [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--provider <p>]",
		Example: "aih usage stats --from 2026-11-01 --json",
	},
	"aih usage models": {
		Usage:   "aih usage models [--provider <p>] [--model <m>]",
		Example: "aih usage models --provider codex",
	},
	"aih summary": {
		Usage:   "aih summary [--from <date>] [--to <date>] [--json]",
		Example: "aih summary --no-scan",
	},
	"aih man": {
		Usage:   "aih man [aih] [--out <file>] [--no-open] [--json]",
		Example: "aih man",
	},
	"aih install": {
		Usage:   "aih install [--no-service] [--json]",
		Example: "aih install --no-service",
	},
	"aih account show": {
		Usage:   "aih account show <account_ref|provider:id>",
		Example: "aih account show codex:41",
	},
	"aih account add": {
		Usage:   "aih account add <provider> --from-env",
		Example: "OPENAI_API_KEY=... aih account add codex --from-env",
	},
	"aih account models refresh": {
		Usage:   "aih account models refresh <account_ref|provider:id>",
		Example: "aih account models refresh claude:20",
	},
	"aih account default set": {
		Usage:   "aih account default set <provider> <account_ref|provider:id>",
		Example: "aih account default set codex codex:41",
	},
	"aih limits show": {
		Usage:   "aih limits show [--json]",
		Example: "aih limits show",
	},
	"aih limits set-global": {
		Usage:   "aih limits set-global --system-max <n> --queue-limit <n>",
		Example: "aih limits set-global --system-max 8 --queue-limit 32",
	},
	"aih failure-policy explain": {
		Usage:   "aih failure-policy explain <provider> <status|*>",
		Example: "aih failure-policy explain codex 429",
	},
	"aih failure-policy set": {
		Usage:   "aih failure-policy set <provider> <status> --semantic <s>",
		Example: "aih failure-policy set claude 401 --semantic credential_rejected",
	},
	"aih client-keys create": {
		Usage:   "aih client-keys create --name <name> [--rpm <n>] [--tpm <n>]",
		Example: "aih client-keys create --name laptop --rpm 60",
	},
	"aih client-keys stats": {
		Usage:   "aih client-keys stats [--key <id>] [--granularity minute|hour]",
		Example: "aih client-keys stats --granularity hour",
	},
	"aih proxy serve": {
		Usage:   "aih proxy serve [--selector auto|pool|ssh:<id>] [--no-socks]",
		Example: "aih proxy serve --selector auto",
	},
	"aih remote target resolve": {
		Usage:   "aih remote target resolve [--server <profile>] [--harness <id>]",
		Example: "aih remote target resolve --server aws",
	},
	"aih workspace connect": {
		Usage:   "aih workspace connect --server <profile> --root <dir>",
		Example: "aih workspace connect --server aws --root .",
	},
	"aih server start": {
		Usage:   "aih server start [--graceful]",
		Example: "aih server start",
	},
	"aih server status": {
		Usage:   "aih server status [--json]",
		Example: "aih server status --json",
	},
	"aih server add": {
		Usage:   "aih server add --name <name> --url <url>",
		Example: "aih server add --name aws --url https://proxy.example.com",
	},
	"aih server config set": {
		Usage:   "aih server config set --port <n> --host <addr>",
		Example: "aih server config set --port 9527",
	},
	"aih desktop status": {
		Usage:   "aih desktop status [--json]",
		Example: "aih desktop status",
	},
	"aih edge apply nginx": {
		Usage:   "aih edge apply nginx [--dry-run] [--no-reload]",
		Example: "aih edge apply nginx --dry-run",
	},
	"aih claim all": {
		Usage:   "aih claim all [--dry-run]",
		Example: "aih claim all --dry-run",
	},
	"aih harness pi models": {
		Usage:   "aih harness pi models [--provider <p>] [--account <id>]",
		Example: "aih harness pi models --provider codex",
	},
	"aih shell apply": {
		Usage:   "aih shell apply [--shell zsh] [--completion --typo --wrapper]",
		Example: "aih shell apply --shell zsh",
	},
	"aih shell doctor": {
		Usage:   "aih shell doctor [--shell zsh] [--json]",
		Example: "aih shell doctor --shell zsh",
	},
	"aih peer send": {
		Usage:   "aih peer send <target> \"<正文>\" [--channel native]",
		Example: "aih peer send build \"部署完成\"",
	},
	"aih peer inbox": {
		Usage:   "aih peer inbox [--self] [--unread]",
		Example: "aih peer inbox --unread",
	},
	"aih clip pick": {
		Usage:   "aih clip pick [--kind image] [--stdout]",
		Example: "aih clip pick --kind image --stdout",
	},
	"aih clip sync": {
		Usage:   "aih clip sync [--once|--watch] [--server <profile>]",
		Example: "aih clip sync --once",
	},
	"aih backup add": {
		Usage:   "aih backup add user@host [--port 22] [--key <file>]",
		Example: "aih backup add deploy@example.com --remote-dir /backups",
	},
	"aih backup run": {
		Usage:   "aih backup run [target] [--full]",
		Example: "aih backup run --full",
	},
	"aih provider models": {
		Usage:   "aih provider models <provider> [account]",
		Example: "aih provider models codex 41",
	},
	"aih native plugin enable": {
		Usage:   "aih native plugin enable <pluginId> [--provider <p>|--host <h>]",
		Example: "aih native plugin enable aih-dsh-gateway --host deepseek",
	},
	"aih native plugin list": {
		Usage:   "aih native plugin list [--json]",
		Example: "aih native plugin list --json",
	},
	"aih mcp add": {
		Usage:   "aih mcp add <name> \"<command> [args...]\" [--provider <p>]",
		Example: "aih mcp add demo \"npx -y demo-mcp\" --provider codex",
	},
	"aih mcp test": {
		Usage:   "aih mcp test <name> [--provider <p>]",
		Example: "aih mcp test demo --provider codex",
	},
	"aih skill install": {
		Usage:   "aih skill install <skillDir> [--provider <p>|--all-supported]",
		Example: "aih skill install ./skills/review --all-supported",
	},
	"aih plugin validate": {
		Usage:   "aih plugin validate <file> [--json]",
		Example: "aih plugin validate ./plugin.json",
	},
	"aih plugin install": {
		Usage:   "aih plugin install <file> [--trust-key <key>] [--require-signed]",
		Example: "aih plugin install ./plugin.zip",
	},
	"aih provider doctor": {
		Usage:   "aih provider doctor [--json]",
		Example: "aih provider doctor",
	},
	"aih codex": {
		Usage:   "aih codex [<cliID>] [--model <model>] [原生参数...]",
		Example: "aih codex --model gpt-6.2-sol",
	},
	"aih codex relay": {
		Usage:   "aih codex relay [<provider>] <cliID> [--model <model>]",
		Example: "aih codex relay 41 --model gpt-6.2-sol",
	},
	"aih claude relay": {
		Usage:   "aih claude relay [<provider>] <cliID> [--model <model>]",
		Example: "aih claude relay 20 --model claude-opus-5-5-high",
	},
	"aih codex model": {
		Usage:   "aih codex model [show|<model>]",
		Example: "aih codex model gpt-6.2-sol",
	},
	"aih codex effort": {
		Usage:   "aih codex effort [show|low|medium|high|xhigh|max|fast on|off]",
		Example: "aih codex effort high",
	},
	"aih codex policy": {
		Usage:   "aih codex policy [show|set <sandbox>]",
		Example: "aih codex policy set workspace-write",
	},
	"aih agy session": {
		Usage:   "aih agy session <open|ls|show|say|tail|resume|close> [args]",
		Example: "aih agy session open \"检查日志\" --model gemini-4-neon-xhigh",
	},
	"aih <provider> relay [<cliID>] [原生参数...]": {
		Usage:   "aih <provider> relay [<cliID>] [--model <model>]",
		Example: "aih codex relay 41 --model gpt-6.2-sol",
	},
}

// docGroupNotes 是页面每个分组的解读；没登记的分组不显示解读。
var docGroupNotes = map[string]string{
	"顶层命令":              "日常入口：看账号、续会话、查用量、装服务。先从这里建立全局地图，再进子命令。",
	"启动语法":              "三种启动形态共用一套账号与模型解析：裸启动自动选号，relay 固定账号且不换号，-- 之后完全交给原生 CLI。",
	"Provider":          "Provider 是实际承载会话的原生 CLI；括号里的动作由合同决定，不是所有 Provider 都支持 resume/fork/relay。",
	"Provider 动作":       "同一组动作用在不同 Provider 上语义一致：ls 看号、usage 看额度、relay 走网关。TAB 会按当前 Provider 过滤可用动作。",
	"aih usage":         "用量是本地扫描 + 账本聚合的结果；scan 负责补历史，recalculate-costs 只重算成本，不改原始 token。",
	"aih account":       "账号管理走目标 Server 的管理面；本机 CLI 只负责把请求送到 AIH_SERVER_BASE_URL。",
	"aih server":        "server 既是本机网关，也是远程 Server 的连接档案：start/stop 管进程，add/use 管连接，config 管监听与密钥。",
	"aih proxy":         "proxy 把远端出口租约变成本机入口；默认只监听 loopback，--system 才动系统代理。",
	"aih remote":        "remote 只做目标解析与预检，不执行命令；执行能力由 workspace connector 提供。",
	"aih workspace":     "workspace 只暴露显式目录；审批与命令通道是两条独立路径，不要把目录可见当成执行成功。",
	"aih clip":          "剪贴板是跨设备总线：pick 负责选，sync 负责传，vim 负责在远端粘贴。图片走原始字节，不走文本转义。",
	"aih backup":        "备份目标是 SSH 主机；run 增量、restore 回滚账号、recover 用本地快照兜底。",
	"aih peer":          "peer 在会话之间投递消息；native 有投递语义，inject 等价用户手打，webui-chat 走聊天总线。",
	"aih mcp":           "MCP 是宿主配置投影：add 登记、test 握手、enable 写配置；投影失败不会偷偷改宿主文件。",
	"aih skill":         "skill 是原生指令包：install 安装并启用，enable/disable 只切投影状态。",
	"aih plugin":        "plugin 是 AIH 自己的插件包体系：validate/pack 在本地，install 需要信任根，call 用于调试贡献项。",
	"aih native plugin": "native plugin 是 Codex/Claude/OpenCode 的宿主投影；enable/disable/remove 只认本机已登记的 pluginId。",
	"aih edge":          "edge 负责本机入口转发；plan 只打印，apply 才写配置并 reload。",
	"aih shell":         "shell 集成负责 TAB、纠错与包装函数；apply 会备份 rc，doctor 检查真实安装与语法。",
	"aih agent":         "agent 描述 TUI harness 的交互适配：审批、提问、计划确认各自支持到什么级别。",
	"aih harness":       "harness 用某个 Provider 的账号跑外部 TUI；模型目录来自该账号，不来自 harness 自己。",
	"aih claim":         "claim 是活动领取入口；--dry-run 只预览，不写账本。",
}

// DocumentationGroupNotes 返回页面分组的解读文案。
func DocumentationGroupNotes() map[string]string {
	notes := make(map[string]string, len(docGroupNotes)*2)
	for group, note := range docGroupNotes {
		notes[group] = note
	}
	// Provider 动作按 Provider 拆组后，共用同一条解读。
	if note, ok := docGroupNotes["Provider 动作"]; ok {
		for _, provider := range allProviderNames() {
			notes["Provider · "+provider] = note
		}
	}
	return notes
}

// RootHelpEntry 是 aih help 的一行：一级命令或 Provider。
type RootHelpEntry struct {
	Name     string
	Summary  string
	Aliases  []string
	Provider bool
}

// RootHelpEntries 返回一级命令（含别名）与全部 Provider，供 aih help 打印基础命令树。
func RootHelpEntries() []RootHelpEntry {
	entries := make([]RootHelpEntry, 0, len(topLevelCommands)+len(allProviderNames()))
	for index := range topLevelCommands {
		command := &topLevelCommands[index]
		entries = append(entries, RootHelpEntry{
			Name:    command.Name,
			Summary: command.Summary,
			Aliases: append([]string(nil), command.Aliases...),
		})
	}
	for _, provider := range allProviderNames() {
		entries = append(entries, RootHelpEntry{
			Name:     provider,
			Summary:  describeProvider(provider),
			Provider: true,
		})
	}
	return entries
}
