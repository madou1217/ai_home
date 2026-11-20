package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	goruntime "runtime"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/runtime/distributioninstall"
	"github.com/madou1217/ai_home/internal/runtime/outboundproxy"
	"github.com/madou1217/ai_home/internal/runtime/serveridentity"
)

const shutdownTimeout = 10 * time.Second

// commandRuntime 集中注入操作系统边界，便于无全局状态测试。
type commandRuntime struct {
	lookupEnv   func(string) (string, bool)
	userHomeDir func() (string, error)
	listen      func(context.Context, string, string) (net.Listener, error)
	stdout      io.Writer
	stderr      io.Writer
	models      []accountapp.ProviderModelDiscoverer
	// requestShutdown 由管理端点调用，触发与收到信号相同的优雅关闭；可为空。
	requestShutdown func()
}

// defaultCommandRuntime 返回生产命令使用的操作系统适配器。
func defaultCommandRuntime(requestShutdown func()) commandRuntime {
	listenConfig := &net.ListenConfig{}
	return commandRuntime{
		lookupEnv:       os.LookupEnv,
		userHomeDir:     os.UserHomeDir,
		listen:          listenConfig.Listen,
		stdout:          os.Stdout,
		stderr:          os.Stderr,
		requestShutdown: requestShutdown,
	}
}

// run 解析配置、装配 Go Server、监听端口并等待退出信号。
func run(
	ctx context.Context,
	args []string,
	runtime commandRuntime,
) (returnErr error) {
	if err := validateCommandRuntime(runtime); err != nil {
		return err
	}
	config, err := loadCommandConfig(args, runtime)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := distributioninstall.AwaitActivation(ctx, config.aiHomeDir, config.listenAddress(), runtime.listen, runtime.stderr); err != nil {
		return err
	}
	// 宿主受管 Codex 配置是常驻启动路径的共享事实；在装配网关前统一自愈一次。
	healHostCodexAuthCommand(runtime)
	managementKey := config.managementKey
	clientKey := config.clientKey
	traceRemoteControl := config.codexHooks.traceRemoteControl
	remoteControlProxy := config.codexHooks.remoteControlProxy
	// 出站语义统一在进程入口装一次：环境代理不可达时改直连（显式代理仍失败关闭）。
	aihserver.InstallOutboundFallback()
	proxyPool := outboundproxy.NewManager()
	if proxyErr := proxyPool.Update(config.proxyURL); proxyErr != nil {
		log.Printf("outbound proxy pool ignored: %v", proxyErr)
	}
	http.DefaultTransport = proxyPool
	defer func() { _ = proxyPool.Close() }()
	go outboundproxy.Watch(ctx, proxyPool, config.aiHomeDir, config.proxyURL, 0)
	desktopOwner, _ := runtime.lookupEnv("AIH_DESKTOP_TRANSLATION_OWNER")
	server, err := aihserver.New(ctx, aihserver.Options{
		AIHomeDir:                  config.aiHomeDir,
		ProxyPool:                  proxyPool,
		NodeBaseURL:                config.nodeBaseURL,
		SelfBaseURL:                config.selfBaseURL(),
		FrontDoorBaseURL:           config.frontDoorBaseURL(),
		DesktopManagedByHost:       desktopOwner == "node",
		ManagementKey:              func() string { return managementKey },
		ClientKey:                  func() string { return clientKey },
		ModelDiscoverers:           runtime.models,
		DelegateCredentialRefresh:  config.delegateCredentialRefresh,
		UpstreamErrorRuleProviders: config.upstreamErrorRuleProviders,
		WebDir:                     config.webDir,
		RequestShutdown:            runtime.requestShutdown,
		CodexHooks: aihserver.CodexHooksOptions{
			EnableCLIHook:                config.codexHooks.enableCLIHook,
			EnableDesktopHook:            config.codexHooks.enableDesktopHook,
			CLISelfHealInterval:          time.Duration(config.codexHooks.cliSelfHealIntervalMs) * time.Millisecond,
			DesktopSelfHealInterval:      time.Duration(config.codexHooks.desktopSelfHealIntervalMs) * time.Millisecond,
			ProviderHookReceiverURL:      config.codexHooks.providerHookReceiverURL,
			TraceFile:                    config.codexHooks.traceFile,
			TraceResponses:               config.codexHooks.traceResponses,
			TraceRemoteControl:           &traceRemoteControl,
			RemoteControlProxy:           &remoteControlProxy,
			RestartAppServerOnHookChange: config.codexHooks.restartAppServerOnHookChange,
			NodeExecPath:                 config.nodeExecPath,
			EntryFilePath:                config.entryFilePath,
		},
		ErrorLog: log.New(
			runtime.stderr,
			"aih-server http: ",
			log.Ldate|log.Ltime|log.LUTC,
		),
	})
	if err != nil {
		return err
	}
	var releaseIdentity func()
	defer func() {
		if closeErr := server.Close(); closeErr != nil {
			returnErr = errors.Join(returnErr, closeErr)
			_, _ = fmt.Fprintln(runtime.stderr, "aih-server failclosed: host_resource_close_unknown; original holder retained; external controlled shutdown required")
			// Source-only protection for this candidate, not the old loaded
			// host. No main/os.Exit, identity release or new owner receipt.
			for {
				time.Sleep(time.Hour)
				goruntime.KeepAlive(server)
				goruntime.KeepAlive(releaseIdentity)
			}
		}
		if releaseIdentity != nil {
			releaseIdentity()
		}
	}()

	listener, err := runtime.listen(ctx, "tcp", config.listenAddress())
	if err != nil {
		return fmt.Errorf("监听 Go Server 地址失败: %w", err)
	}
	release, err := serveridentity.Publish(config.aiHomeDir, listener.Addr())
	if err != nil {
		_ = listener.Close()
		return fmt.Errorf("记录 Go Server 进程身份失败: %w", err)
	}
	releaseIdentity = release
	_, _ = fmt.Fprintf(
		runtime.stdout,
		"aih-server listening on http://%s\n",
		listener.Addr().String(),
	)
	return serveUntilCanceled(ctx, server, listener, runtime.stderr)
}

// serveUntilCanceled 协调 HTTP Serve 和有界优雅关闭。
func serveUntilCanceled(
	ctx context.Context,
	server *aihserver.Server,
	listener net.Listener,
	stderr io.Writer,
) error {
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()
	select {
	case err := <-serveErrors:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(
			context.Background(),
			shutdownTimeout,
		)
		defer cancel()
		shutdownErr := server.Shutdown(shutdownCtx)
		serveErr := <-serveErrors
		// 收到信号后的主动关停属于**正常退出**：必须返回 nil（退出码 0）。
		// 真机实测（2026-11-20）：plist 里 KeepAlive 是 {SuccessfulExit: false}，
		// 非零退出会被 launchd 在 ThrottleInterval(5s) 后重新拉起 —— 于是
		// "手工 kill 旧进程给新二进制腾端口" 会立刻把旧进程复活，重启随即撞上
		// "旧进程仍占用作业" 的 bootstrap 失败。连接没在限期内排空只是关闭期噪声，
		// 记录一行即可，不能升级成失败退出码。
		if shutdownErr != nil {
			_, _ = fmt.Fprintf(
				stderr,
				"aih-server 关闭未在 %s 内完成（按正常退出处理）: %v\n",
				shutdownTimeout,
				shutdownErr,
			)
		}
		// Serve 在主动关停时可能返回 ErrServerClosed，也可能因为监听器/请求
		// 被关闭而返回 context deadline/canceled；这些都不是启动失败，更不能
		// 变成非零退出码让 KeepAlive 复活旧实例。真实崩溃在 ctx 取消前的
		// select 分支已经返回，不会走到这里。
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			_, _ = fmt.Fprintf(
				stderr,
				"aih-server 关闭期间 Serve 返回错误（按正常退出处理）: %v\n",
				serveErr,
			)
		}
		return nil
	}
}

// validateCommandRuntime 防止测试或未来嵌入方遗漏操作系统依赖。
func validateCommandRuntime(runtime commandRuntime) error {
	if runtime.lookupEnv == nil ||
		runtime.userHomeDir == nil ||
		runtime.listen == nil ||
		runtime.stdout == nil ||
		runtime.stderr == nil {
		return errInvalidCommandConfig
	}
	return nil
}
