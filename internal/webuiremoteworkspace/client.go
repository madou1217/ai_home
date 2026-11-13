package webuiremoteworkspace

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

const (
	// DefaultCommandLimit 是列目录 / stat 的默认输出上限。
	DefaultCommandLimit = 4 << 20
)

// SessionRunner 抽象单条已建立的 SSH 会话连接，方便测试替身注入。
type SessionRunner interface {
	Run(ctx context.Context, command string, limit int) (sshremote.Result, error)
	Close() error
}

// DialFunc 按连接配置建立远端执行会话。
type DialFunc func(ctx context.Context, connection Connection, hostHomeDir string) (SessionRunner, error)

// Service 管理远程工作区的 SSH 会话创建与方言识别。
type Service struct {
	aiHomeDir   string
	hostHomeDir string
	dial        DialFunc
}

// NewService 创建远程工作区访问服务。
func NewService(aiHomeDir, hostHomeDir string, dial DialFunc) *Service {
	if dial == nil {
		dial = defaultDial
	}
	return &Service{
		aiHomeDir:   strings.TrimSpace(aiHomeDir),
		hostHomeDir: strings.TrimSpace(hostHomeDir),
		dial:        dial,
	}
}

func defaultDial(ctx context.Context, connection Connection, hostHomeDir string) (SessionRunner, error) {
	cfg, err := ToSSHConfig(connection, hostHomeDir)
	if err != nil {
		return nil, err
	}
	client, err := sshremote.Dial(ctx, cfg, 0)
	if err != nil {
		return nil, translateSSHError(err)
	}
	return client, nil
}

// OpenSession 按工作区 ID 查配置、建立 SSH 会话并返回可复用的 Session。
func (service *Service) OpenSession(ctx context.Context, workspaceID string) (*Session, error) {
	if service == nil || service.aiHomeDir == "" {
		return nil, &RemoteError{Status: http.StatusServiceUnavailable, Code: "remote_workspace_unavailable", Message: "远程工作区服务不可用"}
	}
	workspace, found, err := FindWorkspace(ctx, service.aiHomeDir, workspaceID)
	if err != nil {
		return nil, &RemoteError{Status: http.StatusInternalServerError, Code: "remote_workspace_read_failed", Message: err.Error()}
	}
	if !found {
		return nil, &RemoteError{Status: http.StatusNotFound, Code: "workspace_not_found", Message: "远程工作区不存在"}
	}
	conn, connFound, err := LoadConnection(ctx, service.aiHomeDir, workspace.ConnectionID)
	if err != nil {
		return nil, &RemoteError{Status: http.StatusInternalServerError, Code: "ssh_connection_read_failed", Message: err.Error()}
	}
	if !connFound {
		return nil, &RemoteError{Status: http.StatusNotFound, Code: "connection_not_found", Message: "远程工作区关联的 SSH 连接不存在"}
	}
	runner, err := service.dial(ctx, conn, service.hostHomeDir)
	if err != nil {
		return nil, err
	}
	return &Session{
		workspace: workspace,
		runner:    runner,
		dialect:   workspace.Dialect,
	}, nil
}

// Session 封装一个已连接远程工作区上的文件与 Git 操作。
type Session struct {
	workspace WorkspaceRecord
	runner    SessionRunner

	mu      sync.Mutex
	dialect string
}

// Workspace 返回关联的工作区记录。
func (session *Session) Workspace() WorkspaceRecord {
	return session.workspace
}

// Close 关闭底层 SSH 会话。
func (session *Session) Close() error {
	if session == nil || session.runner == nil {
		return nil
	}
	return session.runner.Close()
}

// Dialect 确保已识别远端 shell 方言（一次检测后缓存于当前请求会话）。
func (session *Session) Dialect(ctx context.Context) (string, error) {
	session.mu.Lock()
	cached := session.dialect
	session.mu.Unlock()
	if cached != "" {
		return cached, nil
	}
	result, err := session.runner.Run(ctx, DetectCommand, 64*1024)
	if err != nil {
		return "", translateSSHError(err)
	}
	dialect, ok := ParseDetectOutput(string(result.Stdout))
	if !ok {
		return "", &RemoteError{Status: http.StatusBadGateway, Code: "remote_dialect_unknown", Message: "无法识别远端操作系统方言"}
	}
	session.mu.Lock()
	if session.dialect == "" {
		session.dialect = dialect
	} else {
		dialect = session.dialect
	}
	session.mu.Unlock()
	return dialect, nil
}

// Stat 查询工作区相对路径的文件/目录元数据。
func (session *Session) Stat(ctx context.Context, relPath string) (StatInfo, error) {
	dialect, err := session.Dialect(ctx)
	if err != nil {
		return StatInfo{}, err
	}
	absPath := JoinRemotePath(dialect, session.workspace.RemoteRoot, relPath)
	result, err := session.runner.Run(ctx, BuildStatCommand(dialect, absPath), DefaultCommandLimit)
	if err != nil {
		return StatInfo{}, translateSSHError(err)
	}
	if result.Code != 0 {
		return StatInfo{}, classifyExecFailure(result, absPath)
	}
	return ParseStatOutput(string(result.Stdout))
}

// ListDir 列出工作区相对目录下的所有条目。
func (session *Session) ListDir(ctx context.Context, relPath string) ([]Entry, error) {
	dialect, err := session.Dialect(ctx)
	if err != nil {
		return nil, err
	}
	absPath := JoinRemotePath(dialect, session.workspace.RemoteRoot, relPath)
	result, err := session.runner.Run(ctx, BuildListDirCommand(dialect, absPath), DefaultCommandLimit)
	if err != nil {
		return nil, translateSSHError(err)
	}
	if result.Code != 0 {
		return nil, classifyExecFailure(result, absPath)
	}
	return ParseListDirOutput(string(result.Stdout)), nil
}

// ReadFile 读取远端文件字节内容（base64 传输并按 maxBytes 限流）。
func (session *Session) ReadFile(ctx context.Context, relPath string, maxBytes int64) ([]byte, int64, int64, error) {
	dialect, err := session.Dialect(ctx)
	if err != nil {
		return nil, 0, 0, err
	}
	absPath := JoinRemotePath(dialect, session.workspace.RemoteRoot, relPath)
	limit := int((maxBytes*4)/3) + 1024
	if maxBytes <= 0 || limit < DefaultCommandLimit {
		limit = DefaultCommandLimit
	}
	result, err := session.runner.Run(ctx, BuildReadFileCommand(dialect, absPath), limit)
	if err != nil {
		return nil, 0, 0, translateSSHError(err)
	}
	if result.Code != 0 {
		return nil, 0, 0, classifyExecFailure(result, absPath)
	}
	return ParseReadFileOutput(string(result.Stdout), result.Truncated, maxBytes)
}

// RunGit 在工作区根目录执行 git 命令。
func (session *Session) RunGit(ctx context.Context, args []string, maxOutputBytes int) (sshremote.Result, error) {
	dialect, err := session.Dialect(ctx)
	if err != nil {
		return sshremote.Result{}, err
	}
	cmd := BuildGitCommand(dialect, session.workspace.RemoteRoot, args)
	result, err := session.runner.Run(ctx, cmd, maxOutputBytes)
	if err != nil {
		return sshremote.Result{}, translateSSHError(err)
	}
	return result, nil
}

func classifyExecFailure(result sshremote.Result, absPath string) error {
	stderr := string(result.Stderr)
	lower := strings.ToLower(stderr)
	if strings.Contains(lower, "permission denied") || strings.Contains(lower, "access") && strings.Contains(lower, "denied") {
		return &RemoteError{Status: http.StatusForbidden, Code: "permission_denied", Message: fmt.Sprintf("没有权限：%s", absPath)}
	}
	if result.Code == 3 || strings.Contains(stderr, "NOENT") {
		return &RemoteError{Status: http.StatusNotFound, Code: "not_found", Message: fmt.Sprintf("远端不存在：%s", absPath)}
	}
	return &RemoteError{Status: http.StatusBadGateway, Code: "remote_io_error", Message: fmt.Sprintf("远端读写失败：%s", absPath)}
}

func translateSSHError(err error) error {
	var remoteErr *RemoteError
	if errors.As(err, &remoteErr) && remoteErr != nil {
		return remoteErr
	}
	var sshErr *sshremote.Error
	if errors.As(err, &sshErr) && sshErr != nil {
		status := http.StatusBadGateway
		if sshErr.Code == sshremote.CodeTimeout {
			status = http.StatusGatewayTimeout
		} else if sshErr.Code == sshremote.CodeInvalidConfig || sshErr.Code == sshremote.CodeInvalidPath {
			status = http.StatusBadRequest
		}
		return &RemoteError{Status: status, Code: sshErr.Code, Message: sshErr.Message}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &RemoteError{Status: http.StatusGatewayTimeout, Code: "ssh_timeout", Message: "远程工作区连接或执行超时"}
	}
	return &RemoteError{Status: http.StatusBadGateway, Code: "remote_workspace_failed", Message: err.Error()}
}
