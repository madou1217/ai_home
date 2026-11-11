package sshremote

import (
	"context"
	"io"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// PTYOptions 是远端交互 shell 的终端事实。
type PTYOptions struct {
	Cols uint16
	Rows uint16
	Term string
	Env  []string
}

// PTYSession 把一个 SSH session 的 pty 通道适配成 pty.Session。
//
// 读写直接落在 SSH channel 上；Resize 走 window-change；Close 同时关闭
// session 与底层连接；Wait 返回远端退出状态（非零退出是 *ssh.ExitError）。
type PTYSession struct {
	client  *Client
	session *ssh.Session
	stdin   io.WriteCloser
	stdout  io.Reader

	closeOnce sync.Once
	waitOnce  sync.Once
	done      chan struct{}
	waitErr   error
}

// OpenPTY 在已认证的 SSH 连接上申请 pty 并启动登录 shell。
func OpenPTY(ctx context.Context, config Config, options PTYOptions) (*PTYSession, error) {
	client, err := Dial(ctx, config, 0)
	if err != nil {
		return nil, err
	}
	session, err := client.client.NewSession()
	if err != nil {
		_ = client.Close()
		return nil, newError(CodeDialFailed, "无法创建 SSH 会话", err)
	}
	term := options.Term
	if term == "" {
		term = "xterm-256color"
	}
	cols := options.Cols
	if cols == 0 {
		cols = 80
	}
	rows := options.Rows
	if rows == 0 {
		rows = 24
	}
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := session.RequestPty(term, int(rows), int(cols), modes); err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, newError(CodeDialFailed, "远端拒绝分配 PTY", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, newError(CodeDialFailed, "无法打开远端输入", err)
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, newError(CodeDialFailed, "无法打开远端输出", err)
	}
	for _, entry := range options.Env {
		if separator := strings.IndexByte(entry, '='); separator > 0 {
			_ = session.Setenv(entry[:separator], entry[separator+1:])
		}
	}
	if err := session.Shell(); err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, newError(CodeDialFailed, "无法启动远端 shell", err)
	}
	terminal := &PTYSession{
		client:  client,
		session: session,
		stdin:   stdin,
		stdout:  stdout,
		done:    make(chan struct{}),
	}
	go terminal.wait()
	if ctx != nil {
		go func() {
			select {
			case <-ctx.Done():
				_ = terminal.Close()
			case <-terminal.done:
			}
		}()
	}
	return terminal, nil
}

func (terminal *PTYSession) wait() {
	terminal.waitOnce.Do(func() {
		terminal.waitErr = terminal.session.Wait()
		close(terminal.done)
	})
}

// Read 读取远端 PTY 输出。
func (terminal *PTYSession) Read(buffer []byte) (int, error) {
	if terminal == nil || terminal.stdout == nil {
		return 0, io.EOF
	}
	return terminal.stdout.Read(buffer)
}

// Write 写入远端 PTY 输入。
func (terminal *PTYSession) Write(buffer []byte) (int, error) {
	if terminal == nil || terminal.stdin == nil {
		return 0, io.ErrClosedPipe
	}
	return terminal.stdin.Write(buffer)
}

// Resize 通过 window-change 调整远端终端大小。
func (terminal *PTYSession) Resize(size pty.Size) error {
	if terminal == nil || terminal.session == nil {
		return io.ErrClosedPipe
	}
	return terminal.session.WindowChange(int(size.Rows), int(size.Cols))
}

// Close 关闭会话与连接；可重复调用。
func (terminal *PTYSession) Close() error {
	if terminal == nil {
		return nil
	}
	terminal.closeOnce.Do(func() {
		if terminal.session != nil {
			_ = terminal.session.Close()
		}
		if terminal.client != nil {
			_ = terminal.client.Close()
		}
	})
	return nil
}

// Wait 等待远端 shell 退出。
func (terminal *PTYSession) Wait() error {
	if terminal == nil {
		return io.EOF
	}
	<-terminal.done
	return terminal.waitErr
}
