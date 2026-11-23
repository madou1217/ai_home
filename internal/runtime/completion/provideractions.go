package completion

import (
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/mcpselection"
)

// sessionFlags 是 aih 自己的持久会话旗标（在 Provider 参数之前被摘走）。
var sessionFlags = []namedSummary{
	{Name: "-S", Summary: "本次启动的持久会话标签（等价 --session <标签>）"},
	{Name: "--session", Summary: "本次启动的持久会话标签"},
	{Name: "-R", Summary: "接管本项目最近的持久会话（--aih-resume）"},
	{Name: "--aih-resume", Summary: "接管本项目最近的持久会话"},
	{Name: "-M", Summary: "共享本项目最近的持久会话（--aih-mirror）"},
	{Name: "--aih-mirror", Summary: "共享本项目最近的持久会话"},
	{Name: "--remote", Summary: "指定远程主机名（远程粘贴通道）"},
	{Name: "--model", Summary: "本次启动请求的模型名"},
	{Name: "--model-alias", Summary: "本次启动的临时转发：A 请求实际用 B（不落库）"},
}

// mcpSessionFlags 只在实现了 MCP 选择入口的 Provider 上出现。
var mcpSessionFlags = []namedSummary{
	{Name: "--mcp", Summary: "只启用列出的 MCP（逗号分隔，可多选）"},
	{Name: "--no-mcp", Summary: "本次会话不启用任何 MCP"},
}

// providerSessionFlags 是某个 Provider 启动位的旗标面：通用会话旗标 +
// 该 Provider 实际支持的扩展旗标。支持判定来自 mcpselection，避免两处各写一份。
func providerSessionFlags(provider string) []namedSummary {
	flags := append([]namedSummary(nil), sessionFlags...)
	if mcpselection.Supports(provider) {
		flags = append(flags, mcpSessionFlags...)
	}
	return flags
}

const escapeHatchValue = "--"

const escapeHatchSummary = "逃生门：之后的参数原样交给原生 CLI"

// providerActions 是 Provider 通用动作；对每个声明了 CLI 的 Provider 都成立。
var providerActions = []namedSummary{
	{Name: "ls", Summary: "列出该工具的账号"},
	{Name: "sessions", Summary: "进入/列出该账号的持久会话"},
	{Name: "resume", Summary: "续接上一段对话（翻译成原生 resume 参数）"},
	{Name: "fork", Summary: "从上一段对话分叉（翻译成原生 fork 参数）"},
	{Name: "login", Summary: "新建账号并跑登录流程"},
	{Name: "detect", Summary: "扫描本机已登录账号（仅支持的 CLI 有效）"},
	{Name: "import", Summary: "从 AIH 原生 JSON 导入账号"},
	{Name: "export", Summary: "导出该工具的账号包"},
	{Name: "usage", Summary: "查询账号额度（可带 id）"},
	{Name: "auto-switch", Summary: "原生模式自动换号：额度见底 / 429 冷却时换下一个账号"},
	{Name: "home", Summary: "打印生效的 HOME/配置路径"},
	{Name: "version", Summary: "打印原生 CLI 版本与路径"},
	{Name: "install", Summary: "安装 harness/provider CLI（可指定本次代理）"},
	{Name: "update", Summary: "更新 harness/provider CLI（可指定本次代理）"},
	{Name: "terminal-icon", Summary: "安装终端里的 provider 图标"},
	{Name: "set-default", Summary: "设置宿主默认账号 / AIH Server 档"},
	{Name: "unset-default", Summary: "清除宿主默认账号"},
	{Name: "delete", Summary: "按 id 删除账号（如 1,2,3 或 1-9）"},
	{Name: "deleteall", Summary: "删除该工具的全部账号"},
}

// providerActionExtras 只放仅对某个 CLI 有意义的界面动作（CLI 面数据）。
var providerActionExtras = map[string][]namedSummary{
	"codex": {
		{Name: "set-mobile", Summary: "设置 Codex App 账号（仅 ChatGPT OAuth）"},
		{Name: "unset-mobile", Summary: "清除 Codex App 账号指针"},
		{Name: "effort", Summary: "设置推理强度或 fast 快速模式"},
		{Name: "policy", Summary: "查看/设置 exec 沙箱策略"},
	},
}

// providerActionSubcommands 是动作自己的固定取值层。
var providerActionSubcommands = map[string][]string{
	"auto-switch": {"on", "off", "status"},
}

// providerActionFlags 按动作名声明通用选项。
var providerActionFlags = map[string][]string{
	"usage":       {"--refresh", "--preflight", "-j"},
	"install":     {"--proxy"},
	"update":      {"--proxy"},
	"auto-switch": {"--remaining"},
	"login":       {"--no-browser"},
	"sessions":    {"--history", "--limit", "--all-projects"},
	"import":      {"--dry-run"},
	"set-default": {"--restart-client", "--force-quit-client"},
	"set-mobile":  {},
	"resume":      {},
	"fork":        {},
}

// listProviderActions 返回某个 Provider 的动作候选：通用动作 + 该 CLI 的界面动作。
// 可用性判据来自 Go 合同（loginArgs / desktopClient / gatewayProfile / 会话边界）。
func listProviderActions(provider string) []namedSummary {
	id := normalizeProviderID(provider)
	loginArgs := providerLoginArgs(id)
	actions := make([]namedSummary, 0, len(providerActions)+len(providerActionExtras[id]))
	for _, action := range providerActions {
		switch action.Name {
		case "resume", "fork":
			if providerSessionCommand(id, action.Name) == nil {
				continue
			}
		case "login":
			if len(loginArgs) == 0 {
				continue
			}
		case "set-default", "unset-default":
			if !providerSupportsHostDefault(id) {
				continue
			}
		}
		actions = append(actions, action)
	}
	actions = append(actions, providerActionExtras[id]...)
	return actions
}

func listProviderActionFlags(action string) []string {
	name := strings.ToLower(strings.TrimSpace(action))
	flags := make([]string, 0, 1+len(providerActionFlags[name]))
	flags = append(flags, "--help")
	flags = append(flags, providerActionFlags[name]...)
	return flags
}
