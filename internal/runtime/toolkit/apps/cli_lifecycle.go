package apps

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/hostexec"
)

// CLILifecycleFunc 是一次 CLI 安装或更新的统一签名。
// 调用方据此在「直连失败 → 换出口重试」时按同一入口重跑，而不复制计划差异。
//
// proxyActive 的语义是「**本轮**环境里是否真的配了任务期代理」——显式 --proxy
// 和自动代理轮换都算。参数名沿用 explicitProxy 仅为兼容，判断时请按语义理解：
// 它决定 Windows 上要不要剔除无法保证走代理的安装器。
type CLILifecycleFunc func(ctx context.Context, provider string, opts Options, proxyActive bool, progress func(string)) (CLIUpdateResult, error)

// ErrEgressUnsupported 表示「这个官方安装器无法保证所有下载都走代理」。
//
// 它不是网络失败：换出口不会改变结论，自动代理必须把它当作终止条件，
// 否则会把真正的原因（安装器不支持代理）掩盖成一次网络重试。
var ErrEgressUnsupported = errors.New("此官方安装器不支持任务期代理")

// InstallCLI uses the catalog's official install plans, with the same terminal
// cancellation and executable/version verification as UpdateCLI.
func InstallCLI(ctx context.Context, provider string, opts Options, proxyActive bool, progress func(string)) (CLIUpdateResult, error) {
	return runCLILifecycle(ctx, provider, "install", opts, proxyActive, progress)
}

func runCLILifecycle(ctx context.Context, provider, action string, opts Options, proxyActive bool, progress func(string)) (CLIUpdateResult, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	label := lifecycleActionLabel(action)
	spec := getInstaller(provider)
	if spec == nil || spec.CLI == nil || !isCLIInstallSupported(provider) {
		return CLIUpdateResult{}, fmt.Errorf("%s 没有可用的 CLI %s计划", provider, label)
	}
	if err := ctx.Err(); err != nil {
		return CLIUpdateResult{}, err
	}
	// Both version probes and every nested plan use a cancellable process group.
	if opts.Executor == nil {
		opts.Executor = hostexec.Executor{ProcessGroup: true}
	}
	installed := ResolveProviderCLIPath(provider, opts)
	if action == "update" && installed == "" {
		return CLIUpdateResult{}, fmt.Errorf("未找到 %s CLI；请先运行 aih %s install", provider, provider)
	}
	before := ""
	if installed != "" {
		before = probeCLIBinaryVersion(ctx, installed, opts)
	}
	plans := ResolveLifecyclePlans(provider, "cli", action, opts, installed, nil)
	// Update retains its selected channel; install uses the catalog's existing
	// install lifecycle rather than inferring a different action from PATH.
	if action == "update" && provider == "claude" {
		var err error
		plans, err = claudeCLIUpdatePlans(installed, opts, plans)
		if err != nil {
			return CLIUpdateResult{}, err
		}
	}
	if len(plans) == 0 {
		return CLIUpdateResult{}, fmt.Errorf("%s 不支持 CLI %s", provider, label)
	}
	// Windows 上只要本轮配了代理（显式或自动），就必须保证计划真的会走代理。
	// 判定与 WebUI 作业共用 planHonorsProxy：同一个问题不在这里另写一套。
	//
	// 语义是「剔除不可代理的计划」：同一 provider 的 Windows 计划常是
	// PowerShell / cmd / winget 混合列表，逐条尝试；把 winget 剔掉后其余计划
	// 仍能完成安装，全部被剔时才如实失败。
	if proxyActive && resolvePlatform(opts) == platformWindows {
		plans, _ = EnsureWingetProxy(ctx, plans, opts, progress)
		kept := make([]LifecyclePlan, 0, len(plans))
		var skipped []string
		for _, plan := range plans {
			if planHonorsProxy(plan) {
				kept = append(kept, plan)
				continue
			}
			skipped = append(skipped, nonEmpty(plan.Label, plan.ID))
		}
		if len(kept) == 0 {
			// 轮换器把「不能保证全下载走代理」当普通失败处理，因此必须显式
			// 标注不可重试：否则自动代理会换一个出口再撞同一堵墙，把真正原因
			// 掩盖成一句无信息量的网络错误。
			return CLIUpdateResult{}, fmt.Errorf("%w: 此 Windows 安装器（%s）不能保证所有下载使用 --proxy；请使用支持代理的官方原生命令，不会修改系统代理或回落直连", ErrEgressUnsupported, strings.Join(skipped, "、"))
		}
		if len(skipped) > 0 && progress != nil {
			progress("已跳过不支持代理的安装器：" + strings.Join(skipped, "、"))
		}
		plans = kept
	}
	manager := NewJobManager(nil, opts)
	if attempt, _ := manager.checkCLIMinNodeVersion(ctx, spec.CLI, opts); attempt != nil {
		return CLIUpdateResult{}, fmt.Errorf("%s", attempt.Error)
	}
	target := &InstallTarget{AppID: provider, Provider: provider, Kind: "cli", Action: action, Key: "cli:" + provider}
	var failures []string
	for _, plan := range plans {
		if err := ctx.Err(); err != nil {
			return CLIUpdateResult{}, err
		}
		if progress != nil {
			progress(plan.Label)
		}
		attempt, result, ok := manager.executeSinglePlan(ctx, target, plan, opts)
		if err := ctx.Err(); err != nil {
			return CLIUpdateResult{}, err
		}
		if !ok {
			failures = append(failures, attempt.Error)
			continue
		}
		if result == nil || result.CLIPath == "" {
			return CLIUpdateResult{}, fmt.Errorf("%s命令结束，但未能确认 %s 实际 CLI 路径", label, provider)
		}
		version := probeCLIBinaryVersion(ctx, result.CLIPath, opts)
		if err := ctx.Err(); err != nil {
			return CLIUpdateResult{}, err
		}
		if version == "" {
			return CLIUpdateResult{}, fmt.Errorf("%s命令结束，但无法读取 %s CLI 的实际版本", label, provider)
		}
		return CLIUpdateResult{CLIPath: result.CLIPath, BeforeVersion: before, Version: version}, nil
	}
	return CLIUpdateResult{}, fmt.Errorf("%s CLI %s失败: %s", provider, label, strings.Join(failures, "; "))
}
