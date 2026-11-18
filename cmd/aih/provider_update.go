package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"unicode"

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

// --proxy is optional-valued; the next flag is never consumed as its value.
// The native -- escape is handled before this command in run.go.
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

func runProviderLifecycle(ctx context.Context, provider, action string, arguments []string, runtime commandRuntime) (resultErr error) {
	options, err := parseProviderLifecycleFlags(arguments)
	if err != nil {
		return err
	}
	if options.help {
		_, _ = fmt.Fprintf(runtime.stdout, "用法: aih %s %s [--proxy[=<选择器或 HTTP(S) URL>]]\n\n安装/更新此 harness/provider CLI，不更新 AIH、模型或账号。\n--proxy 裸旗标选择 auto；也可使用名称、ssh:conn_...、节点 ID 或 pool。\n命名代理使用管理面 lease，并在当前 CLI 主机上建立临时认证入口；失败不回落直连。\nHTTP(S) URL 不需要 Server；未指定旗标时继承当前代理环境。\n原生命令透传: aih %s -- %s\n", provider, action, provider, action)
		return nil
	}
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		if key, value, ok := strings.Cut(entry, "="); ok {
			env[key] = value
		}
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
	proxyURL := options.proxy
	if options.explicitProxy {
		// Any URL-like input must be validated as a direct URL, never reinterpreted
		// as a managed name (especially malformed URLs containing credentials).
		if !strings.Contains(proxyURL, "://") {
			managed, err := acquireProviderProxy(ctx, runtime, proxyURL)
			if err != nil {
				return err
			}
			defer func() {
				if err := managed.Close(); err != nil {
					if resultErr == nil {
						resultErr = err
					} else {
						_, _ = fmt.Fprintln(runtime.stderr, "[aih] 代理 lease 释放失败；Server 将在 3 小时到期时清理。")
					}
				}
			}()
			proxyURL = managed.URL
			name := strings.Join(strings.FieldsFunc(managed.Name, func(value rune) bool {
				return unicode.IsControl(value) || unicode.IsSpace(value)
			}), " ")
			if name == "" {
				name = "未命名代理"
			}
			_, _ = fmt.Fprintf(runtime.stderr, "[aih] 代理出口：%s\n", name)
		}
		env, err = updateproxy.Environment(env, proxyURL)
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintln(runtime.stderr, "[aih] 使用本次任务专用代理；不修改全局配置。")
	}
	// Management credentials must never be inherited by third-party installers.
	for key := range env {
		if strings.EqualFold(key, "AIH_SERVER_MANAGEMENT_KEY") {
			env[key] = ""
		}
	}
	env["AIH_SERVER_MANAGEMENT_KEY"] = ""
	lifecycle := apps.UpdateCLI
	label := "更新"
	if action == "install" {
		lifecycle, label = apps.InstallCLI, "安装"
	}
	result, err := lifecycle(ctx, provider, apps.Options{
		AIHomeDir: aiHome, HostHomeDir: hostHome, Env: env,
	}, options.explicitProxy, func(label string) {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] %s\n", label)
	})
	if err != nil {
		return fmt.Errorf("%s", updateproxy.Redact(err.Error(), proxyURL))
	}
	previous := result.BeforeVersion
	if previous == "" {
		previous = "未安装/未知版本"
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] %s CLI %s验证通过: %s -> %s\n%s\n", provider, label, previous, result.Version, result.CLIPath)
	return nil
}
