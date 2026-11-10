// Package webuitoolkittargetsapi 提供 toolkit 执行目标的只读列表。
//
// 目标只有两类：本机（local）与 SSH 连接（ssh:<connectionId>）。SSH 连接来自
// Node app-state.db 的 ssh_connections；Go 只读并复刻 Node listToolkitTargets
// 的过滤与展示规则，连接的增删改仍在 Node。
package webuitoolkittargetsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
)

const (
	// Path 是 toolkit 执行目标的只读管理契约。
	Path = "/v1/management/webui/toolkit/environments/targets"

	localTargetKey = "local"
	sshPrefix      = "ssh:"
)

// connectionID 与 Node toolkit-execution-target.js 的 CONNECTION_ID 一致。
var connectionID = regexp.MustCompile(`^conn_[a-f0-9]{16}$`)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("toolkit 执行目标接口依赖无效")

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

// Handler 处理 toolkit 执行目标读取。
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

// TargetView 与 Node listToolkitTargets 的响应字段同名；label/host 为空时省略。
type TargetView struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
	Host  string `json:"host,omitempty"`
}

type responseView struct {
	OK      bool         `json:"ok"`
	Targets []TargetView `json:"targets"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "toolkit_targets_unavailable", "toolkit 执行目标服务不可用")
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
		writeError(response, http.StatusInternalServerError, "toolkit_targets_read_failed", "")
		return
	}
	targets, err := buildTargets(raw, found)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "toolkit_targets_invalid", "ssh_connections 不是合法 JSON")
		return
	}
	writeJSON(response, http.StatusOK, responseView{OK: true, Targets: targets})
}

// buildTargets 复刻 Node：本机固定第一项；SSH 连接只保留 conn_<16hex>，
// label 取 label 或 host，host 展示为 user@host（没有 user 就是 host）。
func buildTargets(raw string, found bool) ([]TargetView, error) {
	targets := []TargetView{{Kind: "local", ID: localTargetKey, Label: "本机（AIH Server）"}}
	if !found || raw == "" {
		return targets, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	list, ok := decoded.([]any)
	if !ok {
		return targets, nil
	}
	for _, item := range list {
		connection, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := connection["id"].(string)
		if !connectionID.MatchString(id) {
			continue
		}
		host, _ := connection["host"].(string)
		label, _ := connection["label"].(string)
		if label == "" {
			label = host
		}
		displayHost := host
		if user, _ := connection["user"].(string); user != "" {
			displayHost = user + "@" + host
		}
		targets = append(targets, TargetView{
			Kind:  "ssh",
			ID:    sshPrefix + id,
			Label: label,
			Host:  displayHost,
		})
	}
	return targets, nil
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
