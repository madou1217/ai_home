// Package webuisshprobeapi 是 WebUI「SSH 开发机探测」的只读 HTTP 边界。
//
//	GET /v1/management/webui/ssh/probe?connectionId=conn_...&timeoutMs=12000
//
// 对应 Node 的 POST /v0/webui/ssh-connections/test（lib/server/webui-ssh-host-routes.js），
// 但只接受已保存连接的 id：凭据从 ssh_connections 读取，浏览器不必回传秘密；
// 查询参数只有 connectionId 与 timeoutMs，探测本身不修改任何持久状态。
//
// 与 Node 的差异：Node 允许临时传 host / user / 密码做未保存连接测试；
// 本接口第一切片只覆盖「已保存连接」，临时连接留给后续切片。
package webuisshprobeapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
)

const (
	// Path 是 SSH 连通性探测的管理契约路径。
	Path = "/v1/management/webui/ssh/probe"

	defaultTimeoutMs = 12000
	maxTimeoutMs     = 60000
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权或连接读取端口。
var ErrInvalidDependencies = errors.New("SSH 探测接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Connections 读取 ssh_connections 原文（与 webuisshapi.Store 同形状）。
type Connections interface {
	ReadConnections(ctx context.Context) (string, bool, error)
}

// Prober 执行一次只读探测；生产实现是 sshremote.Prober。
type Prober interface {
	Probe(ctx context.Context, config sshremote.Config, timeout time.Duration) (sshremote.ProbeResult, error)
}

// Dependencies 汇总探测依赖。
type Dependencies struct {
	Authorizer Authorizer
	// AIHomeDir 在 Connections 为 nil 时用于打开 app-state 的只读连接表。
	AIHomeDir   string
	Connections Connections
	// Prober 为 nil 时返回 501：宿主还没接线 SSH 传输。
	Prober Prober
}

// Handler 处理 SSH 连通性探测。
type Handler struct {
	authorizer  Authorizer
	connections Connections
	prober      Prober
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
	return &Handler{
		authorizer:  dependencies.Authorizer,
		connections: connections,
		prober:      dependencies.Prober,
	}, nil
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.connections == nil {
		writeError(response, http.StatusServiceUnavailable, "ssh_probe_unavailable", "SSH 探测服务不可用")
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
	if handler.prober == nil {
		writeError(response, http.StatusNotImplemented, "ssh_transport_unavailable", "SSH 传输端口未接线，无法探测")
		return
	}

	query := request.URL.Query()
	connectionID := strings.TrimSpace(query.Get("connectionId"))
	if connectionID == "" {
		writeError(response, http.StatusBadRequest, "missing_connection", "Connection ID is required.")
		return
	}
	raw, found, err := handler.connections.ReadConnections(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_connections_read_failed", "")
		return
	}
	target, ok, err := findConnection(raw, found, connectionID)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_connections_invalid", "ssh_connections 不是合法 JSON")
		return
	}
	if !ok {
		writeError(response, http.StatusNotFound, "not_found", "Connection not found.")
		return
	}
	if target.Host == "" {
		writeError(response, http.StatusBadRequest, "missing_host", "Host is required.")
		return
	}

	result, err := handler.prober.Probe(request.Context(), sshremote.Config{
		Host:         target.Host,
		Port:         target.Port,
		User:         target.User,
		AuthType:     target.AuthType,
		Password:     target.Password,
		PrivateKey:   target.PrivateKey,
		IdentityFile: target.IdentityFile,
	}, timeoutFromQuery(query.Get("timeoutMs")))
	if err != nil {
		writeError(response, http.StatusInternalServerError, "probe_failed", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "result": result})
}

// timeoutFromQuery 解析毫秒超时；非法或非正值回落默认，超过上限则夹取。
func timeoutFromQuery(value string) time.Duration {
	milliseconds := defaultTimeoutMs
	if parsed, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && parsed > 0 {
		milliseconds = parsed
	}
	if milliseconds > maxTimeoutMs {
		milliseconds = maxTimeoutMs
	}
	return time.Duration(milliseconds) * time.Millisecond
}

// connection 是探测需要展开的连接事实。
type connection struct {
	ID           string
	Host         string
	User         string
	Port         int
	AuthType     string
	Password     string
	PrivateKey   string
	IdentityFile string
}

// findConnection 在 ssh_connections 原文里按 id 找连接；端口缺省或越界时回落 22。
func findConnection(raw string, found bool, connectionID string) (connection, bool, error) {
	if !found || strings.TrimSpace(raw) == "" {
		return connection{}, false, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return connection{}, false, err
	}
	list, ok := decoded.([]any)
	if !ok {
		return connection{}, false, nil
	}
	for _, item := range list {
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

// connectionFromObject 展开一条连接记录；密码与私钥保持原值，不做裁剪。
func connectionFromObject(object map[string]any) connection {
	port := int(numberField(object, "port"))
	if port <= 0 || port > 65535 {
		port = 22
	}
	return connection{
		ID:           stringField(object, "id"),
		Host:         stringField(object, "host"),
		User:         stringField(object, "user"),
		Port:         port,
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

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	body := map[string]any{"ok": false, "error": code}
	if message != "" {
		body["message"] = message
	}
	writeJSON(response, status, body)
}
