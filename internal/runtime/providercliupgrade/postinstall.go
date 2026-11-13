package providercliupgrade

import "context"

// PostInstallReinstallCodexCLIHook 表示安装/回滚完成后重装 Codex CLI hook 垫片。
const PostInstallReinstallCodexCLIHook = "reinstall_codex_cli_hook"

// PostInstallActionResult 记录单个善后动作的执行状态。
type PostInstallActionResult struct {
	Action  string
	OK      bool
	Skipped bool
	Error   string
}

// PostInstallResult 汇总善后动作集合的结果。
type PostInstallResult struct {
	OK           bool
	Performed    []PostInstallActionResult
	FailedAction string
}

// CollectPostInstallActions 从安装计划中收集去重后的善后动作顺序列表。
func CollectPostInstallActions(plans []InstallPlan) []string {
	var actions []string
	seen := map[string]struct{}{}
	for _, plan := range plans {
		for _, action := range plan.PostInstall {
			if _, exists := seen[action]; exists {
				continue
			}
			seen[action] = struct{}{}
			actions = append(actions, action)
		}
	}
	return actions
}

// RunPostInstallActions 顺序执行所有善后动作；未注入对应实现时按跳过处理（不视为失败）。
func RunPostInstallActions(
	ctx context.Context,
	actions []string,
	reinstallCodexCLIHook func(ctx context.Context) error,
) PostInstallResult {
	performed := make([]PostInstallActionResult, 0, len(actions))
	for _, action := range actions {
		if action == PostInstallReinstallCodexCLIHook {
			if reinstallCodexCLIHook == nil {
				performed = append(performed, PostInstallActionResult{
					Action:  action,
					OK:      true,
					Skipped: true,
				})
				continue
			}
			if err := reinstallCodexCLIHook(ctx); err != nil {
				performed = append(performed, PostInstallActionResult{
					Action: action,
					OK:     false,
					Error:  err.Error(),
				})
				return PostInstallResult{
					OK:           false,
					Performed:    performed,
					FailedAction: action,
				}
			}
			performed = append(performed, PostInstallActionResult{Action: action, OK: true})
			continue
		}
		performed = append(performed, PostInstallActionResult{
			Action:  action,
			OK:      true,
			Skipped: true,
			Error:   "unknown_action",
		})
	}
	return PostInstallResult{OK: true, Performed: performed}
}
