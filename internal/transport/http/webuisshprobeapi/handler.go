// Package webuisshprobeapi 是 WebUI「SSH 开发机探测」的只读 HTTP 边界。
//
//	GET  /v1/management/webui/ssh/probe?connectionId=conn_...&timeoutMs=12000
//	POST /v1/management/webui/ssh/probe  { connectionId? | host, port?, user?, authType?, password?, privateKey?, identityFile?, egressConnectionId?, timeoutMs? }
//
// 对应 Node 的 POST /v0/webui/ssh-connections/test（lib/server/webui-ssh-host-routes.js），
// 支持按已保存 connectionId 读取凭据，或用未保存的表单字段做临时连通性探测。
package webuisshprobeapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
)

const (
	// Path 是 SSH 连通性探测的管理契约路径。
	Path = "/v1/management/webui/ssh/probe"

	defaultTimeoutMs     = 12000
	defaultPostTimeoutMs = 5000
	maxTimeoutMs         = 60000
	maxJumpDepth         = 5
	maxBodyBytes         = 1 << 20
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
	// HostHomeDir 用于校验 key-file 路径与 known_hosts；未传且 Prober 为 sshremote.Prober 时复用其 HomeDir。
	HostHomeDir string
	// Prober 为 nil 时返回 501：宿主还没接线 SSH 传输。
	Prober Prober
}

// Handler 处理 SSH 连通性探测。
type Handler struct {
	authorizer  Authorizer
	connections Connections
	prober      Prober
	hostHomeDir string
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
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)
	if hostHomeDir == "" {
		if prober, ok := dependencies.Prober.(sshremote.Prober); ok {
			hostHomeDir = strings.TrimSpace(prober.HomeDir)
		}
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		connections: connections,
		prober:      dependencies.Prober,
		hostHomeDir: hostHomeDir,
	}, nil
}

// ServeHTTP 处理 GET（connectionId 查询参数）与 POST（已保存或临时连接体）。
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
	if request.Method != http.MethodGet && request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET 或 POST")
		return
	}
	if handler.prober == nil {
		writeError(response, http.StatusNotImplemented, "ssh_transport_unavailable", "SSH 传输端口未接线，无法探测")
		return
	}

	if request.Method == http.MethodPost {
		handler.servePost(response, request)
		return
	}
	handler.serveGet(response, request)
}

func (handler *Handler) serveGet(response http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	connectionID := strings.TrimSpace(query.Get("connectionId"))
	if connectionID == "" {
		writeError(response, http.StatusBadRequest, "missing_connection", "Connection ID is required.")
		return
	}
	handler.probeSaved(response, request, connectionID, timeoutFromQuery(query.Get("timeoutMs")))
}

func (handler *Handler) servePost(response http.ResponseWriter, request *http.Request) {
	payload, errCode, errMsg := decodeBodyObject(response, request)
	if errCode != "" {
		writeError(response, http.StatusBadRequest, errCode, errMsg)
		return
	}
	timeout := timeoutFromValue(payload["timeoutMs"], defaultPostTimeoutMs)
	connectionID := stringField(payload, "connectionId")
	if connectionID != "" {
		handler.probeSaved(response, request, connectionID, timeout)
		return
	}

	target := connectionFromObject(payload)
	if target.Host == "" {
		writeError(response, http.StatusBadRequest, "missing_host", "Host is required.")
		return
	}
	var config sshremote.Config
	if target.EgressConnectionID != "" {
		raw, found, err := handler.connections.ReadConnections(request.Context())
		if err != nil {
			writeError(response, http.StatusInternalServerError, "ssh_connections_read_failed", "")
			return
		}
		byID, err := parseConnectionsMap(raw, found)
		if err != nil {
			writeError(response, http.StatusInternalServerError, "ssh_connections_invalid", "ssh_connections 不是合法 JSON")
			return
		}
		cfg, ok := buildSSHConfig(target, byID, handler.hostHomeDir)
		if !ok {
			writeError(response, http.StatusConflict, "egress_connection_invalid", "该连接依赖的出口/跳板连接不存在或形成环。")
			return
		}
		config = cfg
	} else {
		config = toSSHConfig(target, handler.hostHomeDir)
	}
	handler.executeProbe(response, request, config, timeout)
}

func (handler *Handler) probeSaved(response http.ResponseWriter, request *http.Request, connectionID string, timeout time.Duration) {
	raw, found, err := handler.connections.ReadConnections(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_connections_read_failed", "")
		return
	}
	byID, err := parseConnectionsMap(raw, found)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_connections_invalid", "ssh_connections 不是合法 JSON")
		return
	}
	targetObj, ok := byID[connectionID]
	if !ok {
		writeError(response, http.StatusNotFound, "not_found", "Connection not found.")
		return
	}
	target := connectionFromObject(targetObj)
	if target.Host == "" {
		writeError(response, http.StatusBadRequest, "missing_host", "Host is required.")
		return
	}
	config, ok := buildSSHConfig(target, byID, handler.hostHomeDir)
	if !ok {
		writeError(response, http.StatusConflict, "egress_connection_invalid", "该连接依赖的出口/跳板连接不存在或形成环。")
		return
	}
	handler.executeProbe(response, request, config, timeout)
}

func (handler *Handler) executeProbe(response http.ResponseWriter, request *http.Request, config sshremote.Config, timeout time.Duration) {
	if errReason, errMsg := validateKeyFileConfig(config, handler.hostHomeDir); errReason != "" {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   "invalid_identity_file",
			"reason":  errReason,
			"message": errMsg,
		})
		return
	}
	result, err := handler.prober.Probe(request.Context(), config, timeout)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "probe_failed", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "result": result})
}

var identityFileMessages = map[string]string{
	sshhost.IdentityFileRequired:           "SSH identity file path is required.",
	sshhost.IdentityFileMustBeAbsolute:     "SSH identity file path must be absolute or start with ~/.",
	sshhost.IdentityFileOutsideSSHDir:      "SSH identity file must be inside the current server user SSH directory.",
	sshhost.IdentityFileNotFound:           "SSH identity file was not found.",
	sshhost.IdentityFileNotRegularFile:     "SSH identity file must be a regular file.",
	sshhost.IdentityFilePermissionsTooOpen: "SSH identity file permissions must not allow group or other access.",
}

func validateKeyFileConfig(config sshremote.Config, hostHomeDir string) (string, string) {
	for cur := &config; cur != nil; cur = cur.Jump {
		if strings.TrimSpace(cur.AuthType) != sshhost.KeyFileAuthType {
			continue
		}
		if strings.TrimSpace(cur.IdentityFile) == "" {
			code := sshhost.IdentityFileRequired
			return code, identityFileMessages[code]
		}
		if strings.TrimSpace(hostHomeDir) == "" {
			continue
		}
		if _, err := sshhost.ResolveIdentityFilePath(cur.IdentityFile, sshhost.IdentityOptions{HomeDir: hostHomeDir}); err != nil {
			var idErr *sshhost.IdentityFileError
			if errors.As(err, &idErr) && idErr != nil {
				msg := identityFileMessages[idErr.Code]
				if msg == "" {
					msg = "SSH identity file is invalid."
				}
				return idErr.Code, msg
			}
			return "identity_file_invalid", "SSH identity file is invalid."
		}
	}
	return "", ""
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

func timeoutFromValue(raw any, fallbackMs int) time.Duration {
	milliseconds := fallbackMs
	switch typed := raw.(type) {
	case float64:
		if typed > 0 {
			milliseconds = int(typed)
		}
	case int:
		if typed > 0 {
			milliseconds = typed
		}
	case string:
		if parsed, err := strconv.Atoi(strings.TrimSpace(typed)); err == nil && parsed > 0 {
			milliseconds = parsed
		}
	}
	if milliseconds <= 0 {
		milliseconds = fallbackMs
	}
	if milliseconds > maxTimeoutMs {
		milliseconds = maxTimeoutMs
	}
	return time.Duration(milliseconds) * time.Millisecond
}

func decodeBodyObject(response http.ResponseWriter, request *http.Request) (map[string]any, string, string) {
	if request.Body == nil {
		return map[string]any{}, "", ""
	}
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes))
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		if errors.Is(err, io.EOF) {
			return map[string]any{}, "", ""
		}
		return nil, "invalid_json_body", "请求体不是合法 JSON"
	}
	object, ok := payload.(map[string]any)
	if !ok || object == nil {
		return nil, "invalid_request_body", "请求体必须是 JSON 对象"
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, "invalid_json_body", "请求体不是合法 JSON"
	}
	return object, "", ""
}

// connection 是探测需要展开的连接事实。
type connection struct {
	ID                 string
	Host               string
	User               string
	Port               int
	AuthType           string
	Password           string
	PrivateKey         string
	IdentityFile       string
	EgressConnectionID string
}

func parseConnectionsMap(raw string, found bool) (map[string]map[string]any, error) {
	byID := make(map[string]map[string]any)
	if !found || strings.TrimSpace(raw) == "" {
		return byID, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	list, ok := decoded.([]any)
	if !ok {
		return byID, nil
	}
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id := stringField(object, "id")
		if id != "" {
			byID[id] = object
		}
	}
	return byID, nil
}

func buildSSHConfig(target connection, byID map[string]map[string]any, hostHomeDir string) (sshremote.Config, bool) {
	seen := map[string]bool{}
	if target.ID != "" {
		seen[target.ID] = true
	}
	return resolveSSHConfig(target, byID, seen, 0, hostHomeDir)
}

func resolveSSHConfig(
	current connection,
	byID map[string]map[string]any,
	seen map[string]bool,
	depth int,
	hostHomeDir string,
) (sshremote.Config, bool) {
	cfg := toSSHConfig(current, hostHomeDir)
	egressID := strings.TrimSpace(current.EgressConnectionID)
	if egressID == "" {
		return cfg, true
	}
	if seen[egressID] || depth >= maxJumpDepth {
		return sshremote.Config{}, false
	}
	egressObj, ok := byID[egressID]
	if !ok {
		return sshremote.Config{}, false
	}
	nextSeen := make(map[string]bool, len(seen)+1)
	for key, val := range seen {
		nextSeen[key] = val
	}
	nextSeen[egressID] = true
	jumpCfg, ok := resolveSSHConfig(connectionFromObject(egressObj), byID, nextSeen, depth+1, hostHomeDir)
	if !ok {
		return sshremote.Config{}, false
	}
	cfg.Jump = &jumpCfg
	return cfg, true
}

func toSSHConfig(target connection, _ string) sshremote.Config {
	return sshremote.Config{
		Host:         target.Host,
		Port:         target.Port,
		User:         target.User,
		AuthType:     target.AuthType,
		Password:     target.Password,
		PrivateKey:   target.PrivateKey,
		IdentityFile: target.IdentityFile,
	}
}

// connectionFromObject 展开一条连接记录；密码与私钥保持原值，不做裁剪。
func connectionFromObject(object map[string]any) connection {
	port := int(numberField(object, "port"))
	if port <= 0 || port > 65535 {
		port = 22
	}
	return connection{
		ID:                 stringField(object, "id"),
		Host:               stringField(object, "host"),
		User:               stringField(object, "user"),
		Port:               port,
		AuthType:           stringField(object, "authType"),
		Password:           rawStringField(object, "password"),
		PrivateKey:         rawStringField(object, "privateKey"),
		IdentityFile:       stringField(object, "identityFile"),
		EgressConnectionID: stringField(object, "egressConnectionId"),
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
	switch typed := object[key].(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil {
			return parsed
		}
		return 0
	default:
		return 0
	}
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
