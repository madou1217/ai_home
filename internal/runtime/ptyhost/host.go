// Package ptyhost 是前台交互式 Provider CLI 的 Go 宿主。
//
// 它只负责「终端 + PTY 生命周期」：raw mode、初始尺寸、SIGWINCH、输入/输出透传、
// 子进程退出码和终端恢复。账号选择、凭据投影、会话身份/续接、PTY 内换号、
// 持久会话都不在这里；这些由上层 application/host 包按 provider 组合。
//
// 设计约束：
//   - 不解析 ANSI，不读屏幕内容，不从输出推断状态；字节原样透传。
//   - 不把 Ctrl+C 当宿主信号：raw mode 下它是 0x03，必须原样交给 TUI。
//   - 退出/取消时必须恢复终端，不能让用户 shell 留在 raw。
//   - stdin/stdout 不是终端时退化成普通字节流（脚本、管道、测试）。
package ptyhost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"

	"golang.org/x/term"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

var (
	// ErrInvalidConfig 表示宿主缺少启动 PTY 所需的最小输入。
	ErrInvalidConfig = errors.New("pty host config invalid")
)

// Config 是一次前台 Provider CLI 会话的全部宿主输入。
type Config struct {
	Path    string
	Args    []string
	Env     []string
	Dir     string
	Stdin   io.Reader
	Stdout  io.Writer
	Starter pty.Starter
	// InitialSize 可选；为零值时从 Stdout/Stdin 探测，失败回退 80x24。
	InitialSize pty.Size
}

// ExitError 是子进程非零退出的可静默传递结果；cmd 层用它保留退出码，
// 不把 TUI 的正常非零退出打印成 aih 自身错误。
type ExitError struct {
	Code int
}

func (err *ExitError) Error() string { return fmt.Sprintf("exit status %d", err.Code) }

// ExitCode 返回子进程退出码。
func (err *ExitError) ExitCode() int {
	if err == nil {
		return 0
	}
	return err.Code
}

// SilentExit 标记这种错误不需要再打印一行 "aih: ..."。
func (*ExitError) SilentExit() {}

// Run 启动官方 CLI，把它接到当前终端上，返回子进程退出码。
//
// Run 返回的 error 为 nil 表示子进程 0 退出；非零退出返回 *ExitError；
// 宿主自身失败（PTY 分配、raw mode、输出写失败）返回普通 error。
func Run(ctx context.Context, config Config) (int, error) {
	if ctx == nil || config.Starter == nil || config.Path == "" ||
		config.Stdin == nil || config.Stdout == nil {
		return 0, ErrInvalidConfig
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}

	restore, err := enterRaw(config.Stdin)
	if err != nil {
		return 0, err
	}
	defer restore()

	size := initialSize(config)
	session, err := config.Starter.Start(ctx, pty.Spec{
		Path: config.Path,
		Args: append([]string(nil), config.Args...),
		Env:  append([]string(nil), config.Env...),
		Dir:  config.Dir,
		Size: size,
	})
	if err != nil {
		return 0, err
	}

	done := make(chan struct{})

	// context 取消时主动杀子进程：只 Close PTY 主端不保证 TUI 退出。
	go func() {
		select {
		case <-ctx.Done():
			killSession(session)
		case <-done:
		}
	}()

	resizeCh := make(chan pty.Size, 1)
	stopResize := startResizeWatcher(ctx, func() (pty.Size, bool) {
		return readTerminalSize(config.Stdin, config.Stdout)
	}, resizeCh)
	var resizeWG sync.WaitGroup
	resizeWG.Add(1)
	go func() {
		defer resizeWG.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case next := <-resizeCh:
				_ = session.Resize(next)
			}
		}
	}()

	// 先停 resize 并等它退出，再关 PTY：否则 Resize 的 ioctl 会和 Close 并发。
	defer func() {
		close(done)
		stopResize()
		resizeWG.Wait()
		_ = session.Close()
	}()

	// 输入原样透传。raw mode 已关闭行缓冲，括号粘贴/方向键由 TUI 自己解释；
	// 这里不做分帧，避免把跨 chunk 的转义序列改写成另一种字节流。
	go func() {
		_, _ = io.Copy(session, config.Stdin)
	}()

	_, outputErr := io.Copy(config.Stdout, session)
	waitErr := session.Wait()

	if ctx.Err() != nil {
		return 130, &ExitError{Code: 130}
	}
	if outputErr != nil && !errors.Is(outputErr, io.EOF) {
		return 1, outputErr
	}
	code, err := exitCode(waitErr)
	if err != nil {
		return 1, err
	}
	if code != 0 {
		return code, &ExitError{Code: code}
	}
	return 0, nil
}

// enterRaw 只在 stdin 是真终端时切换 raw；脚本/管道保持原样。
func enterRaw(input io.Reader) (func(), error) {
	file, ok := input.(interface{ Fd() uintptr })
	if !ok || !term.IsTerminal(int(file.Fd())) {
		return func() {}, nil
	}
	state, err := term.MakeRaw(int(file.Fd()))
	if err != nil {
		return nil, err
	}
	return func() {
		_ = term.Restore(int(file.Fd()), state)
	}, nil
}

// initialSize 优先用调用方指定尺寸，其次从当前终端探测，最后回退 80x24。
func initialSize(config Config) pty.Size {
	if config.InitialSize.Rows > 0 && config.InitialSize.Cols > 0 {
		return normalizeSize(config.InitialSize)
	}
	if size, ok := readTerminalSize(config.Stdin, config.Stdout); ok {
		return size
	}
	return pty.Size{Rows: 24, Cols: 80}
}

// readTerminalSize 先看 stdout，再看 stdin；两者都可能与真实终端共享同一 tty。
func readTerminalSize(input io.Reader, output io.Writer) (pty.Size, bool) {
	for _, candidate := range []any{output, input} {
		file, ok := candidate.(interface{ Fd() uintptr })
		if !ok {
			continue
		}
		width, height, err := term.GetSize(int(file.Fd()))
		if err != nil || width <= 0 || height <= 0 {
			continue
		}
		return normalizeSize(pty.Size{Rows: uint16(height), Cols: uint16(width)}), true
	}
	return pty.Size{}, false
}

// normalizeSize 锁到上层终端服务同一套安全范围，避免异常 ioctl 尺寸。
func normalizeSize(size pty.Size) pty.Size {
	if size.Cols < 2 {
		size.Cols = 2
	}
	if size.Cols > 500 {
		size.Cols = 500
	}
	if size.Rows < 1 {
		size.Rows = 1
	}
	if size.Rows > 200 {
		size.Rows = 200
	}
	return size
}

// killSession 优先用具体实现的 Kill；接口不扩大，fake/远端实现仍可只实现 Close。
func killSession(session pty.Session) {
	if killer, ok := session.(interface{ Kill() error }); ok {
		_ = killer.Kill()
		return
	}
	_ = session.Close()
}

// exitCode 把 exec.ExitError 归一成退出码；被信号杀掉的进程在 Unix 上映射为 128+signal。
func exitCode(err error) (int, error) {
	if err == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if code, ok := signaledExitCode(exitErr.ProcessState); ok {
			return code, nil
		}
		if code := exitErr.ExitCode(); code >= 0 {
			return code, nil
		}
		return 1, nil
	}
	return 1, err
}
