package apps

import (
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// npmResolutionFailure 判断失败是否来自「registry 里没有这个包/版本」。
//
// 工具箱的 npm 计划跟随镜像设置，而镜像同步滞后是常态（实测 npm 官方已有
// @ai-sdk/google@4.0.121、镜像只到 4.0.120，cline 安装因此整体失败）。这类
// 失败换成官方源即可成功，属于可回退错误；网络、权限、脚本错误不在此列。
func npmResolutionFailure(res environment.RunResult) bool {
	text := strings.ToLower(res.Stdout + "\n" + res.Stderr)
	for _, marker := range []string{
		"notarget",
		"etarget",
		"e404",
		"no matching version",
		"404 not found",
	} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

// planWithOfficialNPMRegistry 把 npm 安装计划的 registry 换成官方源。
// 计划本来就用官方源、或不是 npm install 时 ok=false，不做无意义的重复执行。
func planWithOfficialNPMRegistry(plan LifecyclePlan) (LifecyclePlan, bool) {
	if !isNPMCommand(plan.Command) || len(plan.Args) == 0 || plan.Args[0] != "install" {
		return LifecyclePlan{}, false
	}
	registry := ""
	for _, arg := range plan.Args {
		if strings.HasPrefix(arg, "--registry=") {
			registry = strings.TrimPrefix(arg, "--registry=")
			break
		}
	}
	if registry == "" || sameRegistry(registry, NPMRegistry) {
		return LifecyclePlan{}, false
	}
	args := append([]string(nil), plan.Args...)
	for index, arg := range args {
		if strings.HasPrefix(arg, "--registry=") {
			args[index] = "--registry=" + NPMRegistry
		}
	}
	plan.Args = args
	plan.ID = plan.ID + "_official_registry"
	plan.Label = strings.TrimSpace(plan.Label) + "（官方源回退）"
	return plan, true
}

func isNPMCommand(command string) bool {
	switch strings.ToLower(filepath.Base(strings.TrimSpace(command))) {
	case "npm", "npm.cmd":
		return true
	default:
		return false
	}
}

func sameRegistry(left, right string) bool {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(left)), "/") ==
		strings.TrimSuffix(strings.ToLower(strings.TrimSpace(right)), "/")
}
