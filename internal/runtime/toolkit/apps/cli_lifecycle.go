package apps

import (
	"context"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/hostexec"
)

// InstallCLI uses the catalog's official install plans, with the same terminal
// cancellation and executable/version verification as UpdateCLI.
func InstallCLI(ctx context.Context, provider string, opts Options, explicitProxy bool, progress func(string)) (CLIUpdateResult, error) {
	return runCLILifecycle(ctx, provider, "install", opts, explicitProxy, progress)
}

func runCLILifecycle(ctx context.Context, provider, action string, opts Options, explicitProxy bool, progress func(string)) (CLIUpdateResult, error) {
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
	if explicitProxy && resolvePlatform(opts) == platformWindows {
		for _, plan := range plans {
			if !isNPMCommand(plan.Command) {
				return CLIUpdateResult{}, fmt.Errorf("此 Windows 官方安装器不能保证所有下载使用 --proxy；请使用支持代理的官方原生命令，不会修改系统代理或回落直连")
			}
		}
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
