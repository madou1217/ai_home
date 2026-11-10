package appserver

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	// closeGrace 是关闭时等待进程自行退出的时间，超时后强制结束。
	closeGrace = 3 * time.Second

	defaultClientName    = "aih-go"
	defaultClientTitle   = "AI Home"
	defaultClientVersion = "1"
)

// Config 描述一次 app-server 启动。Runtime 解析（二进制发现）由调用方完成。
type Config struct {
	Command string
	Args    []string
	Dir     string
	// Env 为 nil 时继承当前进程环境。
	Env []string
	// RequestTimeout 为 0 时使用 DefaultRequestTimeout；每个请求单独计时。
	RequestTimeout time.Duration
	ClientInfo     ClientInfo
	// Stderr 接收非空的 stderr 行，用于日志；可为 nil。
	Stderr func(line string)
}

// Client 监护一个 app-server 子进程并复用同一条 JSON-RPC 会话。
//
// 一个 Client 对应一个运行时；二进制指纹变化时应关闭旧 Client 再新建，
// 与 Node 生命周期策略的 clientEntry 行为一致。
type Client struct {
	conn      *rpcConn
	stdin     io.WriteCloser
	command   *exec.Cmd
	process   *os.Process
	exited    chan struct{}
	timeout   time.Duration
	closeOnce sync.Once
}

// Dial 启动子进程、完成 initialize/initialized 握手，失败时回收进程。
func Dial(ctx context.Context, config Config) (*Client, error) {
	command := strings.TrimSpace(config.Command)
	if command == "" {
		return nil, fmt.Errorf("%w: 缺少可执行文件", ErrInvalidConfig)
	}
	timeout := config.RequestTimeout
	if timeout <= 0 {
		timeout = DefaultRequestTimeout
	}
	clientInfo := config.ClientInfo
	if strings.TrimSpace(clientInfo.Name) == "" {
		clientInfo = ClientInfo{
			Name:    defaultClientName,
			Title:   defaultClientTitle,
			Version: defaultClientVersion,
		}
	}

	cmd := exec.Command(command, config.Args...)
	cmd.Dir = config.Dir
	cmd.Env = config.Env
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrSpawn, err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("%w: %v", ErrSpawn, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("%w: %v", ErrSpawn, err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("%w: %v", ErrSpawn, err)
	}

	client := &Client{
		conn:    newRPCConn(stdin, stdout),
		stdin:   stdin,
		command: cmd,
		process: cmd.Process,
		exited:  make(chan struct{}),
		timeout: timeout,
	}
	go client.drainStderr(stderr, config.Stderr)
	go client.wait()

	handshakeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	params := initializeParams{
		ClientInfo:   clientInfo,
		Capabilities: initializeCapabilities{ExperimentalAPI: true},
	}
	if err := client.conn.request(handshakeCtx, "initialize", params, nil); err != nil {
		client.terminate()
		return nil, fmt.Errorf("Codex app-server 初始化失败: %w", err)
	}
	if err := client.conn.notify("initialized", map[string]any{}); err != nil {
		client.terminate()
		return nil, fmt.Errorf("Codex app-server 初始化失败: %w", err)
	}
	return client, nil
}

// ListArchivedThreads 翻完 thread/list 的所有归档分页。
func (client *Client) ListArchivedThreads(ctx context.Context) ([]ArchivedThread, error) {
	threads := make([]ArchivedThread, 0)
	seenCursors := make(map[string]struct{})
	var cursor *string
	for {
		response := threadListResponse{}
		params := listParams{
			Archived:       true,
			Cursor:         cursor,
			Limit:          listPageSize,
			ModelProviders: []string{},
			SourceKinds:    []string{},
			UseStateDBOnly: false,
		}
		if err := client.request(ctx, "thread/list", params, &response); err != nil {
			return nil, err
		}
		for _, record := range response.Data {
			thread, ok := mapArchivedThread(record)
			if ok {
				threads = append(threads, thread)
			}
		}
		nextCursor := strings.TrimSpace(response.NextCursor)
		if nextCursor == "" {
			return threads, nil
		}
		if _, repeated := seenCursors[nextCursor]; repeated {
			return nil, ErrCursorRepeated
		}
		seenCursors[nextCursor] = struct{}{}
		cursor = &nextCursor
	}
}

// ArchiveThread 调用 thread/archive。
func (client *Client) ArchiveThread(ctx context.Context, threadID string) error {
	id := strings.TrimSpace(threadID)
	if id == "" {
		return ErrMissingThreadID
	}
	return client.request(ctx, "thread/archive", threadParams{ThreadID: id}, nil)
}

// UnarchiveThread 调用 thread/unarchive。
func (client *Client) UnarchiveThread(ctx context.Context, threadID string) error {
	id := strings.TrimSpace(threadID)
	if id == "" {
		return ErrMissingThreadID
	}
	return client.request(ctx, "thread/unarchive", threadParams{ThreadID: id}, nil)
}

// ProbeCapabilities 逐个探测归档方法：-32601 视为方法缺失，其他 RPC 错误
// （例如探针线程不存在）说明方法存在；传输错误则整体失败。
func (client *Client) ProbeCapabilities(ctx context.Context) (Capabilities, error) {
	listAvailable, err := probeMethod(ctx, func(probeCtx context.Context) error {
		params := listParams{
			Archived:       true,
			Cursor:         nil,
			Limit:          1,
			ModelProviders: []string{},
			SourceKinds:    []string{},
			UseStateDBOnly: true,
		}
		return client.request(probeCtx, "thread/list", params, nil)
	})
	if err != nil {
		return Capabilities{}, err
	}
	archiveAvailable, err := probeMethod(ctx, func(probeCtx context.Context) error {
		return client.request(probeCtx, "thread/archive", threadParams{ThreadID: probeThreadID}, nil)
	})
	if err != nil {
		return Capabilities{}, err
	}
	unarchiveAvailable, err := probeMethod(ctx, func(probeCtx context.Context) error {
		return client.request(probeCtx, "thread/unarchive", threadParams{ThreadID: probeThreadID}, nil)
	})
	if err != nil {
		return Capabilities{}, err
	}
	return newCapabilities(archiveAvailable, listAvailable, unarchiveAvailable), nil
}

// Close 关闭 stdin 让子进程自行退出；超时后强制结束。可重复调用。
func (client *Client) Close() error {
	client.closeOnce.Do(func() {
		client.conn.fail(ErrClosed)
		_ = client.stdin.Close()
		select {
		case <-client.exited:
		case <-time.After(closeGrace):
			_ = client.process.Kill()
			<-client.exited
		}
	})
	return nil
}

// request 给每次调用加独立超时，并共享同一会话。
func (client *Client) request(ctx context.Context, method string, params any, result any) error {
	if _, hasDeadline := ctx.Deadline(); !hasDeadline && client.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, client.timeout)
		defer cancel()
	}
	return client.conn.request(ctx, method, params, result)
}

func (client *Client) wait() {
	defer close(client.exited)
	_ = client.command.Wait()
}

func (client *Client) drainStderr(stderr io.Reader, onLine func(string)) {
	scanner := bufio.NewScanner(stderr)
	scanner.Buffer(make([]byte, 0, 64<<10), maxLineBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" && onLine != nil {
			onLine(line)
		}
	}
}

// terminate 回收握手失败的子进程，避免遗留孤儿。
func (client *Client) terminate() {
	client.conn.fail(ErrClosed)
	_ = client.stdin.Close()
	select {
	case <-client.exited:
	case <-time.After(closeGrace):
		_ = client.process.Kill()
		<-client.exited
	}
}

// probeMethod 把一次探针调用的结果翻译成「方法是否可用」。
func probeMethod(ctx context.Context, invoke func(context.Context) error) (bool, error) {
	err := invoke(ctx)
	if err == nil {
		return true, nil
	}
	var rpcErr *RPCError
	if errors.As(err, &rpcErr) {
		return rpcErr.Code != codeMethodNotFound, nil
	}
	return false, err
}
