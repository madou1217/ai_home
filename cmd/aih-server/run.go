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
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/host/aihserver"
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
}

// defaultCommandRuntime 返回生产命令使用的操作系统适配器。
func defaultCommandRuntime() commandRuntime {
	listenConfig := &net.ListenConfig{}
	return commandRuntime{
		lookupEnv:   os.LookupEnv,
		userHomeDir: os.UserHomeDir,
		listen:      listenConfig.Listen,
		stdout:      os.Stdout,
		stderr:      os.Stderr,
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
	managementKey := config.managementKey
	clientKey := config.clientKey
	server, err := aihserver.New(ctx, aihserver.Options{
		AIHomeDir:        config.aiHomeDir,
		ManagementKey:    func() string { return managementKey },
		ClientKey:        func() string { return clientKey },
		ModelDiscoverers: runtime.models,
		ErrorLog: log.New(
			runtime.stderr,
			"aih-server http: ",
			log.Ldate|log.Ltime|log.LUTC,
		),
	})
	if err != nil {
		return err
	}
	defer func() {
		returnErr = errors.Join(returnErr, server.Close())
	}()

	listener, err := runtime.listen(ctx, "tcp", config.listenAddress())
	if err != nil {
		return fmt.Errorf("监听 Go Server 地址失败: %w", err)
	}
	_, _ = fmt.Fprintf(
		runtime.stdout,
		"aih-server listening on http://%s\n",
		listener.Addr().String(),
	)
	return serveUntilCanceled(ctx, server, listener)
}

// serveUntilCanceled 协调 HTTP Serve 和有界优雅关闭。
func serveUntilCanceled(
	ctx context.Context,
	server *aihserver.Server,
	listener net.Listener,
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
