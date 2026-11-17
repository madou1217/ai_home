package apps

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexruntime"
	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// executeCodexRuntimePlan stages an entire official package in a fresh prefix.
// Installation and validation cannot alter the selected current/previous runtime.
func executeCodexRuntimePlan(ctx context.Context, target *InstallTarget, plan LifecyclePlan, opts Options) (AttemptView, *JobResultView, bool) {
	attempt := AttemptView{ID: plan.ID, Label: plan.Label}
	fail := func(message string) (AttemptView, *JobResultView, bool) {
		attempt.Error = truncateJobString(message, 500)
		return attempt, nil, false
	}
	if value, configured := resolveEnvMap(opts)["AIH_CODEX_BINARY"]; configured {
		return fail("已设置显式 Codex 路径（" + value + "）；请先在应用诊断中确认或移除该配置，安装不会擅自覆盖它。")
	}
	if !isNPMCommand(plan.Command) {
		return fail("Codex 需要使用受管理的官方安装计划。")
	}
	tx, err := codexruntime.Begin(ResolveHostHome(opts))
	if err != nil {
		return fail(err.Error())
	}
	defer tx.Close()
	plan.Args = replaceCodexPrefix(plan.Args, tx.Prefix)
	timeout := plan.Timeout
	if timeout <= 0 {
		timeout = defaultPlanExecTimeout
	}
	run := func(candidate LifecyclePlan) environment.RunResult {
		return runCodexNPMPlan(ctx, candidate, opts, environment.ExecOptions{Timeout: timeout, Env: mergePlanEnv(opts.Env, candidate.Env)})
	}
	res := run(plan)
	if !res.OK && npmResolutionFailure(res) {
		if fallback, ok := planWithOfficialNPMRegistry(plan); ok {
			res = run(fallback)
		}
	}
	if !res.OK {
		return fail("Codex 安装或更新未完成；当前版本和配置未变。" + formatExecFailure(res))
	}
	binary, err := codexruntime.NativeFromPrefix(tx.Prefix)
	if err != nil {
		return fail("Codex 安装校验失败：" + err.Error())
	}
	version := probeCLIBinaryVersion(ctx, binary, opts)
	if version == "" {
		return fail("Codex 候选版本无法运行；已保留当前版本。")
	}
	verdict := providercliupgrade.VerifyCodexAppServerBoot(ctx, providercliupgrade.CodexVerifyOptions{
		CLIPath: binary, GoOS: runtime.GOOS, NodeExecutable: opts.NodeExecPath, BaseEnv: resolveEnvMap(opts), Timeout: 12 * time.Second,
	})
	if verdict.Verdict != providercliupgrade.VerdictPass {
		return fail(fmt.Sprintf("Codex 候选启动验证未通过（%s）；已保留当前版本。", verdict.Detail))
	}
	if err = tx.Activate(binary, version); err != nil {
		return fail(err.Error())
	}
	// An explicit override is never silently rewritten. Its selection should
	// already have been disclosed by the caller; verify actual canonical identity.
	selected, err := resolveOfficialCodex(opts)
	if err != nil || selected != binary {
		return fail("Codex 已安装，但显式路径配置仍选择另一份 CLI；请检查应用诊断。")
	}
	attempt.OK = true
	return attempt, &JobResultView{Installed: true, CLIPath: binary}, true
}

func replaceCodexPrefix(args []string, prefix string) []string {
	out := make([]string, 0, len(args)+2)
	for i := 0; i < len(args); i++ {
		if args[i] == "--prefix" {
			i++
			continue
		}
		if strings.HasPrefix(args[i], "--prefix=") {
			continue
		}
		out = append(out, args[i])
	}
	return append(out, "--prefix", prefix)
}

func executeCodexRuntimeUninstall(opts Options) (AttemptView, *JobResultView, bool) {
	attempt := AttemptView{ID: "codex_managed_uninstall", Label: "卸载 Codex 受管理入口（保留配置与回滚文件）"}
	tx, err := codexruntime.Begin(ResolveHostHome(opts))
	if err != nil {
		attempt.Error = err.Error()
		return attempt, nil, false
	}
	defer tx.Close()
	if err = tx.Deactivate(); err != nil {
		attempt.Error = err.Error()
		return attempt, nil, false
	}
	attempt.OK = true
	return attempt, &JobResultView{Installed: false}, true
}
