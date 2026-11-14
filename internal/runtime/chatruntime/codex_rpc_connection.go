package chatruntime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	// 协议帧与在途请求有明确上限；历史读取用分页，不用无限内存吸收任意 stdout。
	maxCodexRPCFrameBytes   = 32 << 20
	maxCodexPendingRequests = 256
)

type codexRPCConnectionKey struct{}

type codexConnectFlight struct {
	done chan struct{}
	err  error
}

// EnsureConnected 合并建连与 initialize；调用方不会借到握手未完成的子进程。
func (c *CodexAppServerClient) EnsureConnected(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, c.requestTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	if c.closed || c.retiring {
		c.mu.Unlock()
		return NewError("codex_app_server_closed", http.StatusGone, nil)
	}
	if c.ready && c.connected {
		c.mu.Unlock()
		return nil
	}
	if flight := c.connecting; flight != nil {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-flight.done:
			return flight.err
		}
	}
	// 最多保留一个正在 drain 的旧代次和一个当前代次。外部 callback 若不遵守
	// 返回/取消合同，也不能靠重复重连累计无限 worker 与队列。
	if c.dispatchers >= 2 {
		c.mu.Unlock()
		return NewError("codex_app_server_callbacks_draining", http.StatusServiceUnavailable, nil)
	}
	flight := &codexConnectFlight{done: make(chan struct{})}
	c.connecting = flight
	c.mu.Unlock()
	// 建连属于 client 生命周期，不让最先进入的短 deadline 取消所有并发等待者。
	// 每个 client 最多一个 owner goroutine，Close 会使连接在发布时失败关闭。
	go func() {
		connectCtx, stop := context.WithTimeout(context.Background(), c.requestTimeout)
		defer stop()
		err := c.connect(connectCtx)
		c.mu.Lock()
		flight.err = err
		c.connecting = nil
		close(flight.done)
		idle := c.idleObserverLocked()
		c.mu.Unlock()
		if idle != nil {
			idle()
		}
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-flight.done:
		return flight.err
	}
}

func (c *CodexAppServerClient) connect(ctx context.Context) error {
	command, args, env, runtimeHome, err := c.resolveSpawnSpec()
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	cmd := exec.Command(command, args...)
	cmd.Env = env
	if runtimeHome.CodexHome != "" {
		_ = os.MkdirAll(runtimeHome.CodexHome, 0o700)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return NewErrorWithMessage("codex_app_server_spawn_failed", http.StatusBadGateway, err.Error(), nil)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		return err
	}
	c.mu.Lock()
	if c.closed || c.retiring || ctx.Err() != nil {
		c.mu.Unlock()
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if err := ctx.Err(); err != nil {
			return err
		}
		return NewError("codex_app_server_closed", http.StatusGone, nil)
	}
	waitDone := make(chan struct{})
	dispatcher := newCodexRPCDispatch(c, cmd)
	c.cmd, c.stdin, c.waitDone = cmd, stdin, waitDone
	c.stdout, c.stderr = stdout, stderr
	c.dispatch = dispatcher
	c.dispatchers++
	c.connectionDone = make(chan struct{})
	c.connected, c.ready = true, false
	c.runtimeHome, c.hasHome = runtimeHome, runtimeHome.CodexHome != ""
	c.identity = &CodexVerifiedIdentity{Verified: true, Kind: "oauth", Assurance: "runtime-home", AccountRef: c.opts.AccountRef}
	c.stderrTail.Reset()
	c.mu.Unlock()
	go c.drainStderr(stderr, cmd)
	go dispatcher.run()
	go c.readLoop(stdout, cmd, waitDone, dispatcher)
	_, err = c.requestConnected(ctx, cmd, "initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "ai_home", "title": "AIH Server", "version": "1.0.0"},
		"capabilities": map[string]any{"experimentalApi": true},
	})
	if err == nil {
		err = c.writeConnectionEnvelope(ctx, cmd, map[string]any{"jsonrpc": "2.0", "method": "initialized"})
	}
	if err != nil {
		_ = c.disconnectConnection(cmd, err, true)
		return NewErrorWithMessage("codex_app_server_initialize_failed", http.StatusBadGateway, err.Error(), nil)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cmd != cmd || !c.connected || c.closed || c.retiring {
		return NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	c.ready = true
	return nil
}

func (c *CodexAppServerClient) disconnect(reason error) error {
	return c.disconnectConnection(nil, reason, true)
}

// disconnectConnection 先失败在途 RPC，解除回调中的 Request 等待，再通知顺序分发器。
// reader 不等待自身 Wait；回调 worker 也不 join 自身。旧进程不能拆掉新连接。
func (c *CodexAppServerClient) disconnectConnection(expected *exec.Cmd, reason error, wait bool) error {
	if reason == nil {
		reason = NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	c.mu.Lock()
	if expected != nil && c.cmd != expected {
		c.mu.Unlock()
		return nil
	}
	cmd, stdin, waitDone, dispatcher := c.cmd, c.stdin, c.waitDone, c.dispatch
	stdout, stderr := c.stdout, c.stderr
	c.cmd, c.stdin, c.waitDone, c.dispatch = nil, nil, nil, nil
	c.stdout, c.stderr = nil, nil
	c.connected, c.ready = false, false
	if c.connectionDone != nil {
		close(c.connectionDone)
		c.connectionDone = nil
	}
	pending := c.pending
	c.pending = make(map[string]chan codexRPCResult)
	bindings := c.bindings
	c.bindings = make(map[string]*codexTurnRegistration)
	c.failThreadReleasesLocked(reason)
	idle := c.idleObserverLocked()
	c.mu.Unlock()
	// 响应通道由持锁取出 pending 的一方独占；不会重复发送/close。
	for _, ch := range pending {
		ch <- codexRPCResult{err: reason}
		close(ch)
	}
	if dispatcher != nil {
		dispatcher.finish(bindings, reason)
	}
	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	// 后代可能继承写端：直接子进程退出不保证 EOF，显式关闭本代读端解除 reader。
	if stdout != nil {
		_ = stdout.Close()
	}
	if stderr != nil {
		_ = stderr.Close()
	}
	if idle != nil {
		idle()
	}
	if wait && waitDone != nil {
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		select {
		case <-waitDone:
		case <-timer.C:
		}
	}
	return nil
}

func (c *CodexAppServerClient) writeEnvelope(ctx context.Context, payload any) error {
	if ctx == nil {
		ctx = context.Background()
	}
	cmd, scoped := ctx.Value(codexRPCConnectionKey{}).(*exec.Cmd)
	if !scoped {
		c.mu.Lock()
		cmd = c.cmd
		c.mu.Unlock()
	}
	return c.writeConnectionEnvelope(ctx, cmd, payload)
}

// writeConnectionEnvelope 在 deadline 到期时关闭管道并终止该连接，使被堵住的写也可退出。
// AfterFunc 每个活动写最多一个取消回调，不为每个消息常驻 goroutine。
func (c *CodexAppServerClient) writeConnectionEnvelope(ctx context.Context, cmd *exec.Cmd, payload any) error {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, c.requestTimeout)
	defer cancel()
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if len(raw) > maxCodexRPCFrameBytes {
		return NewError("codex_app_server_frame_too_large", http.StatusRequestEntityTooLarge, nil)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	stdin := c.stdin
	valid := c.connected && !c.closed && !c.retiring && cmd != nil && c.cmd == cmd && stdin != nil
	c.mu.Unlock()
	if !valid {
		return NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	stop := context.AfterFunc(ctx, func() { _ = c.disconnectConnection(cmd, ctx.Err(), false) })
	defer stop()
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	valid = c.cmd == cmd && c.connected && !c.closed && !c.retiring
	c.mu.Unlock()
	if !valid {
		return NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	raw = append(raw, '\n')
	_, err = stdin.Write(raw)
	return err
}

func (c *CodexAppServerClient) drainStderr(r io.Reader, cmd *exec.Cmd) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			c.mu.Lock()
			if c.cmd != cmd {
				c.mu.Unlock()
				return
			}
			if c.stderrTail.Len() > 8192 {
				b := c.stderrTail.Bytes()
				copy(b, b[len(b)-4096:])
				c.stderrTail.Truncate(4096)
			}
			_, _ = c.stderrTail.Write(buf[:n])
			c.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (c *CodexAppServerClient) readLoop(stdout io.Reader, cmd *exec.Cmd, waitDone chan struct{}, dispatcher *codexRPCDispatch) {
	defer func() { _ = cmd.Wait(); close(waitDone) }()
	reader := bufio.NewReaderSize(stdout, 64<<10)
	var readErr error
	for {
		line, err := readCodexRPCFrame(reader)
		line = bytes.TrimSpace(line)
		if len(line) > 0 {
			if dispatchErr := c.dispatchLine(cmd, dispatcher, line); dispatchErr != nil {
				_ = c.disconnectConnection(cmd, dispatchErr, false)
				return
			}
		}
		if err != nil {
			readErr = err
			break
		}
	}
	c.mu.Lock()
	tail := strings.TrimSpace(c.stderrTail.String())
	same := c.cmd == cmd
	c.mu.Unlock()
	if !same {
		return
	}
	message := "codex app-server disconnected"
	if tail != "" {
		message = tail
	} else if readErr != nil && !errors.Is(readErr, io.EOF) {
		message = readErr.Error()
	}
	_ = c.disconnectConnection(cmd, NewErrorWithMessage("codex_app_server_disconnected", http.StatusBadGateway, message, nil), false)
}

// readCodexRPCFrame 小帧直接借 Reader 缓冲；大帧只在本轮扩容且严格封顶。
// 不把偶发的大历史响应永久保留成每条连接的 Scanner 工作缓冲。
func readCodexRPCFrame(reader *bufio.Reader) ([]byte, error) {
	var frame []byte
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(fragment) > maxCodexRPCFrameBytes-len(frame) {
			return nil, NewError("codex_app_server_frame_too_large", http.StatusBadGateway, nil)
		}
		if frame == nil && err != bufio.ErrBufferFull {
			return fragment, err
		}
		need := len(frame) + len(fragment)
		if cap(frame) < need {
			capacity := max(need, cap(frame)*2)
			capacity = min(capacity, maxCodexRPCFrameBytes)
			next := make([]byte, len(frame), capacity)
			copy(next, frame)
			frame = next
		}
		frame = append(frame, fragment...)
		if err != bufio.ErrBufferFull {
			return frame, err
		}
	}
}
