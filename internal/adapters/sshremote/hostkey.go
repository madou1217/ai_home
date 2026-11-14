package sshremote

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// knownHostsWriteMu 串行化 known_hosts 追加：多个并发拨号可能同时首次见到同一主机。
var knownHostsWriteMu sync.Mutex

// hostKeyCallback 返回 accept-new 语义的主机密钥校验器：
//
//   - known_hosts 里没有该主机 → 记录一行并放行（与 StrictHostKeyChecking=accept-new 一致）；
//   - 已记录且一致 → 放行；
//   - 已记录但不一致、或被 @revoked 标记 → 拒绝。
//
// known_hosts 文件不存在时会连同父目录一起创建（0700 / 0600）。
func (config Config) hostKeyCallback() (ssh.HostKeyCallback, error) {
	if config.HostKeyCallback != nil {
		return config.HostKeyCallback, nil
	}
	path, err := config.knownHostsPath()
	if err != nil {
		return nil, err
	}
	if err := ensureKnownHostsFile(path); err != nil {
		return nil, newError(CodeInvalidConfig, "无法准备 known_hosts 文件", err)
	}
	base, err := knownhosts.New(path)
	if err != nil {
		return nil, newError(CodeInvalidConfig, "known_hosts 无法解析: "+path, err)
	}
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		verifyErr := base(hostname, remote, key)
		if verifyErr == nil {
			return nil
		}
		var keyErr *knownhosts.KeyError
		if !errors.As(verifyErr, &keyErr) {
			return fmt.Errorf("SSH 主机密钥校验失败: %w", verifyErr)
		}
		if len(keyErr.Want) == 0 {
			// 未知主机：accept-new 记录后放行。
			return appendKnownHost(path, hostname, key)
		}
		// x/crypto/knownhosts 把同一主机记录过的任何密钥都当作期望值；
		// OpenSSH（以及 Node 的 ssh2）按密钥类型分别记录。主机只记录过
		// ED25519 时，服务端同时提供的 RSA/ECDSA 主机密钥属于尚未记录的
		// 类型，应 accept-new 记录，而不是误报“指纹变化”。只有同一类型
		// 已记录且不匹配时才是真正的主机密钥变更，必须拒绝。
		for _, want := range keyErr.Want {
			if want.Key != nil && want.Key.Type() == key.Type() {
				return fmt.Errorf("SSH 主机密钥校验失败: %w", verifyErr)
			}
		}
		return appendKnownHost(path, hostname, key)
	}, nil
}

// knownHostsPath 解析 known_hosts 位置；相对路径按 home 展开。
func (config Config) knownHostsPath() (string, error) {
	path := strings.TrimSpace(config.KnownHostsPath)
	if path == "" {
		home, err := config.homeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".ssh", "known_hosts"), nil
	}
	if filepath.IsAbs(path) {
		return path, nil
	}
	home, err := config.homeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, path), nil
}

// ensureKnownHostsFile 确保父目录与文件存在；已存在时不改权限、不改内容。
func ensureKnownHostsFile(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	return file.Close()
}

// appendKnownHost 追加一行标准 known_hosts 记录。
func appendKnownHost(path, hostname string, key ssh.PublicKey) error {
	line := knownhosts.Line([]string{knownhosts.Normalize(hostname)}, key)
	knownHostsWriteMu.Lock()
	defer knownHostsWriteMu.Unlock()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("记录 SSH 主机密钥失败: %w", err)
	}
	defer file.Close()
	if _, err := file.WriteString(line + "\n"); err != nil {
		return fmt.Errorf("记录 SSH 主机密钥失败: %w", err)
	}
	return nil
}
