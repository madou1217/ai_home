package webuitoolkitenvapi

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// remoteDialTimeout 与 Node 远端通道的单次连接上限一致（12s 量级）。
const remoteDialTimeout = 20 * time.Second

// connection 是 SSH 连接记录的展开结果。
type connection struct {
	ID           string
	Label        string
	Host         string
	Port         int
	User         string
	AuthType     string
	Password     string
	PrivateKey   string
	IdentityFile string
}

func connectionFromObject(object map[string]any) connection {
	port := int(numberField(object, "port"))
	if port <= 0 || port > 65535 {
		port = 22
	}
	return connection{
		ID:           stringField(object, "id"),
		Label:        stringField(object, "label"),
		Host:         stringField(object, "host"),
		Port:         port,
		User:         stringField(object, "user"),
		AuthType:     stringField(object, "authType"),
		Password:     rawStringField(object, "password"),
		PrivateKey:   rawStringField(object, "privateKey"),
		IdentityFile: stringField(object, "identityFile"),
	}
}

func stringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return strings.TrimSpace(value)
}

func rawStringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

func numberField(object map[string]any, key string) float64 {
	value, _ := object[key].(float64)
	return value
}

// findConnection 在 ssh_connections 原文里按 id 查找连接。
func findConnection(raw string, found bool, connectionID string) (connection, bool, error) {
	if !found || strings.TrimSpace(raw) == "" {
		return connection{}, false, nil
	}
	var decoded []any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return connection{}, false, err
	}
	for _, item := range decoded {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if stringField(object, "id") != connectionID {
			continue
		}
		return connectionFromObject(object), true, nil
	}
	return connection{}, false, nil
}

// sshTarget 是一条 SSH 连接上的执行目标。
//
// 连接按需建立并在目标生命周期内复用：一次探测要发几十条命令，逐条握手不可接受。
// Close 由调用方在请求 / 作业结束时调用。出网代理（egressConnectionId）尚未迁移：
// 这类连接仍走直连，不会静默使用错误的代理。
type sshTarget struct {
	key           string
	label         string
	record        connection
	knownHostsDir string

	mu     sync.Mutex
	client *sshremote.Client
	facts  *remoteFacts
}

type remoteFacts struct {
	Platform string
	HomeDir  string
	Arch     string
	OS       string
}

func newSSHTarget(record connection, homeDir string) *sshTarget {
	label := record.Label
	if label == "" {
		label = record.Host
	}
	return &sshTarget{
		key:           "ssh:" + record.ID,
		label:         label,
		record:        record,
		knownHostsDir: homeDir,
	}
}

func (target *sshTarget) Key() string   { return target.key }
func (target *sshTarget) Kind() string  { return "ssh" }
func (target *sshTarget) Label() string { return target.label }

func (target *sshTarget) config() sshremote.Config {
	return sshremote.Config{
		Host:         target.record.Host,
		Port:         target.record.Port,
		User:         target.record.User,
		AuthType:     target.record.AuthType,
		Password:     target.record.Password,
		PrivateKey:   target.record.PrivateKey,
		IdentityFile: target.record.IdentityFile,
		HomeDir:      target.knownHostsDir,
	}
}

func (target *sshTarget) ensureClient(ctx context.Context) (*sshremote.Client, error) {
	target.mu.Lock()
	defer target.mu.Unlock()
	if target.client != nil {
		return target.client, nil
	}
	client, err := sshremote.Dial(ctx, target.config(), remoteDialTimeout)
	if err != nil {
		return nil, err
	}
	target.client = client
	return client, nil
}

func (target *sshTarget) ExistingFacts() *remoteFacts {
	target.mu.Lock()
	defer target.mu.Unlock()
	if target.facts == nil {
		return nil
	}
	copied := *target.facts
	return &copied
}

// describe 探测远端平台 / 家目录 / 架构。
func (target *sshTarget) describe(ctx context.Context) (remoteFacts, error) {
	if facts := target.ExistingFacts(); facts != nil {
		return *facts, nil
	}
	client, err := target.ensureClient(ctx)
	if err != nil {
		return remoteFacts{}, err
	}
	script := "printf '%s\\n' \"$HOME\"; uname -s 2>/dev/null || echo unknown; uname -m 2>/dev/null || echo unknown"
	runCtx, cancel := context.WithTimeout(ctx, remoteDialTimeout)
	defer cancel()
	result, err := client.Run(runCtx, "sh -lc "+shellQuote(script), 16*1024)
	if err != nil {
		return remoteFacts{}, err
	}
	if result.Code != 0 {
		return remoteFacts{}, errUnsupportedRemote
	}
	lines := splitLines(string(result.Stdout))
	if len(lines) < 3 {
		return remoteFacts{}, errUnsupportedRemote
	}
	facts := remoteFacts{HomeDir: lines[0], OS: lines[1], Arch: lines[2]}
	switch strings.ToLower(lines[1]) {
	case "darwin":
		facts.Platform = environment.PlatformMacOS
	case "linux":
		facts.Platform = environment.PlatformLinux
	default:
		return remoteFacts{}, errUnsupportedRemote
	}
	target.mu.Lock()
	target.facts = &facts
	target.mu.Unlock()
	return facts, nil
}

// host 返回绑定当前 SSH 连接的探测视图。
func (target *sshTarget) host(ctx context.Context) (environment.Host, error) {
	facts, err := target.describe(ctx)
	if err != nil {
		return environment.Host{}, err
	}
	client, err := target.ensureClient(ctx)
	if err != nil {
		return environment.Host{}, err
	}
	executor := &sshExecutor{client: client, homeDir: facts.HomeDir}
	return environment.Host{
		Platform:  facts.Platform,
		HomeDir:   facts.HomeDir,
		Exists:    func(path string) bool { return remotePathExists(ctx, client, path) },
		ReadDir:   func(path string) ([]string, error) { return remoteListDirectories(ctx, client, path) },
		Exec:      executor,
		LookupEnv: func(string) string { return "" },
	}, nil
}

// run 在远端执行一个计划。
func (target *sshTarget) run(ctx context.Context, plan environment.Plan, onOutput func(stream string, chunk string)) environment.RunResult {
	facts, err := target.describe(ctx)
	if err != nil {
		return environment.RunResult{SpawnFailed: true, Message: err.Error()}
	}
	client, err := target.ensureClient(ctx)
	if err != nil {
		return environment.RunResult{SpawnFailed: true, Message: err.Error()}
	}
	executor := &sshExecutor{client: client, homeDir: facts.HomeDir}
	timeout := time.Duration(plan.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	options := environment.ExecOptions{Env: plan.Env, Timeout: timeout, OnOutput: onOutput}
	if plan.Cwd != nil {
		options.Dir = *plan.Cwd
	}
	return executor.Run(ctx, plan.Command, plan.Args, options)
}

func (target *sshTarget) close() {
	target.mu.Lock()
	client := target.client
	target.client = nil
	target.mu.Unlock()
	if client != nil {
		_ = client.Close()
	}
}

// sshExecutor 把 argv 交给远端登录 shell 执行。
//
// 不把参数拼成未引用的字符串：每个 argv 元素都经过 POSIX 单引号引用。
type sshExecutor struct {
	client  *sshremote.Client
	homeDir string
}

func (executor *sshExecutor) Run(ctx context.Context, command string, args []string, options environment.ExecOptions) environment.RunResult {
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, shellQuote(command))
	for _, arg := range args {
		parts = append(parts, shellQuote(arg))
	}
	directory := strings.TrimSpace(options.Dir)
	if directory == "" {
		directory = executor.homeDir
	}
	exports := make([]string, 0, len(options.Env))
	for key, value := range options.Env {
		if !environmentNamePattern.MatchString(key) {
			continue
		}
		exports = append(exports, "export "+key+"="+shellQuote(value))
	}
	script := ""
	if len(exports) > 0 {
		script = strings.Join(exports, "; ") + "; "
	}
	script += "cd " + shellQuote(directory) + " && " + strings.Join(parts, " ")
	result, err := executor.client.Run(runCtx, "sh -lc "+shellQuote(script), maxOutputLimit(options.MaxOutputBytes))
	if err != nil {
		timedOut := runCtx.Err() == context.DeadlineExceeded
		return environment.RunResult{
			TimedOut:    timedOut,
			SpawnFailed: !timedOut,
			Message:     err.Error(),
		}
	}
	code := result.Code
	runResult := environment.RunResult{
		OK:        code == 0,
		ExitCode:  &code,
		Stdout:    string(result.Stdout),
		Stderr:    string(result.Stderr),
		Truncated: result.Truncated,
	}
	if options.OnOutput != nil {
		if len(runResult.Stdout) > 0 {
			options.OnOutput("stdout", runResult.Stdout)
		}
		if len(runResult.Stderr) > 0 {
			options.OnOutput("stderr", runResult.Stderr)
		}
	}
	return runResult
}

func maxOutputLimit(value int) int {
	if value <= 0 {
		return 64 * 1024
	}
	if value < 1024 {
		return 1024
	}
	if value > 1024*1024 {
		return 1024 * 1024
	}
	return value
}

// remotePathExists 用 test -e 判断远端路径是否存在。
func remotePathExists(ctx context.Context, client *sshremote.Client, path string) bool {
	runCtx, cancel := context.WithTimeout(ctx, remoteDialTimeout)
	defer cancel()
	result, err := client.Run(runCtx, "sh -lc "+shellQuote("test -e "+shellQuote(path)), 4096)
	if err != nil {
		return false
	}
	return result.Code == 0
}

// remoteListDirectories 用 ls -1Ap 列出远端目录下的子目录名。
func remoteListDirectories(ctx context.Context, client *sshremote.Client, path string) ([]string, error) {
	runCtx, cancel := context.WithTimeout(ctx, remoteDialTimeout)
	defer cancel()
	result, err := client.Run(runCtx, "sh -lc "+shellQuote("ls -1Ap "+shellQuote(path)), 64*1024)
	if err != nil {
		return nil, err
	}
	if result.Code != 0 {
		return nil, errRemoteDirectoryUnavailable
	}
	names := make([]string, 0)
	for _, line := range splitLines(string(result.Stdout)) {
		if !strings.HasSuffix(line, "/") {
			continue
		}
		name := strings.TrimSuffix(line, "/")
		if name == "" || name == "." || name == ".." {
			continue
		}
		names = append(names, name)
	}
	return names, nil
}

func splitLines(value string) []string {
	raw := strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return lines
}
