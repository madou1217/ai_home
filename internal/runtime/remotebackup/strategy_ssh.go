package remotebackup

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	defaultReadyTimeout      = 20 * time.Second
	defaultKeepaliveInterval = 10 * time.Second
)

var windowsDrivePrefixPattern = regexp.MustCompile(`^[A-Za-z]:[\\/]`)

// Strategy 抽象远端备份目标的传输操作，便于 SSH/SFTP 与单测替身解耦。
type Strategy interface {
	ID() string
	Connect(ctx context.Context) error
	ReadFile(ctx context.Context, relativePath string) (content string, found bool, err error)
	WriteFile(ctx context.Context, relativePath string, content string, mode os.FileMode) error
	Close() error
}

// SSHStrategyDeps 配置 SSH/SFTP 备份策略的外部环境与首次信任（TOFU）回调。
type SSHStrategyDeps struct {
	HomeDir           string
	Env               func(string) string
	ReadyTimeout      time.Duration
	OperationTimeout  time.Duration
	KeepaliveInterval time.Duration
	OnHostKey         func(fingerprint string)
	HostKeyAlgorithms []string
}

// ExpandHome 将前导 `~` 或 `~/` 展开为指定或当前宿主用户目录。
func ExpandHome(value, homeDir string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	home := strings.TrimSpace(homeDir)
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if text == "~" {
		return home
	}
	if strings.HasPrefix(text, "~/") || strings.HasPrefix(text, `~\`) {
		return filepath.Join(home, text[2:])
	}
	return text
}

// JoinRemote 安全拼接远端 POSIX 相对路径，拒绝 `..` 目录穿越。
func JoinRemote(base, relative string) (string, error) {
	left := strings.TrimRight(strings.TrimSpace(base), "/")
	right := strings.TrimLeft(strings.TrimSpace(relative), "/")
	if right == "" {
		return left, nil
	}
	for _, seg := range strings.Split(right, "/") {
		if seg == ".." || strings.ContainsRune(seg, '\x00') {
			return "", errors.New("invalid_remote_path")
		}
	}
	return left + "/" + right, nil
}

// ResolveRemoteDir 根据远端家目录解析配置里的 remoteDir（支持 ~、绝对路径和 Windows 盘符）。
func ResolveRemoteDir(remoteDir, home string) (string, error) {
	value := strings.TrimSpace(remoteDir)
	if value == "" || value == "~" {
		return home, nil
	}
	if strings.HasPrefix(value, "~/") {
		return JoinRemote(home, value[2:])
	}
	if strings.HasPrefix(value, "/") {
		return value, nil
	}
	if windowsDrivePrefixPattern.MatchString(value) {
		return strings.ReplaceAll(value, `\`, `/`), nil
	}
	return JoinRemote(home, value)
}

// SSHBackupStrategy 通过原生 golang.org/x/crypto/ssh + SFTP v3 执行增量备份写入。
type SSHBackupStrategy struct {
	target BackupTarget
	deps   SSHStrategyDeps

	mu                  sync.Mutex
	connection          *sshBackupConnection
	connecting          *sshConnectFlight
	baseDir             string
	observedFingerprint string
}

// NewSSHBackupStrategy 构造面向单个 BackupTarget 的 SSH/SFTP 备份策略。
func NewSSHBackupStrategy(target BackupTarget, deps SSHStrategyDeps) *SSHBackupStrategy {
	return &SSHBackupStrategy{
		target: target,
		deps:   deps,
	}
}

func (s *SSHBackupStrategy) ID() string {
	return s.target.ID
}

// BaseDir 返回连接解析后的远端备份根目录。
func (s *SSHBackupStrategy) BaseDir() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.baseDir
}

// ObservedFingerprint 返回本次连接观测到的 SHA-256 十六进制主机密钥指纹。
func (s *SSHBackupStrategy) ObservedFingerprint() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.observedFingerprint
}

// Connect 建立 SSH 连接与 SFTP 会话，校验或记录主机指纹，并确保远端根目录存在。
func (s *SSHBackupStrategy) Connect(ctx context.Context) error {
	_, err := s.connectionFor(ctx)
	return err
}

// ReadFile executes on one connection generation with cancellation and a bound.
func (s *SSHBackupStrategy) ReadFile(ctx context.Context, relativePath string) (content string, found bool, err error) {
	err = s.withConnection(ctx, func(conn *sshBackupConnection) error {
		remote, e := JoinRemote(conn.baseDir, relativePath)
		if e != nil {
			return e
		}
		data, e := conn.sftp.ReadFile(remote)
		if IsNoSuchFile(e) && completeSFTPStatus(e) {
			return nil
		}
		if e != nil {
			return e
		}
		content, found = string(data), true
		return nil
	})
	return
}

// WriteFile publishes only after a complete staged write, including CLOSE ACK.
// Failure never authorizes unlinking the previous destination.
func (s *SSHBackupStrategy) WriteFile(ctx context.Context, relativePath, content string, mode os.FileMode) error {
	return s.withConnection(ctx, func(conn *sshBackupConnection) error {
		remote, err := JoinRemote(conn.baseDir, relativePath)
		if err != nil {
			return err
		}
		if err = ensureRemoteDir(conn.sftp, path.Dir(remote)); err != nil {
			return err
		}
		if mode == 0 {
			mode = 0o600
		}
		var rnd [12]byte
		if _, err = rand.Read(rnd[:]); err != nil {
			return err
		}
		temp := fmt.Sprintf("%s.tmp-%d-%s", remote, os.Getpid(), hex.EncodeToString(rnd[:]))
		created, err := conn.sftp.WriteExclusive(temp, []byte(content), mode)
		if err != nil {
			if created && completeSFTPStatus(err) && !conn.closed.Load() {
				err = errors.Join(err, conn.sftp.Remove(temp))
			}
			return err
		}
		if err = conn.sftp.ReplaceFile(temp, remote); err != nil {
			var existing *SFTPReplacementError
			if !completeSFTPStatus(err) && !errors.As(err, &existing) {
				return &SFTPReplacementError{Code: "write_outcome_unknown", RecoveryPath: temp, cause: err}
			}
			var replacement *SFTPReplacementError
			if ctx.Err() == nil && !conn.closed.Load() && completeSFTPStatus(err) && !errors.As(err, &replacement) {
				err = errors.Join(err, conn.sftp.Remove(temp))
			}
			return err
		}
		return nil
	})
}

// Close cancels any in-progress connect and wakes blocked operations without
// waiting for their RPC mutex. A later explicit call may open a new generation.
func (s *SSHBackupStrategy) Close() error {
	s.mu.Lock()
	conn, flight := s.connection, s.connecting
	s.connection = nil
	s.connecting = nil
	s.mu.Unlock()
	if flight != nil {
		flight.cancel()
	}
	return conn.close()
}

func (s *SSHBackupStrategy) buildSSHClientConfig() (*ssh.ClientConfig, *string, error) {
	getenv := s.deps.Env
	if getenv == nil {
		getenv = os.Getenv
	}
	var authMethods []ssh.AuthMethod

	if idFile := ExpandHome(s.target.IdentityFile, s.deps.HomeDir); idFile != "" {
		if _, err := os.Stat(idFile); err != nil {
			return nil, nil, fmt.Errorf("SSH 私钥不存在：%s", idFile)
		}
		keyBytes, err := os.ReadFile(idFile)
		if err != nil {
			return nil, nil, fmt.Errorf("读取 SSH 私钥失败：%s: %w", idFile, err)
		}
		signer, err := ssh.ParsePrivateKey(keyBytes)
		if err != nil {
			return nil, nil, fmt.Errorf("解析 SSH 私钥失败：%s: %w", idFile, err)
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	}
	if s.target.PasswordEnv != "" {
		if password := getenv(s.target.PasswordEnv); password != "" {
			authMethods = append(
				authMethods,
				ssh.Password(password),
				ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
					answers := make([]string, len(questions))
					for i := range answers {
						answers[i] = password
					}
					return answers, nil
				}),
			)
		}
	}
	if len(authMethods) == 0 {
		return nil, nil, fmt.Errorf("备份目标 %s 没有可用凭据：用 --key 指定私钥，或配置 passwordEnv", s.target.ID)
	}

	var observed string
	timeout := s.deps.ReadyTimeout
	if timeout <= 0 {
		timeout = defaultReadyTimeout
	}
	expectedFP := strings.ToLower(strings.TrimSpace(s.target.HostKeyFingerprint))

	cfg := &ssh.ClientConfig{
		User: s.target.Username,
		Auth: authMethods,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			sum := sha256.Sum256(key.Marshal())
			observed = strings.ToLower(hex.EncodeToString(sum[:]))
			if expectedFP != "" && observed != expectedFP {
				return fmt.Errorf("SSH 主机指纹不匹配: got %s want %s", observed, expectedFP)
			}
			return nil
		},
		Timeout: timeout,
	}
	if len(s.deps.HostKeyAlgorithms) > 0 {
		cfg.HostKeyAlgorithms = append([]string(nil), s.deps.HostKeyAlgorithms...)
	}
	return cfg, &observed, nil
}

func ensureRemoteDir(sftpCli *sftpClient, directory string) error {
	clean := strings.TrimSpace(directory)
	if clean == "" {
		return nil
	}
	absolute := strings.HasPrefix(clean, "/")
	parts := strings.Split(clean, "/")
	current := ""
	if !absolute {
		current = "."
	}
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		if current == "" {
			current = "/" + part
		} else if current == "." {
			current = part
		} else {
			current = current + "/" + part
		}
		if err := sftpCli.Mkdir(current); err != nil {
			// Windows 盘符根（如 C:）或已存在目录，mkdir 可能报错，stat 确认为目录即可继续。
			attr, statErr := sftpCli.Stat(current)
			if statErr == nil && (!attr.HasPermissions || attr.IsDir()) {
				continue
			}
			return err
		}
	}
	return nil
}
