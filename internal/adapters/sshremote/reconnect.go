package sshremote

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// ReconnectBackoff 是断线重连的退避序列；与 Node ssh-remote-supervisor 一致。
var ReconnectBackoff = []time.Duration{
	time.Second, 2 * time.Second, 5 * time.Second,
	10 * time.Second, 20 * time.Second, 30 * time.Second,
}

// StableAfter 是「连接稳定运行」阈值：超过后下一次断线从退避起点重算。
const StableAfter = time.Minute

// ReconnectingPTY 在 SSH 断线（255/连接错误）后按退避重连，保持同一个 pty.Session
// 给终端服务；远端命令应自带 tmux new-session -A 才能接回原 shell。
type ReconnectingPTY struct {
	config  Config
	command string
	options PTYOptions
	backoff []time.Duration

	mu          sync.Mutex
	current     *PTYSession
	ready       chan struct{}
	pendingSize *pty.Size
	closed      bool
	done        chan struct{}
	waitErr     error
}

// OpenReconnectingPTY 建立首个连接；首连失败直接返回错误（由 UI 展示），
// 之后的断线由后台循环重连。
func OpenReconnectingPTY(ctx context.Context, config Config, command string, options PTYOptions) (*ReconnectingPTY, error) {
	first, err := OpenPTYCommand(ctx, config, command, options)
	if err != nil {
		return nil, err
	}
	session := &ReconnectingPTY{
		config:  config,
		command: command,
		options: options,
		backoff: append([]time.Duration(nil), ReconnectBackoff...),
		current: first,
		ready:   closedChannel(),
		done:    make(chan struct{}),
	}
	go session.supervise(first)
	return session, nil
}

func closedChannel() chan struct{} {
	channel := make(chan struct{})
	close(channel)
	return channel
}

func (session *ReconnectingPTY) supervise(current *PTYSession) {
	attempt := 0
	startedAt := time.Now()
	for {
		err := current.Wait()
		session.mu.Lock()
		closed := session.closed
		session.mu.Unlock()
		if closed {
			return
		}
		if !shouldReconnect(err) {
			session.finish(err)
			return
		}
		session.markDisconnected(current)
		if time.Since(startedAt) >= StableAfter {
			attempt = 0
		}
		for {
			delay := session.backoffDelay(attempt)
			if !sleepContext(session.done, delay) {
				return
			}
			next, dialErr := OpenPTYCommand(context.Background(), session.config, session.command, session.options)
			if dialErr == nil {
				session.attach(next)
				current = next
				startedAt = time.Now()
				attempt++
				break
			}
			attempt++
		}
	}
}

func (session *ReconnectingPTY) backoffDelay(attempt int) time.Duration {
	if len(session.backoff) == 0 {
		return time.Second
	}
	if attempt >= len(session.backoff) {
		return session.backoff[len(session.backoff)-1]
	}
	return session.backoff[attempt]
}

func sleepContext(done <-chan struct{}, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-done:
		return false
	case <-timer.C:
		return true
	}
}

func (session *ReconnectingPTY) markDisconnected(current *PTYSession) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.current != current {
		return
	}
	_ = current.Close()
	session.current = nil
	session.ready = make(chan struct{})
}

func (session *ReconnectingPTY) attach(next *PTYSession) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		_ = next.Close()
		return
	}
	session.current = next
	if session.pendingSize != nil {
		_ = next.Resize(*session.pendingSize)
	}
	close(session.ready)
}

func (session *ReconnectingPTY) finish(err error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return
	}
	session.waitErr = err
	close(session.done)
}

// Read 在断线期间等待重连完成；终端关闭后返回 EOF。
func (session *ReconnectingPTY) Read(buffer []byte) (int, error) {
	if session == nil {
		return 0, io.EOF
	}
	for {
		session.mu.Lock()
		current := session.current
		ready := session.ready
		done := session.done
		closed := session.closed
		session.mu.Unlock()
		if closed {
			return 0, io.EOF
		}
		if current != nil {
			count, err := current.Read(buffer)
			if count > 0 {
				return count, nil
			}
			if err != nil {
				if errors.Is(err, io.EOF) || shouldReconnect(err) {
					select {
					case <-ready:
						continue
					case <-done:
						return 0, io.EOF
					}
				}
				return 0, err
			}
			continue
		}
		select {
		case <-ready:
			continue
		case <-done:
			return 0, io.EOF
		}
	}
}

// Write 在断线期间等待重连，避免用户输入被静默丢弃。
func (session *ReconnectingPTY) Write(buffer []byte) (int, error) {
	if session == nil {
		return 0, io.ErrClosedPipe
	}
	for {
		session.mu.Lock()
		current := session.current
		ready := session.ready
		done := session.done
		closed := session.closed
		session.mu.Unlock()
		if closed {
			return 0, io.ErrClosedPipe
		}
		if current != nil {
			return current.Write(buffer)
		}
		select {
		case <-ready:
			continue
		case <-done:
			return 0, io.ErrClosedPipe
		}
	}
}

// Resize 记录最后一次尺寸，重连后立即应用。
func (session *ReconnectingPTY) Resize(size pty.Size) error {
	if session == nil {
		return io.ErrClosedPipe
	}
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return io.ErrClosedPipe
	}
	session.pendingSize = &size
	current := session.current
	session.mu.Unlock()
	if current != nil {
		return current.Resize(size)
	}
	return nil
}

// Close 停止重连并关闭当前连接。
func (session *ReconnectingPTY) Close() error {
	if session == nil {
		return nil
	}
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return nil
	}
	session.closed = true
	current := session.current
	session.current = nil
	close(session.done)
	session.mu.Unlock()
	if current != nil {
		_ = current.Close()
	}
	return nil
}

// Wait 等待会话彻底结束（正常退出或 Close）。
func (session *ReconnectingPTY) Wait() error {
	if session == nil {
		return io.EOF
	}
	<-session.done
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.waitErr
}

func shouldReconnect(err error) bool {
	if err == nil {
		return false
	}
	var exitError *ssh.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitStatus() == 255
	}
	message := strings.ToLower(err.Error())
	return errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF) ||
		strings.Contains(message, "connection reset") ||
		strings.Contains(message, "broken pipe") ||
		strings.Contains(message, "use of closed network connection")
}
