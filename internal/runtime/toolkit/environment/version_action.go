package environment

import (
	"context"
	"path"
	"regexp"
	"strings"
	"time"
)

var (
	actionVersionPattern     = regexp.MustCompile(`^v?\d{1,3}(?:\.\d{1,3}){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$`)
	actionEnvironmentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
)

const fixedNvmScript = "set -eu\n" +
	". \"$NVM_DIR/nvm.sh\"\n" +
	"case \"$AIH_ENV_ACTION\" in\n" +
	"  install|uninstall) nvm \"$AIH_ENV_ACTION\" \"$AIH_ENV_VERSION\" ;;\n" +
	"  default) nvm alias default \"$AIH_ENV_VERSION\" ;;\n" +
	"  *) exit 64 ;;\n" +
	"esac"

// ActionInput 是「环境动作」请求体（没有 toolId 的那条路径）。
type ActionInput struct {
	Manager       string
	Action        string
	Version       string
	Name          string
	PythonVersion string
	Path          string
}

// ActionOptions 是环境动作的上下文。
type ActionOptions struct {
	Platform string
	HomeDir  string
	Cwd      string
}

// VersionPlan 是环境动作计划（字段与 Node createPlan 的 plan 一致）。
type VersionPlan struct {
	Manager              string            `json:"manager"`
	Action               string            `json:"action"`
	Command              string            `json:"command"`
	Args                 []string          `json:"args"`
	Env                  map[string]string `json:"env"`
	Cwd                  *string           `json:"cwd"`
	Scope                string            `json:"scope"`
	Effect               string            `json:"effect"`
	RequiresConfirmation bool              `json:"requiresConfirmation"`
	ChangesCallerShell   bool              `json:"changesCallerShell"`
}

// ActionPlanResult 是 POST /environments/plan 的响应（工具动作或环境动作二选一）。
type ActionPlanResult struct {
	OK      bool         `json:"ok"`
	Error   string       `json:"error,omitempty"`
	Message string       `json:"message,omitempty"`
	Scope   string       `json:"scope,omitempty"`
	Plan    *VersionPlan `json:"plan,omitempty"`
}

// ExecuteResult 是 POST /environments/execute 的同步执行结果。
type ExecuteResult struct {
	OK              bool         `json:"ok"`
	Error           string       `json:"error,omitempty"`
	Message         string       `json:"message,omitempty"`
	ExitCode        *int         `json:"exitCode,omitempty"`
	Signal          string       `json:"signal,omitempty"`
	Stdout          string       `json:"stdout,omitempty"`
	Stderr          string       `json:"stderr,omitempty"`
	OutputTruncated bool         `json:"outputTruncated"`
	TimedOut        bool         `json:"timedOut,omitempty"`
	Plan            *VersionPlan `json:"plan,omitempty"`
}

func invalidActionPlan(code string, message string, scope string) ActionPlanResult {
	result := ActionPlanResult{OK: false, Error: code, Message: message}
	if scope != "" {
		result.Scope = scope
	}
	return result
}

// ValidateVersion 只接受数字、点、可选 v 前缀与安全预发布后缀。
func ValidateVersion(version string) string {
	value := strings.TrimSpace(version)
	if actionVersionPattern.MatchString(value) {
		return value
	}
	return ""
}

// ValidateEnvironmentName 只接受字母、数字、下划线和连字符。
func ValidateEnvironmentName(name string) string {
	value := strings.TrimSpace(name)
	if actionEnvironmentPattern.MatchString(value) {
		return value
	}
	return ""
}

func cleanActionPath(platform string, value string) string {
	if normalizePlatform(platform) == PlatformWindows {
		return strings.ReplaceAll(path.Clean(strings.ReplaceAll(value, "\\", "/")), "/", "\\")
	}
	return path.Clean(value)
}

// ResolveVenvTarget 把 venv 路径限制在当前工作目录内的安全子路径。
func ResolveVenvTarget(rawPath string, options ActionOptions) string {
	cwd := strings.TrimSpace(options.Cwd)
	value := strings.TrimSpace(rawPath)
	if cwd == "" || value == "" || len(value) > 512 || strings.ContainsAny(value, "\x00\r\n") || strings.HasPrefix(value, "~") {
		return ""
	}
	target := cleanActionPath(options.Platform, JoinPath(options.Platform, cwd, value))
	cleanCwd := cleanActionPath(options.Platform, cwd)
	separator := "/"
	if normalizePlatform(options.Platform) == PlatformWindows {
		separator = "\\"
	}
	if target == cleanCwd || !strings.HasPrefix(target, cleanCwd+separator) {
		return ""
	}
	if strings.Contains(target, separator+".."+separator) || strings.HasSuffix(target, separator+"..") {
		return ""
	}
	return target
}

func newVersionPlan(manager string, action string, command string, args []string, options ActionOptions, scope string, effect string) VersionPlan {
	plan := VersionPlan{
		Manager:              manager,
		Action:               action,
		Command:              command,
		Args:                 args,
		Env:                  map[string]string{},
		Scope:                scope,
		Effect:               effect,
		RequiresConfirmation: true,
		ChangesCallerShell:   false,
	}
	if scope == "" {
		plan.Scope = "new-child-process"
	}
	if cwd := strings.TrimSpace(options.Cwd); cwd != "" && manager == "venv" {
		plan.Cwd = &cwd
	}
	return plan
}

// PlanAction 复刻 Node planEnvironmentAction：执行前只生成计划，不跑命令。
func PlanAction(input ActionInput, options ActionOptions) ActionPlanResult {
	manager := strings.ToLower(strings.TrimSpace(input.Manager))
	action := strings.ToLower(strings.TrimSpace(input.Action))
	platform := normalizePlatform(options.Platform)

	switch action {
	case "use", "activate", "deactivate":
		return invalidActionPlan("interactive_shell_action_unsupported",
			"切换或激活只会影响调用者当前 Shell，服务端子进程无法修改已打开的终端。", "caller-shell")
	}

	versionActions := map[string]struct{}{"install": {}, "uninstall": {}, "default": {}, "global": {}}
	version := ""
	if _, requiresVersion := versionActions[action]; requiresVersion {
		version = ValidateVersion(input.Version)
		if version == "" {
			return invalidActionPlan("invalid_version", "版本只能包含数字、点、可选 v 前缀和安全预发布后缀。", "")
		}
	}

	switch manager {
	case "nvm":
		if action != "install" && action != "uninstall" && action != "default" {
			return invalidActionPlan("unsupported_environment_action", "NVM 仅支持 install、uninstall、default。", "")
		}
		if platform == PlatformWindows {
			return invalidActionPlan("unsupported_platform", "该 NVM 执行器仅支持 macOS 与 Linux。", "")
		}
		nvmDir := JoinPath(options.Platform, options.HomeDir, ".nvm")
		plan := newVersionPlan("nvm", action, "/bin/sh", []string{"-c", fixedNvmScript}, options, "nvm-managed-installation", "")
		plan.Env = map[string]string{
			"NVM_DIR":         nvmDir,
			"AIH_ENV_ACTION":  action,
			"AIH_ENV_VERSION": version,
		}
		if action == "default" {
			plan.Effect = "设置 NVM 新 Shell 的默认 Node.js 版本为 " + version
		} else if action == "install" {
			plan.Effect = "安装 NVM Node.js " + version
		} else {
			plan.Effect = "卸载 NVM Node.js " + version
		}
		return ActionPlanResult{OK: true, Plan: &plan}
	case "fnm":
		if action != "install" && action != "uninstall" && action != "default" {
			return invalidActionPlan("unsupported_environment_action", "FNM 仅支持 install、uninstall、default。", "")
		}
		effect := "卸载 FNM Node.js " + version
		if action == "default" {
			effect = "设置默认 FNM Node.js " + version
		} else if action == "install" {
			effect = "安装 FNM Node.js " + version
		}
		plan := newVersionPlan("fnm", action, "fnm", []string{action, version}, options, "", effect)
		return ActionPlanResult{OK: true, Plan: &plan}
	case "pyenv":
		if action != "install" && action != "uninstall" && action != "global" {
			return invalidActionPlan("unsupported_environment_action", "Pyenv 仅支持 install、uninstall、global。", "")
		}
		args := []string{action, version}
		if action == "uninstall" {
			args = []string{"uninstall", "--force", version}
		}
		effect := "卸载 Python " + version
		if action == "global" {
			effect = "设置新 Shell 的全局 Python " + version
		} else if action == "install" {
			effect = "安装 Python " + version
		}
		plan := newVersionPlan("pyenv", action, "pyenv", args, options, "", effect)
		return ActionPlanResult{OK: true, Plan: &plan}
	case "conda":
		if action != "create" && action != "remove" {
			return invalidActionPlan("unsupported_environment_action", "Conda 仅支持 create、remove。", "")
		}
		name := ValidateEnvironmentName(input.Name)
		if name == "" {
			return invalidActionPlan("invalid_environment_name", "环境名只能包含字母、数字、下划线和连字符。", "")
		}
		if action == "create" {
			pythonVersion := ValidateVersion(input.PythonVersion)
			if pythonVersion == "" {
				pythonVersion = ValidateVersion(input.Version)
			}
			if pythonVersion == "" {
				return invalidActionPlan("invalid_version", "创建 Conda 环境必须提供安全的 Python 版本。", "")
			}
			plan := newVersionPlan("conda", action, "conda", []string{"create", "--yes", "--name", name, "python=" + pythonVersion}, options,
				"", "创建 Conda 环境 "+name+"（Python "+pythonVersion+"）")
			return ActionPlanResult{OK: true, Plan: &plan}
		}
		plan := newVersionPlan("conda", action, "conda", []string{"env", "remove", "--yes", "--name", name}, options, "",
			"删除 Conda 环境 "+name)
		return ActionPlanResult{OK: true, Plan: &plan}
	case "venv":
		if action != "create" {
			return invalidActionPlan("unsupported_environment_action", "venv 仅支持 create。", "")
		}
		target := ResolveVenvTarget(input.Path, options)
		if target == "" {
			return invalidActionPlan("invalid_environment_path", "venv 路径必须是当前工作目录内的安全子路径。", "")
		}
		command := "python3"
		if platform == PlatformWindows {
			command = "python"
		}
		plan := newVersionPlan("venv", action, command, []string{"-m", "venv", target}, options, "",
			"在 "+target+" 创建 Python venv")
		return ActionPlanResult{OK: true, Plan: &plan}
	}
	return invalidActionPlan("unsupported_environment_manager", "不支持的环境管理器。", "")
}

// ExecuteAction 生成计划并执行；未显式确认时返回 confirmation_required。
func ExecuteAction(ctx context.Context, input ActionInput, confirmed bool, host Host, options ActionOptions) ExecuteResult {
	planned := PlanAction(input, options)
	if !planned.OK {
		return ExecuteResult{OK: false, Error: planned.Error, Message: planned.Message}
	}
	if !confirmed {
		return ExecuteResult{
			OK:      false,
			Error:   "confirmation_required",
			Message: "执行环境变更前必须显式确认。",
			Plan:    planned.Plan,
		}
	}
	if host.Exec == nil {
		return ExecuteResult{OK: false, Error: "environment_action_spawn_failed", Message: "executor_unavailable", Plan: planned.Plan}
	}
	plan := planned.Plan
	// Node executeLifecyclePlan 对没有 timeoutMs 的计划用 actionTimeoutMs，缺省 120s。
	optionsForRun := ExecOptions{
		Env:     plan.Env,
		Timeout: 120 * time.Second,
	}
	if plan.Cwd != nil {
		optionsForRun.Dir = *plan.Cwd
	}
	result := host.Exec.Run(ctx, plan.Command, plan.Args, optionsForRun)
	execution := ExecuteResult{
		OK:              result.OK,
		ExitCode:        result.ExitCode,
		Signal:          result.Signal,
		Stdout:          strings.TrimSpace(result.Stdout),
		Stderr:          strings.TrimSpace(result.Stderr),
		OutputTruncated: result.Truncated,
		TimedOut:        result.TimedOut,
		Plan:            plan,
	}
	if !result.OK {
		switch {
		case result.TimedOut:
			execution.Error = "environment_action_timeout"
		case result.SpawnFailed:
			execution.Error = "environment_action_spawn_failed"
			execution.Message = result.Message
		default:
			execution.Error = "environment_action_failed"
		}
	}
	return execution
}
