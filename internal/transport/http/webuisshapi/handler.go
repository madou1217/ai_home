// Package webuisshapi 提供 WebUI SSH 连接的只读列表。
//
// 存储是 Node app-state.db 的 app_kv ssh_connections（JSON 数组）。写入口仍在
// Node（POST/PUT/DELETE /v0/webui/ssh-connections），本包只读并复刻 Node 的脱敏：
// password / privateKey 有值一律替换为 ******，无值补空串；其它字段原样保留。
package webuisshapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

const (
	// Path 是 SSH 连接列表的只读管理契约。
	Path = "/v1/management/webui/ssh-connections"

	// passwordMask 与 Node 的 PASSWORD_MASK 完全一致。
	passwordMask = "******"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("SSH 连接接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 读取 Node 的 ssh_connections 原文。
type Store interface {
	ReadConnections(ctx context.Context) (string, bool, error)
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
}

// Handler 处理 SSH 连接列表读取。
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

type responseView struct {
	OK          bool             `json:"ok"`
	Connections []map[string]any `json:"connections"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "ssh_connections_unavailable", "SSH 连接服务不可用")
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
	raw, found, err := handler.store.ReadConnections(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_connections_read_failed", "")
		return
	}
	connections, err := sanitizeConnections(raw, found)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_connections_invalid", "ssh_connections 不是合法 JSON")
		return
	}
	writeJSON(response, http.StatusOK, responseView{OK: true, Connections: connections})
}

// sanitizeConnections 复刻 Node：非数组 = 空列表；每个元素展开为对象，
// password/privateKey 有真值就替换成掩码，否则写空串。
func sanitizeConnections(raw string, found bool) ([]map[string]any, error) {
	result := make([]map[string]any, 0)
	if !found || raw == "" {
		return result, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	list, ok := decoded.([]any)
	if !ok {
		return result, nil
	}
	for _, item := range list {
		connection := map[string]any{}
		if object, ok := item.(map[string]any); ok {
			for key, value := range object {
				connection[key] = value
			}
		}
		connection["password"] = maskSecret(connection["password"])
		connection["privateKey"] = maskSecret(connection["privateKey"])
		result = append(result, connection)
	}
	return result, nil
}

// maskSecret 对齐 JS 的真值判断：非空字符串 / 非零数字 / true / 非 nil 对象都算有值。
func maskSecret(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		if typed == "" {
			return ""
		}
		return passwordMask
	case bool:
		if !typed {
			return ""
		}
		return passwordMask
	case float64:
		if typed == 0 {
			return ""
		}
		return passwordMask
	default:
		return passwordMask
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
