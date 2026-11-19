package pluginhost

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
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

// ProcessHost 是语言无关插件运行时：每个 process 插件一个子进程，走行分隔 JSON-RPC。
//
// 它不是 Node 宿主协议（帧/二进制 payload）的替代，而是给非 JS 插件的最小通道：
//
//	请求  {"id":"...","method":"prepare|activate|invoke|dispose|status|shutdown","params":{...}}
//	响应  {"id":"...","result":{...}} 或 {"id":"...","error":{"code":"...","message":"..."}}
//
// Node 插件继续走 Supervisor；process 插件由本文件承载，二者由 HybridHost 路由。
type ProcessHost struct {
	onLog  func(string)
	mu     sync.Mutex
	procs  map[string]*processPlugin // instanceId -> process
	routes map[string]*processPlugin // contributionId -> process
}

type processPlugin struct {
	spec       PluginSpec
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	reader     *bufio.Reader
	stderr     *tailBuffer
	writeMu    sync.Mutex
	stateMu    sync.Mutex
	nextID     int64
	pending    map[string]*processPending
	generation int64
	closed     bool
}

type processPending struct {
	replies chan processReply
	onCall  func(context.Context, string, json.RawMessage) (any, error)
}

type processReply struct {
	value json.RawMessage
	err   error
}

type tailBuffer struct {
	mu    sync.Mutex
	value []byte
	limit int
}

func (buffer *tailBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	buffer.value = append(buffer.value, data...)
	if buffer.limit > 0 && len(buffer.value) > buffer.limit {
		buffer.value = buffer.value[len(buffer.value)-buffer.limit:]
	}
	return len(data), nil
}

func (buffer *tailBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return string(buffer.value)
}

func NewProcessHost(onLog func(string)) *ProcessHost {
	return &ProcessHost{onLog: onLog, procs: map[string]*processPlugin{}, routes: map[string]*processPlugin{}}
}

func (host *ProcessHost) Start(context.Context) error { return nil }

func (host *ProcessHost) Stop(ctx context.Context) error {
	host.mu.Lock()
	procs := make([]*processPlugin, 0, len(host.procs))
	for _, proc := range host.procs {
		procs = append(procs, proc)
	}
	host.procs = map[string]*processPlugin{}
	host.routes = map[string]*processPlugin{}
	host.mu.Unlock()
	for _, proc := range procs {
		proc.stop(ctx)
	}
	return nil
}

func (host *ProcessHost) Prepare(ctx context.Context, generation int64, plugins []PluginSpec) (HostPrepareResult, error) {
	result := HostPrepareResult{Generation: generation, State: "prepared"}
	for _, spec := range plugins {
		if strings.ToLower(strings.TrimSpace(spec.Runtime)) != "process" {
			continue
		}
		proc, err := host.startPlugin(ctx, generation, spec)
		if err != nil {
			_ = host.Stop(ctx)
			return HostPrepareResult{}, err
		}
		contributions := manifestContributions(spec.Manifest)
		if len(contributions) == 0 {
			_ = host.Stop(ctx)
			return HostPrepareResult{}, pluginerr.New("plugin_process_contributions_missing", "process 插件没有声明 contributes")
		}
		for _, contributionID := range contributions {
			host.routes[contributionID] = proc
		}
		host.procs[spec.InstanceID] = proc
		result.Contributions = append(result.Contributions, contributions...)
		result.ProcessContributions = append(result.ProcessContributions, contributions...)
	}
	return result, nil
}

func (host *ProcessHost) startPlugin(ctx context.Context, generation int64, spec PluginSpec) (*processPlugin, error) {
	argv := spec.ExecArgv
	if len(argv) == 0 {
		argv = []string{spec.EntryPath}
	}
	command := argv[0]
	if strings.HasPrefix(command, "./") || strings.HasPrefix(command, "../") {
		command = filepath.Join(spec.Directory, command)
	}
	cmd := exec.Command(command, argv[1:]...)
	cmd.Dir = spec.Directory
	env := processEnvironment(spec.ExecEnv)
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	proc := &processPlugin{
		spec: spec, cmd: cmd, stdin: stdin, reader: bufio.NewReader(stdout),
		stderr: &tailBuffer{limit: 8192}, generation: generation,
		pending: map[string]*processPending{},
	}
	cmd.Stderr = proc.stderr
	if err := cmd.Start(); err != nil {
		return nil, pluginerr.New("plugin_process_start_failed", "process 插件启动失败："+err.Error())
	}
	go proc.readLoop()
	prepareCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	response, err := proc.call(prepareCtx, "prepare", map[string]any{
		"generation": generation,
		"plugins":    []PluginSpec{spec},
	})
	if err != nil {
		proc.stop(context.Background())
		return nil, err
	}
	var payload struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(response, &payload)
	host.log("process plugin ready: " + spec.InstanceID)
	return proc, nil
}

func (host *ProcessHost) Activate(ctx context.Context, generation int64, retainPrevious bool) (HostActivateResult, error) {
	host.mu.Lock()
	procs := make([]*processPlugin, 0, len(host.procs))
	for _, proc := range host.procs {
		procs = append(procs, proc)
	}
	host.mu.Unlock()
	for _, proc := range procs {
		_, _ = proc.call(ctx, "activate", map[string]any{"generation": generation, "retainPrevious": retainPrevious})
	}
	return HostActivateResult{Generation: generation, State: "active"}, nil
}

func (host *ProcessHost) Invoke(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error) {
	host.mu.Lock()
	proc := host.routes[contributionID]
	host.mu.Unlock()
	if proc == nil {
		return nil, pluginerr.New("plugin_process_route_missing", "没有 process 插件承载该能力："+contributionID)
	}
	callCtx := ctx
	var cancel context.CancelFunc
	if timeout > 0 {
		callCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	return proc.call(callCtx, "invoke", map[string]any{
		"generation": generation, "contributionId": contributionID, "value": value,
	})
}

func (host *ProcessHost) InvokeReverse(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration, onCall func(context.Context, string, json.RawMessage) (any, error)) (json.RawMessage, error) {
	host.mu.Lock()
	proc := host.routes[contributionID]
	host.mu.Unlock()
	if proc == nil {
		return nil, pluginerr.New("plugin_process_route_missing", "没有 process 插件承载该能力："+contributionID)
	}
	return proc.InvokeReverse(ctx, generation, contributionID, value, timeout, onCall)
}

func (host *ProcessHost) Dispose(ctx context.Context, generation int64) (HostDisposeResult, error) {
	_ = host.Stop(ctx)
	return HostDisposeResult{Generation: generation, State: "disposed"}, nil
}

func (host *ProcessHost) Status(context.Context) (HostStatusResult, error) {
	host.mu.Lock()
	defer host.mu.Unlock()
	result := HostStatusResult{Generations: []int64{}}
	for _, proc := range host.procs {
		result.Generations = append(result.Generations, proc.generation)
	}
	return result, nil
}

func (host *ProcessHost) Ping(ctx context.Context) error {
	host.mu.Lock()
	procs := make([]*processPlugin, 0, len(host.procs))
	for _, proc := range host.procs {
		procs = append(procs, proc)
	}
	host.mu.Unlock()
	for _, proc := range procs {
		if _, err := proc.call(ctx, "status", map[string]any{}); err != nil {
			return err
		}
	}
	return nil
}

func (host *ProcessHost) SocketPath() string { return "" }
func (host *ProcessHost) Token() string      { return "" }
func (host *ProcessHost) PID() int {
	host.mu.Lock()
	defer host.mu.Unlock()
	for _, proc := range host.procs {
		if proc.cmd != nil && proc.cmd.Process != nil {
			return proc.cmd.Process.Pid
		}
	}
	return 0
}
func (host *ProcessHost) Running() bool {
	host.mu.Lock()
	defer host.mu.Unlock()
	return len(host.procs) > 0
}

func (host *ProcessHost) log(message string) {
	if host.onLog != nil && strings.TrimSpace(message) != "" {
		host.onLog(message)
	}
}

func (proc *processPlugin) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	return proc.callWith(ctx, method, params, nil)
}

func (proc *processPlugin) callWith(ctx context.Context, method string, params any, onCall func(context.Context, string, json.RawMessage) (any, error)) (json.RawMessage, error) {
	proc.stateMu.Lock()
	if proc.closed {
		proc.stateMu.Unlock()
		return nil, pluginerr.New("plugin_rpc_closed", "process 插件已退出")
	}
	proc.nextID++
	id := fmt.Sprintf("%d", proc.nextID)
	pending := &processPending{replies: make(chan processReply, 1), onCall: onCall}
	proc.pending[id] = pending
	proc.stateMu.Unlock()
	defer func() {
		proc.stateMu.Lock()
		delete(proc.pending, id)
		proc.stateMu.Unlock()
	}()

	request, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	proc.writeMu.Lock()
	_, err := proc.stdin.Write(append(request, '\n'))
	proc.writeMu.Unlock()
	if err != nil {
		return nil, pluginerr.New("plugin_rpc_closed", "process 插件写入失败："+err.Error())
	}
	select {
	case <-ctx.Done():
		proc.stop(context.Background())
		return nil, pluginerr.New("plugin_rpc_timeout", "process 插件调用超时")
	case reply := <-pending.replies:
		return reply.value, reply.err
	}
}

// readLoop 读取插件的响应行，并把带 parent 的 call 帧分发给对应 invoke 的反向回调。
func (proc *processPlugin) readLoop() {
	for {
		line, err := proc.reader.ReadBytes('\n')
		if len(line) > 0 {
			proc.handleLine(line)
		}
		if err != nil {
			proc.stateMu.Lock()
			proc.closed = true
			pending := make([]*processPending, 0, len(proc.pending))
			for _, item := range proc.pending {
				pending = append(pending, item)
			}
			proc.stateMu.Unlock()
			for _, item := range pending {
				item.replies <- processReply{err: pluginerr.New("plugin_rpc_closed", "process 插件已退出")}
			}
			return
		}
	}
}

func (proc *processPlugin) handleLine(line []byte) {
	var message struct {
		ID     string          `json:"id"`
		Parent string          `json:"parent"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(line, &message) != nil || message.ID == "" {
		return
	}
	if message.Parent != "" && message.Method != "" {
		proc.stateMu.Lock()
		pending := proc.pending[message.Parent]
		proc.stateMu.Unlock()
		if pending == nil || pending.onCall == nil {
			proc.writeResponse(message.ID, nil, pluginerr.New("plugin_rpc_invalid", "反向调用父请求不存在"))
			return
		}
		go func() {
			result, err := pending.onCall(context.Background(), message.Method, message.Params)
			proc.writeResponse(message.ID, result, err)
		}()
		return
	}
	proc.stateMu.Lock()
	pending := proc.pending[message.ID]
	proc.stateMu.Unlock()
	if pending == nil {
		return
	}
	if message.Error != nil {
		pending.replies <- processReply{err: pluginerr.New(firstNonEmpty(message.Error.Code, "plugin_rpc_error"), message.Error.Message)}
		return
	}
	value := message.Result
	if len(value) == 0 {
		value = json.RawMessage("null")
	}
	pending.replies <- processReply{value: value}
}

func (proc *processPlugin) writeResponse(id string, result any, callErr error) {
	payload := map[string]any{"id": id}
	if callErr != nil {
		code := "plugin_rpc_error"
		message := callErr.Error()
		if coded, ok := pluginerr.From(callErr); ok {
			code = firstNonEmpty(coded.Code, code)
			message = coded.Message
		}
		payload["error"] = map[string]any{"code": code, "message": message}
	} else {
		payload["result"] = result
	}
	encoded, _ := json.Marshal(payload)
	proc.writeMu.Lock()
	_, _ = proc.stdin.Write(append(encoded, '\n'))
	proc.writeMu.Unlock()
}

// InvokeReverse 允许 process 插件在 invoke 中通过 call 帧反向调用网关。
func (proc *processPlugin) InvokeReverse(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration, onCall func(context.Context, string, json.RawMessage) (any, error)) (json.RawMessage, error) {
	callCtx := ctx
	var cancel context.CancelFunc
	if timeout > 0 {
		callCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	return proc.callWith(callCtx, "invoke", map[string]any{
		"generation": generation, "contributionId": contributionID, "value": value,
	}, onCall)
}

func (proc *processPlugin) stop(ctx context.Context) {
	proc.stateMu.Lock()
	if proc.closed {
		proc.stateMu.Unlock()
		return
	}
	proc.closed = true
	_ = proc.stdin.Close()
	proc.stateMu.Unlock()
	if proc.cmd != nil && proc.cmd.Process != nil {
		_ = proc.cmd.Process.Kill()
		_, _ = proc.cmd.Process.Wait()
	}
}

func processEnvironment(extra []string) []string {
	allow := map[string]bool{}
	for _, name := range EnvAllowlist {
		allow[name] = true
	}
	for _, name := range extra {
		allow[name] = true
	}
	env := make([]string, 0, len(allow))
	for _, item := range os.Environ() {
		name, _, found := strings.Cut(item, "=")
		if found && allow[name] {
			env = append(env, item)
		}
	}
	return env
}

func manifestContributions(manifest map[string]any) []string {
	out := make([]string, 0)
	list, _ := manifest["contributes"].([]any)
	for _, item := range list {
		entry, _ := item.(map[string]any)
		id, _ := entry["id"].(string)
		if strings.TrimSpace(id) != "" {
			out = append(out, id)
		}
	}
	return out
}

var _ HostClient = (*ProcessHost)(nil)

// errProcessHostUnavailable 保留给组合根判断；当前实现总是可用。
var errProcessHostUnavailable = errors.New("process plugin host unavailable")
