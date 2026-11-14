package sshremote

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
)

// DefaultTimeout 与 Node 探测接口的 12s 上限一致；调用方仍可显式传入。
const DefaultTimeout = sshhost.DefaultProbeTimeout

// Client 是一条已认证的 SSH 连接。它可以在多个 goroutine 里并发开会话，
// 但 Close 之后不能再使用。
type Client struct {
	connection net.Conn
	client     *ssh.Client
	closers    []io.Closer
}

// Dial 建立 SSH 连接：TCP 拨号、握手、认证都受 ctx 与 timeout 约束。
//
// timeout <= 0 时用 DefaultTimeout；超时、取消、认证失败、主机密钥不匹配
// 都返回带错误码的 *Error，调用方不需要解析文本。
func Dial(ctx context.Context, config Config, timeout time.Duration) (*Client, error) {
	return dial(ctx, config, timeout, 0)
}

const maxJumpDepth = 5

func dial(ctx context.Context, config Config, timeout time.Duration, depth int) (*Client, error) {
	if depth > maxJumpDepth {
		return nil, newError(CodeInvalidConfig, "SSH 跳板层数超过上限", nil)
	}
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	user, err := config.userName()
	if err != nil {
		return nil, err
	}
	methods, closers, err := config.authMethods()
	if err != nil {
		return nil, err
	}
	hostKeyCallback, err := config.hostKeyCallback()
	if err != nil {
		closeAll(closers)
		return nil, err
	}

	address := config.address()
	var connection net.Conn
	if config.Jump != nil {
		jump, jumpErr := dial(ctx, *config.Jump, timeout, depth+1)
		if jumpErr != nil {
			closeAll(closers)
			return nil, jumpErr
		}
		closers = append(closers, jump)
		connection, err = jump.client.Dial("tcp", address)
	} else {
		dialer := net.Dialer{Timeout: timeout}
		connection, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		closeAll(closers)
		return nil, classifyDialError(ctx, err)
	}

	// 握手的截止时间独立于 TCP 拨号：对端接受连接后不发言同样要超时。
	deadline := time.Now().Add(timeout)
	_ = connection.SetDeadline(deadline)
	handshakeDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = connection.Close()
		case <-handshakeDone:
		}
	}()

	clientConfig := &ssh.ClientConfig{
		User:            user,
		Auth:            methods,
		HostKeyCallback: hostKeyCallback,
		Timeout:         timeout,
	}
	if len(config.HostKeyAlgorithms) > 0 {
		clientConfig.HostKeyAlgorithms = append([]string(nil), config.HostKeyAlgorithms...)
	}
	clientConnection, channels, requests, handshakeErr := ssh.NewClientConn(connection, address, clientConfig)
	close(handshakeDone)
	if handshakeErr != nil {
		_ = connection.Close()
		closeAll(closers)
		return nil, classifyDialError(ctx, handshakeErr)
	}
	_ = connection.SetDeadline(time.Time{})
	return &Client{
		connection: connection,
		client:     ssh.NewClient(clientConnection, channels, requests),
		closers:    closers,
	}, nil
}

// Close 关闭 SSH 连接与 agent socket。
func (client *Client) Close() error {
	if client == nil {
		return nil
	}
	var errs []error
	if client.client != nil {
		errs = append(errs, client.client.Close())
	} else if client.connection != nil {
		errs = append(errs, client.connection.Close())
	}
	for _, closer := range client.closers {
		errs = append(errs, closer.Close())
	}
	return errors.Join(errs...)
}

// Result 是一次远端命令的执行结果；Truncated 表示输出触及上限被截断。
type Result struct {
	Code      int
	Stdout    []byte
	Stderr    []byte
	Truncated bool
}

// RunArgv 逐项引用 argv 后在远端执行，返回合并后的输出。
//
// 参数不会被拼成未转义的 shell 字符串：每个元素都经过 POSIX 单引号引用，
// 空白、单引号与重定向符都只作为普通字符。
func (client *Client) RunArgv(ctx context.Context, argv []string, limit int) (Result, error) {
	command, err := QuoteArgv(argv)
	if err != nil {
		return Result{}, err
	}
	return client.Run(ctx, command, limit)
}

// Run 执行一条已经构造好的远端命令，输出超过 limit 字节时截断。
// limit <= 0 表示不限制。
func (client *Client) Run(ctx context.Context, command string, limit int) (Result, error) {
	stdout := &limitedBuffer{limit: limit}
	stderr := &limitedBuffer{limit: limit}
	code, err := client.Stream(ctx, command, stdout, stderr)
	result := Result{
		Code:      code,
		Stdout:    stdout.Bytes(),
		Stderr:    stderr.Bytes(),
		Truncated: stdout.truncated || stderr.truncated,
	}
	return result, err
}

// RunWithInput 执行命令并把 input 写入远端 stdin；用于原子写文件。
func (client *Client) RunWithInput(ctx context.Context, command string, input []byte, limit int) (Result, error) {
	stdout := &limitedBuffer{limit: limit}
	stderr := &limitedBuffer{limit: limit}
	code, err := client.stream(ctx, command, bytes.NewReader(input), stdout, stderr)
	result := Result{
		Code:      code,
		Stdout:    stdout.Bytes(),
		Stderr:    stderr.Bytes(),
		Truncated: stdout.truncated || stderr.truncated,
	}
	return result, err
}

// Stream 执行命令并把 stdout / stderr 实时复制到调用方 writer，返回远端退出码。
//
// 非零退出码不是 error：调用方需要按 code 区分「命令失败」与「传输失败」。
// ctx 取消时会关闭会话并返回 ctx.Err()。
func (client *Client) Stream(ctx context.Context, command string, stdout, stderr io.Writer) (int, error) {
	return client.stream(ctx, command, nil, stdout, stderr)
}

func (client *Client) stream(ctx context.Context, command string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if client == nil || client.client == nil {
		return -1, newError(CodeDialFailed, "SSH 连接已关闭", nil)
	}
	if strings.TrimSpace(command) == "" {
		return -1, newError(CodeInvalidConfig, "远端命令不能为空", nil)
	}
	session, err := client.client.NewSession()
	if err != nil {
		return -1, newError(CodeDialFailed, "无法打开 SSH 会话", err)
	}
	defer session.Close()
	if stdin != nil {
		session.Stdin = stdin
	}
	if stdout != nil {
		session.Stdout = stdout
	}
	if stderr != nil {
		session.Stderr = stderr
	}
	if err := session.Start(command); err != nil {
		return -1, newError(CodeDialFailed, "无法启动远端命令", err)
	}

	finished := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			// 先发 TERM 让远端有机会清理，再关会话兜底。
			_ = session.Signal(ssh.SIGTERM)
			_ = session.Close()
		case <-finished:
		}
	}()
	waitErr := session.Wait()
	close(finished)

	if ctxErr := ctx.Err(); ctxErr != nil {
		return -1, ctxErr
	}
	if waitErr == nil {
		return 0, nil
	}
	var exitErr *ssh.ExitError
	if errors.As(waitErr, &exitErr) {
		return exitErr.ExitStatus(), nil
	}
	var missing *ssh.ExitMissingError
	if errors.As(waitErr, &missing) {
		// 远端没有回传退出状态（常见于连接被中断）：按 ssh 的 255 处理。
		return 255, nil
	}
	return -1, newError(CodeDialFailed, "远端命令执行中断", waitErr)
}

// QuoteArgv 把参数向量转成一条经过 POSIX 单引号引用的远端命令。
func QuoteArgv(argv []string) (string, error) {
	if len(argv) == 0 {
		return "", newError(CodeInvalidConfig, "远端命令不能为空", nil)
	}
	quoted := make([]string, 0, len(argv))
	for _, argument := range argv {
		quoted = append(quoted, sshhost.ShellQuote(argument))
	}
	return strings.Join(quoted, " "), nil
}

// classifyDialError 把网络/握手/认证错误归到稳定的错误码。
func classifyDialError(ctx context.Context, err error) error {
	var keyErr *knownhosts.KeyError
	if errors.As(err, &keyErr) {
		if len(keyErr.Want) > 0 {
			return newError(CodeHostKeyMismatch, "远端主机密钥与 known_hosts 记录不一致，请确认主机身份后更新记录", err)
		}
		return newError(CodeDialFailed, "SSH 主机密钥校验失败", err)
	}
	var revoked *knownhosts.RevokedError
	if errors.As(err, &revoked) {
		return newError(CodeHostKeyRevoked, "远端主机密钥已被 known_hosts 标记为撤销", err)
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return newError(CodeTimeout, "SSH 连接已取消或超时", err)
	}
	if ctx != nil && ctx.Err() != nil {
		return newError(CodeTimeout, "SSH 连接已取消或超时", ctx.Err())
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return newError(CodeTimeout, "SSH 连接超时", err)
	}
	if isAuthFailure(err) {
		return newError(CodeAuthFailed, "SSH 认证失败", err)
	}
	return newError(CodeDialFailed, "无法连接 SSH 主机", err)
}

// isAuthFailure 识别 x/crypto/ssh 的认证失败文案。
func isAuthFailure(err error) bool {
	message := strings.ToLower(err.Error())
	for _, marker := range []string{
		"unable to authenticate",
		"no supported methods remain",
		"no auth passed yet",
		"ssh: handshake failed: ssh: unable to authenticate",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

// limitedBuffer 是带上限的 io.Writer：超限后继续接受写入但丢弃数据，避免阻塞远端。
type limitedBuffer struct {
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func (writer *limitedBuffer) Write(data []byte) (int, error) {
	if writer.limit <= 0 {
		return writer.buffer.Write(data)
	}
	remaining := writer.limit - writer.buffer.Len()
	if remaining <= 0 {
		writer.truncated = true
		return len(data), nil
	}
	if len(data) > remaining {
		_, _ = writer.buffer.Write(data[:remaining])
		writer.truncated = true
		return len(data), nil
	}
	return writer.buffer.Write(data)
}

func (writer *limitedBuffer) Bytes() []byte {
	return writer.buffer.Bytes()
}

func closeAll(closers []io.Closer) {
	for _, closer := range closers {
		if closer != nil {
			_ = closer.Close()
		}
	}
}
