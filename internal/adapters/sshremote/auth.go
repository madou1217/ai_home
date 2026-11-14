package sshremote

import (
	"errors"
	"io"
	"net"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
)

// authMethods 按认证方式构造 ssh.AuthMethod；agent 会多返回一个需要随客户端关闭的连接。
func (config Config) authMethods() ([]ssh.AuthMethod, []io.Closer, error) {
	switch config.authType() {
	case AuthPassword:
		// 同时支持 password 与 keyboard-interactive：远端 sshd 常把口令放在后者。
		password := ssh.Password(config.Password)
		keyboard := ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for index := range answers {
				answers[index] = config.Password
			}
			return answers, nil
		})
		return []ssh.AuthMethod{password, keyboard}, nil, nil
	case AuthKey:
		signer, err := parsePrivateKey([]byte(config.PrivateKey), "内联私钥")
		if err != nil {
			return nil, nil, err
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil, nil
	case AuthKeyFile:
		signer, err := config.identityFileSigner()
		if err != nil {
			return nil, nil, err
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil, nil
	case AuthAgent:
		// 与 OpenSSH 一致：先试 agent，再试 ~/.ssh 下的默认私钥。
		// systemd 拉起的服务常带着一个空的 SSH_AUTH_SOCK（登录会话的 agent
		// 已重启），这时只认 agent 会让「测试连接」（ssh CLI）成功、浏览失败。
		var methods []ssh.AuthMethod
		var closers []io.Closer
		method, closer, signerCount, agentErr := agentMethod()
		if agentErr == nil && signerCount > 0 {
			methods = append(methods, method)
			closers = append(closers, closer)
		}
		methods = append(methods, config.defaultIdentityMethods()...)
		if len(methods) == 0 {
			if agentErr != nil {
				return nil, nil, agentErr
			}
			return nil, nil, newError(CodeAuthFailed, "ssh-agent 没有可用身份，且未找到可用的默认私钥", nil)
		}
		return methods, closers, nil
	default:
		return nil, nil, newError(CodeInvalidConfig, "不支持的 SSH 认证方式: "+config.authType(), nil)
	}
}

// identityFileSigner 读取 key-file 认证的私钥文件。
//
// 路径规则（必须在 ~/.ssh 内、必须是普通文件、权限不得对组或其他用户开放）
// 直接复用 sshhost.ResolveIdentityFilePath，与 Node 的 ssh-identity-file.js 一致。
func (config Config) identityFileSigner() (ssh.Signer, error) {
	home, err := config.homeDir()
	if err != nil {
		return nil, err
	}
	resolved, err := sshhost.ResolveIdentityFilePath(config.IdentityFile, sshhost.IdentityOptions{HomeDir: home})
	if err != nil {
		var identityErr *sshhost.IdentityFileError
		if errors.As(err, &identityErr) {
			return nil, newError(CodeKeyInvalid, identityFileMessage(identityErr.Code), err)
		}
		return nil, newError(CodeKeyInvalid, "SSH 身份文件不可用", err)
	}
	body, err := os.ReadFile(resolved)
	if err != nil {
		return nil, newError(CodeKeyInvalid, "SSH 身份文件无法读取", err)
	}
	return parsePrivateKey(body, "身份文件")
}

// identityFileMessage 把身份文件错误码翻成可执行的中文提示。
func identityFileMessage(code string) string {
	switch code {
	case sshhost.IdentityFileRequired:
		return "SSH 身份文件路径不能为空"
	case sshhost.IdentityFileMustBeAbsolute:
		return "SSH 身份文件路径必须是绝对路径或以 ~/ 开头"
	case sshhost.IdentityFileOutsideSSHDir:
		return "SSH 身份文件必须位于当前用户的 ~/.ssh 目录内"
	case sshhost.IdentityFileNotFound:
		return "SSH 身份文件不存在"
	case sshhost.IdentityFileNotRegularFile:
		return "SSH 身份文件必须是普通文件"
	case sshhost.IdentityFilePermissionsTooOpen:
		return "SSH 身份文件权限过宽，不允许组或其他用户访问"
	default:
		return "SSH 身份文件无效"
	}
}

// parsePrivateKey 解析未加密私钥；加密私钥在 Go 侧暂不支持，给出明确提示。
func parsePrivateKey(body []byte, source string) (ssh.Signer, error) {
	signer, err := ssh.ParsePrivateKey(body)
	if err == nil {
		return signer, nil
	}
	var passphraseMissing *ssh.PassphraseMissingError
	if errors.As(err, &passphraseMissing) {
		return nil, newError(CodeKeyInvalid, source+"已加密，Go 传输暂不支持带口令的私钥，请改用未加密私钥或 ssh-agent", err)
	}
	return nil, newError(CodeKeyInvalid, source+"无法解析", err)
}

// defaultIdentityMethods 返回 ~/.ssh 下 OpenSSH 默认私钥的认证方法。
//
// 仅在 agent 认证之后追加：agent 没有身份或身份被远端拒绝时，行为与
// ssh CLI 的默认身份文件回退一致。缺失、权限不合格或加密的私钥直接跳过。
func (config Config) defaultIdentityMethods() []ssh.AuthMethod {
	home, err := config.homeDir()
	if err != nil {
		return nil
	}
	methods := make([]ssh.AuthMethod, 0, 3)
	for _, name := range []string{"id_ed25519", "id_ecdsa", "id_rsa"} {
		resolved, err := sshhost.ResolveIdentityFilePath("~/.ssh/"+name, sshhost.IdentityOptions{HomeDir: home})
		if err != nil {
			continue
		}
		body, err := os.ReadFile(resolved)
		if err != nil {
			continue
		}
		signer, err := ssh.ParsePrivateKey(body)
		if err != nil {
			continue
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	return methods
}

// agentMethod 连接 SSH_AUTH_SOCK；返回的 closer 由 Client 统一关闭。
//
// 返回 signerCount 供调用方跳过空 agent：x/crypto 在回调返回空身份时会直接
// 结束 publickey 尝试，后面的默认私钥就再也试不到了。
func agentMethod() (ssh.AuthMethod, io.Closer, int, error) {
	socket := strings.TrimSpace(os.Getenv("SSH_AUTH_SOCK"))
	if socket == "" {
		return nil, nil, 0, newError(CodeAgentUnavailable, "SSH_AUTH_SOCK 未设置，agent 认证不可用", nil)
	}
	conn, err := net.Dial("unix", socket)
	if err != nil {
		return nil, nil, 0, newError(CodeAgentUnavailable, "无法连接 ssh-agent", err)
	}
	client := agent.NewClient(conn)
	signers, err := client.Signers()
	if err != nil {
		_ = conn.Close()
		return nil, nil, 0, newError(CodeAgentUnavailable, "ssh-agent 无法列出身份", err)
	}
	if len(signers) == 0 {
		_ = conn.Close()
		return nil, nil, 0, nil
	}
	return ssh.PublicKeysCallback(client.Signers), conn, len(signers), nil
}
