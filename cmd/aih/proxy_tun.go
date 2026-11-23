package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/tuningress"
)

// startTUN 把租约入口挂成显式 TUN 网络层接管。dry-run 只做 Render/Check，
// 不创建 TUN、不改路由；真正 Start 还要求当前进程已有 root/管理员权限。
func startTUN(ctx context.Context, cmdRuntime commandRuntime, lease *serveLease, options proxyServeOptions) (func(), error) {
	upstream, err := url.Parse(lease.httpURL)
	if err != nil || upstream == nil || upstream.User == nil {
		return nil, errors.New("TUN 上游入口无效")
	}
	password, _ := upstream.User.Password()
	port, err := strconv.Atoi(upstream.Port())
	if err != nil || port <= 0 {
		return nil, errors.New("TUN 上游端口无效")
	}
	home, err := resolveAIHomeDir(cmdRuntime)
	if err != nil {
		return nil, err
	}
	binary := strings.TrimSpace(options.tunSingBox)
	if binary == "" {
		binary, err = tuningress.DiscoverBinary()
		if err != nil {
			return nil, err
		}
	}
	addresses := make([]string, 0, 2)
	for _, item := range strings.Split(options.tunAddresses, ",") {
		if item = strings.TrimSpace(item); item != "" {
			addresses = append(addresses, item)
		}
	}
	logFile := strings.TrimSpace(options.tunLogFile)
	if logFile == "" {
		logFile = filepath.Join(home, "logs", "proxy-tun.log")
	}
	tunOptions := tuningress.Options{
		UpstreamHost:     upstream.Hostname(),
		UpstreamPort:     port,
		UpstreamUsername: upstream.User.Username(),
		UpstreamPassword: password,
		InterfaceName:    strings.TrimSpace(options.tunInterface),
		Addresses:        addresses,
		MTU:              options.tunMTU,
		AutoRoute:        !options.tunNoAutoRoute,
		StrictRoute:      options.tunStrictRoute,
		Stack:            strings.TrimSpace(options.tunStack),
		LogFile:          logFile,
		DirectDNSServer:  strings.TrimSpace(options.tunDNS),
		SingBoxPath:      binary,
	}
	if err := tuningress.Check(ctx, tunOptions); err != nil {
		return nil, fmt.Errorf("TUN 配置校验失败: %w", err)
	}
	if options.tunDryRun {
		_, _ = fmt.Fprintf(cmdRuntime.stdout, "[aih] TUN 配置校验通过（dry-run）：binary=%s interface=%s autoRoute=%v\n", binary, options.tunInterface, !options.tunNoAutoRoute)
		return nil, nil
	}
	if !tuningress.Privileged() {
		return nil, errors.New("TUN 需要 root/管理员权限；请使用 sudo 或管理员终端重新运行")
	}
	tunRuntime, err := tuningress.Start(ctx, tuningress.Options{
		UpstreamHost:     tunOptions.UpstreamHost,
		UpstreamPort:     tunOptions.UpstreamPort,
		UpstreamUsername: tunOptions.UpstreamUsername,
		UpstreamPassword: tunOptions.UpstreamPassword,
		InterfaceName:    tunOptions.InterfaceName,
		Addresses:        tunOptions.Addresses,
		MTU:              tunOptions.MTU,
		AutoRoute:        tunOptions.AutoRoute,
		StrictRoute:      tunOptions.StrictRoute,
		Stack:            tunOptions.Stack,
		LogFile:          tunOptions.LogFile,
		DirectDNSServer:  tunOptions.DirectDNSServer,
		SingBoxPath:      tunOptions.SingBoxPath,
		AllowStart:       true,
	})
	if err != nil {
		return nil, err
	}
	_, _ = fmt.Fprintf(cmdRuntime.stdout, "[aih] TUN 已启动：pid=%d binary=%s autoRoute=%v\n", tunRuntime.PID(), binary, tunOptions.AutoRoute)
	return func() {
		if closeErr := tunRuntime.Close(); closeErr != nil {
			_, _ = fmt.Fprintf(cmdRuntime.stderr, "[aih] TUN 停止失败：%v\n", closeErr)
		}
	}, nil
}
