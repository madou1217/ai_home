// Package harnesses 注册「不是 AIH Provider、但可以由 aih 启动」的外部 harness。
//
// 为什么单独成包：这些 harness 没有上游协议、没有账号池，不能进入 Provider 合同；
// 但 WebUI 的入口探测（GET /v1/management/webui/app-entries）与打开应用
// （POST .../open-app）必须能回答它们的可用性、二进制名与跨 Provider 能力。
// 注册表是唯一真值源：新增 harness 只在这里加一条，派发层不出现名字比较。
//
// 与 Node lib/harness/catalog.js 的关系：本包只承载启动/探测需要的公开字段；
// 投影适配器、原生会话命令等仍归 Node（它们依赖各 harness 的私有约定）。
package harnesses

import "strings"

// Harness 是外部 harness 的公开描述。
type Harness struct {
	// ID 是稳定标识，也是 WebUI 的 entries / capabilities 键。
	ID string
	// Label 是展示名。
	Label string
	// ManagedAppID 是安装器目标标识；dsh-tui 复用 dsh 的安装生命周期。
	ManagedAppID string
	// BinaryName 是 PATH 上的可执行文件名。
	BinaryName string
	// InteractiveKind 是交互形态：tui（终端内）或 web（本地 Web UI）。
	InteractiveKind string
	// SupportsCrossProvider 表示可作为跨 Provider harness 启动。
	SupportsCrossProvider bool
	// SupportsAccountPin 表示启动时能把身份账号钉到请求上。
	SupportsAccountPin bool
	// SupportsModelSelection 表示启动时可选择模型。
	SupportsModelSelection bool
	// Description 是界面提示文案。
	Description string
}

// builtin 与 Node 的 EXTERNAL_HARNESSES 保持同 ID / 同二进制名。
//
// dsh-tui 不是独立二进制：它装进 DSH profile，靠 `dsh --profile dsh-tui` 启动，
// 因此 ManagedAppID 与 BinaryName 都指向 dsh。
var builtin = []Harness{
	{
		ID:                     "pi",
		Label:                  "Pi",
		ManagedAppID:           "pi",
		BinaryName:             "pi",
		InteractiveKind:        "tui",
		SupportsCrossProvider:  true,
		SupportsAccountPin:     true,
		SupportsModelSelection: true,
		Description:            "轻量终端 Agent harness，支持自定义 OpenAI 兼容 provider",
	},
	{
		ID:                     "dsh",
		Label:                  "DeepSeek Harness",
		ManagedAppID:           "dsh",
		BinaryName:             "dsh",
		InteractiveKind:        "web",
		SupportsCrossProvider:  true,
		SupportsAccountPin:     true,
		SupportsModelSelection: true,
		Description:            "DeepSeek 官方开源 Agent Harness（web profile）",
	},
	{
		ID:                     "dsh-tui",
		Label:                  "DeepSeek Harness TUI",
		ManagedAppID:           "dsh",
		BinaryName:             "dsh",
		InteractiveKind:        "tui",
		SupportsCrossProvider:  true,
		SupportsAccountPin:     true,
		SupportsModelSelection: true,
		Description:            "DeepSeek Harness 的终端 TUI（树外 profile，经 DSH 启动）",
	},
}

// nativeCrossProvider 列出可以跨 Provider 运行的原生 harness。
//
// 判定对齐 Node lib/cli/services/ai-cli/relay/cli-relay-profile.js：
// 只有同时声明 buildAccountRelayEnv 与 buildCrossProviderEnv 的 relay profile
// 才能作为跨 Provider 入口（当前 claude / codex；kimi 只有账号钉选）。
// 新增 relay profile 时必须同步这里，否则 WebUI 会把它从跨 Provider 选择器里漏掉。
var nativeCrossProvider = map[string]bool{
	"claude": true,
	"codex":  true,
}

// List 返回全部外部 harness 的副本，调用方改写不会污染注册表。
func List() []Harness {
	items := make([]Harness, len(builtin))
	copy(items, builtin)
	return items
}

// Get 按 ID 查找外部 harness（大小写不敏感）。
func Get(id string) (Harness, bool) {
	normalized := NormalizeID(id)
	for _, harness := range builtin {
		if harness.ID == normalized {
			return harness, true
		}
	}
	return Harness{}, false
}

// NormalizeID 与 Node 的 normalizeHarnessId 同语义。
func NormalizeID(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// SupportsCrossProvider 回答某个 harness ID（原生或外部）能否跨 Provider 启动。
func SupportsCrossProvider(id string) bool {
	normalized := NormalizeID(id)
	if nativeCrossProvider[normalized] {
		return true
	}
	harness, found := Get(normalized)
	return found && harness.SupportsCrossProvider
}
