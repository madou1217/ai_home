// Package webuisshwriteapi 提供 WebUI SSH 连接的写入接口。
//
// 路由（管理面）：
//
//	POST   /v1/management/webui/ssh-connections
//	PUT    /v1/management/webui/ssh-connections/{id}
//	DELETE /v1/management/webui/ssh-connections/{id}
//
// 存储是 app-state.db 的 app_kv ssh_connections（JSON 数组）。Node 仍在写同一个
// 键，所以整条写路径必须是 BEGIN IMMEDIATE 事务里的读改写（appstate.UpdateKV），
// 不能先读再单独写：两个并发新增各自写回旧列表时会丢记录。
//
// 与 Node 对齐：id 为 conn_ + 16 位十六进制；PUT 缺省字段保持原值；
// password / privateKey 传入掩码 ****** 视为「未修改」；非当前 authType 的凭据
// 写空；删除时清空其它连接对本条的 egressConnectionId。
//
// 刻意更严：路径 id 必须匹配 conn_[a-f0-9]{16}；host / user 做字符集校验并禁止
// 以 - 开头（防 ssh 选项注入）；port 必须 1–65535；已有 ssh_connections 非法
// JSON 时失败关闭，而不是按空列表覆盖。
package webuisshwriteapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

const (
	// CollectionPath 是连接集合的管理契约；POST 新增。
	CollectionPath = "/v1/management/webui/ssh-connections"
	// ItemPath 是单条连接的管理契约；PUT 编辑、DELETE 删除。
	ItemPath = CollectionPath + "/{id}"

	// passwordMask 与 Node 的 PASSWORD_MASK 完全一致。
	passwordMask = "******"
	maxBodyBytes = 1024 * 1024

	authTypeAgent    = "agent"
	authTypeKey      = "key"
	authTypeKeyFile  = "key-file"
	authTypePassword = "password"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("SSH 连接写入接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 在 BEGIN IMMEDIATE 事务里读改写 ssh_connections。
type Store interface {
	UpdateConnections(ctx context.Context, mutate func(current string, found bool) (string, error)) error
}

// Dependencies 汇总写入依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
}

// Handler 处理 SSH 连接新增、编辑、删除。
type Handler struct {
	authorizer Authorizer
	store      Store
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, store: dependencies.Store}, nil
}

// Route 是本切片需要的路由模式，宿主装配时挂到 ServeMux。
type Route struct {
	Pattern string
	Handler http.Handler
}

// Routes 返回三个写入路由。
func (handler *Handler) Routes() []Route {
	return []Route{
		{Pattern: http.MethodPost + " " + CollectionPath, Handler: handler},
		{Pattern: http.MethodPut + " " + ItemPath, Handler: handler},
		{Pattern: http.MethodDelete + " " + ItemPath, Handler: handler},
	}
}

type connectionResponse struct {
	OK         bool           `json:"ok"`
	Connection map[string]any `json:"connection"`
}

type deleteResponse struct {
	OK bool `json:"ok"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// requestError 携带 HTTP 状态与稳定错误码，由事务回调抛回。
type requestError struct {
	status  int
	code    string
	message string
}

func (failure *requestError) Error() string {
	if failure.message != "" {
		return failure.message
	}
	return failure.code
}

// ServeHTTP 按路径分派集合与单条连接。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "ssh_connections_unavailable", "SSH 连接写入服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	id, collection, ok := routeTarget(request)
	if !ok {
		writeError(response, http.StatusNotFound, "not_found", "未知的 SSH 连接路径")
		return
	}
	if collection {
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
			return
		}
		handler.create(response, request)
		return
	}
	if !connectionIDPattern.MatchString(id) {
		writeError(response, http.StatusBadRequest, "invalid_connection_id", "连接 id 必须形如 conn_<16 位十六进制>")
		return
	}
	switch request.Method {
	case http.MethodPut:
		handler.update(response, request, id)
	case http.MethodDelete:
		handler.remove(response, request, id)
	default:
		response.Header().Set("Allow", http.MethodPut+", "+http.MethodDelete)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 PUT/DELETE")
	}
}

// routeTarget 解析集合 / 单条路径；mux 已经设过 {id} 时优先用 PathValue。
func routeTarget(request *http.Request) (string, bool, bool) {
	path := strings.TrimSuffix(request.URL.Path, "/")
	if path == CollectionPath {
		return "", true, true
	}
	prefix := CollectionPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", false, false
	}
	id := request.PathValue("id")
	if id == "" {
		id = strings.TrimPrefix(path, prefix)
	}
	if id == "" || strings.Contains(id, "/") {
		return "", false, false
	}
	return id, false, true
}

func (handler *Handler) create(response http.ResponseWriter, request *http.Request) {
	payload, failure := decodePayload(response, request)
	if failure != nil {
		writeFailure(response, failure)
		return
	}
	input, failure := parseCreateInput(payload)
	if failure != nil {
		writeFailure(response, failure)
		return
	}
	var created map[string]any
	err := handler.store.UpdateConnections(request.Context(), func(current string, found bool) (string, error) {
		connections, failure := decodeConnections(current, found)
		if failure != nil {
			return "", failure
		}
		id, failure := newConnectionID(connections)
		if failure != nil {
			return "", failure
		}
		connection, failure := buildConnection(id, input, connections)
		if failure != nil {
			return "", failure
		}
		connections = append(connections, connection)
		encoded, encodeErr := json.Marshal(connections)
		if encodeErr != nil {
			return "", encodeErr
		}
		created = connection
		return string(encoded), nil
	})
	if err != nil {
		writeStoreError(response, err, "ssh_connections_write_failed")
		return
	}
	writeJSON(response, http.StatusOK, connectionResponse{OK: true, Connection: sanitizeConnection(created)})
}

func (handler *Handler) update(response http.ResponseWriter, request *http.Request, id string) {
	payload, failure := decodePayload(response, request)
	if failure != nil {
		writeFailure(response, failure)
		return
	}
	patch, failure := parseUpdatePatch(payload)
	if failure != nil {
		writeFailure(response, failure)
		return
	}
	var updated map[string]any
	err := handler.store.UpdateConnections(request.Context(), func(current string, found bool) (string, error) {
		connections, failure := decodeConnections(current, found)
		if failure != nil {
			return "", failure
		}
		index := indexOfConnection(connections, id)
		if index < 0 {
			return "", &requestError{status: http.StatusNotFound, code: "not_found", message: "Connection not found."}
		}
		connection := connections[index]
		if failure := patch.apply(connection, connections, id); failure != nil {
			return "", failure
		}
		if failure := validateConnection(connection); failure != nil {
			return "", failure
		}
		clearInactiveCredentials(connection)
		connections[index] = connection
		encoded, encodeErr := json.Marshal(connections)
		if encodeErr != nil {
			return "", encodeErr
		}
		updated = connection
		return string(encoded), nil
	})
	if err != nil {
		writeStoreError(response, err, "ssh_connections_write_failed")
		return
	}
	writeJSON(response, http.StatusOK, connectionResponse{OK: true, Connection: sanitizeConnection(updated)})
}

func (handler *Handler) remove(response http.ResponseWriter, request *http.Request, id string) {
	err := handler.store.UpdateConnections(request.Context(), func(current string, found bool) (string, error) {
		connections, failure := decodeConnections(current, found)
		if failure != nil {
			return "", failure
		}
		next := make([]map[string]any, 0, len(connections))
		for _, connection := range connections {
			if connectionString(connection, "id") == id {
				continue
			}
			if connectionString(connection, "egressConnectionId") == id {
				connection["egressConnectionId"] = ""
			}
			next = append(next, connection)
		}
		encoded, encodeErr := json.Marshal(next)
		if encodeErr != nil {
			return "", encodeErr
		}
		return string(encoded), nil
	})
	if err != nil {
		writeStoreError(response, err, "ssh_connections_write_failed")
		return
	}
	writeJSON(response, http.StatusOK, deleteResponse{OK: true})
}

// decodePayload 读取 JSON 对象；空 body 视为 {}（与 Node 一致）。
func decodePayload(response http.ResponseWriter, request *http.Request) (map[string]any, *requestError) {
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes))
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		if errors.Is(err, io.EOF) {
			return map[string]any{}, nil
		}
		return nil, &requestError{status: http.StatusBadRequest, code: "invalid_json_body"}
	}
	object, ok := payload.(map[string]any)
	if !ok || object == nil {
		return nil, &requestError{status: http.StatusBadRequest, code: "invalid_request_body"}
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, &requestError{status: http.StatusBadRequest, code: "invalid_json_body"}
	}
	return object, nil
}

func writeFailure(response http.ResponseWriter, failure *requestError) {
	writeError(response, failure.status, failure.code, failure.message)
}

func writeStoreError(response http.ResponseWriter, err error, fallbackCode string) {
	var failure *requestError
	if errors.As(err, &failure) {
		writeFailure(response, failure)
		return
	}
	writeError(response, http.StatusInternalServerError, fallbackCode, "")
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
