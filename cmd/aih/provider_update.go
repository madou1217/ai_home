package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
	"github.com/madou1217/ai_home/internal/runtime/updateproxy"
)

// runProviderUpdate updates the harness, never an account or AIH itself.
func runProviderUpdate(ctx context.Context, provider string, arguments []string, runtime commandRuntime) error {
	return runProviderLifecycle(ctx, provider, "update", arguments, runtime)
}

type providerLifecycleFlags struct {
	proxy         string
	explicitProxy bool
	help          bool
}

// --proxy 的值是可选的：裸旗标选择 auto，且绝不会把下一个旗标当成值吃掉。
// 原生命令的 `--` 逃生门在 run.go 更早的位置处理。
func parseProviderLifecycleFlags(arguments []string) (providerLifecycleFlags, error) {
	var options providerLifecycleFlags
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		switch {
		case argument == "--help" || argument == "-h":
			options.help = true
		case argument == "--proxy" || strings.HasPrefix(argument, "--proxy="):
			if options.explicitProxy {
				return options, fmt.Errorf("%w: --proxy 只能指定一次", errInvalidCommand)
			}
			options.explicitProxy = true
			options.proxy = "auto"
			if argument == "--proxy" {
				if index+1 < len(arguments) && !strings.HasPrefix(arguments[index+1], "-") {
					index++
					options.proxy = arguments[index]
				}
			} else {
				options.proxy = strings.TrimPrefix(argument, "--proxy=")
			}
			if options.proxy == "" || options.proxy != strings.TrimSpace(options.proxy) || strings.ContainsAny(options.proxy, "\r\n\x00") {
				return options, fmt.Errorf("%w: --proxy 需要有效的选择器或 HTTP(S) URL", errInvalidCommand)
			}
		default:
			return options, fmt.Errorf("%w: install/update 仅接受 --proxy [选择器或 HTTP(S) URL] 和 --help", errInvalidCommand)
		}
	}
	return options, nil
}

func runProviderLifecycle(ctx context.Context, provider, action string, arguments []string, runtime commandRuntime) error {
	options, err := parseProviderLifecycleFlags(arguments)
	if err != nil {
		return err
	}
	if options.help {
		writeProviderLifecycleUsage(provider, action, runtime)
		return nil
	}
	aiHome, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	hostHome := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
	if hostHome == "" {
		hostHome, err = runtime.userHomeDir()
		if err != nil {
			return err
		}
	}
	baseEnv := make(map[string]string)
	for _, entry := range os.Environ() {
		if key, value, ok := strings.Cut(entry, "="); ok {
			baseEnv[key] = value
		}
	}
	cycle := &providerLifecycleCycle{
		ctx: ctx, action: action, runtime: runtime, options: options,
		provider: provider, aiHome: aiHome, hostHome: hostHome, baseEnv: baseEnv,
	}
	defer cycle.releaseEgress()
	result, err := cycle.run()
	if err != nil {
		return err
	}
	previous := result.BeforeVersion
	if previous == "" {
		previous = "未安装/未知版本"
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] %s CLI %s验证通过: %s -> %s\n%s\n",
		provider, cycle.label, previous, result.Version, result.CLIPath)
	if cycle.autoSelected {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] 本次经自动代理 %s 完成；全局代理配置未改动。\n", displayEgressName(cycle.egressName))
	}
	return nil
}

func writeProviderLifecycleUsage(provider, action string, runtime commandRuntime) {
	_, _ = fmt.Fprintf(runtime.stdout, `用法: aih %s %s [--proxy[=<选择器或 HTTP(S) URL>]]

安装/更新此 harness/provider CLI，不更新 AIH、模型或账号。
--proxy 裸旗标选择 auto；也可使用名称、ssh:conn_...、节点 ID 或 pool。
不加 --proxy 时：直连若失败于网络层，会自动选一个可用受管代理重试；
该出口也不可用时自动换下一个候选出口，所选出口会在终端说明（仅本次任务）。
显式 --proxy 时绝不自动换出口：你选的就是唯一出口，失败不回落直连。
命名代理使用管理面 lease，并在当前 CLI 主机上建立临时认证入口。
HTTP(S) URL 不需要 Server；未指定旗标时继承当前代理环境。
原生命令透传: aih %s -- %s
`, provider, action, provider, action)
}

// providerLifecycleMaxEgressAttempts 是自动轮换最多尝试的出口数。
const providerLifecycleMaxEgressAttempts = 4

// providerLifecycleCycle 持有一次 install/update 的可变状态。
//
// 单独成类型的原因：自动代理是「失败 → 换出口 → 重跑」的循环。若继续写在
// runProviderLifecycle 里，租约释放、每轮环境重建与错误脱敏会挤进同一条长函数。
type providerLifecycleCycle struct {
	ctx      context.Context
	action   string
	runtime  commandRuntime
	provider string
	aiHome   string
	hostHome string
	options  providerLifecycleFlags
	baseEnv  map[string]string

	label      string
	rotation   *updateproxy.EgressRotation
	egressURL  string
	egressName string
	// autoSelected 区分「自动选出的出口」与「用户显式 --proxy」。
	autoSelected bool
	releases     []func()
}

func (cycle *providerLifecycleCycle) run() (apps.CLIUpdateResult, error) {
	lifecycle, label := apps.UpdateCLI, "更新"
	if cycle.action == "install" {
		lifecycle, label = apps.InstallCLI, "安装"
	}
	cycle.label = label
	if cycle.options.explicitProxy {
		return cycle.runWithExplicitEgress(lifecycle)
	}
	return cycle.runWithAutoEgress(lifecycle)
}

// runWithExplicitEgress 只跑一次：用户选定的出口失败时绝不自动换到别的出口，
// 否则等于静默改变出口 IP。
func (cycle *providerLifecycleCycle) runWithExplicitEgress(lifecycle apps.CLILifecycleFunc) (apps.CLIUpdateResult, error) {
	lease, err := explicitProxyEgress(cycle.ctx, cycle.runtime, cycle.options.proxy)
	if err != nil {
		return apps.CLIUpdateResult{}, err
	}
	if lease.Release != nil {
		cycle.releases = append(cycle.releases, lease.Release)
	}
	cycle.egressName = lease.Name
	_, _ = fmt.Fprintf(cycle.runtime.stderr, "[aih] 代理出口：%s\n", displayEgressName(lease.Name))
	env, err := cycle.taskEnv(lease.URL)
	if err != nil {
		return apps.CLIUpdateResult{}, err
	}
	_, _ = fmt.Fprintln(cycle.runtime.stderr, "[aih] 使用本次任务专用代理；不修改全局配置。")
	return cycle.invoke(lifecycle, env, lease.AnonymousURL)
}

// runWithAutoEgress 先直连；只有网络类失败才启用受管代理，出口失败时再换下一个。
//
// 触发条件刻意收窄：版本不存在、权限不足、脚本错误等都不换出口——换个代理
// 不会让它们成功，只会多花一次完整安装。
func (cycle *providerLifecycleCycle) runWithAutoEgress(lifecycle apps.CLILifecycleFunc) (apps.CLIUpdateResult, error) {
	// lastURL 记录真正跑过安装器的那一轮出口：失败可能发生在租约已释放之后，
	// 脱敏必须用这一轮的 URL，而不是「当前还剩哪个出口」。
	lastURL := ""
	rotation := cycle.newRotation()
	result, used, err := updateproxy.RetryWithEgress(
		cycle.ctx, rotation, providerLifecycleMaxEgressAttempts,
		func(err error) (string, bool) { return providercliupgrade.EgressFailureReason(err.Error()) },
		func(endpoint updateproxy.EgressEndpoint) (apps.CLIUpdateResult, error) {
			lastURL = endpoint.URL
			env, envErr := cycle.taskEnv(endpoint.URL)
			if envErr != nil {
				return apps.CLIUpdateResult{}, envErr
			}
			// proxyActive 必须由**本轮出口**决定，而不是环境里恰好有没有代理变量：
			// 直连轮（endpoint.URL 为空）即便继承到宿主 HTTPS_PROXY，也不该按
			// 「已配置代理」剔除安装器——那会把 winget 误跳过，而这一轮本来就
			// 没打算走代理。
			return cycle.invokeWithEgress(lifecycle, env, endpoint)
		},
	)
	if rotation != nil {
		cycle.rotation = rotation
	}
	cycle.egressURL, cycle.egressName, cycle.autoSelected = used.URL, used.Name, used.Auto
	if err != nil {
		if lastURL == "" {
			lastURL = used.URL
		}
		return apps.CLIUpdateResult{}, cycle.redactError(err, lastURL)
	}
	return result, nil
}

// newRotation 装配受管代理轮换；管理面凭据缺失时返回 nil（保持直连语义）。
func (cycle *providerLifecycleCycle) newRotation() *updateproxy.EgressRotation {
	return managementProxyRotation(cycle.runtime, func(message string) {
		_, _ = fmt.Fprintln(cycle.runtime.stderr, message)
	})
}

// taskEnv 生成本轮安装器环境：先清除管理凭据，再叠加本轮出口。
func (cycle *providerLifecycleCycle) taskEnv(proxyURL string) (map[string]string, error) {
	env := make(map[string]string, len(cycle.baseEnv))
	for key, value := range cycle.baseEnv {
		env[key] = value
	}
	// 管理凭据不得被第三方安装器继承（大小写不同也算）。
	for key := range env {
		if strings.EqualFold(key, "AIH_SERVER_MANAGEMENT_KEY") {
			env[key] = ""
		}
	}
	env["AIH_SERVER_MANAGEMENT_KEY"] = ""
	if proxyURL == "" {
		return env, nil
	}
	return updateproxy.Environment(env, proxyURL)
}

// invokeWithEgress 按本轮出口执行一次安装。
//
// proxyActive 只看 endpoint.URL：有出口才算「本轮配了代理」。先前用环境变量
// 判断，于是直连轮（endpoint 为空、但宿主恰好有 HTTPS_PROXY）也会按已配置代理
// 处理，把 winget 这类需要 --proxy 的计划误剔除。
func (cycle *providerLifecycleCycle) invokeWithEgress(
	lifecycle apps.CLILifecycleFunc,
	env map[string]string,
	endpoint updateproxy.EgressEndpoint,
) (apps.CLIUpdateResult, error) {
	return lifecycle(cycle.ctx, cycle.provider, apps.Options{
		AIHomeDir: cycle.aiHome, HostHomeDir: cycle.hostHome, Env: env,
		AnonymousProxyURL: endpoint.AnonymousURL,
	}, endpoint.URL != "", func(step string) {
		_, _ = fmt.Fprintf(cycle.runtime.stderr, "[aih] %s\n", step)
	})
}

// invoke 是显式 --proxy 路径的入口：那里出口总是非空。
func (cycle *providerLifecycleCycle) invoke(lifecycle apps.CLILifecycleFunc, env map[string]string, anonymousURL string) (apps.CLIUpdateResult, error) {
	return lifecycle(cycle.ctx, cycle.provider, apps.Options{
		AIHomeDir: cycle.aiHome, HostHomeDir: cycle.hostHome, Env: env,
		AnonymousProxyURL: anonymousURL,
	}, true, func(step string) {
		_, _ = fmt.Fprintf(cycle.runtime.stderr, "[aih] %s\n", step)
	})
}

// taskProxyActive 判断本轮环境里是否真的设置了任务期代理。
func taskProxyActive(env map[string]string) bool {
	for _, key := range []string{"AIH_TASK_PROXY", "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"} {
		if value, ok := env[key]; ok && strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

func (cycle *providerLifecycleCycle) redactError(err error, proxyURL string) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s", updateproxy.Redact(err.Error(), proxyURL))
}

func (cycle *providerLifecycleCycle) releaseEgress() {
	if cycle.rotation != nil {
		cycle.rotation.Release()
	}
	for _, release := range cycle.releases {
		release()
	}
	cycle.releases = nil
}
