// Package pluginrpc 提供行分隔 JSON-RPC 进程插件的公共生命周期。
//
// 具体插件槽（egress.engine / profile.render）只负责描述符与操作语义；
// 进程启动、请求编号、超时、退出唤醒与幂等关闭集中在这里，避免每个
// 插件槽复制一套进程管理代码。
package pluginrpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Manifest 是插件声明；具体槽位可将其作为 JSON 结构直接使用。
type Manifest struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Command  string   `json:"command"`
	Args     []string `json:"args,omitempty"`
	Priority int      `json:"priority,omitempty"`
}

type wireRequest struct {
	ID      int64  `json:"id"`
	Op      string `json:"op"`
	Request any    `json:"request,omitempty"`
}

type wireResponse struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type pendingCall struct {
	reply chan wireResponse
}

// Process 是一个已启动的插件子进程。
type Process struct {
	command   *exec.Cmd
	stdin     io.WriteCloser
	stdout    *bufio.Reader
	timeout   time.Duration
	writeMu   sync.Mutex
	callMu    sync.Mutex
	pendingMu sync.Mutex
	pending   map[int64]*pendingCall
	nextID    int64
	closeOnce sync.Once
}

// Start 启动插件进程；调用方必须在 describe 失败时 Close。
func Start(manifest Manifest, timeout time.Duration) (*Process, error) {
	if strings.TrimSpace(manifest.ID) == "" || strings.TrimSpace(manifest.Command) == "" {
		return nil, errors.New("plugin_manifest_invalid")
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	command := exec.Command(manifest.Command, manifest.Args...)
	command.Dir = filepath.Dir(manifest.Command)
	command.Stderr = io.Discard
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, err
	}
	process := &Process{
		command: command,
		stdin:   stdin,
		stdout:  bufio.NewReader(stdout),
		timeout: timeout,
		pending: map[int64]*pendingCall{},
	}
	go process.readLoop()
	return process, nil
}

// Call 发送一次请求并等待响应；同一进程的调用串行化，保持输出顺序可预测。
func (p *Process) Call(ctx context.Context, op string, payload any, target any) error {
	if p == nil {
		return errors.New("plugin_not_running")
	}
	p.callMu.Lock()
	defer p.callMu.Unlock()
	if p.command == nil || p.command.Process == nil {
		return errors.New("plugin_not_running")
	}
	callCtx := ctx
	if callCtx == nil {
		callCtx = context.Background()
	}
	callCtx, cancel := context.WithTimeout(callCtx, p.timeout)
	defer cancel()

	p.pendingMu.Lock()
	p.nextID++
	id := p.nextID
	reply := &pendingCall{reply: make(chan wireResponse, 1)}
	p.pending[id] = reply
	p.pendingMu.Unlock()
	defer func() {
		p.pendingMu.Lock()
		delete(p.pending, id)
		p.pendingMu.Unlock()
	}()

	encoded, err := json.Marshal(wireRequest{ID: id, Op: op, Request: payload})
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	_, err = p.stdin.Write(append(encoded, '\n'))
	p.writeMu.Unlock()
	if err != nil {
		return fmt.Errorf("plugin_write_failed: %w", err)
	}
	select {
	case response := <-reply.reply:
		if response.Error != nil {
			return fmt.Errorf("%s: %s", response.Error.Code, response.Error.Message)
		}
		if target == nil || len(response.Result) == 0 {
			return nil
		}
		return json.Unmarshal(response.Result, target)
	case <-callCtx.Done():
		return fmt.Errorf("plugin_timeout: %w", callCtx.Err())
	}
}

func (p *Process) readLoop() {
	decoder := json.NewDecoder(p.stdout)
	for {
		var response wireResponse
		if err := decoder.Decode(&response); err != nil {
			break
		}
		p.pendingMu.Lock()
		call := p.pending[response.ID]
		p.pendingMu.Unlock()
		if call != nil {
			select {
			case call.reply <- response:
			default:
			}
		}
	}
	// 进程退出时让所有等待者立即失败，而不是等满调用超时。
	p.pendingMu.Lock()
	for id, call := range p.pending {
		select {
		case call.reply <- wireResponse{ID: id, Error: &struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}{Code: "plugin_exited", Message: "插件进程已退出"}}:
		default:
		}
	}
	p.pendingMu.Unlock()
}

// Close 关闭子进程；幂等。
func (p *Process) Close() error {
	if p == nil {
		return nil
	}
	p.closeOnce.Do(func() {
		if p.stdin != nil {
			_ = p.stdin.Close()
		}
		if p.command != nil && p.command.Process != nil {
			_ = p.command.Process.Kill()
			_ = p.command.Wait()
		}
	})
	return nil
}

// SearchDirs 返回插件二进制的搜索目录，按优先级去重。
//
// 主体可执行文件目录排在最前：打包后插件与 aih-server 放在一起，
// 不依赖运行时数据目录是否被手工填充。
func SearchDirs(aiHomeDir string) []string {
	dirs := make([]string, 0, 4)
	if exe, err := os.Executable(); err == nil {
		if resolved, resolveErr := filepath.EvalSymlinks(exe); resolveErr == nil {
			exe = resolved
		}
		dirs = append(dirs, filepath.Dir(exe))
	}
	if root := strings.TrimSpace(aiHomeDir); root != "" {
		dirs = append(dirs, filepath.Join(root, "bin"))
		dirs = append(dirs, filepath.Join(root, "bin", "native", runtime.GOOS+"-"+runtime.GOARCH))
	}
	seen := map[string]struct{}{}
	out := dirs[:0]
	for _, dir := range dirs {
		abs, err := filepath.Abs(dir)
		if err != nil {
			continue
		}
		if _, exists := seen[abs]; exists {
			continue
		}
		seen[abs] = struct{}{}
		out = append(out, abs)
	}
	return out
}
