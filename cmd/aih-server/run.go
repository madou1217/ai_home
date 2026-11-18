package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	goruntime "runtime"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/runtime/distributioninstall"
	"github.com/madou1217/ai_home/internal/runtime/nodesupervisor"
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
	managementKey := config.managementKey
	clientKey := config.clientKey
	// superviseNode：Go 是服务主体，Node 只作为子进程承接尚未迁移的 WebUI 路由。
	// 先选好 Node 私有端口再装配 Handler，监听成功后才真正拉起 Node。
	nodeBaseURL := config.nodeBaseURL
	frontDoorBaseURL := config.frontDoorBaseURL()
	var nodeSupervisor *nodesupervisor.Supervisor
	if config.superviseNode {
		supervisor, baseURL, err := nodesupervisor.Prepare(nodesupervisor.Options{
			AIHomeDir:     config.aiHomeDir,
			NodeExec:      config.nodeExecPath,
			EntryFile:     config.entryFilePath,
			ExternalURL:   config.selfBaseURL(),
			ManagementKey: managementKey,
			ClientKey:     clientKey,
			Logf:          log.New(runtime.stderr, "aih-server node: ", log.Ldate|log.Ltime|log.LUTC).Printf,
			Stdout:        runtime.stderr,
			Stderr:        runtime.stderr,
		})
		if err != nil {
			return fmt.Errorf("准备 Node 子进程失败: %w", err)
		}
		nodeSupervisor = supervisor
		nodeBaseURL = baseURL
		frontDoorBaseURL = baseURL
	}
	traceRemoteControl := config.codexHooks.traceRemoteControl
	remoteControlProxy := config.codexHooks.remoteControlProxy
	// 出站语义统一在进程入口装一次：环境代理不可达时改直连（显式代理仍失败关闭）。
	aihserver.InstallOutboundFallback()
	desktopOwner, _ := runtime.lookupEnv("AIH_DESKTOP_TRANSLATION_OWNER")
	server, err := aihserver.New(ctx, aihserver.Options{
		AIHomeDir:                  config.aiHomeDir,
		NodeBaseURL:                nodeBaseURL,
		SelfBaseURL:                config.selfBaseURL(),
		DesktopManagedByHost:       desktopOwner == "node" && !config.superviseNode,
		FrontDoorBaseURL:           frontDoorBaseURL,
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
		// The writer lease belongs to server.Close. Keep it while the Node
		// child drains, so an offline installer cannot overlap its last writes.
		if nodeSupervisor != nil {
			if drainErr := nodeSupervisor.Stop(); drainErr != nil {
				// An uncertain direct-child/pump drain cannot release the
				// original writer lease or publish a successful handoff.
				returnErr = errors.Join(returnErr, drainErr)
				_, _ = fmt.Fprintln(runtime.stderr, "aih-server failclosed: node_supervisor_direct_child_drain_unknown; original holder retained; external controlled shutdown required")
				// Keep the concrete holder, identity release closure and
				// supervisor reachable across every sleep. An empty select
				// alone is neither a GC root guarantee nor deadlock-safe.
				// This deliberately ignores the already-canceled shutdown
				// context; external kill/crash still ends the OS lease.
				for {
					time.Sleep(time.Hour)
					goruntime.KeepAlive(server)
					goruntime.KeepAlive(releaseIdentity)
					goruntime.KeepAlive(nodeSupervisor)
				}
			}
		}
		if closeErr := server.Close(); closeErr != nil {
			returnErr = errors.Join(returnErr, closeErr)
			_, _ = fmt.Fprintln(runtime.stderr, "aih-server failclosed: host_resource_close_unknown; original holder retained; external controlled shutdown required")
			// Source-only protection for this candidate, not the old loaded
			// host. No main/os.Exit, identity release or new owner receipt.
			for {
				time.Sleep(time.Hour)
				goruntime.KeepAlive(server)
				goruntime.KeepAlive(releaseIdentity)
				goruntime.KeepAlive(nodeSupervisor)
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
	// Go 已在监听：此时拉起 Node，它启动期间的账号同步能立刻打到管理面。
	if nodeSupervisor != nil {
		nodeSupervisor.Start()
	}
	return serveUntilCanceled(ctx, server, listener, nodeSupervisor)
}

// serveUntilCanceled 协调 HTTP Serve 和有界优雅关闭。
func serveUntilCanceled(
	ctx context.Context,
	server *aihserver.Server,
	listener net.Listener,
	nodeSupervisors ...*nodesupervisor.Supervisor,
) error {
	inhibit := func() {
		for _, supervisor := range nodeSupervisors {
			supervisor.Inhibit()
		}
	}
	defer inhibit()
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()
	select {
	case err := <-serveErrors:
		return err
	case <-ctx.Done():
		// Stop new starts before HTTP shutdown; this closes only the
		// original supervisor's admission, not all native/chat writers.
		inhibit()
		shutdownCtx, cancel := context.WithTimeout(
			context.Background(),
			shutdownTimeout,
		)
		defer cancel()
		shutdownErr := server.Shutdown(shutdownCtx)
		serveErr := <-serveErrors
		return errors.Join(shutdownErr, serveErr)
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
