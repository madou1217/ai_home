package environment

import (
	"context"
	"encoding/json"
	"strings"
)

// ToolView 是计划响应里的工具摘要（Node {id,name,runtime,category}）。
type ToolView struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Runtime  string `json:"runtime"`
	Category string `json:"category"`
}

// ToolPlanResult 是 resolveEnvironmentToolPlans / planEnvironmentToolAction 的结果。
type ToolPlanResult struct {
	OK       bool         `json:"ok"`
	Error    string       `json:"error,omitempty"`
	Message  string       `json:"message,omitempty"`
	Scope    string       `json:"scope,omitempty"`
	Platform string       `json:"platform,omitempty"`
	Tool     *ToolView    `json:"tool,omitempty"`
	Action   string       `json:"action,omitempty"`
	Label    string       `json:"label,omitempty"`
	Plans    []Plan       `json:"plans,omitempty"`
	Current  *ProbeResult `json:"current,omitempty"`
}

// IsLifecycleAction 判断动作是否属于安装 / 更新 / 卸载。
func IsLifecycleAction(action string) bool {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "install", "update", "uninstall":
		return true
	}
	return false
}

// NormalizeAction 返回归一化动作；未知动作返回空串。
func NormalizeAction(value string) string {
	action := strings.ToLower(strings.TrimSpace(value))
	if IsLifecycleAction(action) {
		return action
	}
	return ""
}

// resolvePlansForTool 按插件注册表分派计划构建（Node getRuntimePluginForTool 的等价）。
func resolvePlansForTool(toolID string, action string, options BuildOptions) []Plan {
	switch toolID {
	case "rustup", "cargo-binstall":
		return ResolveRustPlans(toolID, action, options)
	case "go", "goenv":
		return ResolveGoPlans(toolID, action, options)
	case "git":
		return ResolveGitPlans(toolID, action, options)
	case "nvm", "fnm", "volta", "pnpm", "yarn", "bun", "pyenv", "conda", "uv", "poetry":
		switch normalizePlatform(options.Platform) {
		case PlatformMacOS:
			return ResolveMacosPlans(toolID, action, options)
		case PlatformWindows:
			return ResolveWindowsPlans(toolID, action, options)
		default:
			return ResolveLinuxPlans(toolID, action, options)
		}
	}
	return nil
}

// normalizePlan 收口计划形状并补上预览命令。
func normalizePlan(plan Plan, tool ToolSpec, platform string) Plan {
	normalized := plan
	normalized.ToolID = tool.ID
	normalized.Action = strings.ToLower(strings.TrimSpace(plan.Action))
	if normalized.ID == "" {
		normalized.ID = tool.ID + "_" + normalized.Action
	}
	if normalized.Env == nil {
		normalized.Env = map[string]string{}
	}
	normalized.TimeoutMS = normalizePlanTimeout(normalized.TimeoutMS)
	normalized.RequiresConfirmation = plan.RequiresConfirmation
	normalized.Preview = RenderPlanCommand(normalized, platform)
	return normalized
}

// uniquePlans 按 command + args 去重（Node 用 NUL 连接 command 与参数 JSON）。
func uniquePlans(plans []Plan) []Plan {
	seen := map[string]struct{}{}
	result := make([]Plan, 0, len(plans))
	for _, plan := range plans {
		encoded, _ := json.Marshal(plan.Args)
		key := plan.Command + "\x00" + string(encoded)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, plan)
	}
	return result
}

// ResolveToolPlans 复刻 Node resolveEnvironmentToolPlans：校验工具 / 动作 / 平台后生成回退链。
func ResolveToolPlans(toolID string, action string, options BuildOptions) ToolPlanResult {
	tool, found := ToolByID(toolID)
	normalizedAction := NormalizeAction(action)
	if !found {
		return ToolPlanResult{OK: false, Error: "environment_tool_not_found", Message: "运行环境工具不存在。"}
	}
	if normalizedAction == "" {
		return ToolPlanResult{OK: false, Error: "unsupported_environment_tool_action", Message: "仅支持安装、更新和卸载。"}
	}
	if !supportsPlatform(tool, normalizePlatform(options.Platform)) {
		return ToolPlanResult{OK: false, Error: "unsupported_platform", Message: tool.Name + " 不支持当前系统。"}
	}
	buildOptions := options
	buildOptions.Platform = normalizePlatform(options.Platform)
	buildOptions.Name = tool.Name
	rawPlans := resolvePlansForTool(tool.ID, normalizedAction, buildOptions)
	plans := make([]Plan, 0, len(rawPlans))
	for _, plan := range rawPlans {
		if strings.TrimSpace(plan.Command) == "" {
			continue
		}
		plans = append(plans, normalizePlan(plan, tool, buildOptions.Platform))
	}
	plans = uniquePlans(plans)
	if len(plans) == 0 {
		if tool.ID == "git" && normalizedAction == "uninstall" {
			return ToolPlanResult{OK: false, Error: "environment_tool_action_unavailable", Message: "Git 是系统组件，toolkit 不提供卸载。"}
		}
		return ToolPlanResult{OK: false, Error: "environment_lifecycle_contract_violation", Message: "运行环境生命周期配置异常，请刷新资源清单后重试。"}
	}
	return ToolPlanResult{
		OK:       true,
		Platform: buildOptions.Platform,
		Tool:     &ToolView{ID: tool.ID, Name: tool.Name, Runtime: tool.Runtime, Category: tool.Category},
		Action:   normalizedAction,
		Label:    plans[0].Label,
		Plans:    plans,
	}
}

// PlanToolAction 生成计划并附带执行前的安装状态。
func PlanToolAction(ctx context.Context, input ToolInput, host Host, options BuildOptions) ToolPlanResult {
	result := ResolveToolPlans(input.ToolID, input.Action, options)
	if !result.OK {
		return result
	}
	tool, _ := ToolByID(input.ToolID)
	current := Probe(ctx, tool, host)
	switch {
	case result.Action == "install" && current.Installed:
		return ToolPlanResult{OK: false, Error: "environment_tool_already_installed", Message: tool.Name + " 已安装。"}
	case result.Action != "install" && !current.Installed:
		return ToolPlanResult{OK: false, Error: "environment_tool_not_installed", Message: tool.Name + " 尚未安装。"}
	}
	result.Current = &current
	return result
}

// ToolInput 是 plan / execute 请求里与工具相关的字段。
type ToolInput struct {
	ToolID string
	Action string
}
