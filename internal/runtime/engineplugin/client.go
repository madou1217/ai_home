// Package engineplugin 发现并驱动 egress.engine 进程插件。
//
// 插件是独立可执行文件，通过行分隔 JSON-RPC 提供 describe/resolve/compile；
// 主体不 import 任何具体内核。插件只返回配置与启动事实，进程/控制面/健康
// 仍由 egress PoolSupervisor 负责。
package engineplugin

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

	"github.com/madou1217/ai_home/application/egressengine"
)

const (
	manifestDirName = "plugins/engines"
	callTimeout     = 30 * time.Second
)

// Manifest 是 <aiHome>/plugins/engines/*.json 的插件声明。
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

// Client 是一个已启动的进程插件，实现 egressengine.Engine。
type Client struct {
	manifest   Manifest
	descriptor egressengine.Descriptor
	command    *exec.Cmd
	stdin      io.WriteCloser
	stdout     *bufio.Reader
	writeMu    sync.Mutex
	callMu     sync.Mutex
	pendingMu  sync.Mutex
	pending    map[int64]*pendingCall
	nextID     int64
	closeOnce  sync.Once
}

// Load 扫描插件目录并启动可用插件；单个插件失败只跳过，不影响其它插件。
//
// 去重键是插件自报的 descriptor.id，而不是文件名或 manifest.id：
// 同一个插件可能有多种命名（sing-box / singbox），按文件名去重会让一份
// 陈旧副本抢先占位。发现顺序固定为「随主体分发的目录 -> manifest -> aiHome」，
// 打包自带的插件始终优先于运行时目录里的历史副本。
func Load(aiHomeDir string) []*Client {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil
	}
	clients := make([]*Client, 0, 3)
	seen := map[string]struct{}{}
	start := func(manifest Manifest) {
		client, err := NewClient(manifest)
		if err != nil {
			return
		}
		id := strings.ToLower(strings.TrimSpace(client.Descriptor().ID))
		if id == "" {
			_ = client.Close()
			return
		}
		if _, exists := seen[id]; exists {
			_ = client.Close()
			return
		}
		seen[id] = struct{}{}
		clients = append(clients, client)
	}

	// 先扫描与主体同目录/运行目录的 aih-engine-*。
	for _, binDir := range engineSearchDirs(root) {
		entries, err := os.ReadDir(binDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasPrefix(strings.ToLower(entry.Name()), "aih-engine-") {
				continue
			}
			id := strings.TrimPrefix(strings.ToLower(entry.Name()), "aih-engine-")
			if strings.HasSuffix(id, ".exe") {
				id = strings.TrimSuffix(id, ".exe")
			}
			start(Manifest{ID: id, Command: filepath.Join(binDir, entry.Name())})
		}
	}

	// manifest 只补位：随包插件已经注册的 ID 不再被外部声明覆盖。
	manifestDir := filepath.Join(root, manifestDirName)
	entries, err := os.ReadDir(manifestDir)
	if err != nil {
		return clients
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".json") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(manifestDir, entry.Name()))
		if readErr != nil {
			continue
		}
		var manifest Manifest
		if json.Unmarshal(raw, &manifest) != nil || strings.TrimSpace(manifest.ID) == "" {
			continue
		}
		if strings.TrimSpace(manifest.Command) == "" {
			manifest.Command = filepath.Join(root, "bin", "aih-engine-"+manifest.ID)
		} else if !filepath.IsAbs(manifest.Command) {
			manifest.Command = filepath.Join(manifestDir, manifest.Command)
		}
		start(manifest)
	}
	return clients
}

// SearchDirs 返回插件二进制的搜索目录（按优先级去重），供诊断视图与测试注入。
func SearchDirs(aiHomeDir string) []string { return engineSearchDirs(aiHomeDir) }

// engineSearchDirs 返回插件二进制的搜索目录，按优先级去重。
//
// 主体可执行文件目录排在最前：打包后插件与 aih-server 放在一起，
// 不依赖运行时数据目录是否被手工填充。
func engineSearchDirs(aiHomeDir string) []string {
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

// NewClient 启动插件并读取 describe 描述符。
func NewClient(manifest Manifest) (*Client, error) {
	if strings.TrimSpace(manifest.ID) == "" || strings.TrimSpace(manifest.Command) == "" {
		return nil, errors.New("engine_plugin_manifest_invalid")
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
	client := &Client{
		manifest: manifest,
		command:  command,
		stdin:    stdin,
		stdout:   bufio.NewReader(stdout),
		pending:  map[int64]*pendingCall{},
	}
	go client.readLoop()
	var descriptor egressengine.Descriptor
	if err := client.call(context.Background(), "describe", nil, &descriptor); err != nil {
		_ = client.Close()
		return nil, err
	}
	if strings.ToLower(strings.TrimSpace(descriptor.Controller)) != "clash-api" {
		_ = client.Close()
		return nil, errors.New("engine_plugin_controller_unsupported")
	}
	if strings.TrimSpace(descriptor.ID) == "" {
		_ = client.Close()
		return nil, errors.New("engine_plugin_id_required")
	}
	if manifest.Priority != 0 {
		descriptor.Priority = manifest.Priority
	}
	client.descriptor = descriptor
	return client, nil
}

// Descriptor 实现 egressengine.Engine。
func (client *Client) Descriptor() egressengine.Descriptor { return client.descriptor }

// Resolve 实现 egressengine.Engine。
func (client *Client) Resolve(ctx context.Context, request egressengine.ResolveRequest) (egressengine.ResolveResult, error) {
	var result egressengine.ResolveResult
	if err := client.call(ctx, "resolve", request, &result); err != nil {
		return egressengine.ResolveResult{}, err
	}
	if result.UsableNodes > 0 && strings.TrimSpace(result.Binary) == "" {
		return egressengine.ResolveResult{}, errors.New("engine_plugin_binary_required")
	}
	return result, nil
}

// Compile 实现 egressengine.Engine。
func (client *Client) Compile(ctx context.Context, request egressengine.CompileRequest) (egressengine.LaunchSpec, error) {
	var spec egressengine.LaunchSpec
	if err := client.call(ctx, "compile", request, &spec); err != nil {
		return egressengine.LaunchSpec{}, err
	}
	if len(spec.Config) == 0 || strings.TrimSpace(spec.ConfigFileName) == "" || strings.TrimSpace(spec.GlobalGroup) == "" {
		return egressengine.LaunchSpec{}, errors.New("engine_plugin_launch_spec_invalid")
	}
	return spec, nil
}

func (client *Client) call(ctx context.Context, op string, payload any, target any) error {
	client.callMu.Lock()
	defer client.callMu.Unlock()
	if client.command == nil || client.command.Process == nil {
		return errors.New("engine_plugin_not_running")
	}
	callCtx := ctx
	if callCtx == nil {
		callCtx = context.Background()
	}
	callCtx, cancel := context.WithTimeout(callCtx, callTimeout)
	defer cancel()

	client.pendingMu.Lock()
	client.nextID++
	id := client.nextID
	reply := &pendingCall{reply: make(chan wireResponse, 1)}
	client.pending[id] = reply
	client.pendingMu.Unlock()
	defer func() {
		client.pendingMu.Lock()
		delete(client.pending, id)
		client.pendingMu.Unlock()
	}()

	encoded, err := json.Marshal(wireRequest{ID: id, Op: op, Request: payload})
	if err != nil {
		return err
	}
	client.writeMu.Lock()
	_, err = client.stdin.Write(append(encoded, '\n'))
	client.writeMu.Unlock()
	if err != nil {
		return fmt.Errorf("engine_plugin_write_failed: %w", err)
	}
	select {
	case response := <-reply.reply:
		if response.Error != nil {
			return fmt.Errorf("%s: %s", response.Error.Code, response.Error.Message)
		}
		if target == nil {
			return nil
		}
		return json.Unmarshal(response.Result, target)
	case <-callCtx.Done():
		return fmt.Errorf("engine_plugin_timeout: %w", callCtx.Err())
	}
}

func (client *Client) readLoop() {
	decoder := json.NewDecoder(client.stdout)
	for {
		var response wireResponse
		if err := decoder.Decode(&response); err != nil {
			break
		}
		client.pendingMu.Lock()
		call := client.pending[response.ID]
		client.pendingMu.Unlock()
		if call != nil {
			select {
			case call.reply <- response:
			default:
			}
		}
	}
	// 进程退出时让所有等待者立即失败，而不是等满 30s 超时。
	client.pendingMu.Lock()
	for id, call := range client.pending {
		select {
		case call.reply <- wireResponse{ID: id, Error: &struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}{Code: "engine_plugin_exited", Message: "插件进程已退出"}}:
		default:
		}
	}
	client.pendingMu.Unlock()
}

// Close 关闭插件进程；幂等。
func (client *Client) Close() error {
	if client == nil {
		return nil
	}
	client.closeOnce.Do(func() {
		_ = client.stdin.Close()
		if client.command != nil && client.command.Process != nil {
			_ = client.command.Process.Kill()
			_ = client.command.Wait()
		}
	})
	return nil
}
