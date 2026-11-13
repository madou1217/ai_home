// Package webuisshhostbrowseapi 是 WebUI「选择远端目录」的只读 HTTP 边界。
//
//	GET  /v1/management/webui/ssh-hosts/browse?connectionId=...&subDir=...
//	POST /v1/management/webui/ssh-hosts/browse  { connectionId, subDir? }
//
// 对应 Node lib/server/ssh-host-browse.js 的 browseRemoteDirectories：
// 按连接 id 与远端目录（支持空路径 / ~ / 相对路径折成远端家目录，以及 POSIX / Windows 方言）
// 列出条目，返回 currentDir / parentDir / entries / directories。
package webuisshhostbrowseapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
)

const (
	// Path 是远端目录浏览的管理契约路径。
	Path = "/v1/management/webui/ssh-hosts/browse"

	defaultTimeout        = 15 * time.Second
	defaultMaxOutputBytes = 2 << 20
	maxRemotePathBytes    = 4096
	maxBrowseBodyBytes    = 256 * 1024
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

// DirectoryResult 表示方言自适应的目录浏览结果。
type DirectoryResult struct {
	CurrentDir  string
	ParentDir   string
	Entries     []Entry
	Directories []Directory
	Truncated   bool
}

// DirectoryBrowser 由适配层可选实现：单次连接完成方言识别、$HOME 探测与列目录，
// 支持空路径 / ~ / 相对路径及 Windows PowerShell 远端。
type DirectoryBrowser interface {
	BrowseDirectory(ctx context.Context, connection Conn, subDir string, maxOutputBytes int) (DirectoryResult, error)
}

// RemoteFailure 是 Runner 可返回的结构化远端失败，Code 与 Node 的 error.code 对齐。
type RemoteFailure struct {
	Code    string
	Reason  string
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
	// AIHomeDir 是 aih 数据目录；Connections 为 nil 时用它打开 app-state 的只读连接表。
	AIHomeDir   string
	Connections Connections
	// Runner 为 nil 时浏览接口返回 501：宿主还没接线远端执行。
	Runner Runner
	// Timeout 是单次远端列目录的超时，<=0 用 15s。
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
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 接受 GET 与 POST。
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
	if request.Method != http.MethodGet && request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET 或 POST")
		return
	}
	if handler.runner == nil {
		writeError(response, http.StatusNotImplemented, "ssh_runner_unavailable", "SSH 执行端口未接线，无法浏览远端目录")
		return
	}

	connectionID, rawSubDir, bodyCode, bodyMsg := extractBrowseInput(response, request)
	if bodyCode != "" {
		writeError(response, http.StatusBadRequest, bodyCode, bodyMsg)
		return
	}
	if connectionID == "" {
		writeError(response, http.StatusBadRequest, "missing_connection", "Connection ID is required.")
		return
	}
	subDir, pathErr := validateBrowseSubDir(rawSubDir)
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

	result, err := handler.browse(request.Context(), connection, subDir)
	if err != nil {
		writeBrowseFailure(response, err)
		return
	}
	writeJSON(response, http.StatusOK, responseView{
		OK:          true,
		CurrentDir:  result.CurrentDir,
		ParentDir:   result.ParentDir,
		Entries:     result.Entries,
		Directories: result.Directories,
		Truncated:   result.Truncated,
	})
}

func extractBrowseInput(response http.ResponseWriter, request *http.Request) (string, string, string, string) {
	if request.Method == http.MethodGet {
		query := request.URL.Query()
		return strings.TrimSpace(query.Get("connectionId")), query.Get("subDir"), "", ""
	}
	if request.Body == nil {
		return "", "", "", ""
	}
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBrowseBodyBytes))
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		if errors.Is(err, io.EOF) {
			return "", "", "", ""
		}
		return "", "", "invalid_json_body", "请求体不是合法 JSON"
	}
	object, ok := payload.(map[string]any)
	if !ok || object == nil {
		return "", "", "invalid_request_body", "请求体必须是 JSON 对象"
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return "", "", "invalid_json_body", "请求体不是合法 JSON"
	}
	connID, _ := object["connectionId"].(string)
	subDir, _ := object["subDir"].(string)
	return strings.TrimSpace(connID), subDir, "", ""
}

func (handler *Handler) browse(ctx context.Context, connection Conn, subDir string) (DirectoryResult, error) {
	if browser, ok := handler.runner.(DirectoryBrowser); ok {
		runCtx, cancel := context.WithTimeout(ctx, handler.timeout)
		defer cancel()
		return browser.BrowseDirectory(runCtx, connection, subDir, handler.maxOutputBytes)
	}
	directory := subDir
	if isPOSIXAbsolute(directory) {
		directory = path.Clean(directory)
	} else {
		runCtx, cancel := context.WithTimeout(ctx, handler.timeout)
		homeBytes, err := handler.runner.Run(runCtx, connection, []string{"sh", "-c", `printf %sn "$HOME"`})
		cancel()
		if err != nil {
			return DirectoryResult{}, err
		}
		home := strings.TrimSpace(strings.Split(strings.ReplaceAll(string(homeBytes), "\r\n", "\n"), "\n")[0])
		if home == "" {
			home = "/"
		}
		resolved := sshhost.ResolveBrowsePath(directory, home, sshhost.DialectPOSIX)
		if !strings.HasPrefix(resolved, "/") {
			return DirectoryResult{}, &RemoteFailure{Code: "remote_execution_failed", Message: "远端家目录路径无效。"}
		}
		directory = path.Clean(resolved)
	}
	entries, truncated, err := handler.readDirectory(ctx, connection, directory)
	if err != nil {
		return DirectoryResult{}, err
	}
	directories := make([]Directory, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDirectory {
			directories = append(directories, Directory{Name: entry.Name, Path: entry.Path})
		}
	}
	return DirectoryResult{
		CurrentDir:  directory,
		ParentDir:   parentRemotePath(directory),
		Entries:     entries,
		Directories: directories,
		Truncated:   truncated,
	}, nil
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

func writeBrowseFailure(response http.ResponseWriter, err error) {
	var failure *RemoteFailure
	if errors.As(err, &failure) && failure != nil && failure.Code == "invalid_identity_file" {
		writeJSON(response, http.StatusBadRequest, errorView{
			OK:      false,
			Error:   "invalid_identity_file",
			Reason:  failure.Reason,
			Message: failure.Message,
		})
		return
	}
	writeError(response, http.StatusInternalServerError, "remote_execution_failed", failureMessage(err))
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
	if text := strings.TrimSpace(err.Error()); text != "" {
		return text
	}
	return "连接远程服务器失败或指定的工作区目录路径不存在。"
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
