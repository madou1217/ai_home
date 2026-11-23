package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/proxytransport"
)

// openSSHTransport 读取本机 SSH 连接记录，建立到远端 AIH loopback 的本地转发。
// 只搬运 direct-tcpip 字节，不执行远端命令；具体转发生命周期由 proxytransport 管理。
func openSSHTransport(ctx context.Context, runtime commandRuntime, connectionID, listenAddress, remoteAddress string) (proxytransport.Transport, error) {
	connectionID = strings.TrimSpace(connectionID)
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return nil, err
	}
	databasePath, err := appstate.DatabasePath(home)
	if err != nil {
		return nil, err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, "ssh_connections")
	if err != nil || !found {
		return nil, errors.New("本机没有可用的 SSH 连接记录")
	}
	hostHome, err := runtime.userHomeDir()
	if err != nil || strings.TrimSpace(hostHome) == "" {
		return nil, errors.New("无法解析本机用户目录")
	}
	resolver, err := proxytransport.NewResolver(proxytransport.ResolverOptions{
		Connections: []byte(raw),
		KnownHosts:  readSSHKnownHosts(ctx, databasePath),
		HomeDir:     hostHome,
	})
	if err != nil {
		return nil, err
	}
	initial, err := resolver.Open(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	connector, err := proxytransport.NewReconnectingConnector(initial, func(factoryCtx context.Context) (proxytransport.Connector, error) {
		return resolver.Open(factoryCtx, connectionID)
	})
	if err != nil {
		_ = initial.Close()
		return nil, err
	}
	return proxytransport.NewSSH(ctx, connector, proxytransport.SSHOptions{
		RemoteAddress: remoteAddress,
		ListenAddress: listenAddress,
	})
}

func readSSHKnownHosts(ctx context.Context, databasePath string) map[string]string {
	records := map[string]string{}
	raw, found, err := appstate.ReadKV(ctx, databasePath, "ssh_known_hosts")
	if err != nil || !found {
		return records
	}
	var stored map[string]struct {
		Fingerprint string `json:"fingerprint"`
	}
	if json.Unmarshal([]byte(raw), &stored) != nil {
		return records
	}
	for id, record := range stored {
		if value := strings.TrimSpace(record.Fingerprint); value != "" {
			records[strings.ToLower(id)] = value
		}
	}
	return records
}
