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
	client              *ssh.Client
	sftp                *sftpClient
	baseDir             string
	connected           bool
	observedFingerprint string
	keepaliveStop       chan struct{}
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
	s.mu.Lock()
	if s.connected {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	config, observedPtr, err := s.buildSSHClientConfig()
	if err != nil {
		return err
	}

	timeout := s.deps.ReadyTimeout
	if timeout <= 0 {
		timeout = defaultReadyTimeout
	}
	port := s.target.Port
	if port <= 0 {
		port = 22
	}
	address := net.JoinHostPort(s.target.Host, fmt.Sprintf("%d", port))
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return err
	}

	_ = conn.SetDeadline(time.Now().Add(timeout))
	handshakeDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-handshakeDone:
		}
	}()

	sshConn, chans, reqs, err := ssh.NewClientConn(conn, address, config)
	close(handshakeDone)
	if err != nil {
		_ = conn.Close()
		return err
	}
	_ = conn.SetDeadline(time.Time{})

	client := ssh.NewClient(sshConn, chans, reqs)
	sftpCli, err := newSFTPClient(client)
	if err != nil {
		_ = client.Close()
		return err
	}

	home, err := sftpCli.Realpath(".")
	if err != nil {
		_ = sftpCli.Close()
		_ = client.Close()
		return err
	}
	baseDir, err := ResolveRemoteDir(s.target.RemoteDir, home)
	if err != nil {
		_ = sftpCli.Close()
		_ = client.Close()
		return err
	}
	if err := ensureRemoteDir(sftpCli, baseDir); err != nil {
		_ = sftpCli.Close()
		_ = client.Close()
		return err
	}

	observed := *observedPtr
	keepaliveStop := make(chan struct{})
	keepaliveInterval := s.deps.KeepaliveInterval
	if keepaliveInterval <= 0 {
		keepaliveInterval = defaultKeepaliveInterval
	}
	go runSSHKeepalive(client, keepaliveInterval, keepaliveStop)

	s.mu.Lock()
	s.client = client
	s.sftp = sftpCli
	s.baseDir = baseDir
	s.observedFingerprint = observed
	s.connected = true
	s.keepaliveStop = keepaliveStop
	s.mu.Unlock()

	if s.target.HostKeyFingerprint == "" && observed != "" && s.deps.OnHostKey != nil {
		s.deps.OnHostKey(observed)
	}
	return nil
}

// ReadFile 读取远端相对路径文件；文件不存在返回 found=false, err=nil。
func (s *SSHBackupStrategy) ReadFile(ctx context.Context, relativePath string) (string, bool, error) {
	if err := s.Connect(ctx); err != nil {
		return "", false, err
	}
	s.mu.Lock()
	baseDir := s.baseDir
	sftpCli := s.sftp
	s.mu.Unlock()

	remote, err := JoinRemote(baseDir, relativePath)
	if err != nil {
		return "", false, err
	}
	content, err := sftpCli.ReadFile(remote)
	if err != nil {
		if IsNoSuchFile(err) {
			return "", false, nil
		}
		return "", false, err
	}
	return string(content), true, nil
}

// WriteFile 先写临时文件再 rename 到目标路径（含 Windows 覆盖回退），避免远端出现半截文件。
func (s *SSHBackupStrategy) WriteFile(ctx context.Context, relativePath string, content string, mode os.FileMode) error {
	if err := s.Connect(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	baseDir := s.baseDir
	sftpCli := s.sftp
	s.mu.Unlock()

	remote, err := JoinRemote(baseDir, relativePath)
	if err != nil {
		return err
	}
	dir := path.Dir(remote)
	if err := ensureRemoteDir(sftpCli, dir); err != nil {
		return err
	}
	if mode == 0 {
		mode = 0o600
	}
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	temp := fmt.Sprintf("%s.tmp-%d-%s", remote, os.Getpid(), hex.EncodeToString(rnd[:]))

	if err := sftpCli.WriteFile(temp, []byte(content), mode); err != nil {
		_ = sftpCli.Remove(temp)
		return err
	}
	if err := sftpCli.Rename(temp, remote); err != nil {
		// Windows OpenSSH 的 SFTP 不允许 rename 直接覆盖已存在文件。
		_ = sftpCli.Remove(remote)
		if retryErr := sftpCli.Rename(temp, remote); retryErr != nil {
			_ = sftpCli.Remove(temp)
			return retryErr
		}
	}
	return nil
}

// Close 关闭 SFTP 子系统与底层 SSH 连接。
func (s *SSHBackupStrategy) Close() error {
	s.mu.Lock()
	sftpCli := s.sftp
	client := s.client
	keepaliveStop := s.keepaliveStop
	s.sftp = nil
	s.client = nil
	s.keepaliveStop = nil
	s.connected = false
	s.mu.Unlock()

	if keepaliveStop != nil {
		close(keepaliveStop)
	}
	var errs []error
	if sftpCli != nil {
		errs = append(errs, sftpCli.Close())
	}
	if client != nil {
		errs = append(errs, client.Close())
	}
	return errors.Join(errs...)
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

func runSSHKeepalive(client *ssh.Client, interval time.Duration, stop <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	missed := 0
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
			if err != nil {
				missed++
				if missed >= 3 {
					_ = client.Close()
					return
				}
			} else {
				missed = 0
			}
		}
	}
}
