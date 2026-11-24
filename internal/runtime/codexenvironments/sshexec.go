package codexenvironments

import (
	"context"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

// SSHRemoteExecutor 用 AIH 自己的 SSH 拨号能力执行远端探测命令。
//
// 它把本包的 Connection 适配成 sshremote.Config（复用 AIH 的凭据、known_hosts
// 与跳板链），因此探测走的链路与用户在 AIH 里点"测试连接"完全一致。
type SSHRemoteExecutor struct {
	// HomeDir 用于 ~ 展开与默认 known_hosts；为空时由 sshremote 取当前用户目录。
	HomeDir string
	// OutputLimit 是单次探测保留的输出上限，默认 8KiB。
	OutputLimit int
}

const defaultProbeOutputLimit = 8 * 1024

// RunCommand 实现 SSHDialer。
func (executor SSHRemoteExecutor) RunCommand(ctx context.Context, connection Connection, script string) (string, string, error) {
	config, err := toSSHConfig(connection, executor.HomeDir)
	if err != nil {
		return "", "", err
	}
	client, err := sshremote.Dial(ctx, config, 0)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = client.Close() }()
	limit := executor.OutputLimit
	if limit <= 0 {
		limit = defaultProbeOutputLimit
	}
	result, err := client.Run(ctx, script, limit)
	stdout := TrimOutput(string(result.Stdout))
	stderr := TrimOutput(string(result.Stderr))
	if err != nil {
		return stdout, stderr, err
	}
	if result.Code != 0 {
		return stdout, firstNonEmpty(stderr, "远端命令退出码非 0"), exitError(result.Code)
	}
	return stdout, stderr, nil
}

type exitError int

func (e exitError) Error() string {
	return "远端命令退出码 " + strconv.Itoa(int(e))
}

// toSSHConfig 把本包的连接事实转换为 sshremote 的拨号配置。
func toSSHConfig(connection Connection, homeDir string) (sshremote.Config, error) {
	port := connectionPort(connection)
	config := sshremote.Config{
		Host:         strings.TrimSpace(connection.Host),
		Port:         port,
		User:         strings.TrimSpace(connection.User),
		AuthType:     connection.AuthType,
		IdentityFile: strings.TrimSpace(connection.IdentityFile),
		HomeDir:      homeDir,
	}
	if strings.TrimSpace(config.AuthType) == "" {
		config.AuthType = AuthAgent
	}
	if connection.Jump != nil {
		jump, err := toSSHConfig(*connection.Jump, homeDir)
		if err != nil {
			return sshremote.Config{}, err
		}
		config.Jump = &jump
	}
	return config, nil
}
