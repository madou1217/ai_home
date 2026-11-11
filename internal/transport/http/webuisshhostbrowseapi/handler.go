// Package webuisshhostbrowseapi 是 WebUI「选择远端目录」的只读 HTTP 边界。
//
//	GET /v1/management/webui/ssh-hosts/browse?connectionId=...&subDir=...
//
// 对应 Node lib/server/ssh-host-browse.js 的 browseRemoteDirectories：
// 按连接 id 与远端目录列出条目，返回 currentDir / parentDir / entries，
// 同时保留 Node 的 directories（只含目录）以兼容现有前端。
//
// 与 Node 的差异（刻意收紧）：
//   - Node 是 POST + JSON body，这里改成 GET 查询参数；
//   - Node 会把空路径 / 相对路径折成远端家目录，那需要先探测远端 profile；
//     本包没有 profile 端口，因此只接受绝对路径，空值与相对路径一律 400；
//   - 远端命令由 Runner 以 argv 直传执行，路径永远是独立参数，不拼 shell 字符串。
package webuisshhostbrowseapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
)

const (
	// Path 是远端目录浏览的管理契约路径。
	Path = "/v1/management/webui/ssh-hosts/browse"

	defaultTimeout        = 10 * time.Second
	defaultMaxOutputBytes = 2 << 20
	maxRemotePathBytes    = 4096
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权或连接读取端口。
var ErrInvalidDependencies = errors.New("SSH 远端目录浏览接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Connections 读取 ssh_connections 原文（与 webuisshapi.Store 同形状）。
type Connections interface {
	ReadConnections(ctx context.Context) (string, bool, error)
}

// Conn 是一次远端执行需要的连接事实，由 ssh_connections 的记录展开。
type Conn struct {
	ID                 string
	Label              string
	Host               string
	User               string
	Port               int
	AuthType           string
	Password           string
	PrivateKey         string
	IdentityFile       string
	EgressConnectionID string
	// Jump 是 egressConnectionId 解析后的跳板链；为 nil 且 EgressConnectionID 非空时
	// 由 Runner 失败关闭（不静默直连）。
	Jump          *Conn
	ReverseTunnel map[string]any
	// Raw 是记录原文，适配层可读取本包未建模的字段（例如隧道参数）。
	Raw map[string]any
}

// Runner 在指定连接上执行一条远端命令。
//
// argv 是参数向量：实现方必须逐项作为参数执行（ssh exec 时逐项转义），
// 不能把 argv 拼成一条未经转义的 shell 字符串。返回的 stdout 超限时由 Handler 截断。
type Runner interface {
	Run(ctx context.Context, connection Conn, argv []string) ([]byte, error)
}

// RemoteFailure 是 Runner 可返回的结构化远端失败，Code 与 Node 的 error.code 对齐。
type RemoteFailure struct {
	Code    string
	Message string
}

// Error 实现 error；Message 为空时回落到 Code。
func (failure *RemoteFailure) Error() string {
	if failure == nil {
		return ""
	}
	if strings.TrimSpace(failure.Message) != "" {
		return failure.Message
	}
	return failure.Code
}

// Dependencies 汇总浏览依赖。
type Dependencies struct {
	Authorizer Authorizer
	// AIHomeDir 是 aih 数据目录；Connections 为 nil 时用它打开 app-state 的只读连接表
	// （复用 webuisshapi.Source）。两者都缺时拒绝装配。
	AIHomeDir   string
	Connections Connections
	// Runner 为 nil 时浏览接口返回 501：宿主还没接线远端执行。
	Runner Runner
	// Timeout 是单次远端列目录的超时，<=0 用 10s。
	Timeout time.Duration
	// MaxOutputBytes 是远端输出上限，<=0 用 2MB；超限截断并标记 truncated。
	MaxOutputBytes int
}

// Handler 处理远端目录浏览。
type Handler struct {
	authorizer     Authorizer
	connections    Connections
	runner         Runner
	timeout        time.Duration
	maxOutputBytes int
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	connections := dependencies.Connections
	if connections == nil && strings.TrimSpace(dependencies.AIHomeDir) != "" {
		source, err := webuisshapi.OpenSource(dependencies.AIHomeDir)
		if err != nil {
			return nil, err
		}
		connections = source
	}
	if connections == nil {
		return nil, ErrInvalidDependencies
	}
	timeout := dependencies.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	maxOutputBytes := dependencies.MaxOutputBytes
	if maxOutputBytes <= 0 {
		maxOutputBytes = defaultMaxOutputBytes
	}
	return &Handler{
		authorizer:     dependencies.Authorizer,
		connections:    connections,
		runner:         dependencies.Runner,
		timeout:        timeout,
		maxOutputBytes: maxOutputBytes,
	}, nil
}

type responseView struct {
	OK          bool        `json:"ok"`
	CurrentDir  string      `json:"currentDir"`
	ParentDir   string      `json:"parentDir"`
	Entries     []Entry     `json:"entries"`
	Directories []Directory `json:"directories"`
	Truncated   bool        `json:"truncated,omitempty"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.connections == nil {
		writeError(response, http.StatusServiceUnavailable, "ssh_browse_unavailable", "SSH 远端目录浏览服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	if handler.runner == nil {
		writeError(response, http.StatusNotImplemented, "ssh_runner_unavailable", "SSH 执行端口未接线，无法浏览远端目录")
		return
	}

	query := request.URL.Query()
	connectionID := strings.TrimSpace(query.Get("connectionId"))
	if connectionID == "" {
		writeError(response, http.StatusBadRequest, "missing_connection", "Connection ID is required.")
		return
	}
	directory, pathErr := normalizeRemotePath(query.Get("subDir"))
	if pathErr != nil {
		writeError(response, http.StatusBadRequest, "invalid_path", pathErr.Error())
		return
	}

	raw, found, err := handler.connections.ReadConnections(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_connections_read_failed", "")
		return
	}
	connection, ok, err := findConnection(raw, found, connectionID)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_connections_invalid", "ssh_connections 不是合法 JSON")
		return
	}
	if !ok {
		writeError(response, http.StatusNotFound, "not_found", "Connection not found.")
		return
	}

	entries, truncated, err := handler.readDirectory(request.Context(), connection, directory)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "remote_execution_failed", failureMessage(err))
		return
	}
	directories := make([]Directory, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDirectory {
			directories = append(directories, Directory{Name: entry.Name, Path: entry.Path})
		}
	}
	writeJSON(response, http.StatusOK, responseView{
		OK:          true,
		CurrentDir:  directory,
		ParentDir:   parentRemotePath(directory),
		Entries:     entries,
		Directories: directories,
		Truncated:   truncated,
	})
}

// readDirectory 执行一次列目录，并按输出上限截断（截断时丢掉末尾不完整的行）。
func (handler *Handler) readDirectory(
	ctx context.Context,
	connection Conn,
	directory string,
) ([]Entry, bool, error) {
	runCtx, cancel := context.WithTimeout(ctx, handler.timeout)
	defer cancel()
	stdout, err := handler.runner.Run(runCtx, connection, listArgv(directory))
	if err != nil {
		return nil, false, err
	}
	truncated := false
	if len(stdout) > handler.maxOutputBytes {
		stdout = truncateAtLine(stdout, handler.maxOutputBytes)
		truncated = true
	}
	return parseListing(string(stdout), directory), truncated, nil
}

// failureMessage 把 Runner 错误翻成面向用户的文案，优先采用适配层给出的结构化失败。
func failureMessage(err error) string {
	var failure *RemoteFailure
	if errors.As(err, &failure) {
		if message := strings.TrimSpace(failure.Message); message != "" {
			return message
		}
		switch failure.Code {
		case "not_found":
			return "目录不存在或不可访问。"
		case "permission_denied":
			return "没有权限访问该目录。"
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "读取远端目录超时。"
	}
	if message := strings.TrimSpace(err.Error()); message != "" {
		return message
	}
	return "连接远程服务器失败。"
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
