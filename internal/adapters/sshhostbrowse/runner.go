// Package sshhostbrowse 把 sshremote 的远端执行能力接到 WebUI 目录浏览的 Runner 端口。
//
// 只负责连接事实映射与错误翻译；列目录命令由 webuisshhostbrowseapi 传入 argv，
// 本包不拼 shell 字符串，也不缓存凭据。egress/反向隧道尚未在 Go 侧实现，
// 这类连接明确失败关闭，避免静默绕过 Node 的隧道语义。
package sshhostbrowse

import (
	"context"
	"errors"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshhostbrowseapi"
)

// Runner 实现 webuisshhostbrowseapi.Runner。
type Runner struct {
	HomeDir string
}

// Run 在指定连接上执行 argv，返回远端 stdout。
func (runner Runner) Run(ctx context.Context, connection webuisshhostbrowseapi.Conn, argv []string) ([]byte, error) {
	if len(connection.ReverseTunnel) > 0 {
		return nil, &webuisshhostbrowseapi.RemoteFailure{
			Code:    "ssh_tunnel_unsupported",
			Message: "该连接使用反向隧道，Go 侧暂未承接；请继续使用 Node 浏览。",
		}
	}
	if strings.TrimSpace(connection.EgressConnectionID) != "" && connection.Jump == nil {
		return nil, &webuisshhostbrowseapi.RemoteFailure{
			Code:    "ssh_egress_unresolved",
			Message: "该连接的出口连接不存在或跳板链无效。",
		}
	}
	client, err := sshremote.Dial(ctx, configFor(connection, runner.HomeDir), 0)
	if err != nil {
		return nil, translate(err)
	}
	defer func() { _ = client.Close() }()
	result, err := client.RunArgv(ctx, argv, 0)
	if err != nil {
		return nil, translate(err)
	}
	if result.Code != 0 {
		cause := sshhost.ClassifyBrowseFailure(result.Code, string(result.Stderr))
		return nil, &webuisshhostbrowseapi.RemoteFailure{Code: cause.Code, Message: cause.Message}
	}
	return result.Stdout, nil
}

func configFor(connection webuisshhostbrowseapi.Conn, homeDir string) sshremote.Config {
	config := sshremote.Config{
		Host:         connection.Host,
		Port:         connection.Port,
		User:         connection.User,
		AuthType:     connection.AuthType,
		Password:     connection.Password,
		PrivateKey:   connection.PrivateKey,
		IdentityFile: connection.IdentityFile,
		HomeDir:      homeDir,
	}
	if connection.Jump != nil {
		jump := configFor(*connection.Jump, homeDir)
		config.Jump = &jump
	}
	return config
}

func translate(err error) error {
	var remoteError *sshremote.Error
	if errors.As(err, &remoteError) && remoteError != nil {
		return &webuisshhostbrowseapi.RemoteFailure{Code: remoteError.Code, Message: remoteError.Message}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &webuisshhostbrowseapi.RemoteFailure{Code: "ssh_timeout", Message: "读取远端目录超时。"}
	}
	return &webuisshhostbrowseapi.RemoteFailure{Code: "remote_execution_failed", Message: err.Error()}
}
