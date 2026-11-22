package completion

import (
	"strings"

	"github.com/madou1217/ai_home/core/harnesses"
)

// namedSummary 是「名字 + 一句话说明」的通用命令面条目。
type namedSummary struct {
	Name    string
	Summary string
}

// commandSpec 是 aih 自身命令面的声明式描述。
type commandSpec struct {
	Name        string
	Aliases     []string
	Summary     string
	Subcommands []namedSummary
	Flags       []string
}

func harnessSubcommands() []namedSummary {
	items := harnesses.List()
	result := make([]namedSummary, 0, len(items))
	for _, item := range items {
		summary := strings.TrimSpace(item.Label)
		if summary == "" {
			summary = strings.TrimSpace(item.Description)
		}
		result = append(result, namedSummary{Name: item.ID, Summary: summary})
	}
	return result
}

var coreCommands = []commandSpec{
	{
		Name:    "ls",
		Aliases: []string{"list"},
		Summary: "列出所有工具、账号与状态（provider 位支持通配，也可 --scope）",
		Flags:   []string{"--scope", "--help"},
	},
	{
		Name:    "resume",
		Summary: "跨 provider 选择一段会话并续聊（不记得 id 时用这个）",
		Flags:   []string{"--provider", "--account", "--limit", "--json", "--help"},
	},
	{
		Name:    "ss",
		Aliases: []string{"sessions"},
		Summary: "选择并进入一个活跃的持久会话",
		Subcommands: []namedSummary{
			{Name: "--list", Summary: "按项目预览所有活跃会话"},
			{Name: "--detail", Summary: "列出活跃会话的完整状态"},
		},
	},
	{
		Name:    "usage",
		Summary: "按 provider / 模型统计 token 与成本",
		Subcommands: []namedSummary{
			{Name: "stats", Summary: "总览"},
			{Name: "models", Summary: "按模型汇总"},
			{Name: "sessions", Summary: "按会话汇总"},
			{Name: "session-detail", Summary: "单个会话明细"},
			{Name: "scan", Summary: "重新扫描历史记录"},
			{Name: "recalculate-costs", Summary: "用当前定价重算历史成本"},
		},
		Flags: []string{"--from", "--to", "--provider", "--model", "--session-id", "--no-scan", "--json", "--reindex-codex-forks"},
	},
	{
		Name:    "update",
		Summary: "检查更新或通过 npm 更新 ai-home",
		Flags:   []string{"--check", "--dry-run", "--force"},
	},
}

var remoteCommands = []commandSpec{
	{
		Name:    "remote",
		Summary: "远程执行目标、Server/Workspace/Harness/Model 选择与预检",
		Subcommands: []namedSummary{
			{Name: "target", Summary: "解析远程执行目标"},
		},
		Flags: []string{"--json", "--help"},
	},
}

var serverNodeCommands = []commandSpec{
	{
		Name:    "server",
		Aliases: []string{"serve", "daemon"},
		Summary: "管理本机 OpenAI 兼容网关",
		Subcommands: []namedSummary{
			{Name: "start", Summary: "启动（daemon 模式）"},
			{Name: "restart", Summary: "重启"},
			{Name: "stop", Summary: "停止"},
			{Name: "status", Summary: "查看状态"},
			{Name: "serve", Summary: "前台运行"},
			{Name: "add", Summary: "保存并选中一个远程 Server"},
			{Name: "ls", Summary: "列出已保存的 Server"},
			{Name: "use", Summary: "切换当前 Server"},
			{Name: "remove", Summary: "移除已保存的 Server"},
			{Name: "config", Summary: "查看/设置服务端配置"},
			{Name: "autostart", Summary: "开机自启 install|uninstall|status"},
			{Name: "env", Summary: "打印可用的网关环境变量"},
			{Name: "sync-codex", Summary: "同步 Codex 账号到远端 Server"},
		},
		Flags: []string{"--json", "--help"},
	},
	{
		Name:    "desktop",
		Summary: "桌面端版本总览（canonical / 影子 / 运行中）",
		Subcommands: []namedSummary{
			{Name: "status", Summary: "canonical 版本、影子副本、运行中实例与漂移"},
		},
		Flags: []string{"--json", "--help"},
	},
	{
		Name:    "edge",
		Summary: "本机入口转发（nginx / caddy / frp）",
		Subcommands: []namedSummary{
			{Name: "status", Summary: "当前入口与转发状态"},
			{Name: "plan", Summary: "只打印将要写入的配置"},
			{Name: "apply", Summary: "写入配置并校验/重载"},
			{Name: "remove", Summary: "移除受管条目"},
		},
		Flags: []string{"--dry-run", "--json", "--help"},
	},
	{
		Name:    "claim",
		Summary: "领取账号福利 / 活动（签到）",
		Subcommands: []namedSummary{
			{Name: "qoder", Summary: "Qoder 每日签到"},
			{Name: "qodercn", Summary: "Qoder 国内站每日签到"},
			{Name: "zcode", Summary: "ZCode 活动领取"},
			{Name: "all", Summary: "全部可领取项（默认）"},
		},
		Flags: []string{"--dry-run", "--account", "--json", "--quiet"},
	},
}

var toolCommands = []commandSpec{
	{
		Name:        "harness",
		Summary:     "用某个 Provider 的某个账号跑外部 harness（经本地网关 relay）",
		Subcommands: harnessSubcommands(),
		Flags:       []string{"--provider", "--account", "--model", "--model-alias", "--json", "--list", "--help"},
	},
	{
		Name:    "shell",
		Summary: "终端集成：补全、拼写纠正、rc 片段管理",
		Subcommands: []namedSummary{
			{Name: "status", Summary: "当前 shell 集成状态"},
			{Name: "plan", Summary: "打印将要写入 rc 的片段（不写文件）"},
			{Name: "apply", Summary: "写入 shell 集成（带备份）"},
			{Name: "remove", Summary: "移除 aih 写入的片段"},
			{Name: "snippet", Summary: "只打印片段（可 eval）"},
			{Name: "doctor", Summary: "检查实际安装、语法与补全入口"},
			{Name: "typo", Summary: "查看/遗忘已学习的拼写纠正"},
		},
		Flags: []string{"--shell", "--rc-file", "--all", "--completion", "--typo", "--wrapper", "--no-typo", "--no-completion", "--no-wrapper", "--dry-run", "--json", "--help"},
	},
	{
		Name:    "agent",
		Summary: "TUI harness 的会话适配层：用哪个 adapter、三种交互从哪来",
		Subcommands: []namedSummary{
			{Name: "adapters", Summary: "每个 harness 的 adapter 候选与实现状态"},
			{Name: "capabilities", Summary: "某 harness 的审批/提问/计划确认支持级别"},
			{Name: "probe", Summary: "现在实际会选中哪个 adapter"},
		},
		Flags: []string{"--json", "--help"},
	},
	{
		Name:    "peer",
		Summary: "给另一个正在跑的会话发消息 / 看收件箱（协议 / 注入 / chat 总线）",
		Subcommands: []namedSummary{
			{Name: "list", Summary: "列出可发消息的会话"},
			{Name: "send", Summary: "发一条消息：send <名字|id> \"<正文>\""},
			{Name: "inbox", Summary: "看收件箱：inbox [--target <名字>] [--self]"},
			{Name: "read", Summary: "看一条消息全文：read <msg-id>"},
			{Name: "reply", Summary: "回给原发送方：reply <msg-id> \"<正文>\""},
			{Name: "flush", Summary: "手动补投一轮待投递消息"},
			{Name: "channels", Summary: "每条通道怎么投递"},
		},
		Flags: []string{
			"--provider", "--channel", "--mode", "--from", "--target", "--reply-to",
			"--self", "--unread", "--state", "--limit", "--wait", "--no-envelope",
			"--dry-run", "--json", "--help",
		},
	},
	{
		Name:    "export",
		Summary: "导出账号（aih 原生 JSON，含明文凭据）",
	},
	{
		Name:    "import",
		Summary: "导入 aih 账号文件",
		Flags:   []string{"--dry-run"},
	},
	{
		Name:    "backup",
		Summary: "导出 / 导入 / 远程自动备份",
		Subcommands: []namedSummary{
			{Name: "add", Summary: "添加 SSH 备份目标"},
			{Name: "list", Summary: "列出目标与最近结果"},
			{Name: "remove", Summary: "删除目标"},
			{Name: "enable", Summary: "启用目标"},
			{Name: "disable", Summary: "暂停目标"},
			{Name: "run", Summary: "立即备份（默认增量）"},
			{Name: "status", Summary: "查看本地状态 / 远端清单"},
			{Name: "test", Summary: "测试 SSH 连接"},
			{Name: "restore", Summary: "从远端恢复账号"},
			{Name: "config", Summary: "修改自动备份参数"},
			{Name: "show", Summary: "打印配置与状态"},
		},
		Flags: []string{
			"--name", "--port", "--key", "--remote-dir", "--password-env", "--strategy",
			"--interval", "--debounce", "--enabled", "--full", "--dry-run", "--remote", "--help",
		},
	},
	{
		Name:    "provider",
		Summary: "Provider 目录、资源边界与诊断",
		Subcommands: []namedSummary{
			{Name: "ls", Summary: "列出 provider 与各自的账号数（支持通配）"},
			{Name: "capabilities", Summary: "列出各 provider 的资源边界"},
			{Name: "doctor", Summary: "本机可用性与受管资源状态"},
		},
		Flags: []string{"--scope", "--json"},
	},
	{
		Name:    "native",
		Summary: "原生宿主投影（plugin）",
		Subcommands: []namedSummary{
			{Name: "plugin", Summary: "Codex/Claude/OpenCode 原生插件投影"},
		},
	},
	{
		Name:    "mcp",
		Summary: "管理并测试原生 MCP 投影",
		Subcommands: []namedSummary{
			{Name: "list", Summary: "列出已登记 MCP"},
			{Name: "add", Summary: "登记一个 stdio MCP"},
			{Name: "test", Summary: "运行并握手测试"},
			{Name: "tools", Summary: "列出工具"},
			{Name: "call", Summary: "调用一个工具"},
			{Name: "enable", Summary: "写入原生配置"},
			{Name: "disable", Summary: "停用原生投影"},
			{Name: "remove", Summary: "移除登记"},
			{Name: "doctor", Summary: "检查投影一致性"},
		},
		Flags: []string{"--provider", "--json"},
	},
	{
		Name:    "skill",
		Summary: "管理原生 skill 与指令投影",
		Subcommands: []namedSummary{
			{Name: "list", Summary: "列出 skill"},
			{Name: "install", Summary: "安装并启用"},
			{Name: "enable", Summary: "启用"},
			{Name: "disable", Summary: "停用"},
			{Name: "remove", Summary: "移除"},
			{Name: "doctor", Summary: "检查投影一致性"},
		},
		Flags: []string{"--provider", "--all-supported", "--json"},
	},
	{
		Name:    "plugin",
		Summary: "AIH 插件包与实例",
		Subcommands: []namedSummary{
			{Name: "validate", Summary: "校验插件包"},
			{Name: "pack", Summary: "打包成离线插件包"},
			{Name: "keygen", Summary: "生成发布密钥对"},
			{Name: "trust", Summary: "把发布公钥加入本机信任根"},
			{Name: "untrust", Summary: "移除发布公钥"},
			{Name: "trusted", Summary: "列出信任的发布公钥"},
			{Name: "install", Summary: "安装插件包"},
			{Name: "list", Summary: "已安装插件与实例"},
			{Name: "enable", Summary: "启用实例"},
			{Name: "disable", Summary: "停用实例"},
			{Name: "uninstall", Summary: "卸载插件"},
			{Name: "call", Summary: "调试调用一个贡献项"},
			{Name: "doctor", Summary: "检查制品/签名/权限"},
		},
		Flags: []string{"--json"},
	},
	{
		Name:    "ssh",
		Summary: "非零客户端 SSH 图片粘贴包装",
		Flags:   []string{"--help"},
	},
	{
		Name:    "ssh-clipboard",
		Summary: "严格零客户端终端图片剪贴板探针",
		Subcommands: []namedSummary{
			{Name: "probe", Summary: "诊断真实粘贴路径"},
		},
		Flags: []string{"--json", "--paste-event", "--timeout-ms"},
	},
	{
		Name:    "clip-agent",
		Summary: "SSH RemoteForward 剪贴板图片提供方",
		Subcommands: []namedSummary{
			{Name: "start", Summary: "启动本机剪贴板代理"},
		},
	},
	{
		Name:    "help",
		Summary: "打印用法",
		Aliases: []string{"--help", "-h"},
	},
}

// topLevelCommands 是补全/建议消费的唯一命令面声明。
var topLevelCommands = buildTopLevelCommands()

func buildTopLevelCommands() []commandSpec {
	result := make([]commandSpec, 0, len(coreCommands)+len(remoteCommands)+len(serverNodeCommands)+len(toolCommands))
	result = append(result, coreCommands...)
	result = append(result, remoteCommands...)
	result = append(result, serverNodeCommands...)
	result = append(result, toolCommands...)
	return result
}

var topLevelCommandIndex = buildTopLevelCommandIndex()

func buildTopLevelCommandIndex() map[string]int {
	index := make(map[string]int, len(topLevelCommands)*2)
	for position := range topLevelCommands {
		command := &topLevelCommands[position]
		index[command.Name] = position
		for _, alias := range command.Aliases {
			index[alias] = position
		}
	}
	return index
}

// findTopLevelCommand 返回命令（含别名）的声明；未知命令返回 false。
func findTopLevelCommand(token string) (commandSpec, bool) {
	position, found := topLevelCommandIndex[strings.ToLower(strings.TrimSpace(token))]
	if !found {
		return commandSpec{}, false
	}
	return topLevelCommands[position], true
}

func listTopLevelCommandNames() []string {
	names := make([]string, 0, len(topLevelCommands)*2)
	for _, command := range topLevelCommands {
		names = append(names, command.Name)
		names = append(names, command.Aliases...)
	}
	return names
}
