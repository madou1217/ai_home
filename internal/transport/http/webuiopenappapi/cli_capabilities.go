package webuiopenappapi

import (
	"strings"

	"github.com/madou1217/ai_home/core/harnesses"
	"github.com/madou1217/ai_home/core/providers"
)

// webUICLIIsGoOwned 在读取构件/配置之前按已迁能力分流，不是执行失败后的回退。
// 外部 harness 由 externalHarnessLaunchArgs 直接走 Go 简写，不走本判定；
// 这里只回答「Provider 身份 + CLI harness」的组合是否已由 Go 组合根承接。
// 上层 plan.go 仍负责 CLI / 跨 Provider 的可用性校验。
func webUICLIIsGoOwned(deps NativeLauncherDependencies, req Request, harness string) bool {
	harness = strings.ToLower(strings.TrimSpace(harness))
	provider := strings.ToLower(strings.TrimSpace(req.Provider))
	if strings.EqualFold(strings.TrimSpace(req.HarnessKind), "external") {
		return false
	}
	if _, external := harnesses.Get(harness); external {
		return false
	}
	if harness != provider {
		// 对齐 aihcli 的 Gateway Strategy：Go 当前只注册了 codex/claude 的
		// 跨 Provider relay；其它组合在 plan.go 阶段就不会被提供。
		return (harness == "codex" || harness == "claude") &&
			(provider == "codex" || provider == "claude")
	}
	return deps.supportsNativeCLI(harness)
}

// supportsNativeCLI 回答该 Provider 的原生 CLI 是否由 Go 组合根承接。
//
// 真相源是宿主注入的组合根事实（aihcli 实际注册的 Native Direct 策略）；
// 未注入时回退到 Provider 合同声明的 CLI 客户端——这是必要非充分条件，只用于
// 没有组合根上下文的调用方（单元测试、诊断）。
func (deps NativeLauncherDependencies) supportsNativeCLI(providerID string) bool {
	if deps.NativeCLIProvider != nil {
		return deps.NativeCLIProvider(providerID)
	}
	catalog := deps.Catalog
	if catalog == nil {
		builtin, err := providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			return false
		}
		catalog = builtin
	}
	definition, known := catalog.Get(providerID)
	return known && definition.Clients.CLI
}

// externalHarnessID 返回外部 harness 的规范 ID（不是 Provider）。
func externalHarnessID(harness string) (string, bool) {
	item, found := harnesses.Get(harness)
	if !found {
		return "", false
	}
	return item.ID, true
}

// externalHarnessLaunchArgs 构造 Go 简写的启动参数：
//
//	aih <harness> <accountRef> [--model <m>]
//
// 与旧 Node 入口的 `node bin/ai-home.js <harness> <accountRef> --model <m>`
// 逐位对应；accountRef 自带 Provider 归属，不需要额外传 --provider。
func externalHarnessLaunchArgs(harnessID, accountRef, model string) []string {
	args := []string{harnessID}
	if ref := strings.TrimSpace(accountRef); ref != "" {
		args = append(args, ref)
	}
	if name := strings.TrimSpace(model); name != "" {
		args = append(args, "--model", name)
	}
	return args
}
