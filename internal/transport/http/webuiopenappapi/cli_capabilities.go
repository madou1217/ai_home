package webuiopenappapi

import (
	"strings"

	"github.com/madou1217/ai_home/core/harnesses"
)

// webUICLIIsGoOwned 在读取构件/配置之前按已迁能力分流，不是执行失败后的回退。
// 未迁域保持旧 Node 合同：跨 Provider 使用 accountRef，external harness 由其
// 专属启动适配器处理。上层 plan.go 仍负责 CLI / 跨 Provider 的可用性校验。
func webUICLIIsGoOwned(req Request, harness string) bool {
	harness = strings.ToLower(strings.TrimSpace(harness))
	provider := strings.ToLower(strings.TrimSpace(req.Provider))
	if strings.EqualFold(strings.TrimSpace(req.HarnessKind), "external") {
		return false
	}
	if _, external := harnesses.Get(harness); external {
		return false
	}
	if harness != provider {
		// 对齐 aihcli 的 Gateway Strategy 与上游支持范围；Node 的跨 Provider
		// 合同更宽，不能把尚未迁移的组合改为 unsupported，也不能改成账号池。
		return (harness == "codex" || harness == "claude") &&
			(provider == "codex" || provider == "claude")
	}
	// 当前已注册的 Go Native Direct Strategy（internal/host/aihcli/app.go）。
	// 新 Provider 默认仍归 Node，确认完整启动合同后才加入迁移覆盖范围。
	switch harness {
	case "codex", "claude", "gemini", "agy", "grok", "cline", "kimi", "kiro", "opencode", "zcode", "qoder", "qodercn", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		return true
	default:
		return false
	}
}
