// Package webuisshreverseapi 暴露 SSH 反向隧道的管理面：只读状态 + 配置变更后的 reconcile。
//
// 隧道本身由 runtime/sshtunnel.Supervisor 持有；本包不执行网络操作，也不回显凭据。
package webuisshreverseapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
)

const (
	// Path 是状态查询路径。
	Path = "/v1/management/webui/ssh/reverse-tunnels"
	// ReconcilePath 让 Node 在 ssh_connections 增删改后触发一次重读。
	ReconcilePath = Path + "/reconcile"
	// ReconnectSuffix 是强制关闭并重连一条隧道。
	ReconnectSuffix = "/reconnect"
	// WatchPath 是状态 SSE；隧道状态变化时推全量快照。
	WatchPath = Path + "/watch"
)

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Connections 读取 ssh_connections 原文；与 webuisshapi.Source 同形。
type Connections interface {
	ReadConnections(ctx context.Context) (string, bool, error)
}

// Supervisor 是 sshtunnel.Supervisor 的入站端口。
type Supervisor interface {
	Reconcile(raw []byte) error
	Reconnect(connectionID string) bool
	Status() []sshtunnel.Status
	Subscribe() (<-chan struct{}, func())
}

// Dependencies 汇总入站依赖。
type Dependencies struct {
	Authorizer  Authorizer
	Connections Connections
	Supervisor  Supervisor
}

// Handler 处理状态与 reconcile。
type Handler struct {
	authorizer  Authorizer
	connections Connections
	supervisor  Supervisor
}

// NewHandler 创建 handler；依赖缺失时拒绝装配。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Connections == nil || dependencies.Supervisor == nil {
		return nil, errors.New("SSH 反向隧道接口依赖无效")
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		connections: dependencies.Connections,
		supervisor:  dependencies.Supervisor,
	}, nil
}

// ServeHTTP 只接受 GET 状态与 POST reconcile。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.connections == nil || handler.supervisor == nil {
		writeError(response, http.StatusServiceUnavailable, "ssh_reverse_tunnel_unavailable", "SSH 反向隧道服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "")
		return
	}
	if request.Method == http.MethodPost && strings.HasPrefix(request.URL.Path, Path+"/") && strings.HasSuffix(request.URL.Path, ReconnectSuffix) {
		connectionID := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, Path+"/"), ReconnectSuffix)
		connectionID = strings.TrimSuffix(connectionID, "/")
		if connectionID == "" || strings.Contains(connectionID, "/") {
			writeError(response, http.StatusBadRequest, "invalid_connection_id", "")
			return
		}
		if !handler.supervisor.Reconnect(connectionID) {
			writeError(response, http.StatusNotFound, "connection_not_found", "")
			return
		}
		writeJSON(response, http.StatusAccepted, struct {
			OK      bool               `json:"ok"`
			Tunnels []sshtunnel.Status `json:"tunnels"`
		}{OK: true, Tunnels: handler.supervisor.Status()})
		return
	}
	if request.Method == http.MethodGet && request.URL.Path == WatchPath {
		handler.serveWatch(response, request)
		return
	}
	switch {
	case request.Method == http.MethodGet && request.URL.Path == Path:
		writeJSON(response, http.StatusOK, struct {
			OK      bool               `json:"ok"`
			Tunnels []sshtunnel.Status `json:"tunnels"`
		}{OK: true, Tunnels: handler.supervisor.Status()})
	case request.Method == http.MethodPost && request.URL.Path == ReconcilePath:
		raw, found, err := handler.connections.ReadConnections(request.Context())
		if err != nil {
			writeError(response, http.StatusInternalServerError, "ssh_connections_read_failed", "")
			return
		}
		if !found {
			raw = ""
		}
		if err := handler.supervisor.Reconcile([]byte(raw)); err != nil {
			writeError(response, http.StatusBadRequest, "ssh_connections_invalid", err.Error())
			return
		}
		writeJSON(response, http.StatusOK, struct {
			OK      bool               `json:"ok"`
			Tunnels []sshtunnel.Status `json:"tunnels"`
		}{OK: true, Tunnels: handler.supervisor.Status()})
	default:
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
	}
}

func (handler *Handler) serveWatch(response http.ResponseWriter, request *http.Request) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, "sse_unsupported", "")
		return
	}
	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("Connection", "keep-alive")
	response.WriteHeader(http.StatusOK)
	send := func() bool {
		payload, err := json.Marshal(struct {
			Type    string             `json:"type"`
			Tunnels []sshtunnel.Status `json:"tunnels"`
		}{Type: "tunnels", Tunnels: handler.supervisor.Status()})
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(response, "data: %s\n\n", payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !send() {
		return
	}
	updates, cancel := handler.supervisor.Subscribe()
	defer cancel()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-updates:
			if !send() {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(response, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	if strings.TrimSpace(message) == "" {
		message = code
	}
	writeJSON(response, status, struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error"`
		Message string `json:"message"`
	}{OK: false, Error: code, Message: message})
}
